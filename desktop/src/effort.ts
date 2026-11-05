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

import i18n from "i18next";
import type { TFunction } from "i18next";
import { remoteReasoningValues } from "./modelProfiles";

/** 档位值 → composer ns 的 key（与 ZCode 的文案表一致）。表里只存 key，禁止在模块顶层取译文。 */
const LEVEL_KEYS: Record<string, string> = {
  "": "effort.default",
  disabled: "effort.off",
  off: "effort.off",
  none: "effort.off",
  enabled: "effort.on",
  minimal: "effort.minimal",
  low: "effort.low",
  medium: "effort.medium",
  high: "effort.high",
  xhigh: "effort.xhigh",
  max: "effort.max",
  ultra: "effort.ultra",
};

export type EffortLevel = { value: string; label: string };

/**
 * 档位标签。传了组件的 `t` 就走它（随语言刷新）；没传时按当前界面语言现取，
 * 这样 `effortLevelsFrom*` 的老调用点不必逐个改签名。
 */
export function levelLabel(value: string, t?: TFunction): string {
  const key = LEVEL_KEYS[value];
  if (!key) return value;
  if (t) return t(key);
  return i18n.t(key, { ns: "composer" });
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
