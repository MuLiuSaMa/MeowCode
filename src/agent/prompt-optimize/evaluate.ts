/**
 * 候选评估与冻结建议（#10）：离线回路的「评测」与「决策」两半。
 *
 * 设计约束（与研究报告 §10.2 第 10 项一致）：
 *  - 本模块**不 import provider**：跑任务靠注入的 `run` 回调，离线进程自己决定
 *    用哪个模型、怎么计费。这样评估器可以在任何进程跑，也不会意外发请求。
 *  - 评分复用 learning 的 `computeImplicitScore`（status/toolErrors/userCorrected），
 *    与线上 15% 对照组的口径一致，离线结论才能和线上数据对得上。
 *  - 每个任务跑 `repeat` 次（默认 2）：单次结果噪声太大，两次取均值还能暴露不稳定。
 *  - `recommendFreeze` 只给出建议与理由，绝不写盘——冻结是人确认后的动作。
 */
import { computeImplicitScore } from "../learning/signals.js";
import type { PromptCandidate } from "./candidate.js";

export type OfflineTask = {
  id: string;
  /** 固定任务集里的一条指令：两个版本跑同一句话，差异才归因到提示词 */
  prompt: string;
};

/** 一次运行的结果（与线上隐式信号同口径）。 */
export type RunOutcome = {
  status: "completed" | "error" | "aborted";
  toolErrors: number;
  userCorrected: boolean;
};

/** 注入的任务执行器：segment = null 表示跑基线，否则跑候选正文。 */
export type TaskRunner = (input: {
  prompt: string;
  segment: string | null;
  taskId: string;
}) => Promise<RunOutcome>;

export type TaskResult = {
  taskId: string;
  baselineScore: number;
  candidateScore: number;
  /** candidate - baseline；正数表示候选更好 */
  delta: number;
};

export type CandidateReport = {
  candidateId: string;
  segment: string;
  baselineVersion: string;
  /** 每任务均值差的总平均；正数 = 候选整体更好 */
  avgDelta: number;
  /** 候选更优 / 打平 / 更差 的任务数 */
  wins: number;
  ties: number;
  losses: number;
  perTask: TaskResult[];
  /** 任务数太少时不给结论：样本不足的「赢」比输更危险 */
  enoughSamples: boolean;
};

const MIN_TASKS_FOR_DECISION = 4;
/** 单任务回归容忍度：掉 0.5 以上直接否决，不看平均 */
const MAX_TASK_REGRESSION = -0.5;

export async function evaluateCandidate(input: {
  candidate: PromptCandidate;
  tasks: OfflineTask[];
  run: TaskRunner;
  repeat?: number;
}): Promise<CandidateReport> {
  const repeat = Math.max(1, Math.min(5, input.repeat ?? 2));
  const perTask: TaskResult[] = [];
  for (const task of input.tasks) {
    const baselineRuns: number[] = [];
    const candidateRuns: number[] = [];
    for (let index = 0; index < repeat; index += 1) {
      const baseline = await input.run({ prompt: task.prompt, segment: null, taskId: task.id });
      baselineRuns.push(computeImplicitScore(baseline));
      const candidate = await input.run({
        prompt: task.prompt,
        segment: input.candidate.text,
        taskId: task.id,
      });
      candidateRuns.push(computeImplicitScore(candidate));
    }
    const mean = (values: number[]) =>
      values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
    const baselineScore = mean(baselineRuns);
    const candidateScore = mean(candidateRuns);
    // 0.05 以内视为打平：隐式评分的粒度是 {-1,-0.5,0.5,1}，微差没有决策价值
    const delta = candidateScore - baselineScore;
    perTask.push({
      taskId: task.id,
      baselineScore,
      candidateScore,
      delta: Math.abs(delta) < 0.05 ? 0 : delta,
    });
  }
  const wins = perTask.filter((item) => item.delta > 0).length;
  const ties = perTask.filter((item) => item.delta === 0).length;
  const losses = perTask.filter((item) => item.delta < 0).length;
  const avgDelta =
    perTask.reduce((sum, item) => sum + item.delta, 0) / Math.max(1, perTask.length);
  return {
    candidateId: input.candidate.id,
    segment: input.candidate.segment,
    baselineVersion: input.candidate.baselineVersion,
    avgDelta,
    wins,
    ties,
    losses,
    perTask,
    enoughSamples: perTask.length >= MIN_TASKS_FOR_DECISION,
  };
}

export type FreezeDecision = {
  freeze: boolean;
  reason: string;
};

/**
 * 冻结建议：只判「够不够格交给用户确认」，不做任何写入。
 *
 * 三条硬门槛（全部满足才建议冻结）：
 *  1. 任务数足够（< 4 条不给结论）；
 *  2. 没有单任务回归超过 0.5 —— 平均再好也不能踩个别任务；
 *  3. 平均差为正且赢面过半。
 */
export function recommendFreeze(report: CandidateReport): FreezeDecision {
  if (!report.enoughSamples) {
    return {
      freeze: false,
      reason: `only ${report.perTask.length} task(s); need at least ${MIN_TASKS_FOR_DECISION} before any conclusion`,
    };
  }
  const regression = Math.min(...report.perTask.map((item) => item.delta));
  if (regression <= MAX_TASK_REGRESSION) {
    const worst = report.perTask.find((item) => item.delta === regression);
    return {
      freeze: false,
      reason: `task "${worst?.taskId ?? "?"}" regressed by ${regression.toFixed(2)}; fix it before freezing`,
    };
  }
  if (report.avgDelta <= 0) {
    return {
      freeze: false,
      reason: `avg delta ${report.avgDelta.toFixed(2)} is not positive (${report.wins}W/${report.ties}T/${report.losses}L)`,
    };
  }
  if (report.wins <= report.losses) {
    return {
      freeze: false,
      reason: `wins (${report.wins}) do not beat losses (${report.losses})`,
    };
  }
  return {
    freeze: true,
    reason: `avg +${report.avgDelta.toFixed(2)}, ${report.wins}W/${report.ties}T/${report.losses}L, no task regressed beyond ${MAX_TASK_REGRESSION}`,
  };
}
