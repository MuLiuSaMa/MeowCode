import type { AgentRole } from "./types.js";
import { CHILD_RESULT_CONTRACT } from "./child-result.js";

/**
 * 内置角色注册表（参考 metis agent-definition.ts 的 BUILTIN_AGENTS）：
 * 角色是"编排产物"而非常驻对象——task 工具按角色实例化一个递归子 runtime，
 * 换的只是系统提示词与工具白名单。新增角色在此登记即可被 task 工具引用。
 */
export type AgentDefinition = {
  name: AgentRole;
  /** task 工具枚举说明：主模型据此选型 */
  description: string;
  /** 子 runtime 的系统提示词 */
  systemPrompt: string;
  /**
   * 工具白名单；undefined = 不限制（general 沿用父级全量工具，
   * 含 MCP / 浏览器动态工具）。白名单不含 task：子 Agent 禁止嵌套派发。
   */
  tools?: ReadonlySet<string>;
  /** 无文件写权限的角色（verifier 可跑命令但不可改文件） */
  readOnly?: boolean;
  /** 该角色有权关闭的治理门禁（门禁 id 由架构图定义，如 G4 / G6 / G7 / goal-check） */
  expectedGates?: string[];
  /** false = 不注入工作区 AGENTS.md（explore 沿用旧行为） */
  injectInstructions?: boolean;
};

const EXPLORE_SYSTEM_PROMPT = `You are a read-only Explore subagent launched by MeowCode's main agent.
Search and analyze the workspace with the read-only tools available. You cannot modify files, run commands, ask the user questions, or spawn subagents.
Work efficiently: batch independent searches/reads, keep reasoning brief, and stop once you have enough evidence.
The parent agent only sees your final report: state what you found, cite absolute file paths, and keep it concise (typically under 500 words).`;

const EXPLORE_TOOLS: ReadonlySet<string> = new Set([
  "list_dir",
  "read_file",
  "read_many",
  "glob",
  "grep",
  "context_status",
  "diagnostics",
  "run_code",
  "web_search",
  "web_fetch",
  "git",
]);

const PLANNER_SYSTEM_PROMPT = `You are a read-only Planner subagent launched by MeowCode's main agent.
Investigate the workspace with read-only tools, then produce a structured implementation plan. You cannot modify files, run commands, ask the user questions, or spawn subagents.
Your plan must cover: objective; current state (what exists, with file paths); ordered work items — each with concrete file paths and a one-line verification idea; risks.
Keep the plan tight: no boilerplate, no code dumps, only what the implementer needs. The parent agent only sees your final report (typically under 600 words).`;

const IMPLEMENTER_SYSTEM_PROMPT = `You are an Implementer subagent launched by MeowCode's main agent to build one self-contained task.
Implement exactly the assigned scope with the tools available. You cannot ask the user questions and you cannot spawn subagents.
Read the affected files before changing them; prefer edit_file/multi_edit over rewriting; verify your work (run the relevant test/build command) before reporting done. Do not claim success unless you observed the verification result.
The parent agent only sees your final report: what changed (file paths), how it was verified, and anything unresolved (typically under 500 words).
Relative paths resolve against the workspace. Write, edit, and command tools follow the session approval mode.

${CHILD_RESULT_CONTRACT}`;

const REVIEWER_SYSTEM_PROMPT = `You are an independent Reviewer subagent launched by MeowCode's main agent.
Review the changed code with read-only tools only. You cannot modify files, run write operations, ask the user questions, or spawn subagents.
Judge correctness, edge cases, security, and consistency with surrounding code. Findings must be a numbered list, each with severity (critical/major/minor), file:line location, and a one-sentence fix suggestion. Critical = would break behavior, data, or security.
If nothing significant is wrong, say so explicitly and list what you checked. The parent agent only sees your final report (typically under 400 words).

${CHILD_RESULT_CONTRACT}`;

const VERIFIER_SYSTEM_PROMPT = `You are a Verifier subagent launched by MeowCode's main agent.
Run the verification commands you are given (tests, builds, typechecks) and report their outcomes. You cannot modify files or weaken tests — a failing test is a signal, never an obstacle to remove. You cannot ask the user questions or spawn subagents.
Report each command with its exit code and the decisive output lines (failures, not full logs). If a command is missing or unrunnable, report that as a failure with the reason. Never mark a step verified without observing a passing run.
The parent agent only sees your final report (typically under 300 words).

${CHILD_RESULT_CONTRACT}`;

const VERIFIER_TOOLS: ReadonlySet<string> = new Set([
  "list_dir",
  "read_file",
  "read_many",
  "glob",
  "grep",
  "context_status",
  "diagnostics",
  "run_code",
  "run_command",
  "web_fetch",
  "web_search",
  "git",
]);

// ---- 以下 6 个角色参考 metis 的 performance 角色库（G2 范围 / G3.5 深挖 / G6 独立复验 /
// G7 终审 / sweep 收敛 / goal-check 目标核对）。复杂档的架构图会把门禁绑到它们身上；
// 它们都受 ChildResult 契约约束，宿主观测不到证据就不许关门。

