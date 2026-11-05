import i18n from "i18next";
import type { SubagentType } from "./api";

/** 与 src/agent/agent-definition.ts 的 BUILTIN_AGENTS 同步的展示信息。 */
export const SUBAGENT_ROLE_KEYS = {
  general: "role.general",
  explore: "role.explore",
  planner: "role.planner",
  scoper: "role.scoper",
  "depth-prober": "role.depthProber",
  implementer: "role.implementer",
  reviewer: "role.reviewer",
  verifier: "role.verifier",
  "fresh-verifier": "role.freshVerifier",
  juror: "role.juror",
  sweeper: "role.sweeper",
  "goal-checker": "role.goalChecker",
  custom: "role.custom",
} as const satisfies Record<SubagentType, string>;

/**
 * 只读展示视图：取值时才查译文。
 *
 * 本次批次之外的消费点（TaskToolRow、panel/SubagentTab、panel/SubagentsTab 由并行批次负责）
 * 仍在按 `SUBAGENT_ROLE_LABELS[type]` 读取；在它们改成 `t(SUBAGENT_ROLE_KEYS[type])` 之前，
 * 这里保留同一形状，避免把未翻译的 key 直接显示给用户。模块加载期不调用 t()，
 * 因此切换语言后只要所在组件重渲染就会取到新译文。
 */
export const SUBAGENT_ROLE_LABELS: Readonly<Record<SubagentType, string>> = (() => {
  const labels = {} as Record<SubagentType, string>;
  for (const [role, key] of Object.entries(SUBAGENT_ROLE_KEYS) as Array<[SubagentType, string]>) {
    Object.defineProperty(labels, role, {
      enumerable: true,
      get: () => i18n.t(`chat:${key}`),
    });
  }
  return labels;
})();

/** 只读角色：子会话审批模式被强制为 read-only。 */
export const SUBAGENT_READ_ONLY: ReadonlySet<SubagentType> = new Set([
  "explore",
  "planner",
  "scoper",
  "depth-prober",
  "reviewer",
  "juror",
  "sweeper",
  "goal-checker",
]);
