import { AGENT_ROLE_NAMES } from "./agent-definition.js";
import type { AgentProfileId, AgentRole } from "./types.js";

/**
 * 主 Agent 档位注册表（会话级）：一个档位决定根 runtime 的四件事——
 * 主提示词、可用工具白名单、可派发的子 Agent 角色白名单、并发子 Agent 上限。
 *
 * 参考 deepseek-harness 的 agent preset（`presets/minimal.patch.yml`）：
 * 极简档只挂"看图 + 持久 shell"两个工具，其余能力靠 shell 自己拼；
 * 这里对应 read_file（文本/图片）+ run_command（PowerShell 读写文件）。
 *
 * task / admit 是编排通道而非干活工具：任何档位都保留，只按档位收紧 task 的
 * agent_type 枚举（见 runtime 的 activeTools / beginSubagent）。
 */

export type AgentProfileDefinition = {
  id: AgentProfileId;
  /** 展示名（Composer 胶囊 / 架构页菜单） */
  name: string;
  /** 一行说明（弹层副标题） */
  tagline: string;
  /** 详细说明（架构页详情） */
  description: string;
  /** 根 runtime 的主提示词 */
  prompt: string;
  /** task 可派发的角色白名单；顺序即 agent_type 枚举顺序 */
  roles: readonly AgentRole[];
  /** 主 Agent 工具白名单；null = 全量（task / admit 始终放行） */
  tools: ReadonlySet<string> | null;
  /** 单回合并发子 Agent 上限 */
  maxSubagents: number;
};

/** 标准档提示词：即原来的 BASE_SYSTEM_PROMPT，逐字保留（prompt-budget 有 token 断言）。 */
export const BASE_SYSTEM_PROMPT = `You are MeowCode, a practical local coding agent on Windows.
Read files before changing them. Change existing files with edit_file or multi_edit (batch changes in one multi_edit) instead of rewriting with write_file. A successful edit returns the changed lines — do not re-read to verify.
Use glob and grep before listing directories or guessing paths. Prefer one read_many call for several files, and one run_code call for multi-file search/aggregation — only its return value is billed.
Relative paths resolve against the workspace; absolute paths need full-access mode.
Default mode asks before writes/edits/commands; full-access runs every tool without prompts.
Do not claim success unless you observed the tool result.
Keep answers concise: ≤10 lines unless asked; 2-5 sentences or ≤6 bullets; cite paths and line numbers; no full-file or before/after code dumps.
In write/edit calls put "path" first and long content after (the UI streams the target first).
Default to batching: put every independent read/search/test command in ONE assistant message; for multi-project work prefer one run_code loop or one run_command that runs all suites and prints exit codes over one project per turn.
Delegate multi-file exploration, cross-project comparison, or independent edits to 1-3 subagents (task); choose agent_type: explore/planner read-only, implementer edits, reviewer reviews, verifier checks, general mixed. Keep quick or coupled work in the main agent.
When goal-mode gating is active, call admit first (T0 trivial / T1 single lane / T2 parallel lanes); close each lane through the gates your architecture graph defines (lane_id) before claiming completion.`;

/** 极简档：两个干活工具，一切读写都走 PowerShell。 */
const MINIMAL_SYSTEM_PROMPT = `You are MeowCode in minimal mode, a small local coding agent on Windows.
You have exactly two working tools: read_file (text and images) and run_command (PowerShell).
Do all searching and editing through them: Select-String / Get-ChildItem to search, Get-Content with -TotalCount or -Tail for slices, Set-Content / Out-File / a here-string to write files. There is no write_file or edit_file.
Relative paths resolve against the workspace; default mode asks before commands.
Delegate only to explore (read-only research) or general (one self-contained task) when the work is broad; otherwise do it yourself.
Do not claim success unless you observed the command output. Keep answers short: ≤10 lines, cite paths, no full-file dumps.`;

