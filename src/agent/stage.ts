/**
 * 任务阶段派生：把计划步骤 / 子 Agent / 治理 lane 三种状态算成同一个阶段。
 *
 * 存事实、算显示 —— 与 dsh-superagent 的 `ticketStage` 同一思路（26 行纯函数、
 * 首条命中即返回、闭合枚举）。这样时间线、右栏总览、治理面板用的是同一套语义，
 * 不再各自 `filter` 一遍。
 *
 * 两个轴是分开的：`stage` 表示「卡在哪」，`needsHuman` 表示「要不要人管」。
 * 合成一个平铺枚举的话，「机器在等 gate」和「人在等审批」会被压成同一个「阻塞」，
 * 通知逻辑就再也分不出来了。
 */

export type Stage =
  | { stage: "person"; action: "approval" | "answer" | "review" }
  | { stage: "machine"; action: "repair" | "blocked" | "gate" | "queued" }
  | { stage: "working"; action: "running" }
  | { stage: "idle" }
  | {
      stage: "ended";
      outcome: "completed" | "failed" | "aborted" | "interrupted" | "cancelled";
    };

/**
 * 输入取 `string` 而不是窄联合：事件载荷里的 status 本身就是 string，
 * 在这里归一（含 `pass`/`fail` 与 `passed`/`failed` 两套拼写）比在调用方各写一遍稳。
 */
export type StageInput =
  | { kind: "attention"; source: "approval" | "ask_user" }
  | {
      kind: "plan";
      steps: ReadonlyArray<{ status: string }>;
      /** 本回合是否还在流式输出：决定「还有 pending 步骤」时是跑还是等 */
      streaming: boolean;
    }
  | { kind: "subagent"; status: string }
  | {
      kind: "lane";
      status: string;
      gates?: Readonly<Record<string, string>>;
      repairCount?: number;
      maxRepairs?: number;
      /** 前置 lane 是否都已结束；缺省按「已结束」处理 */
      upstreamDone?: boolean;
    };

export type StageView = {
  stage: Stage;
  /** 唯一判据，恒等于 `stage.stage === "person"`，调用方不要自己再判一次 */
  needsHuman: boolean;
  /** 人话原因，日志与 tooltip 用 */
  reason: string;
};

/** 修复次数上限：与 workflow-runtime 的 DEFAULT_MAX_REPAIRS 对齐 */
export const DEFAULT_MAX_REPAIRS = 3;

const MAX_REPAIRS = DEFAULT_MAX_REPAIRS;

const view = (stage: Stage, reason: string): StageView => ({
  stage,
  needsHuman: stage.stage === "person",
  reason,
});

const IDLE = view({ stage: "idle" }, "没有可执行的任务");
const RUNNING = view({ stage: "working", action: "running" }, "正在执行");
const QUEUED = view({ stage: "machine", action: "queued" }, "排队等待");

function derivePlan(
  steps: ReadonlyArray<{ status: string }>,
  streaming: boolean,
): StageView {
  if (!steps.length) return IDLE;
  if (steps.some((step) => step.status === "in_progress")) return RUNNING;
  // 全部终结：全 completed 算完成，含 cancelled 的算放弃（都不需要人）
  if (steps.every((step) => step.status === "completed")) {
    return view({ stage: "ended", outcome: "completed" }, "计划全部完成");
  }
  if (steps.every((step) => step.status === "completed" || step.status === "cancelled")) {
    return view({ stage: "ended", outcome: "cancelled" }, "计划已放弃剩余步骤");
  }
  return streaming ? RUNNING : QUEUED;
}

function deriveSubagent(status: string): StageView {
  switch (status) {
    case "running":
      return RUNNING;
    case "completed":
      return view({ stage: "ended", outcome: "completed" }, "子 Agent 完成");
    case "failed":
      return view({ stage: "ended", outcome: "failed" }, "子 Agent 失败");
    case "aborted":
      return view({ stage: "ended", outcome: "aborted" }, "已主动停止");
    // 进程重启杀掉的是「终态但仍需人」的唯一一项：自动续跑会在重启后同时拉起多个
    // 子 Agent 一起烧 token，所以交给人决定要不要续。
    case "interrupted":
      return view({ stage: "person", action: "review" }, "进程中断，等确认是否续跑");
    default:
      return IDLE;
  }
}

