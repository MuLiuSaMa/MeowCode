/**
 * 边界后的增量段：环境上下文 + 行为段。
 *
 * 位置刻意放在 instructions（AGENTS.md，稳定段）之后：这些字节不进前缀缓存，
 * 改它们不会让基线或项目指令的前缀失效；基线仍是 359 token 的那一段
 * （prompt-budget.test.ts 有硬上限，不要往里塞内容）。
 *
 * 只给主 Agent：子 Agent 有自己的角色契约（agent-definition.ts），再叠一份通用段
 * 等于每个子请求都多付一遍 token。
 */

export type EnvironmentFacts = {
  workspace: string;
  platform?: NodeJS.Platform;
  /** 会话当前档位；"default" 视为 ask */
  approvalMode?: string;
  /** 本地日期（YYYY-MM-DD）；缺省取今天 */
  today?: string;
  shell?: string;
};

const APPROVAL_LABELS: Record<string, string> = {
  "read-only": "read-only (no writes, no commands)",
  ask: "ask (writes and commands need approval)",
  default: "ask (writes and commands need approval)",
  auto: "auto (routine work runs, risky commands still ask)",
  full: "full access (no approvals)",
};

/** 环境一行流：模型不该靠猜知道自己在哪个目录、什么平台、什么审批档。 */
export function buildEnvironmentSegment(facts: EnvironmentFacts): string {
  const parts = [
    `workspace ${facts.workspace}`,
    facts.platform ?? process.platform,
    `shell ${facts.shell ?? "PowerShell"}`,
    `approval ${APPROVAL_LABELS[facts.approvalMode ?? "ask"] ?? facts.approvalMode}`,
    `today ${facts.today ?? today()}`,
  ];
  return `Environment: ${parts.join(" · ")}.`;
}

function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * 行为段：基线之外的「动作边界」。
 *
 * 每一条都对应参考实现（codex 的 general/editing constraints、cc-haha 的
 * "Executing actions with care" / "Doing tasks" / review mindset）里影响决策的那句，
 * 压到一行——不搬原文，只保留触发条件。
 */
export const BEHAVIOR_SEGMENT = `Working rules beyond the baseline:
- Risky or hard-to-reverse actions (force-push, deleting work you did not create, rewriting history, publishing or posting externally) need a go-ahead for that action in this conversation; local reversible work does not ask.
- The worktree may hold the user's unfinished changes: never revert them, and if files change in ways you did not cause, stop and ask before continuing.
- A request to review is a review, not a summary: findings first with severity and path:line, then open questions; when nothing is wrong, say so and name what you could not check.
- When something fails, read the error and fix the cause before switching tactics; repeating the same call unchanged is not a diagnosis.
- Keep update_plan current for work with several dependent steps; skip it for one-step tasks and never write a single-item plan.`;

/** 主 Agent 的增量段（顺序即字节顺序：行为段在前、环境段在后）。 */
export function buildAgentSegments(facts: EnvironmentFacts): string[] {
  return [BEHAVIOR_SEGMENT, buildEnvironmentSegment(facts)];
}