/** 复杂档：标准提示词 + 编排要求（不改变权限与门禁，只改工作方式）。 */
const COMPLEX_SYSTEM_PROMPT = `${BASE_SYSTEM_PROMPT}

Complex mode is active (gated governance): prefer structure over speed.
Turn non-trivial work into ordered lanes with concrete file paths (planner subagent when scope is unclear, update_plan to keep the lane list current).
The architecture graph is the source of truth for gates: T1 runs G0 baseline → G4 implement → G5 review → G6 fresh verification → goal-check; T2 runs G0 → G1 plan → G2 scope → G3.5 depth lock → G4 → G5 → G6 → G7 sign-off → sweep → goal-check. Dispatch exactly the role each gate names (verifier/planner/scoper/depth-prober/implementer/reviewer/fresh-verifier/juror/sweeper/goal-checker) and never close a gate yourself.
Independent roles must be fresh: never let the implementer review its own diff, and never let the same agent close two gates of one lane. Never weaken a failing test; a regression is a signal.
Merge conflicts, repeated gate failures, or a lane that keeps growing go back to planning instead of being patched around.`;

/** 标准档默认可派发的角色：通用 / Explore / 规划 + 三道门禁角色 + 自定义。 */
const STANDARD_ROLES: readonly AgentRole[] = [
  "general",
  "explore",
  "planner",
  "implementer",
  "reviewer",
  "verifier",
  "custom",
];

/** 标准档的并发默认值：参考 Metis 的并发上限与 Codex v2 的默认线程配额。 */
export const MAX_SUBAGENTS_PER_TURN = 3;

export const AGENT_PROFILES: Record<AgentProfileId, AgentProfileDefinition> = {
  standard: {
    id: "standard",
    name: "标准 Agent",
    tagline: "完整能力：全量工具 + 全部子 Agent",
    description:
      "MeowCode 的默认主 Agent：全量工具、全部子 Agent 角色按需派发，单回合最多 3 个子 Agent。",
    prompt: BASE_SYSTEM_PROMPT,
    roles: STANDARD_ROLES,
    tools: null,
    maxSubagents: MAX_SUBAGENTS_PER_TURN,
  },
  minimal: {
    id: "minimal",
    name: "极简 Agent",
    tagline: "只有 read_file + run_command，自己动手",
    description:
      "极简主 Agent：只保留 read_file 与 run_command（PowerShell 读写文件），子 Agent 仅 general / explore，单回合最多 1 个。省 token、链路短，但没有逐文件 diff 审阅。",
    prompt: MINIMAL_SYSTEM_PROMPT,
    roles: ["general", "explore"],
    tools: new Set(["read_file", "run_command"]),
    maxSubagents: 1,
  },
  complex: {
    id: "complex",
    name: "复杂 Agent",
    tagline: "先规划，再并行实现，逐关评审验证",
    description:
      "复杂主 Agent：全量工具 + 13 个子 Agent 角色（含范围界定 / 深挖 / 独立复验 / 终审 / 收敛清扫 / 目标核对），架构图跑 G0→G1→G2→G3.5→G4→G5→G6→G7→sweep→goal-check 十道门禁，单回合最多 5 个子 Agent。",
    prompt: COMPLEX_SYSTEM_PROMPT,
    roles: AGENT_ROLE_NAMES,
    tools: null,
    maxSubagents: 5,
  },
};

export const AGENT_PROFILE_IDS: AgentProfileId[] = ["standard", "minimal", "complex"];

/** 未知档位（旧会话 / 旧客户端 / 模型幻觉）一律回落 standard。 */
export function normalizeAgentProfile(value: unknown): AgentProfileId {
  return isAgentProfile(value) ? value : "standard";
}

export function isAgentProfile(value: unknown): value is AgentProfileId {
  return value === "standard" || value === "minimal" || value === "complex";
}

export function agentProfileFor(id: AgentProfileId): AgentProfileDefinition {
  return AGENT_PROFILES[id] ?? AGENT_PROFILES.standard;
}

/** task / admit 是编排通道：档位收紧工具时不裁掉它们（agent_type 另行收紧）。 */
export const PROFILE_ALWAYS_ALLOWED_TOOLS: ReadonlySet<string> = new Set(["task", "admit"]);

/** 该档位是否允许某个工具（不含编排通道放行；调用方自行叠加）。 */
export function profileAllowsTool(
  profile: AgentProfileDefinition,
  tool: string,
): boolean {
  if (profile.tools === null) return true;
  return PROFILE_ALWAYS_ALLOWED_TOOLS.has(tool) || profile.tools.has(tool);
}
