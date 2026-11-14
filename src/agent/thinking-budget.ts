/**
 * 思考预算（extended thinking budget）的单一出口。
 *
 * 之前 `thinkingBudgetFor` 藏在 anthropic.ts 里，只有 Anthropic 原生端点能用；
 * 桌面端也无法显式指定预算。这里把三件事收成一份：
 *  1) 档位 → 预算的映射（沿用既有省 token 口径，不抬高默认值）；
 *  2) 显式 `thinkingBudget` 覆盖档位；
 *  3) 与 max_tokens 的钳制（Anthropic 硬约束：1024 <= budget < max_tokens）。
 *
 * 「不下发」比「发一个非法值」好：不满足约束时返回 undefined，服务端用自己的
 * 默认思考策略，而不是直接 400 把整个回合打掉。
 */

/** 档位 → budget_tokens（省 token 优先）。 */
export const THINKING_BUDGET_BY_EFFORT: Record<string, number> = {
  minimal: 1024,
  low: 1024,
  medium: 2048,
  high: 4096,
  xhigh: 8192,
  max: 16384,
};

export const MIN_THINKING_BUDGET = 1024;
/** Anthropic 当前上限 32k；再高的值一律按 128k 兜底裁剪，避免把非法值发出去。 */
export const MAX_THINKING_BUDGET = 131_072;

/**
 * 未知档位（自定义 reasoningLevels）的兜底预算：与 medium 同档，
 * 不为一个没听说过的名字付 max 级别的思考费。
 */
const UNKNOWN_EFFORT_BUDGET = 2048;

/** 不给 maxTokens 时的假定值（与 provider 默认 8192 对齐）。 */
const DEFAULT_MAX_TOKENS = 8192;
/**
 * 输出预留：thinking 之外还要留同样多的空间给正文与工具参数，
 * 否则 max_tokens 会被思考吃光，模型只能吐出半截工具调用。
 */
const OUTPUT_RESERVE_TOKENS = 1024;

export type ThinkingBudgetInput = {
  /** 用户选择的档位（reasoningEffort）；未设置为空 */
  effort?: string;
  /** 显式预算（provider.thinkingBudget）：设置后优先于档位 */
  explicit?: number;
  /** 本次请求的 max_tokens */
  maxTokens?: number;
};

/**
 * 计算实际下发的 thinking budget。
 *
 * 返回 undefined = 本次请求不要 thinking：
 *  - 既没有档位也没有显式预算；
 *  - max_tokens 太小（`maxTokens - 1024 < 1024`，即 maxTokens < 2048），
 *    放不下一个合法预算 + 正文预留。
 */
export function resolveThinkingBudget(input: ThinkingBudgetInput = {}): number | undefined {
  const explicit = input.explicit;
  const wanted =
    typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0
      ? Math.floor(explicit)
      : input.effort
        ? (THINKING_BUDGET_BY_EFFORT[input.effort] ?? UNKNOWN_EFFORT_BUDGET)
        : undefined;
  if (wanted === undefined) return undefined;

  const maxTokens =
    typeof input.maxTokens === "number" && Number.isFinite(input.maxTokens) && input.maxTokens > 0
      ? Math.floor(input.maxTokens)
      : DEFAULT_MAX_TOKENS;
  // budget 必须给正文留位置：maxTokens=2048 时只能给 1024（而不是 2047），
  // maxTokens=1500 时连一个合法预算都放不下 —— 直接不下发。
  const room = maxTokens - OUTPUT_RESERVE_TOKENS;
  if (room < MIN_THINKING_BUDGET) return undefined;
  const upper = Math.min(MAX_THINKING_BUDGET, room);
  return Math.max(MIN_THINKING_BUDGET, Math.min(wanted, upper));
}

/**
 * 按 modes 升一档（plan/goal 需要更长的推理链）。显式预算不参与升档：
 * 用户手填的数字是精确意图，不该被模式悄悄改掉。
 */
export function boostEffort(
  effort: string | undefined,
  levels: string[] | undefined,
  steps = 1,
): string | undefined {
  if (!effort || !levels?.length || steps <= 0) return effort;
  const index = levels.indexOf(effort);
  if (index < 0) return effort;
  return levels[Math.min(levels.length - 1, index + steps)];
}

/**
 * 复杂度事实：runtime 每回合按**已经发生过的事**填，不用「一句话分类」。
 * 换档改的是 reasoning_effort / budget_tokens（不进前缀），
 * 所以调档不会破坏缓存，但会让服务端换一套推理行为——必须有据可依。
 */
export type ThinkingComplexity = {
  /** 本轮治理门禁数（同一 lane 上最多几条门禁） */
  gates?: number;
  /** 本回合已派发的子 Agent 数 */
  subagents?: number;
  /** 治理档 T0/T1/T2 */
  tier?: string;
  /** 本回合连续工具/验证失败次数 */
  recentFailures?: number;
};

/** 单项阈值：过了才加一档，避免「什么都算复杂」等于什么都没调 */
const COMPLEXITY_RULES = {
  gates: 4,
  subagents: 2,
  failures: 2,
} as const;
/** 最多升两档：再往上就是 max，cost 会翻倍而收益递减 */
const MAX_COMPLEXITY_STEPS = 2;

/**
 * 复杂度 → 升档步数。纯函数，可单测。
 *
 * 为什么不用「一句话分类」：分类结果本身不稳定，且换档会改请求参数
 * （reasoning_effort / budget_tokens 不进前缀，但会改服务端的推理行为），
 * 用**已经发生过的事实**（门禁数、子 Agent 数、T2、失败次数）更可解释。
 */
export function complexityBoostSteps(complexity: ThinkingComplexity | undefined): number {
  if (!complexity) return 0;
  let steps = 0;
  if ((complexity.gates ?? 0) >= COMPLEXITY_RULES.gates) steps += 1;
  if ((complexity.subagents ?? 0) >= COMPLEXITY_RULES.subagents) steps += 1;
  if (complexity.tier === "T2") steps += 1;
  if ((complexity.recentFailures ?? 0) >= COMPLEXITY_RULES.failures) steps += 1;
  return Math.min(steps, MAX_COMPLEXITY_STEPS);
}

/**
 * 请求级思考策略：显式预算 > 复杂度/模式升档后的档位。
 * runtime 用它算升档结果，协议层只消费最终值。
 */
export function resolveThinkingPolicy(input: {
  effort?: string;
  explicit?: number;
  maxTokens?: number;
  reasoningLevels?: string[];
  /** plan/goal 模式升档 */
  boost?: boolean;
  /**
   * 复杂度事实（#9）。显式预算仍然优先：用户手填的数字是精确意图。
   * boost 与 complexity 取较大步数，不是相加——两套信号高度相关，
   * 相加会让「plan 模式 + 4 条门禁」直接跳到 max。
   */
  complexity?: ThinkingComplexity;
}): { effort?: string; budget?: number } {
  const modeSteps = input.boost ? 1 : 0;
  const steps = Math.max(modeSteps, complexityBoostSteps(input.complexity));
  // 显式预算不参与升档：用户手填的数字是精确意图
  const applied = input.explicit === undefined && steps > 0;
  const effort = applied
    ? boostEffort(input.effort, input.reasoningLevels, steps)
    : input.effort;
  const budget = resolveThinkingBudget({
    effort,
    explicit: input.explicit,
    maxTokens: input.maxTokens,
  });
  return {
    ...(effort ? { effort } : {}),
    ...(budget !== undefined ? { budget } : {}),
  };
}
