/**
 * 逐请求输出预算预检（preflight）。
 *
 * 上下文窗口是输入与输出共享的：一个 200k 窗口的模型，如果输入已经占了 195k，
 * 再按配置的 8k/32k 去请求输出，服务商只会两种结局——直接 400，或者悄悄把
 * 输入截断。这里在发请求之前按「窗口 − 输入 − 安全余量」算出这一轮真正可用的
 * 输出上限（参考 ZCode 的 per-step preflight 与 opencode 的 output clamp）。
 *
 * 输入优先用服务商上报的真实用量（usage anchor）：字符估算在代码/中文混排时
 * 误差可达 ±30%，用真实值才能把「刚好卡在窗口边缘」的请求算准。只有锚点精确
 * 覆盖当前请求前缀时才允许使用，否则退回估算。
 */

/** 未配置输出上限时的保守默认；用户显式调大才会放宽。 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
/** 再紧也要给模型留出能说一句话的输出预算，否则请求没有意义。 */
export const MIN_OUTPUT_TOKENS = 256;
/** 输入/输出之外的安全余量，吸收字符估算误差与协议包装开销。 */
export const CONTEXT_SAFETY_TOKENS = 1_024;

export type OutputBudgetInput = {
  /** 服务商配置的单次输出上限 */
  configuredMaxTokens?: number;
  /** 服务商声明的上下文窗口；缺省表示未知，不做预检 */
  contextWindow?: number;
  /** 本轮请求输入的字符估算 token */
  inputTokens: number;
  /**
   * 服务商上报的真实输入 token。仅当它精确覆盖本轮请求的整个前缀时传入；
   * 裁剪/压缩改变消息集合后必须留空，否则会按旧前缀算出一个偏大的预算。
   */
  measuredInputTokens?: number;
};

export type OutputBudget = {
  /** 本轮请求应使用的 max_tokens */
  tokens: number;
  /** 是否被窗口余量压到配置值以下 */
  clamped: boolean;
  /** 窗口减输入与余量后的可用值；窗口未知时为 Infinity */
  available: number;
  /** 实际参与计算的输入 token */
  inputTokens: number;
  /** 预算来源：真实用量 / 字符估算 / 窗口未知直接用配置 */
  source: "measured" | "estimate" | "configured";
};

export function resolveOutputBudget(input: OutputBudgetInput): OutputBudget {
  const configured = Math.max(
    MIN_OUTPUT_TOKENS,
    Math.floor(input.configuredMaxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS),
  );
  const window = input.contextWindow && input.contextWindow > 0 ? input.contextWindow : null;
  const measured =
    typeof input.measuredInputTokens === "number" &&
    Number.isFinite(input.measuredInputTokens) &&
    input.measuredInputTokens > 0
      ? Math.floor(input.measuredInputTokens)
      : null;
  const inputTokens = measured ?? Math.max(0, Math.floor(input.inputTokens || 0));

  // 窗口未知：无法预检，保持配置值（由服务商自行拒绝或截断）
  if (!window) {
    return {
      tokens: configured,
      clamped: false,
      available: Number.POSITIVE_INFINITY,
      inputTokens,
      source: "configured",
    };
  }

  const available = window - inputTokens - CONTEXT_SAFETY_TOKENS;
  const tokens = Math.max(MIN_OUTPUT_TOKENS, Math.min(configured, available));
  return {
    tokens,
    clamped: tokens < configured,
    available,
    inputTokens,
    source: measured === null ? "estimate" : "measured",
  };
}
