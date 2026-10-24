import type { SubagentType } from "./api";

/** 与 src/agent/agent-definition.ts 的 BUILTIN_AGENTS 同步的展示信息。 */
export const SUBAGENT_ROLE_LABELS: Record<SubagentType, string> = {
  general: "通用",
  explore: "探索",
  planner: "规划",
  scoper: "范围界定",
  "depth-prober": "深挖",
  implementer: "实现",
  reviewer: "评审",
  verifier: "验证",
  "fresh-verifier": "独立复验",
  juror: "终审",
  sweeper: "收敛清扫",
  "goal-checker": "目标核对",
  custom: "自定义",
};

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
