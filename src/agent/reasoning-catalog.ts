/**
 * 推理档位的单一真源（模型 → 支持的档位 + 推荐默认）。
 *
 * 存在的理由只有一个：**"默认"不等于"合适"**。空值意味着"不下发 reasoning_effort"，
 * 服务商自己决定想多久 —— DeepSeek 这类端点默认就是高档，一轮能想 20~150 秒。
 * Codex 的做法是每个模型自带 `default_reasoning_level`（多数 medium），
 * 这里对齐：按模型给出真实支持的档位与一个推荐值，桌面端表单用它做默认/下拉。
 *
 * 档位取值来自 ZCode 内置的 modelRules（见 desktop/src/effort.ts），不要臆造：
 * 例如 DeepSeek 只认 low/high/max，传 medium 不报错、但会被当成高档。
 *
 * 本模块**不依赖 i18n、不依赖 desktop**：桌面端跨包直接 import，
 * 保证"下拉里能选的"和"推荐值"永远出自同一张表。
 */

export type ReasoningProfile = {
  match: RegExp;
  /** 该模型真实支持的档位（不含"默认"） */
  levels: readonly string[];
  /** 推荐默认档位：必须是 levels 里的值 */
  recommended: string;
};

/**
 * 顺序即优先级，先命中先返回。新增模型只加行，不改逻辑。
 * flash / economy / mini 这类快模型推荐 low：它们的 high 通常已经等价于别家的 medium。
 */
const PROFILES: readonly ReasoningProfile[] = [
  { match: /deepseek-v4[.-]1-flash/i, levels: ["low", "high", "max"], recommended: "low" },
  { match: /deepseek-v4-pro/i, levels: ["low", "high", "max"], recommended: "low" },
  { match: /deepseek-v4-flash/i, levels: ["low", "high", "max"], recommended: "low" },
  { match: /deepseek-flash/i, levels: ["low", "high", "max"], recommended: "low" },
  // GLM-5.4（2026-11-23 发布）：1M 上下文 / 128K 输出 / 原生视觉；
  // 档位按 models.dev 与 5.3 同一套（low/high/max）—— 远端目录一旦给出别的值会覆盖这里
  {
    match: /glm-5\.4/i,
    levels: ["low", "high", "max"],
    recommended: "low",
  },
  { match: /glm-5\.3/i, levels: ["low", "high", "max"], recommended: "low" },
  { match: /glm-5\.2/i, levels: ["low", "high", "max"], recommended: "low" },
  { match: /kimi[-_ ]?k3/i, levels: ["low", "high", "max"], recommended: "low" },
  {
    match: /gpt-5\.6/i,
    levels: ["none", "low", "medium", "high", "xhigh", "max", "ultra"],
    recommended: "medium",
  },
  { match: /gpt-5\.3-codex/i, levels: ["low", "medium", "high", "xhigh"], recommended: "medium" },
  { match: /gpt-5\.4-pro/i, levels: ["medium", "high", "xhigh"], recommended: "medium" },
  { match: /gpt-5\.4/i, levels: ["none", "low", "medium", "high", "xhigh"], recommended: "medium" },
  {
    match: /claude-(fable|opus|sonnet|mythos)-5/i,
    levels: ["low", "medium", "high", "xhigh", "max"],
    recommended: "medium",
  },
  { match: /grok-4\.6/i, levels: ["low", "medium", "high", "xhigh"], recommended: "medium" },
];

/** 认不出模型时用 OpenAI 的通用四档；推荐值仍是 medium（Codex 的默认档）。 */
const FALLBACK_LEVELS: readonly string[] = ["minimal", "low", "medium", "high"];
const FALLBACK_RECOMMENDED = "medium";

function profileFor(model: string | null | undefined): ReasoningProfile | undefined {
  const name = model ?? "";
  return PROFILES.find((item) => item.match.test(name));
}

/** 该模型支持的档位；未知模型给通用四档（与桌面端下拉的兜底一致）。 */
export function reasoningLevelsForModel(model: string | null | undefined): readonly string[] {
  return profileFor(model)?.levels ?? FALLBACK_LEVELS;
}

/** 目录里有没有这个模型的规则（未知模型不能猜它支持什么档位）。 */
export function hasReasoningProfile(model: string | null | undefined): boolean {
  return profileFor(model) !== undefined;
}

/** 推荐默认档位；未知模型给 medium。 */
export function recommendedEffortForModel(model: string | null | undefined): string {
  return profileFor(model)?.recommended ?? FALLBACK_RECOMMENDED;
}

/**
 * 请求时实际下发的默认档位：**模型商没有查询默认思考强度的接口**，
 * 所以认识的模型统一按 medium 兜底（Codex 的做法也是 medium）；
 * 档位表里没有 medium 的（DeepSeek/GLM-5.3 是 low/high/max）取最低一档，
 * 因为往上顶等于偷偷加价。
 *
 * `levels` 是服务商手动配置的档位表（优先于目录）：用户既然写了，就按他的表来。
 * 不认识的模型返回 undefined —— 连它认不认 reasoning_effort 都不知道，
 * 不发比发错好（发错会 400，或者被网关当成最高档）。
 */
export function defaultEffortForModel(
  model: string | null | undefined,
  levels?: readonly string[],
): string | undefined {
  const ladder = levels?.length ? levels : profileFor(model)?.levels;
  if (!ladder?.length) return undefined;
  if (ladder.includes("medium")) return "medium";
  return ladder.find((level) => !["none", "off", "disabled"].includes(level)) ?? ladder[0];
}

/** 空值（不下发）是否比推荐档更"贵"：用于设置页提示，不参与请求。 */
export function isEffortSupported(model: string | null | undefined, effort: string): boolean {
  if (!effort) return true;
  return reasoningLevelsForModel(model).includes(effort);
}
