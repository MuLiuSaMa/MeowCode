/**
 * 思考强度档位 —— **按模型区分**。
 *
 * 档位表与标签都对齐 ZCode 的 `config/provider/zcode-builtin.json`
 * （`modelRules[].config.optionSpecs.reasoningLevel.values`）与其文案表
 * `chat-input-toolbar/thoughtLevelOptions.ts`。
 *
 * 下面的静态表只是兜底：Electron 主进程会定期从 ZCode 的公开内置配置同步
 * modelRules（新模型发布后无需改代码），远程同步到的规则优先使用。
 *
 * 为什么要按模型分：各家认识的值不一样，而且**兜底行为也不一样** ——
 * GLM 只认 low/high/max，传 `medium` 不报错、而是被当成 max（最贵的档）；
 * 而另一些网关不认 `xhigh` 时会回落到 medium，把「高强度」的意图悄悄降级。
 * 所以只有按模型给出真实支持的档位，用户选的东西才等于真正发出去的东西。
 */

import { remoteReasoningValues } from "./modelProfiles";

/** 档位值 → 中文标签（与 ZCode 的文案表一致）。 */
const LEVEL_LABELS: Record<string, string> = {
  "": "默认",
  disabled: "关闭",
  off: "关闭",
  none: "关闭",
  enabled: "开启",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
  ultra: "极致",
};

export type EffortLevel = { value: string; label: string };

export function levelLabel(value: string): string {
  return LEVEL_LABELS[value] ?? value;
}

export function toEffortLevel(value: string): EffortLevel {
  return { value, label: levelLabel(value) };
}

/**
 * 模型档位表，按顺序取第一条命中的正则。
 * 取值与顺序摘自 ZCode 内置表的 modelRules（2026-10 核对）。
 */
const MODEL_PROFILES: Array<{ match: RegExp; values: readonly string[] }> = [
  // DeepSeek V4 家族（ZCode: deepseek-v4.1-flash → disabled/low/high/max，这里去掉 disabled）
  { match: /deepseek-v4[.-]1-flash/i, values: ["low", "high", "max"] },
  { match: /deepseek-v4-pro/i, values: ["low", "high", "max"] },
  { match: /deepseek-v4-flash/i, values: ["low", "high", "max"] },
  { match: /deepseek-flash/i, values: ["low", "high", "max"] },
  // GLM-5.3 家族（参考图里的 glm-5.3-flash 就走这条）
  { match: /glm-5\.3/i, values: ["low", "high", "max"] },
  { match: /glm-5\.2/i, values: ["low", "high", "max"] },
  // Kimi K3
  { match: /kimi[-_ ]?k3/i, values: ["low", "high", "max"] },
  // OpenAI
  { match: /gpt-5\.6/i, values: ["none", "low", "medium", "high", "xhigh", "max", "ultra"] },
  { match: /gpt-5\.3-codex/i, values: ["low", "medium", "high", "xhigh"] },
  { match: /gpt-5\.4-pro/i, values: ["medium", "high", "xhigh"] },
  { match: /gpt-5\.4/i, values: ["none", "low", "medium", "high", "xhigh"] },
  // Anthropic / xAI
  { match: /claude-(fable|opus|sonnet|mythos)-5/i, values: ["low", "medium", "high", "xhigh", "max"] },
  { match: /grok-4\.6/i, values: ["low", "medium", "high", "xhigh"] },
];

/** 认不出模型时用 OpenAI 的通用四档。 */
const FALLBACK_VALUES: readonly string[] = ["minimal", "low", "medium", "high"];

/** 由一串档位值构造列表（第一档固定是「默认」= 不下发）。 */
export function effortLevelsFromValues(values: readonly string[]): EffortLevel[] {
  return [toEffortLevel(""), ...values.filter(Boolean).map(toEffortLevel)];
}

/** 该模型支持的档位列表。第一档固定是「默认」（不下发 reasoning_effort）。 */
export function effortLevelsForModel(model?: string | null): EffortLevel[] {
  const name = model ?? "";
  const remote = remoteReasoningValues(name);
  if (remote) return effortLevelsFromValues(remote);
  const profile = MODEL_PROFILES.find((item) => item.match.test(name));
  return effortLevelsFromValues(profile ? profile.values : FALLBACK_VALUES);
}

export function effortIndex(value: string | null | undefined, levels: EffortLevel[]): number {
  const index = levels.findIndex((level) => level.value === (value ?? ""));
  return index < 0 ? 0 : index;
}

export function effortLabel(value: string | null | undefined, levels: EffortLevel[]): string {
  return levels[effortIndex(value, levels)].label;
}

export function effortFromIndex(index: number, levels: EffortLevel[]): string {
  const clamped = Math.min(Math.max(Math.round(index), 0), levels.length - 1);
  return levels[clamped].value;
}

/** 存下来的档位可能不属于当前模型（换过模型），这种要按「默认」处理。 */
export function isEffortValid(value: string | null | undefined, levels: EffortLevel[]): boolean {
  return levels.some((level) => level.value === (value ?? ""));
}