function normalizeGate(value: string): "pending" | "passed" | "failed" {
  if (value === "pass" || value === "passed") return "passed";
  if (value === "fail" || value === "failed") return "failed";
  return "pending";
}

function deriveLane(input: Extract<StageInput, { kind: "lane" }>): StageView {
  if (input.status === "done") {
    return view({ stage: "ended", outcome: "completed" }, "lane 已完成");
  }
  const failed = Object.values(input.gates ?? {}).some((gate) => normalizeGate(gate) === "failed");
  if (failed) {
    const repairs = input.repairCount ?? 0;
    const limit = input.maxRepairs ?? MAX_REPAIRS;
    return repairs >= limit
      ? view({ stage: "person", action: "review" }, `已修复 ${repairs} 次仍未通过门禁`)
      : view({ stage: "machine", action: "repair" }, `门禁未通过，第 ${repairs + 1} 次修复`);
  }
  if (input.status === "blocked") {
    // 上游还没跑完 = 排队；上游已结束还 blocked = 真的被挡住
    return input.upstreamDone === false
      ? QUEUED
      : view({ stage: "machine", action: "blocked" }, "被上游 lane 阻塞");
  }
  if (input.status === "active") return RUNNING;
  return QUEUED;
}

/** 单个任务输入 → 阶段视图。首条命中即返回。 */
export function deriveStage(input: StageInput): StageView {
  switch (input.kind) {
    case "attention":
      return input.source === "approval"
        ? view({ stage: "person", action: "approval" }, "等待审批")
        : view({ stage: "person", action: "answer" }, "等待回答");
    case "plan":
      return derivePlan(input.steps, input.streaming);
    case "subagent":
      return deriveSubagent(input.status);
    case "lane":
      return deriveLane(input);
  }
}

const STAGE_ORDER: Stage["stage"][] = ["person", "working", "machine", "ended", "idle"];
const MACHINE_ORDER = ["repair", "blocked", "gate", "queued"] as const;
/** 终态取最坏：失败 > 中断 > 主动停止 > 放弃 > 完成 */
const OUTCOME_ORDER = ["failed", "interrupted", "aborted", "cancelled", "completed"] as const;

/**
 * 会话级聚合：`person > working > machine > ended > idle`。
 * 只有全部输入都是终态时才返回 ended，避免「一个失败盖住还在跑的其他任务」。
 */
export function aggregateStage(views: readonly StageView[]): StageView {
  if (!views.length) return IDLE;

  const person = views.find((item) => item.stage.stage === "person");
  if (person) return person;

  const working = views.find((item) => item.stage.stage === "working");
  if (working) return working;

  const machineRank = (item: StageView): number =>
    item.stage.stage === "machine" ? MACHINE_ORDER.indexOf(item.stage.action) : Number.MAX_SAFE_INTEGER;
  const machines = views.filter((item) => item.stage.stage === "machine");
  if (machines.length) {
    return [...machines].sort((a, b) => machineRank(a) - machineRank(b))[0];
  }

  if (views.every((item) => item.stage.stage === "ended")) {
    const outcomeRank = (item: StageView): number =>
      item.stage.stage === "ended" ? OUTCOME_ORDER.indexOf(item.stage.outcome) : Number.MAX_SAFE_INTEGER;
    return [...views].sort((a, b) => outcomeRank(a) - outcomeRank(b))[0];
  }

  return views.find((item) => item.stage.stage !== "idle") ?? IDLE;
}

/** 稳定的字符串键：日志、`data-stage` 属性与 SVG 图标查表用。 */
export function stageKey(stage: Stage): string {
  if (stage.stage === "idle") return "idle";
  if (stage.stage === "ended") return `ended/${stage.outcome}`;
  return `${stage.stage}/${stage.action}`;
}

export { STAGE_ORDER };
