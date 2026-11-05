import { describe, expect, it } from "vitest";
import type { PluginHookEventMap, PluginHookName, PluginHookResultMap } from "./types.js";

/**
 * hook 名单的契约测试。
 *
 * 事件名只存在于类型层，运行时无法枚举，所以这里维护一份显式名单，
 * 并用下面的编译期断言保证「新增了联合成员但忘了加名单」会直接编译失败 ——
 * 这是这套三张表（名字 / 事件 / 返回值）最容易漏同步的地方。
 */
const HOOK_NAMES = [
  "tool_call",
  "tool_result",
  "prompt_submit",
  "permission_request",
  "turn_start",
  "turn_stop",
  "turn_end",
  "session_start",
  "session_end",
  "session_info_changed",
  "model_switch",
  "subagent_start",
  "subagent_stop",
  "compaction_start",
  "compaction_end",
  "interrupt",
  "tool_execution_start",
  "tool_execution_end",
  "assistant_message_start",
  "assistant_message_end",
  "context_inject",
  "before_provider_request",
] as const satisfies readonly PluginHookName[];

/** 可改写 / 可阻断的事件：hooks.ts 的 transform switch 必须覆盖它们 */
const MUTATING_HOOKS: readonly PluginHookName[] = [
  "tool_call",
  "tool_result",
  "prompt_submit",
  "permission_request",
  "turn_stop",
  "context_inject",
  "before_provider_request",
];

type Covered = (typeof HOOK_NAMES)[number];
// 编译期穷尽：PluginHookName 里有但名单里漏掉时，Missing 不是 never → 赋值报错
const namesAreExhaustive: Exclude<PluginHookName, Covered> extends never ? true : false = true;
// 编译期：每个名字都能索引到事件类型与结果类型（两张表都齐全）
const eventMapComplete: { [N in PluginHookName]: PluginHookEventMap[N] } extends Record<
  PluginHookName,
  unknown
>
  ? true
  : false = true;
const resultMapComplete: { [N in PluginHookName]: PluginHookResultMap[N] } extends Record<
  PluginHookName,
  unknown
>
  ? true
  : false = true;
// 编译期：事件的 hook 字段必须与事件名一致（复制粘贴最容易错的地方）
const hookFieldsMatch: {
  [N in PluginHookName]: PluginHookEventMap[N]["hook"] extends N ? true : false;
} extends Record<PluginHookName, true>
  ? true
  : false = true;

describe("插件 hook 契约", () => {
  it("名单覆盖全部事件、无重复且数量与文档一致", () => {
    // 引用编译期断言，避免被 tree-shake 掉也顺便让 tsc 检查它们
    expect([namesAreExhaustive, eventMapComplete, resultMapComplete, hookFieldsMatch]).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(new Set(HOOK_NAMES).size).toBe(HOOK_NAMES.length);
    expect(HOOK_NAMES).toHaveLength(22);
  });

  it("可改写事件都属于名单，且观察类事件没被误列", () => {
    for (const name of MUTATING_HOOKS) {
      expect(HOOK_NAMES).toContain(name);
    }
    // 观察类不该出现在可改写名单里
    expect(MUTATING_HOOKS).not.toContain("tool_execution_start");
    expect(MUTATING_HOOKS).not.toContain("subagent_stop");
    expect(MUTATING_HOOKS).toHaveLength(7);
  });
});