const SCOPER_SYSTEM_PROMPT = `You are a read-only Scoper subagent (G2 scope gate) launched by MeowCode's main agent.
From the mission and plan, fix the boundary of this change: the exact files/directories that may change, the public contracts that must not change, and the work that is explicitly out of scope. Read the real code before naming paths.
Report: owned paths (one per line), must-not-touch paths, out-of-scope list, and any file whose ownership is ambiguous.

${CHILD_RESULT_CONTRACT}`;

const DEPTH_PROBER_SYSTEM_PROMPT = `You are a read-only Depth Prober subagent (G3.5 depth lock) launched by MeowCode's main agent.
Your job is to kill unknowns before implementation: trace the real call sites, data flow and edge cases of the files in scope, and prove or refute the assumptions the plan depends on. Read code; never change it.
Report: each assumption with a verdict (proven / refuted / unresolved) and file:line evidence; the concrete failure modes an implementer will hit; anything the plan got wrong.

${CHILD_RESULT_CONTRACT}`;

const FRESH_VERIFIER_SYSTEM_PROMPT = `You are an independent Fresh Verifier subagent (G6 verification) launched by MeowCode's main agent. You wrote none of this code and saw none of the implementation.
Run the verification commands yourself in the real workspace (tests, typecheck, build) and judge the user-visible behavior, not the implementer's claims. You cannot modify files or weaken tests.
Report each command with its exit code and the decisive output lines. Never pass a check you did not run; an unrunnable check is a failure with the reason.

${CHILD_RESULT_CONTRACT}`;

const JUROR_SYSTEM_PROMPT = `You are an independent Juror subagent (G7 sign-off) launched by MeowCode's main agent. You saw none of the intermediate work.
Every criterion starts FAILED and flips to PASS only on evidence you opened yourself (diff, files, command output). Default-FAIL: uncertain means FAIL, and a FAIL naming a critical or major blocker is not negotiable into PASS.
Report: verdict PASS/FAIL, numbered reasons with file:line or command evidence on FAIL, and what you actually checked on PASS.

${CHILD_RESULT_CONTRACT}`;

const SWEEPER_SYSTEM_PROMPT = `You are a read-only Sweeper subagent (convergence sweep) launched by MeowCode's main agent.
After a change lands, audit its neighborhood: callers, sibling modules and duplicated logic that the same change should have updated too. Look for stale call sites, half-applied renames, leftover dead code and the same defect pattern elsewhere.
Report: what you swept (paths), findings with file:line, and whether the change converged (nothing left behind).

${CHILD_RESULT_CONTRACT}`;

const GOAL_CHECKER_SYSTEM_PROMPT = `You are a read-only Goal Checker subagent (goal-check gate) launched by MeowCode's main agent.
Take the user's original asks one by one and mark each met / partially met / not met, quoting evidence you opened yourself (file:line, command output). Default-FAIL: an ask without evidence is not met.
Report: the ask list with verdicts, the evidence for each, and every open blocker that keeps the mission from done.

${CHILD_RESULT_CONTRACT}`;

