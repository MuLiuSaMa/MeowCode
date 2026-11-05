/**
 * 用量聚合：流中会多次上报同一轮（roundId）的样本，必须「替换」而不是累加，
 * 否则实时值与最终真值会双计（参考 DSH token-meter 的 addReplacing）。
 */

/** 单轮（一次模型调用）的用量样本：同 roundId 的后续上报整体覆盖旧值。 */
export type UsageSample = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 命中率分母：该轮报告过缓存读取时的输入总量 */
  cacheInput: number;
  cacheReported: boolean;
};

export type UsageTotals = UsageSample;

export const EMPTY_SAMPLE: UsageSample = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheInput: 0,
  cacheReported: false,
};

/** usage 事件里可能带也可能不带的字段：缺省表示本轮没报告，不是 0。 */
export type UsagePatch = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

/** 把事件的字段合并进该轮已有样本；未出现的字段沿用旧值。 */
export function mergeSample(previous: UsageSample | undefined, patch: UsagePatch): UsageSample {
  const next: UsageSample = { ...(previous ?? EMPTY_SAMPLE) };
  if (typeof patch.inputTokens === "number") next.input = patch.inputTokens;
  if (typeof patch.outputTokens === "number") next.output = patch.outputTokens;
  if (typeof patch.cacheReadTokens === "number") {
    next.cacheRead = patch.cacheReadTokens;
    next.cacheReported = true;
    // 缓存命中率的分母取「报告缓存那一轮」的输入总量
    next.cacheInput = next.input;
  }
  if (typeof patch.cacheWriteTokens === "number") next.cacheWrite = patch.cacheWriteTokens;
  return next;
}

function addScaled(totals: UsageTotals, sample: UsageSample, sign: 1 | -1): UsageTotals {
  return {
    input: Math.max(0, totals.input + sign * sample.input),
    output: Math.max(0, totals.output + sign * sample.output),
    cacheRead: Math.max(0, totals.cacheRead + sign * sample.cacheRead),
    cacheWrite: Math.max(0, totals.cacheWrite + sign * sample.cacheWrite),
    cacheInput: Math.max(0, totals.cacheInput + sign * sample.cacheInput),
    // 一旦某轮报告过缓存就保持「有缓存口径」：撤回后 cacheInput 归零会让命中率变 null
    cacheReported: sign === 1 ? totals.cacheReported || sample.cacheReported : totals.cacheReported,
  };
}

/** 用新样本替换该轮旧样本：先减旧再加新。 */
export function applySample(
  totals: UsageTotals,
  previous: UsageSample | undefined,
  next: UsageSample,
): UsageTotals {
  const without = previous ? addScaled(totals, previous, -1) : totals;
  return addScaled(without, next, 1);
}

/** 撤回一整轮（重试 / 中止）。 */
export function retractSample(totals: UsageTotals, sample: UsageSample | undefined): UsageTotals {
  return sample ? addScaled(totals, sample, -1) : totals;
}

/** 缓存命中率：只统计报告过缓存的轮次；没有分母时返回 null（UI 显示 —）。 */
export function hitRate(totals: UsageTotals): number | null {
  if (!totals.cacheReported || totals.cacheInput <= 0) return null;
  return Math.min(totals.cacheRead / totals.cacheInput, 1);
}

/**
 * OpenAI 系命中按 1024-token 桶落账：1–2 个桶的读数漂移不构成失配
 * （对齐 opencode 的 cacheReuseDrop 豁免），超过才算疑似缓存失配。
 */
export const CACHE_BUST_TOLERANCE_TOKENS = 2048;

/**
 * 相邻两轮命中读数跌落检测：上一轮有命中、本轮显著更低 = 疑似缓存失配
 * （前缀被改写/逐出/网关剥离断点）。读数为 0 的轮不参与：新会话、不支持缓存的
 * provider、未报告明细都会产生 0，不是"跌落"。
 */
export function isCacheBust(
  previous: { read: number } | null | undefined,
  current: { read: number } | null | undefined,
): boolean {
  if (!previous || !current) return false;
  if (previous.read <= 0 || current.read <= 0) return false;
  return current.read < previous.read - CACHE_BUST_TOLERANCE_TOKENS;
}

/** `/session` 返回的会话级汇总 → 基座总量（切会话后仍保留历史累计）。 */
export function totalsFromServer(
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        cacheInputTokens?: number;
        cacheReported?: boolean;
      }
    | null
    | undefined,
): UsageTotals {
  if (!usage) return { ...EMPTY_SAMPLE };
  return {
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    cacheRead: usage.cacheReadTokens ?? 0,
    cacheWrite: usage.cacheWriteTokens ?? 0,
    cacheInput: usage.cacheInputTokens ?? 0,
    cacheReported: Boolean(usage.cacheReported),
  };
}
