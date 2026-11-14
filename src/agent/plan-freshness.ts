/**
 * 计划新鲜度（todolist 维护）的纯逻辑。
 *
 * 背景：这套机制原来直接写在 runtime 里，有三处口径问题，实测一个真实会话后暴露：
 *
 * 1. **计数按工具调用算，不按改动量算**：`multi_edit` 一次改 4 个文件只记 1 次；
 *    前面几十次 grep/read 一次都不记。于是「连续改了好几处却没更新清单」这个信号
 *    要等到 4 次写调用才出现——那时活基本干完了，清单只能事后补。
 * 2. **收尾闸判据用的是「距上次清单更新的变更数」**，而 `update_plan` 自己会把它清零。
 *    正常流程「先更新清单 → 再跑验证命令」必然绕过收尾闸，最后一步永远停在 in_progress。
 * 3. 没有清单时只在收尾闸才有一次机会，而那条件要求「已有清单」——空清单会话无人管。
 *
 * 这里把三件事收成可测的纯函数：变更权重、轮间提醒决策、收尾拦截决策。
 */
import { readMultiEditGroups } from "./multi-edit.js";

/** 参与「改动量」统计的工具。读取/搜索不算——它们不改变工作区。 */
export const PLAN_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "multi_edit",
  "apply_patch",
  "delete_file",
  "move_file",
]);

/**
 * 轮间提醒的触发间隔（按**加权变更数**计）。
 * 原来是 4 次工具调用；改成按文件/编辑条目计后，2 已经相当于原来 4~6 次的效果。
 */
export const PLAN_NUDGE_STEP = 2;

/** apply_patch 的文件头：`*** Update File: path` / `*** Add File:` / `*** Delete File:` */
const PATCH_FILE_HEADER = /^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*\S+/gm;

function patchFileCount(patch: unknown): number {
  if (typeof patch !== "string" || !patch) return 0;
  const matches = patch.match(PATCH_FILE_HEADER);
  return matches ? matches.length : 0;
}

/**
 * 一次写类调用折算成多少个「改动单位」。
 *
 * - `multi_edit`：按分组数（= 不同文件数）算，不是按 edits 条数——同一文件改十行
 *   仍然是一处改动；
 * - `apply_patch`：按 patch 里的文件头数算；
 * - 其余：1。
 * 解析失败一律记 1：宁可少算，也不要因为参数格式把计数丢掉。
 */
export function planMutationWeight(tool: string, args: unknown): number {
  if (!PLAN_MUTATION_TOOLS.has(tool)) return 0;
  const record = (args ?? {}) as Record<string, unknown>;
  if (tool === "multi_edit") {
    const groups = readMultiEditGroups(record);
    return typeof groups === "string" ? 1 : Math.max(1, groups.length);
  }
  if (tool === "apply_patch") {
    return Math.max(1, patchFileCount(record.patch));
  }
  return 1;
}

export type PlanFreshnessState = {
  /** 自上次 update_plan 以来累计的加权变更数 */
  mutations: number;
  /** 上次提醒时的 mutations 值；0 = 本回合还没提醒过 */
  nudgedAt: number;
  hasPlan: boolean;
  hasOpenSteps: boolean;
  /** 本回合是否已经推过「建清单」——只推一次，避免每轮啰嗦 */
  noPlanNudged: boolean;
};

export type PlanNudge =
  | { kind: "update"; nextNudgedAt: number }
  | { kind: "create"; nextNudgedAt: number };

/**
 * 轮间提醒决策。
 *
 * - 没有清单：第一次有改动就推一次「建清单」，之后不再推；
 * - 有清单且还有未完成步骤：每积累 PLAN_NUDGE_STEP 个改动单位提醒一次；
 * - 清单全部完成：不提醒（再改文件属于新工作，由「没有清单」分支接手的前提是
 *   清单被清空，这里不做猜测）。
 */
export function planNudge(state: PlanFreshnessState): PlanNudge | null {
  if (!state.hasPlan) {
    if (state.noPlanNudged || state.mutations < 1) return null;
    return { kind: "create", nextNudgedAt: 0 };
  }
  if (!state.hasOpenSteps) return null;
  if (state.mutations - state.nudgedAt < PLAN_NUDGE_STEP) return null;
  return { kind: "update", nextNudgedAt: state.mutations };
}

/**
 * 回合收尾是否该拦一次，逼模型把清单收口。
 *
 * 判据是「本回合有过写操作」而不是「距上次清单更新有变更」：
 * 后者会被 update_plan 自己清零，导致「先更新清单、再跑验证」这种最正常的流程
 * 永远绕开收尾闸，最后一步卡在 in_progress。
 */
export function turnEndPlanBlock(state: {
  hasOpenSteps: boolean;
  turnHadMutations: boolean;
}): boolean {
  return state.hasOpenSteps && state.turnHadMutations;
}
