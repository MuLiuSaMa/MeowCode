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
import { reasoningLevelsForModel } from "../../src/agent/reasoning-catalog";
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

// 模型档位表已收敛到 `src/agent/reasoning-catalog.ts`：设置页下拉与推荐默认值
// 共用同一张表，避免"界面能选、请求被改写成别的档"（DeepSeek 只认 low/high/max）。
// 这里只保留远程同步（ZCode 内置配置更新后无需发版）与文案包装。

/** 由一串档位值构造列表（第一档固定是「默认」= 不下发）。 */
export function effortLevelsFromValues(values: readonly string[]): EffortLevel[] {
  return [toEffortLevel(""), ...values.filter(Boolean).map(toEffortLevel)];
}

/** 该模型支持的档位列表。第一档固定是「默认」（不下发 reasoning_effort）。 */
export function effortLevelsForModel(model?: string | null): EffortLevel[] {
  const name = model ?? "";
  const remote = remoteReasoningValues(name);
  if (remote) return effortLevelsFromValues(remote);
  return effortLevelsFromValues(reasoningLevelsForModel(name));
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