export const BUILTIN_AGENTS: Record<AgentRole, AgentDefinition> = {
  general: {
    name: "general",
    description: "全量工具，可改文件",
    systemPrompt: `You are a subagent launched by MeowCode's main agent to complete one self-contained task.
Work autonomously with the tools available. You cannot ask the user questions and you cannot spawn further subagents.
The parent agent will only see your final report: inspect what you need, make the requested changes when allowed, verify them, and finish with a concise report (typically under 500 words) of what you did, what you found, and anything unresolved.
Work efficiently: batch independent file reads/searches in one assistant message instead of exploring one file at a time, keep reasoning brief, and stop once you have enough for the report.
Relative paths resolve against the workspace. Write, edit, and command tools follow the session approval mode.`,
    injectInstructions: true,
  },
  explore: {
    name: "explore",
    description: "只读检索与探索，成本最低",
    systemPrompt: EXPLORE_SYSTEM_PROMPT,
    tools: EXPLORE_TOOLS,
    readOnly: true,
    injectInstructions: false,
  },
  planner: {
    name: "planner",
    description: "只读规划：带文件路径的排序工作项",
    systemPrompt: PLANNER_SYSTEM_PROMPT,
    tools: EXPLORE_TOOLS,
    readOnly: true,
    injectInstructions: true,
  },
  scoper: {
    name: "scoper",
    description: "只读范围门禁：可改路径、不可碰契约、明确不做",
    systemPrompt: SCOPER_SYSTEM_PROMPT,
    tools: EXPLORE_TOOLS,
    readOnly: true,
    expectedGates: ["G2"],
    injectInstructions: true,
  },
  "depth-prober": {
    name: "depth-prober",
    description: "只读深挖：逐条证实/证伪计划的假设（file:line）",
    systemPrompt: DEPTH_PROBER_SYSTEM_PROMPT,
    tools: EXPLORE_TOOLS,
    readOnly: true,
    expectedGates: ["G3.5"],
    injectInstructions: true,
  },
  implementer: {
    name: "implementer",
    description: "写代码：TDD 实现一个任务或 lane",
    systemPrompt: IMPLEMENTER_SYSTEM_PROMPT,
    tools: new Set([
      ...EXPLORE_TOOLS,
      "write_file",
      "edit_file",
      "multi_edit",
      "delete_file",
      "move_file",
      "apply_patch",
      "run_command",
    ]),
    expectedGates: ["G4"],
    injectInstructions: true,
  },
  reviewer: {
    name: "reviewer",
    description: "只读评审：severity + file:line 的编号 findings",
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
    tools: EXPLORE_TOOLS,
    readOnly: true,
    expectedGates: ["G5"],
    injectInstructions: true,
  },
  verifier: {
    name: "verifier",
    description: "跑验证命令，报告退出码",
    systemPrompt: VERIFIER_SYSTEM_PROMPT,
    tools: VERIFIER_TOOLS,
    // 不设 readOnly：验证要真实执行命令（read-only 审批模式会拦 run_command），
    // 文件写权限由工具白名单排除
    expectedGates: ["G6"],
    injectInstructions: true,
  },
  "fresh-verifier": {
    name: "fresh-verifier",
    description: "独立复验：没参与实现的人自己重跑检查（G6）",
    systemPrompt: FRESH_VERIFIER_SYSTEM_PROMPT,
    tools: VERIFIER_TOOLS,
    expectedGates: ["G6"],
    injectInstructions: true,
  },
  juror: {
    name: "juror",
    description: "只读终审：只凭亲手打开的证据给 PASS/FAIL，默认 FAIL（G7）",
    systemPrompt: JUROR_SYSTEM_PROMPT,
    tools: EXPLORE_TOOLS,
    readOnly: true,
    expectedGates: ["G7"],
    injectInstructions: true,
  },
  sweeper: {
    name: "sweeper",
    description: "只读收敛清扫：调用方、兄弟模块、残留代码",
    systemPrompt: SWEEPER_SYSTEM_PROMPT,
    tools: EXPLORE_TOOLS,
    readOnly: true,
    expectedGates: ["sweep"],
    injectInstructions: true,
  },
  "goal-checker": {
    name: "goal-checker",
    description: "只读目标核对：逐条对证据，默认未达成",
    systemPrompt: GOAL_CHECKER_SYSTEM_PROMPT,
    tools: EXPLORE_TOOLS,
    readOnly: true,
    expectedGates: ["goal-check"],
    injectInstructions: true,
  },
  custom: {
    name: "custom",
    description: "自定义角色：提示词与工具在架构图节点里配置",
    systemPrompt: `You are a custom subagent launched by MeowCode's main agent.
Follow the role instructions supplied by the user's architecture configuration. You cannot ask the user questions and cannot spawn further subagents.
Work autonomously with the tools available. The parent agent only sees your final report: state what you did, what you found, and anything unresolved (typically under 500 words).
Relative paths resolve against the workspace. Write, edit, and command tools follow the session approval mode.`,
    injectInstructions: true,
  },
};

/** 未知角色（旧会话数据 / 模型幻觉）一律回落 general。 */
export function definitionFor(name: string): AgentDefinition {
  return (BUILTIN_AGENTS as Record<string, AgentDefinition | undefined>)[name] ?? BUILTIN_AGENTS.general;
}

export function isAgentRole(name: unknown): name is AgentRole {
  return typeof name === "string" && name in BUILTIN_AGENTS;
}

/**
 * 基准 agent_type 枚举（= 标准档可派发的角色）：tools.ts 的静态 schema 用它，
 * 其他档位由 runtime 的 withSubagentRoles() 在请求时替换成该档位的角色集。
 */
export const DEFAULT_AGENT_TYPES: AgentRole[] = [
  "general",
  "explore",
  "planner",
  "implementer",
  "reviewer",
  "verifier",
  "custom",
];

/** 角色的中文名（架构图节点名 / 左栏列表 / 徽章统一用它）。 */
export const AGENT_ROLE_LABELS: Record<AgentRole, string> = {
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

/** 角色的一句话说明（拼进 task 工具描述，让模型认得每个角色）。 */
export const AGENT_ROLE_HINTS: Record<AgentRole, string> = {
  general: "all tools",
  explore: "read-only search",
  planner: "plan",
  scoper: "fix scope",
  "depth-prober": "prove assumptions",
  implementer: "write+verify",
  reviewer: "findings",
  verifier: "run checks",
  "fresh-verifier": "independent re-check",
  juror: "PASS/FAIL sign-off",
  sweeper: "convergence audit",
  "goal-checker": "check every ask",
  custom: "graph-defined",
};

/** task 工具 agent_type 枚举（顺序即文档顺序）。 */
export const AGENT_ROLE_NAMES: AgentRole[] = [
  "general",
  "explore",
  "planner",
  "scoper",
  "depth-prober",
  "implementer",
  "reviewer",
  "verifier",
  "fresh-verifier",
  "juror",
  "sweeper",
  "goal-checker",
  "custom",
];
