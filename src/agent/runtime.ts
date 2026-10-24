import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { assessCommandRisk } from "./command-risk.js";
import {
  COMPACTION_KEEP_RECENT_TOKENS,
  createCompactionSummary,
  isContextOverflow,
  summarizeToolOutputs,
} from "./compaction.js";
import { previewDiff, renderDiff } from "./diff.js";
import {
  buildFileMentionContext,
  collectInjectedPaths,
  mentionPathKey,
  mentionTokenBudget,
  referenceLabel,
  stripReferenceHeader,
} from "./file-mentions.js";
import { loadWorkspaceInstructions } from "./instructions.js";
import { isAbortError } from "./http.js";
import { resolveOutputBudget } from "./output-budget.js";
import { canReplayNativeCompaction, nativeCompactionMode, requestNativeCompaction } from "./native-compaction.js";
import { multiEditPaths, readMultiEditGroups } from "./multi-edit.js";
import { displayPath, isWithinWorkspace, resolveToolPath, resolveWithinWorkspace } from "./paths.js";
import { captureVersion } from "./read-state.js";
import { SessionStore, listSessions, sessionFileName, type SessionSummary } from "./session-store.js";
import { recoverSession } from "./session-recovery.js";
import {
  executeTool,
  isDynamicToolRequiringApproval,
  listDynamicToolDefinitions,
  toolDefinitions,
  admitToolDefinition,
  truncateOutput,
  READ_MANY_MAX_PATHS,
  type ToolRunOptions,
} from "./tools.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { runHook } from "../plugins/hooks.js";
import { loadVerifyConfig, runVerification } from "./verify.js";
import { type BrowserHostClient } from "./browser-host.js";
import { browserToolDefinitions, executeBrowserTool, isBrowserTool } from "./browser-tools.js";
import { streamChatCompletion } from "./provider.js";
import { sessionAffinityKey, resolveCachePlan } from "./cache-profile.js";
import { failoverReason, planFallbacks } from "./provider-fallback.js";
import { boostEffort } from "./thinking-budget.js";
import { projectForRequest } from "./request-projection.js";
import { toResponsesInput } from "./responses.js";
import type { ToolCallProgress } from "./tool-progress.js";
import { generateSessionTitle } from "./title-generator.js";
import { generateCommitMessage, type CommitContext } from "./commit-message.js";
import {
  collectOldToolOutputs,
  clampOutputTokens,
  estimateContextTokens,
  estimateMessagesTokens,
  estimateRequestInputTokens,
  estimateTokens,
  estimateToolDefinitionsTokens,
  repairToolPairs,
  shouldRecommendCompaction,
  shrinkToolOutputs,
  trimMessages,
  type ContextUsageAnchor,
} from "./context.js";
import {
  READ_ONLY_PARALLEL_TOOLS,
  runAgentLoop,
  type AgentLoopHost,
  type AgentLoopHooks,
  type ToolResultMessage,
} from "./agent-loop.js";
import { AGENT_ROLE_HINTS, definitionFor, isAgentRole } from "./agent-definition.js";
import {
  BASE_SYSTEM_PROMPT,
  agentProfileFor,
  normalizeAgentProfile,
  profileAllowsTool,
} from "./agent-profiles.js";
import {
  buildChildResult,
  renderChildResult,
  CHILD_RESULT_ROLES,
  type ChildResult,
} from "./child-result.js";
import {
  GOVERNANCE_GATED_TOOLS,
  WorkflowRuntime,
  type GovernanceMode,
} from "./workflow-runtime.js";
import { loadHarnessDocument } from "./harness-document.js";
import {
  isApprovalMode,
  normalizeApprovalMode,
  isSessionMode,
  normalizeSessionMode,
  type AgentProfileId,
  type ApprovalMode,
  type ApprovalModeInput,
  type ChatMessage,
  type CommandRisk,
  type MeowEvent,
  type NativeCompactionPayload,
  type PendingApproval,
  type PlanStep,
  type ProviderConfig,
  type SessionMode,
  type SubagentStatus,
  type SubagentType,
  type ToolCall,
  type ToolDefinition,
  type ToolDocument,
  type ToolImage,
  type TurnStatus,
  type UsageSummary,
} from "./types.js";

export type { ApprovalMode, SessionMode } from "./types.js";

export { BASE_SYSTEM_PROMPT };

const PLAN_CONTEXT_PREFIX = "Runtime context: current task plan";
const SUBAGENT_PARENT_GOAL_MAX_CHARS = 1500;

/** 计划快照文本：工具结果与压缩后的上下文 note 共用同一渲染。 */
function renderPlan(plan: { steps: PlanStep[]; explanation?: string }): string {
  return plan.steps
    .map((step, index) => `${index + 1}. [${step.status}] ${step.title}`)
    .join("\n");
}

function clipText(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function lastUserMessage(session: SessionStore): string | undefined {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message.role === "user" && typeof message.content === "string" && message.content.trim()) {
      return message.content;
    }
  }
  return undefined;
}

/**
 * prompt 可选：主 Agent 只给一句 description 时，自动补当前用户请求与计划。
 * 这样主模型不必为每个子 Agent 生成长篇 prompt，派发更快、更省输出 token。
 */
function buildSubagentPrompt(input: {
  description: string;
  parentGoal?: string;
  plan?: { steps: PlanStep[]; explanation?: string } | null;
}): string {
  const parts: string[] = [];
  if (input.parentGoal) {
    parts.push(`Current user request:\n${clipText(input.parentGoal, SUBAGENT_PARENT_GOAL_MAX_CHARS)}`);
  }
  if (input.plan?.steps.length) {
    parts.push(`Current plan:\n${renderPlan(input.plan)}`);
  }
  parts.push(`Your assigned task:\n${input.description}`);
  parts.push("Only handle this assigned part; other agents may cover the rest.");
  return parts.join("\n\n");
}

// 子 Agent 角色注册表在 agent-definition.ts：系统提示词、工具白名单、gate 绑定
// （原 general/explore 提示词已随注册表迁移）

/** 每回合默认最多派发 3 个子 Agent（standard 档）：真源在 agent-profiles.ts。 */
export { MAX_SUBAGENTS_PER_TURN } from "./agent-profiles.js";

/** 宿主续命上限：治理 run 活跃而模型停止回答时，最多强制继续 2 次。 */
export const MAX_WORKFLOW_CONTINUATIONS = 2;

/**
 * 计划模式指令：追加在稳定前缀之后（第三/第四条 system 消息），
 * 因为会话模式在回合间变化，放在末尾才不会破坏可缓存前缀。
 */
const PLAN_MODE_PROMPT = `Plan mode is active for this session.
Research first with read-only tools (list_dir, read_file, glob, grep, browser reads). Do not run commands.
Then write the implementation plan as a markdown document under the workspace plans/ directory (for example plans/2026-10-17-short-slug.md). Cover: goal, current state, step-by-step changes with concrete file paths, risks, and how to verify.
Plan mode only allows writing files under plans/: any other write, every command, and every subagent call is rejected. Keep writes focused on the plan document itself.
After the plan document is written, stop and tell the user where it is. The app shows a confirmation panel; implementation starts only after the user confirms. Do not implement anything in this mode.`;

/** 目标模式指令：只调工作方式，不改权限；治理层（admit/gates）在此模式强制生效。 */
const GOAL_MODE_PROMPT = `Goal mode is active for this session. Keep working autonomously toward the user's goal across multiple steps until it is fully done.
Start by calling admit to declare the task shape (T0 trivial / T1 single lane / T2 parallel lanes); mutating tools stay gated until then. Record the steps with update_plan and keep that plan current.
Work lane by lane: implement (yourself or via an implementer subagent), then close every gate in the order your architecture graph defines, dispatching exactly the role each gate names (G4 implement → G5 review → G6 verification, plus the extra gates your graph adds). Never weaken a failing test — a regression is a signal.
Stop only when every lane has passed G6 (the run completes itself), or you are blocked on a decision that truly needs the user. When stopping, state what is done, what remains, and what you need.`;

const APPROVAL_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "run_command"]);

/** 桌面端技能 chip 的固定前缀：命中时该回合按完全访问执行，技能不受会话权限模式约束。 */
const SKILL_REFERENCE_PREFIX = "【技能引用】";

/** 首部引用块（空行之前）里任一行以技能引用开头：支持一条消息挂多个技能 */
function hasSkillReference(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("【")) return false;
  const head = trimmed.split("\n\n", 1)[0];
  return head.split("\n").some((line) => line.startsWith(SKILL_REFERENCE_PREFIX));
}

/** 浏览器写操作始终审批；外站导航也审批，本地页面预览保持直接执行 */
const BROWSER_APPROVAL_TOOLS = new Set(["browser_click", "browser_type"]);

function isLocalBrowserUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "about:") return true;
    return ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"].includes(
      parsed.hostname.toLowerCase(),
    );
  } catch {
    return false;
  }
}

// READ_ONLY_PARALLEL_TOOLS / PRUNE_TRIGGER_RATIO / clampOutputTokens /
// estimateRequestInputTokens 已随薄循环抽到 agent-loop.ts 与 context.ts（循环与宿主共用）

/**
 * 循环检测（P1-2）：同一回合内「参数完全相同 且 输出逐字节相同」的连续工具调用。
 * 双条件缺一不可 —— edit 之后用相同参数重读同一文件是合法流程（文件变了输出就变，
 * 不会计数）；只有确定性工具返回相同输出时，重复调用才是零信息浪费。
 * 阈值参考 dsh repeat-tool-reminder 的 3/5/8 分级。
 */
const LOOP_REMIND_AT = 3;
const LOOP_WARN_AT = 5;
const LOOP_BLOCK_AT = 8;

type LoopState = { key: string; outputHash: string; count: number };

/** 稳定 JSON 序列化：键排序后拼接，避免模型换键序导致判重失效。 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([field, item]) => `${JSON.stringify(field)}:${stableJson(item)}`).join(",")}}`;
}

/** Windows 路径大小写不敏感；其余平台按原样比较。 */
function sameFilePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** FNV-1a 指纹：循环状态里不存全文，只存 32 位哈希。 */
function outputFingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

const LOOP_REMINDER_3 =
  "[meowcode] Note: this exact call (same tool and arguments) has already returned an identical result 3 times in a row. The output is deterministic — repeating it adds nothing. Change the arguments or move on.";
const LOOP_REMINDER_5 =
  "[meowcode] Warning: 5th identical call in a row with identical output. You are in a loop. Use a different tool, different arguments, or summarize what you have and continue the task.";
const loopBlockedOutput = (tool: string, count: number): string =>
  `Blocked: ${tool} has been called with identical arguments and returned identical output ${count} times in a row. Repeating it is wasteful and it will not be executed again. Change the arguments (different offset/pattern/path) or take a different approach.`;

type ToolArgumentSpec = { required: string[]; nonEmpty: string[] };

type LiveSubagent = {
  runtime: AgentRuntime;
  parentSessionId: string;
  callId: string;
  description: string;
  agentType: SubagentType;
  background: boolean;
  startedAt: string;
  startedAtMs: number;
};

type StartedSubagent = {
  agentId: string;
  description: string;
  background: boolean;
  completion: Promise<SubagentTaskResult>;
};

type SubagentTaskResult = {
  output: string;
  ok: boolean;
  status: SubagentStatus;
  error?: string;
  usage?: UsageSummary;
  /** 契约角色的宿主校验结果（implementer/reviewer/verifier），治理层关 gate 用 */
  childResult?: ChildResult;
};

/**
 * 子 Agent 的宿主观测记录（ChildResult 的 ground truth）：
 * 文件改动来自 onFileChange 回写，命令来自子事件流里的 run_command 起止对。
 */
type SubagentObservations = {
  filesChanged: Set<string>;
  commands: Array<{ argv: string; exitCode: number }>;
  pendingCommands: Map<string, string>;
};

/** 必填参数校验：参数不完整时绝不落盘/执行，按工具错误回给模型。 */
const TOOL_ARGUMENTS: Record<string, ToolArgumentSpec> = {
  read_file: { required: ["path"], nonEmpty: ["path"] },
  glob: { required: ["pattern"], nonEmpty: ["pattern"] },
  grep: { required: ["pattern"], nonEmpty: ["pattern"] },
  run_code: { required: ["code"], nonEmpty: ["code"] },
  write_file: { required: ["path", "content"], nonEmpty: ["path"] },
  edit_file: { required: ["path", "oldString", "newString"], nonEmpty: ["path", "oldString"] },
  run_command: { required: ["command"], nonEmpty: ["command"] },
  browser_navigate: { required: ["url"], nonEmpty: ["url"] },
  browser_click: { required: ["ref"], nonEmpty: ["ref"] },
  browser_type: { required: ["text"], nonEmpty: ["text"] },
  task: { required: ["description"], nonEmpty: ["description"] },
  admit: { required: ["tier", "task_shape"], nonEmpty: ["tier", "task_shape"] },
};

/** 门禁拦截事件的 input 回显：尽力解析参数，解析失败给空对象 */
function safeToolInput(call: ToolCall): unknown {
  try {
    return JSON.parse(call.function.arguments || "{}");
  } catch {
    return {};
  }
}

function validateToolArguments(
  tool: string,
  raw: string | undefined,
): { ok: true; input: unknown } | { ok: false; error: string } {
  const text = (raw ?? "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text || "{}");
  } catch {
    return { ok: false, error: "tool arguments are not valid JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "tool arguments must be a JSON object." };
  }
  const args = parsed as Record<string, unknown>;
  // multi_edit 支持跨文件：path 可以在顶层，也可以挂在每条 edit 上
  if (tool === "multi_edit") {
    const groups = readMultiEditGroups(args);
    if (typeof groups === "string") return { ok: false, error: groups };
    return { ok: true, input: args };
  }
  // read_many 的 paths 是字符串数组：单独校验（TOOL_ARGUMENTS 只覆盖字符串字段）
  if (tool === "read_many") {
    const paths = args.paths;
    if (!Array.isArray(paths) || paths.length === 0) {
      return { ok: false, error: 'argument "paths" must be a non-empty array of file paths.' };
    }
    if (paths.length > READ_MANY_MAX_PATHS) {
      return { ok: false, error: `argument "paths" accepts at most ${READ_MANY_MAX_PATHS} files; split into batches.` };
    }
    if (paths.some((item) => typeof item !== "string" || !item.trim())) {
      return { ok: false, error: 'every entry in "paths" must be a non-empty string.' };
    }
    return { ok: true, input: args };
  }
  const spec = TOOL_ARGUMENTS[tool];
  if (spec) {
    for (const field of spec.required) {
      const value = args[field];
      if (typeof value !== "string") {
        return { ok: false, error: `missing required string argument "${field}".` };
      }
      if (spec.nonEmpty.includes(field) && !value.trim()) {
        return { ok: false, error: `argument "${field}" must not be empty.` };
      }
    }
  }
  return { ok: true, input: args };
}

/**
 * 工具审批模式（粒度由粗到细）：
 *  - "read-only"：只读，写/改/命令一律拒绝
 *  - "ask"：每次写/改/命令都弹审批（旧版 "default" 的语义）
 *  - "auto"：可写根（工作区）内的写/改自动批准，越界与命令仍弹审批（codex 式）
 *  - "full"：全部工具自动放行，并允许工作区外的绝对路径
 * 审批模式按会话持久化；旧会话里存的 "default" 读出来归一到 "ask"。
 */
export { isApprovalMode, normalizeApprovalMode, isSessionMode, normalizeSessionMode };

/** 只有写类工具参与"可写根自动批准"；命令没有沙箱兜底，永远需要人确认。 */
const WRITABLE_ROOT_TOOLS = new Set(["write_file", "edit_file", "multi_edit"]);

/** 写类工具涉及的所有路径：multi_edit 可跨文件，必须逐个判定。 */
function writablePaths(tool: string, input: unknown): string[] {
  const args = (input ?? {}) as Record<string, unknown>;
  if (tool === "multi_edit") {
    const paths = multiEditPaths(input);
    if (paths.length) return paths;
  }
  const target = String(args.path ?? "").trim();
  return target ? [target] : [];
}

/**
 * 计划模式专用：write 系工具的全部目标路径（realpath 后）都落在工作区 plans/ 目录内才放行。
 * 全部在内返回解析后的绝对路径列表（供 plan_documented 事件取展示路径）；
 * 任一路径越界/解析失败/没有路径 → null（整次调用拒绝）。
 */
async function withinPlansDir(
  workspace: string,
  tool: string,
  input: unknown,
): Promise<string[] | null> {
  const paths = writablePaths(tool, input);
  if (!paths.length) return null;
  const plansRoot = path.resolve(workspace, "plans");
  const resolved: string[] = [];
  for (const target of paths) {
    try {
      const full = await resolveWithinWorkspace(workspace, target);
      if (!isWithinWorkspace(plansRoot, full)) return null;
      resolved.push(full);
    } catch {
      return null;
    }
  }
  return resolved;
}

/**
 * 计划模式下被拒绝的工具统一提示（executeToolCall 与 executeTaskToolCall 共用）。
 * 不弹审批：模型收到这条结果后应停下来等用户确认计划。
 */
function planModeRejection(tool: string): string {
  return `Tool ${tool} blocked: plan mode only allows writing plan documents under plans/. Do not run commands, spawn subagents, or modify other files; finish the plan document and wait for the user to confirm it.`;
}

/**
 * codex 式「可写根」判定：目标路径经 realpath 后仍落在工作区内才算可自动批准。
 * 返回第一个越界路径；全部在区内返回 null；参数里没有路径返回空串。
 * 用 resolveWithinWorkspace 而非字符串前缀比较，工作区内指向外部的软链接/junction 会被识别。
 */
async function writableRootViolation(
  workspace: string,
  tool: string,
  input: unknown,
): Promise<string | null> {
  const paths = writablePaths(tool, input);
  if (!paths.length) return "";
  for (const target of paths) {
    try {
      await resolveWithinWorkspace(workspace, target);
    } catch {
      return target;
    }
  }
  return null;
}

/** 一次后台预热压缩的快照与结果；task 内部就地更新 state/summary。 */
type WarmupCompaction = {
  session: SessionStore;
  providerId: string;
  model: string;
  controller: AbortController;
  /** 摘要覆盖的有效历史前缀长度（生成时 effectiveMessages.length - 保留段长度） */
  prefixLength: number;
  /** 生成摘要时捕获的投影对话；压缩后用其中的工具调用提取“读写过哪些文件” */
  messages: ChatMessage[];
  state: "running" | "ready" | "failed";
  summary: string;
  task: Promise<void>;
};

/**
 * 后台预热触发的占用区间：达到窗口 80% 开始预生成摘要；
 * 已过 95% 说明下一轮请求大概率直接溢出，预热来不及，留给前台压缩处理。
 * 参考 codex 的 async_compaction_threshold_percent 与 token_limit_reached 短路。
 */
const COMPACTION_WARMUP_RATIO = 0.8;
const COMPACTION_WARMUP_MAX_RATIO = 0.95;

/**
 * 主动压缩档阈值：占用过 85% 就在回合间隙收一轮上下文，不等溢出。
 * 参考 codex 的三层触发链（采样前预压缩 / 90% 阈值 / 手动）——溢出才压缩
 * 的体验是突然卡住一拍，主动档让压缩发生在回合之间，模型无感。
 */
const COMPACTION_PROACTIVE_RATIO = 0.85;

/** 上下文占用的分类明细（token 数），三项之和恒等于 usedTokens。 */
export type ContextBreakdown = {
  /** 系统提示词（稳定前缀） */
  system: number;
  /** 工具定义 */
  tools: number;
  /** 对话消息 */
  messages: number;
};

/** 估算三部分之和 → 按比例摊分到真实总量；舍入误差补进最大一项，保证加总一致。 */
function allocateByRatio(parts: ContextBreakdown, total: number): ContextBreakdown {
  const sum = parts.system + parts.tools + parts.messages;
  if (sum <= 0 || total <= 0) return { system: 0, tools: 0, messages: 0 };
  const scaled: ContextBreakdown = {
    system: Math.round((parts.system / sum) * total),
    tools: Math.round((parts.tools / sum) * total),
    messages: Math.round((parts.messages / sum) * total),
  };
  const diff = total - (scaled.system + scaled.tools + scaled.messages);
  if (diff !== 0) {
    const key = (["system", "tools", "messages"] as const).reduce((a, b) => (scaled[a] >= scaled[b] ? a : b));
    scaled[key] = Math.max(0, scaled[key] + diff);
  }
  return scaled;
}

/** 审阅记录：执行写/改前捕获 before 内容（捕获失败则不记录这次改动） */
async function captureBefore(
  workspace: string,
  input: unknown,
  allowOutsideWorkspace = false,
): Promise<{ target: string; file: string; before: string | null } | null> {
  const args = (input ?? {}) as Record<string, unknown>;
  const raw = String(args.path ?? "").trim();
  if (!raw) return null;
  let file: string;
  try {
    file = await resolveToolPath(workspace, raw, allowOutsideWorkspace);
  } catch {
    return null;
  }
  const target = displayPath(workspace, file);
  try {
    const before = await fs.readFile(file, "utf8");
    return { target, file, before };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // 新建文件：before 视为空
      return { target, file, before: null };
    }
    return null;
  }
}

/** 写类工具涉及的所有文件的 before 快照：跨文件 multi_edit 会返回多条。 */
async function captureBeforeAll(
  workspace: string,
  tool: string,
  input: unknown,
  allowOutsideWorkspace = false,
): Promise<Array<{ target: string; file: string; before: string | null }>> {
  const captures: Array<{ target: string; file: string; before: string | null }> = [];
  for (const target of writablePaths(tool, input)) {
    const capture = await captureBefore(workspace, { path: target }, allowOutsideWorkspace);
    if (capture) captures.push(capture);
  }
  return captures;
}

/** 审阅记录：执行成功后取 after 并与 before 比对，返回统一 diff（无变化返回 undefined） */
async function buildFileChangeDiff(
  tool: string,
  input: unknown,
  capture: { target: string; file: string; before: string | null },
): Promise<string | undefined> {
  const args = (input ?? {}) as Record<string, unknown>;
  let after: string | null = null;
  if (tool === "write_file") {
    after = String(args.content ?? "");
  } else {
    try {
      after = await fs.readFile(capture.file, "utf8");
    } catch {
      after = null;
    }
  }
  if (after == null) return undefined;
  return renderDiff(capture.target, capture.before ?? "", after);
}

export class AgentRuntime {
  private providers: ProviderConfig[];
  private providerId: string;
  private sessionsDir: string;
  /** 用户主目录：全局技能索引扫描根（~/.meowcode/skills）；测试注入临时目录隔离真实环境 */
  private homeDir: string;
  private currentSession: SessionStore | null = null;
  private turnAbort: AbortController | null = null;
  /** 正在执行的回合属于哪个会话；切换会话时前端据此恢复 streaming 状态 */
  private runningSessionId: string | null = null;
  /** 运行中收到的后续输入：当前回合结束后按顺序执行（图片只留在内存，不落队列文件） */
  private promptQueue: Array<{
    id: string;
    text: string;
    images?: ToolImage[];
    documents?: ToolDocument[];
  }> = [];
  /**
   * 最近一次服务商返回的真实输入 token，以及它覆盖到的有效消息条数。
   * 上下文占用 = 锚点 + 之后新增消息的估算；比每次整段重算字符估算准得多。
   */
  private usageAnchor: ContextUsageAnchor | null = null;
  /** 服务端原生压缩连续失败次数：达上限后本运行时不再尝试，直接走本地摘要。 */
  private nativeCompactionFailures = 0;
  /** run_code 宿主桥的内部调用序号：只用于审批记录与日志的 callId */
  private bridgeCallSeq = 0;
  private approvalMode: ApprovalMode = "auto";
  /** 当前回合启动时的审批模式快照：切会话重置全局模式时不影响正在跑的回合 */
  private turnApprovalMode: ApprovalMode | null = null;
  /** 会话模式（default/plan/goal）：plan 加写门控，goal 只注入指令 */
  private chatMode: SessionMode = "default";
  /** 当前回合启动时的模式快照，语义同 turnApprovalMode */
  private turnChatMode: SessionMode | null = null;
  /** 主 Agent 档位（standard/minimal/complex）：决定提示词、工具白名单、子 Agent 角色与并发上限 */
  private agentProfile: AgentProfileId = "standard";
  /**
   * 会话当前使用的架构图 id：缺省跟随档位；用户选了自定义架构（custom-*）时只换图，
   * 提示词/工具白名单仍按 agentProfile 走。
   */
  private harnessArchitecture: string | null = null;
  private pendingApprovals = new Map<string, (approved: boolean) => void>();

  /** ask_user 虚拟工具：挂起中的澄清问题（callId → resolver），回答文本作为工具结果 */
  private pendingAsks = new Map<string, (answers: string[]) => void>();
  private pendingAskDetails: {
    callId: string;
    sessionId: string;
    questions: Array<{ question: string; options: string[] }>;
  } | null = null;
  /** 正在等待确认的审批详情；切回会话时由 /session 回放 */
  private pendingApprovalDetails: PendingApproval | null = null;
  /** 最近一次回合失败原因（按 runtime/会话保留，切回时展示） */
  private lastErrorMessage: string | null = null;
  private compactingSession = false;
  /** 实验开关（默认全关），见 constructor options.experimental */
  private experimental: {
    midstreamToolExec?: boolean;
    incrementalResponses?: boolean;
    nativeCompaction?: boolean;
  } | null = null;
  /**
   * 治理层（metis 式 admission + gate 状态机）。只有根 runtime 驱动它：
   * 子 Agent 的 createSubagentRuntime 不注册治理 hooks。governance=off 时
   * 状态机仍在（admit 工具不注册，门禁不生效）。
   */
  private readonly governance: GovernanceMode;
  private workflow = new WorkflowRuntime();
  /** 连续变更类工具没更新 update_plan 的计数：达 8 次在轮间注入提醒 */
  private mutationsSincePlanCheck = 0;
  /**
   * 流中提前执行的只读工具（实验开关 midstreamToolExec）：参数闭合即启动执行，
   * 结果等分派阶段按原序落盘。按 callId 幂等，回合开始时清空。
   */
  private earlyToolRuns = new Map<string, Promise<Extract<ChatMessage, { role: "tool" }>>>();
  /**
   * Responses 增量传输链（实验开关 incrementalResponses，codex 式 previous_response_id）：
   * 按会话记录上一条被 store 的 response id、已发送的输入项数与消息引用快照。
   * 链续接条件（全部满足才走增量）：同 provider/model、工具与系统提示签名一致、
   * 消息列表是上次快照的严格追加（压缩/裁剪/纪要都会打破 → 自动回落全量）。
   */
  private responsesChains = new Map<
    string,
    {
      responseId: string;
      sentInputLength: number;
      sentRefs: ChatMessage[];
      requestSig: string;
    }
  >();
  /**
   * 循环检测状态（P1-2）：按会话记录最近一次工具调用的参数键/输出指纹/连续次数。
   * 每回合开始时重置 —— 跨回合的相同调用多是用户再次要求，不算循环。
   */
  private loopStates = new Map<string, LoopState>();
  /**
   * 本进程内 read_file 结果对应的文件版本（callId → file + version）。
   * 「重复读短路」用它判断文件在读取之后有没有被写/改；进程重启后为空，
   * 宁可退回完整读取，也不拿旧内容误 stub。
   */
  private readVersions = new Map<string, { file: string; version: string }>();
  /**
   * 后台预热压缩（codex 式 speculative compaction）：真实用量达到窗口阈值就在后台
   * 预生成摘要，溢出/需要压缩时直接采用 —— 摘要请求不再阻塞当前回合。
   * 参考 codex session/async_compaction.rs 的 maybe_start / take_ready / wait_for_pending。
   */
  private warmupCompaction: WarmupCompaction | null = null;
  /** 连续预热失败计数：达到上限后本会话不再预热，避免失败请求反复烧 token */
  private warmupFailures = 0;
  /** 当前回合 id：工具/审批事件与 partial 检查点都挂在它下面 */
  private currentTurnId: string | null = null;
  /** 流式回答的临时检查点；正常落 assistant 消息后丢弃，异常时补成半截回答 */
  private partialDraft: {
    session: SessionStore;
    turnId: string;
    round: number;
    content: string;
    reasoning: string;
    lastWriteAt: number;
    lastLength: number;
    chain: Promise<void>;
  } | null = null;
  private partialRound = 0;
  /** 回合结束后仍在写的后台任务（标题生成等）；用于避免过早关闭会话文件 */
  private asyncTasks = 0;
  private shuttingDown = false;
  private listeners = new Set<(event: MeowEvent) => void>();
  /** 当前工作区的 AGENTS.md 内容（每轮重新读取，内容变化时下一轮生效） */
  private instructions: string | undefined;
  /** 桌面端内嵌浏览器桥；无桌面环境（测试 / CLI）时为 null，浏览器工具不注册 */
  private browserHost: BrowserHostClient | null;
  /** 子 Agent 开关：side 聊天与子 Agent 自身关闭，避免嵌套派发 */
  private enableTaskTool: boolean;
  private systemPrompt: string;
  /** 调用方显式传了 systemPrompt：此时档位提示词不覆盖它（子 Agent / side 聊天 / 测试） */
  private customSystemPrompt: boolean;
  /** 子 Agent 写/改文件后回写父会话（审阅聚合） */
  private onFileChange?: (change: {
    path: string;
    operation: "write_file" | "edit_file";
    diff: string;
  }) => void | Promise<void>;
  /** 工具白名单：Explore 子 Agent 只挂只读工具 */
  private allowedTools: Set<string> | null;
  /** 插件注册表（server 启动时注入；null = 未启用插件系统，hook 直通） */
  private plugins: PluginRegistry | null;
  /** Explore 子 Agent 不注入 AGENTS.md，减少上下文 */
  private injectInstructions: boolean;
  /** 正在运行的子 Agent（agentId → 子 runtime） */
  private liveSubagents = new Map<string, LiveSubagent>();
  /** 当前回合已派发的子 Agent 数：硬上限 3，避免一个回合放大 token 消耗 */
  private subagentsStartedThisTurn = 0;
  /** 当前回合已回灌的验证失败反馈次数：硬上限防"写→验证失败→修"无限循环 */
  private verifyFailuresThisTurn = 0;
  /** 有后台子 Agent 时暂缓标题生成，等它们结束后再补 */
  private pendingTitle: { session: SessionStore; text: string } | null = null;
  /** 正在创建、尚未进入 liveSubagents 的子 Agent；用于并发上限的同步占位 */
  private startingSubagents = 0;

  /** 本会话内被写/改过的文件（mentionPathKey 归一）：@ 去重占位对这些路径失效，必须重新注入。 */
  private mutatedPaths = new Map<string, Set<string>>();
  /** 动态工具 schema 超预算只提示一次，避免每轮刷日志 */
  private dynamicToolBudgetWarned = false;

  constructor(options: {
    providers: ProviderConfig[];
    providerId?: string;
    sessionsDir: string;
    /** 全局技能目录扫描根（缺省 os.homedir()）；测试注入临时目录隔离真实 ~/.meowcode */
    homeDir?: string;
    workspace?: string;
    browserHost?: BrowserHostClient | null;
    enableTaskTool?: boolean;
    systemPrompt?: string;
    allowedTools?: Iterable<string>;
    injectInstructions?: boolean;
    /**
     * 实验开关（默认全关）：
     * - midstreamToolExec = 流中参数闭合即提前执行只读工具
     * - incrementalResponses = Responses 协议 previous_response_id 增量传输
     * - nativeCompaction = OpenAI /responses/compact 原生压缩（预热路径）
     */
    experimental?: {
      midstreamToolExec?: boolean;
      incrementalResponses?: boolean;
      nativeCompaction?: boolean;
    };
    /** 插件注册表（server 级单例）：null/缺省 = 未启用插件系统，hook 直通、无动态工具 */
    plugins?: PluginRegistry | null;
    /**
     * 治理模式（metis 式 admission 门禁）：off = 完全关闭；goal = 仅 goal 模式
     * 强制先 admit 再变更（默认）；always = 所有会话模式都强制。
     */
    governance?: GovernanceMode;
    onFileChange?: (change: {
      path: string;
      operation: "write_file" | "edit_file";
      diff: string;
    }) => void | Promise<void>;
  }) {
    this.providers = options.providers;
    this.providerId = options.providerId ?? options.providers[0]?.id ?? "";
    this.sessionsDir = options.sessionsDir;
    this.homeDir = options.homeDir ?? os.homedir();
    this.browserHost = options.browserHost ?? null;
    this.enableTaskTool = options.enableTaskTool ?? true;
    this.systemPrompt = options.systemPrompt ?? BASE_SYSTEM_PROMPT;
    this.customSystemPrompt = options.systemPrompt !== undefined;
    this.allowedTools = options.allowedTools ? new Set(options.allowedTools) : null;
    this.injectInstructions = options.injectInstructions ?? true;
    this.experimental = options.experimental ?? null;
    this.plugins = options.plugins ?? null;
    this.governance = options.governance ?? "goal";
    this.onFileChange = options.onFileChange;
  }

  /**
   * 启动时恢复会话：优先服务端持久化的最后活动会话，失效时回退到该工作区最新会话。
   * 必须由 startServer 在监听端口前 await，避免前端先拿到 404/旧会话。
   */
  async restore(workspace?: string, preferredFile?: string): Promise<void> {
    if (preferredFile) {
      try {
        await this.switchSession(preferredFile);
        return;
      } catch {
        // 文件被删除/损坏时回退
      }
    }
    if (workspace) await this.loadLatestForWorkspace(workspace);
  }

  onEvent(listener: (event: MeowEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private toolAllowed(tool: string): boolean {
    if (this.allowedTools && !this.allowedTools.has(tool)) return false;
    // 架构图里主 Agent 节点显式配置的白名单（task / admit 是编排通道，始终保留）
    const harnessTools = this.enableTaskTool ? this.workflow.rootAgentTools : null;
    if (harnessTools && tool !== "task" && tool !== "admit" && !harnessTools.has(tool)) {
      return false;
    }
    // 档位白名单只管根 runtime（子 Agent 的 allowedTools 已在创建时与档位求过交集）
    return this.profileTools === null || profileAllowsTool(this.activeProfile, tool);
  }

  /**
   * 登记"本会话写过这个文件"：@ 去重占位对这些路径失效，否则模型会拿到编辑前的旧内容。
   * 只记工作区内路径 —— @ 引用本来就只解析工作区内的文件。
   */
  private async noteMutatedPath(session: SessionStore, tool: string, input: unknown): Promise<void> {
    if (tool !== "write_file" && tool !== "edit_file" && tool !== "multi_edit") return;
    const set = this.mutatedPaths.get(session.id) ?? new Set<string>();
    let changed = false;
    for (const raw of writablePaths(tool, input)) {
      let absolute: string;
      try {
        absolute = await resolveWithinWorkspace(session.cwd, raw);
      } catch {
        continue;
      }
      set.add(mentionPathKey(absolute));
      changed = true;
    }
    if (changed) this.mutatedPaths.set(session.id, set);
  }

  /** 写类工具在审批时需要盯住的绝对路径（用于批准后比对文件版本）。 */
  private async approvalTargetFiles(
    session: SessionStore,
    tool: string,
    input: unknown,
  ): Promise<string[]> {
    const allowOutside = (this.turnApprovalMode ?? this.approvalMode) === "full";
    const files: string[] = [];
    for (const target of writablePaths(tool, input)) {
      try {
        files.push(await resolveToolPath(session.cwd, target, allowOutside));
      } catch {
        // 越界路径在执行阶段会被拒绝，这里不参与版本比对
      }
    }
    return files;
  }

  /** 发审批并等待；stale=true 表示"文件已变化、预览已重算"的二次确认。 */
  private async awaitApproval(
    session: SessionStore,
    call: ToolCall,
    tool: string,
    input: unknown,
    diff: string | undefined,
    risk: CommandRisk | undefined,
    turnId: string | null,
    stale: boolean,
  ): Promise<boolean> {
    if (turnId) {
      await session.appendApprovalRequested({
        turnId,
        callId: call.id,
        tool,
        input,
        ...(diff ? { diff } : {}),
        ...(risk ? { risk } : {}),
      });
      await session.flush();
    }
    this.pendingApprovalDetails = {
      callId: call.id,
      sessionId: session.id,
      tool,
      input,
      ...(diff ? { diff } : {}),
      ...(risk ? { risk } : {}),
      ...(stale ? { stale: true } : {}),
    };
    this.emit({
      type: "approval_required",
      sessionId: session.id,
      callId: call.id,
      tool,
      input,
      ...(diff ? { diff } : {}),
      ...(risk ? { risk } : {}),
      ...(stale ? { stale: true } : {}),
    });
    if (this.turnAbort?.signal.aborted) return false;
    const approved = await new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(call.id, resolve);
    });
    if (this.pendingApprovalDetails?.callId === call.id) this.pendingApprovalDetails = null;
    return approved;
  }

  /** 工具列表：桌面端注入了浏览器桥才挂 browser_* 工具；子 Agent / side 不挂 task。 */
  private get activeTools(): ToolDefinition[] {
    let base = this.enableTaskTool
      ? toolDefinitions
      : toolDefinitions.filter((definition) => definition.function.name !== "task");
    // 治理开启的根 runtime 才挂 admit（只读/子代理会话不付这份 schema 预算）
    if (this.governance !== "off" && this.enableTaskTool) {
      base = [...base, admitToolDefinition];
    }
    let browser = browserToolDefinitions;
    if (this.allowedTools) {
      base = base.filter((definition) => this.allowedTools!.has(definition.function.name));
      browser = browser.filter((definition) => this.allowedTools!.has(definition.function.name));
    }
    // 档位白名单：极简档只留 read_file / run_command（task / admit 是编排通道，始终保留）
    const profileTools = this.profileTools;
    if (profileTools) {
      base = base.filter((definition) => profileAllowsTool(this.activeProfile, definition.function.name));
      browser = browser.filter((definition) =>
        profileAllowsTool(this.activeProfile, definition.function.name),
      );
    }
    if (this.enableTaskTool) {
      base = base.map((definition) => {
        if (definition.function.name !== "task") return definition;
        return this.withSubagentRoles(this.withSubagentProviderHint(definition));
      });
    }
    // 插件 / MCP 动态工具：同样受 allowedTools 白名单约束（Explore 子 Agent 只挂只读工具）
    const pluginTools = listDynamicToolDefinitions().filter((definition) =>
      this.toolAllowed(definition.function.name),
    );
    // MCP schema 会随每次请求发送；超过 ~16k tokens 说明该关掉一些 server。
    // 这里只提示不截断 inputSchema（截断会让工具调用直接坏掉）。
    const dynamicTokens = estimateToolDefinitionsTokens(pluginTools);
    if (dynamicTokens > 16_000 && !this.dynamicToolBudgetWarned) {
      this.dynamicToolBudgetWarned = true;
      console.error(
        `[meowcode] dynamic tool schemas are ~${dynamicTokens} tokens; disable unused MCP servers to reduce context`,
      );
    }
    return [...(this.browserHost ? [...base, ...browser] : base), ...pluginTools];
  }

  /** 把可选 provider / 思考强度写进 task 工具描述，让主模型能按子任务选择更快的模型。 */
  private withSubagentProviderHint(definition: ToolDefinition): ToolDefinition {
    const options = this.providers
      .filter((provider) => provider.enabled !== false)
      .map((provider) => {
        const levels = provider.reasoningLevels?.length
          ? `; reasoning: ${provider.reasoningLevels.join("|")}`
          : "";
        return `${provider.id} (${provider.name}/${provider.model}${levels})`;
      })
      .join("; ");
    if (!options) return definition;
    return {
      ...definition,
      function: {
        ...definition.function,
        description: `${definition.function.description} Optional subagent providers: ${options}. Use provider/reasoning_effort only when a faster or different model is clearly better.`,
      },
    };
  }

  /**
   * 把档位允许的子 Agent 角色写进 task 的 agent_type 枚举：
   * 极简档只剩 general / explore，模型看不到也派不出 implementer / reviewer / verifier。
   */
  private withSubagentRoles(definition: ToolDefinition): ToolDefinition {
    const roles = this.activeProfile.roles;
    const parameters = definition.function.parameters;
    const agentType = parameters.properties.agent_type as
      | { enum?: string[]; description?: string }
      | undefined;
    if (!agentType) return definition;
    // 枚举与说明都按档位重建：复杂档多出来的角色（scoper / juror / …）也要能读懂
    const hints = roles.map((role) => `${role}=${AGENT_ROLE_HINTS[role]}`).join("; ");
    return {
      ...definition,
      function: {
        ...definition.function,
        parameters: {
          ...parameters,
          properties: {
            ...parameters.properties,
            agent_type: {
              ...agentType,
              enum: [...roles],
              description: `Pick the role via agent_type. ${this.activeProfile.name} allows: ${hints}.`,
            },
          },
        },
      },
    };
  }

  emit(event: MeowEvent): void {
    for (const listener of this.listeners) listener(event);
  }  get providersConfig(): ProviderConfig[] {
    return this.providers;
  }

  get current(): SessionStore | null {
    return this.currentSession;
  }

  /** 是否有回合正在执行（SSE 重连后前端用它判断是否还在等事件）。 */
  get isRunning(): boolean {
    return this.turnAbort !== null;
  }

  get activeTurnSessionId(): string | null {
    return this.runningSessionId;
  }

  get pendingApproval(): PendingApproval | null {
    return this.pendingApprovalDetails;
  }

  /** 正在运行的子 Agent id（会话快照据此区分 running / interrupted）。 */
  get liveSubagentIds(): string[] {
    return [...this.liveSubagents.keys()];
  }

  get hasLiveSubagents(): boolean {
    return this.liveSubagents.size > 0;
  }

  /** 当前 runtime 自己 + 所有活跃子 Agent 的待审批（子审批记在父会话上）。 */
  get pendingApprovalList(): PendingApproval[] {
    const list: PendingApproval[] = [];
    if (this.pendingApprovalDetails) list.push({ ...this.pendingApprovalDetails });
    for (const [agentId, live] of this.liveSubagents) {
      const pending = live.runtime.pendingApproval;
      if (!pending) continue;
      list.push({
        ...pending,
        sessionId: live.parentSessionId,
        parentSessionId: live.parentSessionId,
        agentId,
        agentDescription: live.description,
      });
    }
    return list;
  }

  /** 当前会话排队中的消息（切换回来时恢复输入框上方的队列）。 */
  get queuedPrompts(): Array<{ id: string; text: string }> {
    // 图片不外发：队列面板只需要文字，base64 传过去也是白占带宽
    return this.promptQueue.map(({ id, text }) => ({ id, text }));
  }

  /** 上次进程退出时未交付的排队消息；只展示，不自动执行。 */
  get recoveredPrompts(): Array<{ id: string; text: string }> {
    return this.currentSession?.recoveredQueue ?? [];
  }

  /** 最近一个回合的最终状态（重启后从 JSONL 投影）。 */
  get lastTurn(): { status: TurnStatus; error?: string } | null {
    const entry = this.currentSession?.lastTurnEnd;
    if (!entry) return null;
    return { status: entry.status, ...(entry.error ? { error: entry.error } : {}) };
  }

  /** 最近一次回合的失败原因；新回合开始时清空。 */
  get lastError(): string | null {
    return this.lastErrorMessage;
  }

  get isCompacting(): boolean {
    return this.compactingSession;
  }

  /** 回合已结束但仍有标题/用量等后台写入；此时不能关闭会话文件。 */
  get hasBackgroundWork(): boolean {
    return this.asyncTasks > 0;
  }

  /** 当前会话能否接收新提示：同会话可在运行中排队，跨会话必须等回合结束；压缩期间一律拒绝。 */
  get canAcceptPrompt(): boolean {
    const session = this.currentSession;
    if (!session || this.compactingSession) return false;
    return !this.turnAbort || this.runningSessionId === session.id;
  }

  async listSessions(): Promise<SessionSummary[]> {
    return listSessions(this.sessionsDir);
  }

  /** 关停/切换前把待写队列刷入磁盘。 */
  async flush(): Promise<void> {
    await this.currentSession?.flush();
  }

  /** 释放当前会话文件句柄（server 关停时调用）；活跃子会话一并释放。 */
  async closeSession(): Promise<void> {
    this.cancelWarmupCompaction();
    await this.currentSession?.close();
    for (const live of this.liveSubagents.values()) {
      await live.runtime.closeSession().catch(() => undefined);
    }
  }

  async newSession(cwd?: string): Promise<SessionHeaderLike> {
    const workspace = path.resolve(cwd ?? this.currentSession?.cwd ?? process.cwd());
    let filePath = path.join(this.sessionsDir, sessionFileName(workspace, new Date()));
    let session: SessionStore;
    for (let attempt = 0; ; attempt += 1) {
      try {
        session = await SessionStore.create(filePath, workspace);
        break;
      } catch (error) {
        // 毫秒级撞名（双击/双窗口）：换唯一后缀重试，绝不覆盖已有文件
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 3) throw error;
        filePath = filePath.replace(/\.jsonl$/, `_${randomUUID().slice(0, 8)}.jsonl`);
      }
    }
    const previous = this.currentSession;
    await this.clearQueuedPrompts("discarded");
    // 正在跑的回合仍持有旧 store：等它自然结束，不能在这里关闭句柄
    if (previous && previous !== session && this.runningSessionId !== previous.id) {
      await previous.close().catch(() => undefined);
    }
    this.currentSession = session;
    this.usageAnchor = null;
    this.cancelWarmupCompaction();
    this.warmupFailures = 0;
    this.approvalMode = "auto";
    // 新会话没有模式记录：显式回到 default，避免沿用上一个会话的 plan/goal
    this.chatMode = "default";
    this.turnChatMode = null;
    // 新会话默认标准 Agent：档位是会话级设置，不跨会话继承
    this.agentProfile = "standard";
    this.harnessArchitecture = null;
    this.promptQueue = [];
    this.lastErrorMessage = null;
    this.compactingSession = false;
    this.currentTurnId = null;
    this.partialDraft = null;
    this.readVersions.clear();
    this.dynamicToolBudgetWarned = false;
    await this.refreshInstructions(session);
    // 插件 hook：session_start（观察）
    await runHook(this.plugins, "session_start", {
      hook: "session_start",
      sessionId: session.id,
      cwd: session.cwd,
    });
    return {
      id: session.id,
      cwd: session.cwd,
      filePath: session.filePath,
      messages: session.messages,
    };
  }

  async switchSession(filePath: string): Promise<SessionHeaderLike> {
    const session = await SessionStore.load(filePath);
    const previous = this.currentSession;
    await this.clearQueuedPrompts("discarded");
    // 正在跑的回合仍持有旧 store：等它自然结束，不能在这里关闭句柄
    if (previous && previous !== session && this.runningSessionId !== previous.id) {
      await previous.close().catch(() => undefined);
    }
    this.currentSession = session;
    this.usageAnchor = null;
    this.cancelWarmupCompaction();
    this.warmupFailures = 0;
    this.approvalMode = "auto";
    this.promptQueue = [];
    this.lastErrorMessage = null;
    this.compactingSession = false;
    this.currentTurnId = null;
    this.partialDraft = null;
    this.readVersions.clear();
    this.dynamicToolBudgetWarned = false;
    // 关闭上次进程退出时留下的孤儿回合，并恢复会话级审批模式/用量
    const recovery = await recoverSession(session);
    this.approvalMode = recovery.approvalMode;
    this.chatMode = recovery.mode;
    this.agentProfile = recovery.agentProfile;
    this.harnessArchitecture = recovery.harnessArchitecture;
    this.turnChatMode = null;
    this.usageAnchor = recovery.lastUsageAnchor;
    this.lastErrorMessage = recovery.lastError;
    // 恢复的会话可能带着别的 provider/模型落下的原生压缩点：先判定能否重放
    this.syncNativeReplay();
    await this.refreshInstructions(session);
    // 插件 hook：session_start（观察，切换/恢复会话同样触发）
    await runHook(this.plugins, "session_start", {
      hook: "session_start",
      sessionId: session.id,
      cwd: session.cwd,
    });
    return {
      id: session.id,
      cwd: session.cwd,
      filePath: session.filePath,
      messages: session.messages,
    };
  }

  async setModel(providerId: string, modelId: string): Promise<void> {
    const provider = this.providers.find((item) => item.id === providerId);
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    provider.model = modelId;
    this.providerId = providerId;
    this.usageAnchor = null; // 换模型后旧用量不再代表当前上下文
    this.syncNativeReplay();
    this.cancelWarmupCompaction();
    await this.persistSessionSettings().catch(() => undefined);
  }

  /** 只切换当前激活的服务商（不改它的模型 id）。 */
  setActiveProvider(providerId: string): void {
    const provider = this.providers.find((item) => item.id === providerId);
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    this.providerId = providerId;
    this.usageAnchor = null; // 换模型后旧用量不再代表当前上下文
    this.syncNativeReplay();
    this.cancelWarmupCompaction();
  }

  /**
   * 服务端原生压缩的加密 item 与端点/模型绑定：换模型或换服务商后必须判定
   * 当前 provider 还能不能重放，不能就让会话退回原始历史（见 session-store）。
   * 传入 override 用于「故障转移后的目标 provider」——此时 activeProvider()
   * 还没变（用户配置不动），判定必须针对真正要发请求的那一家。
   */
  private syncNativeReplay(override?: ProviderConfig): void {
    const session = this.currentSession;
    if (!session) return;
    const entry = session.lastNativeCompaction;
    if (!entry) {
      session.nativeCompactionReplayable = true;
      return;
    }
    const provider = override ?? this.activeProvider();
    session.nativeCompactionReplayable = provider
      ? canReplayNativeCompaction(entry.native, provider)
      : false;
  }

  /** 当前激活的服务商 id，供 /config/providers 回给前端；未配置模型时为空，不抛错。 */
  get activeProviderId(): string {
    const active = this.providers.find((item) => item.id === this.providerId) ?? this.providers[0];
    return active?.id ?? "";
  }

  /** 设置思考强度；传空表示回到服务商默认（不下发 reasoning_effort）。 */
  async setReasoningEffort(providerId: string, effort?: string): Promise<void> {
    const provider = this.providers.find((item) => item.id === providerId);
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    if (effort) provider.reasoningEffort = effort;
    else delete provider.reasoningEffort;
    await this.persistSessionSettings().catch(() => undefined);
  }

  /** 记录当前会话的审计信息；模型仍由全局配置决定（不按会话恢复）。 */
  private async persistSessionSettings(): Promise<void> {
    const session = this.currentSession;
    if (!session) return;
    const provider = this.activeProvider();
    await session.appendSessionSettings({
      approvalMode: this.approvalMode,
      providerId: provider.id,
      model: provider.model,
      ...(provider.reasoningEffort ? { reasoningEffort: provider.reasoningEffort } : {}),
    });
  }

  /** 结算审批：先找自己，再找活跃子 Agent；命中返回 true。 */
  /** ask_user 挂起详情（SSE 重连后快照恢复用） */
  get pendingAsk(): {
    callId: string;
    sessionId: string;
    questions: Array<{ question: string; options: string[] }>;
  } | null {
    return this.pendingAskDetails;
  }

  /** 用户提交 ask_user 答案：按题序对齐，resolve 工具挂起返回给模型 */
  respondToAsk(callId: string, answers: string[]): boolean {
    const resolver = this.pendingAsks.get(callId);
    if (!resolver) return false;
    this.pendingAsks.delete(callId);
    if (this.pendingAskDetails?.callId === callId) this.pendingAskDetails = null;
    resolver(answers);
    return true;
  }

  /** ask_user 虚拟工具执行：emit 问题卡片并挂起回合，直到 respondToAsk 或回合中止 */
  private async awaitUserAnswer(
    session: SessionStore,
    callId: string,
    questions: Array<{ question: string; options: string[] }>,
  ): Promise<string[]> {
    this.pendingAskDetails = { callId, sessionId: session.id, questions };
    this.emit({ type: "ask_user", sessionId: session.id, callId, questions });
    if (this.turnAbort?.signal.aborted) return questions.map(() => "");
    return new Promise<string[]>((resolve) => {
      this.pendingAsks.set(callId, resolve);
    });
  }

  respondToApproval(callId: string, approved: boolean): boolean {    const resolver = this.pendingApprovals.get(callId);
    if (resolver) {
      this.pendingApprovals.delete(callId);
      if (this.pendingApprovalDetails?.callId === callId) this.pendingApprovalDetails = null;
      resolver(approved);
      return true;
    }
    for (const live of this.liveSubagents.values()) {
      if (live.runtime.respondToApproval(callId, approved)) return true;
    }
    return false;
  }

  /** 切换审批模式（完全访问 = 自动放行全部工具），并写入会话级设置。 */
  async setApprovalMode(mode: ApprovalModeInput): Promise<void> {
    const normalized = normalizeApprovalMode(mode);
    this.approvalMode = normalized;
    // 正在看的会话可以立即生效；后台会话的回合保持自己启动时的模式
    if (this.turnAbort && this.runningSessionId === this.currentSession?.id) {
      this.turnApprovalMode = normalized;
    }
    const session = this.currentSession;
    if (!session) return;
    const provider = this.activeProvider();
    await session
      .appendSessionSettings({
        approvalMode: normalized,
        providerId: provider.id,
        model: provider.model,
      })
      .catch(() => undefined);
  }

  get currentApprovalMode(): ApprovalMode {
    return this.approvalMode;
  }

  /** 切换会话模式（default/plan/goal）：落盘 + 广播；正在跑的回合保持启动时的模式。 */
  async setSessionMode(mode: SessionMode): Promise<void> {
    const normalized = normalizeSessionMode(mode);
    this.chatMode = normalized;
    if (this.turnAbort && this.runningSessionId === this.currentSession?.id) {
      this.turnChatMode = normalized;
    }
    const session = this.currentSession;
    if (!session) return;
    await session.appendSessionSettings({ mode: normalized }).catch(() => undefined);
    this.emit({ type: "session_mode", sessionId: session.id, mode: normalized });
  }

  get currentSessionMode(): SessionMode {
    return this.chatMode;
  }

  /**
   * 切换主 Agent 档位（standard/minimal/complex）：落盘 + 广播。
   * 提示词与工具白名单在下一轮请求生效（切档会换掉 system 前缀，缓存失效一次）。
   */
  async setAgentProfile(profile: AgentProfileId): Promise<void> {
    const normalized = normalizeAgentProfile(profile);
    this.agentProfile = normalized;
    // 切档位 = 回到该档位的图，自定义架构选择作废
    this.harnessArchitecture = null;
    const session = this.currentSession;
    if (!session) return;
    await session
      .appendSessionSettings({ agentProfile: normalized, harnessArchitecture: "" })
      .catch(() => undefined);
    this.emit({ type: "agent_profile", sessionId: session.id, profile: normalized });
    // 每个档位一张独立架构图：切档后重新装载（治理 run 活跃时保持旧快照，下一轮生效）
    this.refreshHarness();
  }

  get currentAgentProfile(): AgentProfileId {
    return this.agentProfile;
  }

  /**
   * 会话切到某张自定义架构图（custom-*）；传 null 回到跟随档位的内置图。
   * 只换图，提示词与工具白名单仍由 agentProfile 决定。
   */
  async setHarnessArchitecture(id: string | null): Promise<void> {
    this.harnessArchitecture = id;
    const session = this.currentSession;
    if (!session) return;
    await session
      .appendSessionSettings({ harnessArchitecture: id ?? "" })
      .catch(() => undefined);
    this.refreshHarness();
  }

  /** 当前生效的架构图 id（自定义架构优先，否则跟随档位）。 */
  get currentHarnessArchitecture(): string {
    return this.harnessArchitecture ?? this.agentProfile;
  }

  /** 当前生效的档位定义（提示词 / 工具白名单 / 子 Agent 角色 / 并发上限）。 */
  private get activeProfile() {
    return agentProfileFor(this.agentProfile);
  }

  /** 根 runtime 的档位工具白名单；子 Agent / side 聊天返回 null（它们用 allowedTools）。 */
  private get profileTools(): ReadonlySet<string> | null {
    return this.enableTaskTool ? this.activeProfile.tools : null;
  }

  /**
   * 实际使用的主提示词：调用方显式给了 systemPrompt（子 Agent / side 聊天 / 测试）
   * 就尊重它，否则按会话档位取注册表里的提示词。
   */
  private get effectiveSystemPrompt(): string {
    if (this.customSystemPrompt) return this.systemPrompt;
    // 架构图里主 Agent 节点写了提示词就用它（整体替换档位那份）
    const harnessPrompt = this.enableTaskTool ? this.workflow.rootAgentPrompt : null;
    if (harnessPrompt) return harnessPrompt;
    return this.activeProfile.prompt;
  }

  /** 审批/ask_user 的 Promise 不响应 AbortSignal：停止/插话前必须先结算，否则 runTurn 永远退不出。 */
  private settlePendingApprovals(): void {
    for (const resolver of this.pendingApprovals.values()) resolver(false);
    this.pendingApprovals.clear();
    this.pendingApprovalDetails = null;
    for (const resolver of this.pendingAsks.values()) resolver([]);
    this.pendingAsks.clear();
    this.pendingAskDetails = null;
  }

  /** 清空内存队列，并把移除事实写进会话日志（避免重启后“复活”）。 */
  private async clearQueuedPrompts(
    reason: "aborted" | "discarded",
    target: SessionStore | null = this.currentSession,
  ): Promise<void> {
    const session = target;
    const removed = this.promptQueue;
    this.promptQueue = [];
    if (!session || !removed.length) return;
    await Promise.all(
      removed.map((item) => session.appendQueuedPromptRemoved(item.id, reason)),
    ).catch(() => undefined);
  }

  /**
   * 父回合停止时停止前台子 Agent；后台子 Agent 不跟随父回合停止，
   * 由用户通过单个 Agent 的停止按钮结束（shutdown 时全部停止）。
   */
  private abortSubagents(includeBackground = false): void {
    for (const live of this.liveSubagents.values()) {
      if (!includeBackground && live.background) continue;
      live.runtime.abort();
    }
  }

  abort(): void {
    void this.clearQueuedPrompts("aborted");
    this.cancelWarmupCompaction();
    this.settlePendingApprovals();
    this.abortSubagents();
    this.turnAbort?.abort();
  }

  /** 应用/server 关停：中止回合但保留排队消息，下次启动作为“待发送”恢复。 */
  shutdown(): void {
    this.shuttingDown = true;
    this.settlePendingApprovals();
    this.abortSubagents(true);
    this.turnAbort?.abort();
  }

  /** 用户丢弃一条恢复出来的待发送消息。 */
  async discardRecoveredPrompt(id: string): Promise<boolean> {
    const session = this.currentSession;
    if (!session) return false;
    const exists = session.recoveredQueue.some((item) => item.id === id);
    if (!exists) return false;
    await session.appendQueuedPromptRemoved(id, "discarded");
    await session.flush();
    return true;
  }

  /**
   * 手动压缩当前会话上下文：立即生成一次摘要并落盘。
   * 与「服务商报溢出后的自动压缩」共用 performCompaction；会话里的完整历史不删，
   * 压缩点之后的消息才参与后续请求。
   */
  async compactSession(): Promise<void> {
    const session = this.currentSession;
    if (!session) throw new Error("No active session. Create a session first.");
    if (this.compactingSession) throw new Error("Context compaction is already running.");
    if (this.turnAbort) throw new Error("A turn is already running.");
    if (!session.hasUncompactedMessages) throw new Error("Nothing to compact yet.");
    const provider = this.activeProvider();
    // 从准备阶段就置位：切走会话时 runtime 会被判定为有未完成工作而保留
    this.compactingSession = true;
    try {
      await this.refreshInstructions(session);
      const messages: ChatMessage[] = [
        ...this.systemMessages(),
        ...projectForRequest(session.effectiveMessages, provider),
      ];
      await this.performCompaction(session, provider, messages);
    } finally {
      this.compactingSession = false;
    }
  }

  /**
   * 当前会话的上下文占用：优先用服务商返回的真实 inputTokens 做锚点（只估算锚点之后
   * 新增的消息），锚点失效才整段本地估算（含工具定义开销）。
   * 同时给出 system / 工具 / 对话三项明细：估算路径下就是各分项估算值；
   * 真实用量下按估算比例摊分，三项之和恒等于 usedTokens。
   */
  getContextUsage(): {
    contextWindow: number | null;
    usedTokens: number;
    source: "usage" | "estimate";
    breakdown: ContextBreakdown;
    recommendedCompaction: boolean;
  } {
    let contextWindow: number | null = null;
    let provider: ProviderConfig | null = null;
    try {
      provider = this.activeProvider();
      contextWindow = provider.contextWindow ?? null;
    } catch {
      // 尚未配置任何模型时窗口为 null，占用照常返回
    }
    const session = this.currentSession;
    if (!session) {
      return {
        contextWindow,
        usedTokens: 0,
        source: "estimate",
        breakdown: { system: 0, tools: 0, messages: 0 },
        recommendedCompaction: false,
      };
    }
    const effective = projectForRequest(session.effectiveMessages, provider);
    const estimated: ContextBreakdown = {
      system:
        estimateTokens(this.effectiveSystemPrompt) +
        (this.instructions ? estimateTokens(this.instructions) : 0),
      tools: estimateToolDefinitionsTokens(this.activeTools),
      messages: estimateMessagesTokens(effective),
    };
    // 锚点按「请求覆盖到的有效消息数」定位，能精确算出之后新增了多少（工具结果/新回合）
    const anchored = estimateContextTokens(effective, this.usageAnchor);
    if (anchored.source === "usage") {
      return {
        contextWindow,
        usedTokens: anchored.tokens,
        source: "usage",
        breakdown: allocateByRatio(estimated, anchored.tokens),
        recommendedCompaction: shouldRecommendCompaction(anchored.tokens, contextWindow),
      };
    }
    const usedTokens = estimated.system + estimated.tools + estimated.messages;
    return {
      contextWindow,
      usedTokens,
      source: "estimate",
      breakdown: estimated,
      recommendedCompaction: shouldRecommendCompaction(usedTokens, contextWindow),
    };
  }

  /** 每回合开始时清空循环检测状态：跨回合的相同调用不算循环。 */
  private resetLoopState(sessionId: string): void {
    this.loopStates.delete(sessionId);
  }

  /** 执行前检查：连续 8 次零信息重复直接拒绝执行 —— 省掉执行本身与整轮上下文重发。 */
  private loopBlockFor(session: SessionStore, tool: string, input: unknown): string | null {
    const state = this.loopStates.get(session.id);
    if (!state || state.count < LOOP_BLOCK_AT) return null;
    const key = `${tool}:${stableJson(input)}`;
    return state.key === key ? loopBlockedOutput(tool, state.count) : null;
  }

  /**
   * 执行后登记：参数键与输出指纹都相同才累计。返回要附加到工具结果的提醒
   * （未达阈值返回空串）。占位符/错误结果同样计数 —— 反复同参数失败也是循环。
   */
  private noteLoopResult(session: SessionStore, tool: string, input: unknown, output: string): string {
    const key = `${tool}:${stableJson(input)}`;
    const fingerprint = outputFingerprint(output);
    const state = this.loopStates.get(session.id);
    if (state && state.key === key && state.outputHash === fingerprint) {
      state.count += 1;
      if (state.count >= LOOP_BLOCK_AT) return loopBlockedOutput(tool, state.count);
      if (state.count >= LOOP_WARN_AT) return LOOP_REMINDER_5;
      if (state.count >= LOOP_REMIND_AT) return LOOP_REMINDER_3;
      return "";
    }
    this.loopStates.set(session.id, { key, outputHash: fingerprint, count: 1 });
    return "";
  }

  /** 读取成功后登记文件版本，供后续同区间重复读短路；进程重启后 map 为空即自动失效。 */
  private async rememberReadVersion(
    session: SessionStore,
    callId: string,
    input: unknown,
    allowOutsideWorkspace: boolean,
  ): Promise<void> {
    const args = (input ?? {}) as Record<string, unknown>;
    const target = typeof args.path === "string" ? args.path.trim() : "";
    if (!target) return;
    try {
      const file = await resolveToolPath(session.cwd, target, allowOutsideWorkspace);
      const version = await captureVersion(file);
      if (version === "absent") return;
      this.readVersions.set(callId, { file, version });
      // 长会话里读很多文件：只保留最近 256 条，超出的按插入顺序淘汰
      if (this.readVersions.size > 256) {
        const oldest = this.readVersions.keys().next().value;
        if (oldest) this.readVersions.delete(oldest);
      }
    } catch {
      // 路径解析失败不影响读取结果
    }
  }

  /**
   * 同路径、同 offset/limit 的重复读短路（参考 ZCode 的 "file unchanged since your
   * last Read"）：只有“上一次结果仍在上下文里逐字可见”且“文件版本没变”时才 stub。
   * 编辑/写入会改变版本；外部改动也会改变版本；进程重启后没有版本记录，直接退回完整读取。
   */
  private async repeatedReadStub(
    session: SessionStore,
    messages: ChatMessage[],
    call: ToolCall,
    input: unknown,
    allowOutsideWorkspace: boolean,
  ): Promise<string | null> {
    if (call.function.name !== "read_file") return null;
    const args = (input ?? {}) as Record<string, unknown>;
    const target = typeof args.path === "string" ? args.path.trim() : "";
    if (!target) return null;
    const offset = args.offset === undefined ? "" : String(args.offset);
    const limit = args.limit === undefined ? "" : String(args.limit);

    const callArgs = new Map<string, Record<string, unknown>>();
    for (const message of messages) {
      if (message.role !== "assistant" || !message.tool_calls?.length) continue;
      for (const item of message.tool_calls) {
        try {
          const parsed = JSON.parse(item.function.arguments) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            callArgs.set(item.id, parsed as Record<string, unknown>);
          }
        } catch {
          // 参数不是合法 JSON 的历史记录跳过
        }
      }
    }

    // 从最新往回找同路径、同区间的 read_file 结果
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role !== "tool" || message.name !== "read_file") continue;
      const prior = callArgs.get(message.tool_call_id);
      if (!prior) continue;
      const priorPath = typeof prior.path === "string" ? prior.path.trim() : "";
      if (!priorPath || !sameFilePath(priorPath, target)) continue;
      const priorOffset = prior.offset === undefined ? "" : String(prior.offset);
      const priorLimit = prior.limit === undefined ? "" : String(prior.limit);
      if (priorOffset !== offset || priorLimit !== limit) continue;
      // 已被淘汰/摘要的结果不能再让模型“参考上一条”
      if (
        !message.content ||
        message.content.startsWith("[read_file output elided") ||
        message.content.startsWith("[summarized]")
      ) {
        continue;
      }
      const recorded = this.readVersions.get(message.tool_call_id);
      if (!recorded) continue;
      let file: string;
      try {
        file = await resolveToolPath(session.cwd, target, allowOutsideWorkspace);
      } catch {
        return null;
      }
      if (!sameFilePath(file, recorded.file)) continue;
      const current = await captureVersion(file);
      if (current === "absent" || current !== recorded.version) return null;
      return `Unchanged since your last read of ${target} (same offset/limit). Refer to that earlier tool result instead; use a different offset/limit if you need another part.`;
    }
    return null;
  }

  /**
   * context_status 的虚拟实现（P1-3）：executeTool 拿不到 runtime 的用量锚点，
   * 由 runtime 直接作答。读侧信息，plan 模式与 explore 子代理都放行。
   */
  private contextStatusOutput(): string {
    const usage = this.getContextUsage();
    const window = usage.contextWindow;
    const remaining = window ? Math.max(0, window - usage.usedTokens) : null;
    const percent = window ? Math.round((usage.usedTokens / window) * 100) : null;
    const head =
      window && remaining !== null && percent !== null
        ? `Context usage: ${usage.usedTokens} tokens used of ${window} (${percent}% used, ${remaining} remaining)`
        : `Context usage: ${usage.usedTokens} tokens used (context window unknown)`;
    const source = usage.source === "usage" ? " [provider-reported]" : " [estimated]";
    return [
      `${head}${source}`,
      `Breakdown: system ${usage.breakdown.system}, tool schemas ${usage.breakdown.tools}, conversation ${usage.breakdown.messages} (estimated).`,
      usage.recommendedCompaction
        ? "Recommendation: past 85% of the window. Finish the current step, avoid bulk reads, and wrap up or start a new session; older tool results are compacted automatically on overflow."
        : "Recommendation: enough headroom for now.",
    ].join("\n");
  }

  /**
   * 缓存策略（P0-3/P1-4）：Responses 协议的 prompt_cache_key 亲和值由 sessionId+用途
   * 派生，会话内稳定；Anthropic 的断点位置/TTL 由 cache-profile 在序列化时决定，
   * 这里不需要往 provider 上塞东西。
   * 只在 openai-responses 注入 —— chat completions 的未知字段会被部分严格网关拒绝，
   * 且 OpenAI/DeepSeek 的 chat 路径本来就是自动前缀缓存。
   */
  private applyCachePolicy(
    provider: ProviderConfig,
    sessionId: string,
    purpose = "main",
  ): ProviderConfig {
    if (resolveCachePlan(provider).protocol !== "openai-responses") return provider;
    return { ...provider, promptCacheKey: sessionAffinityKey(sessionId, purpose) };
  }

  async prompt(
    text: string,
    queueId?: string,
    images?: ToolImage[],
    documents?: ToolDocument[],
  ): Promise<void> {
    const session = this.currentSession;
    if (!session) throw new Error("No active session. Create a session first.");
    if (this.compactingSession) {
      throw new Error("Context compaction is running. Wait for it to finish before sending.");
    }
    const attachments = images?.length ? images : undefined;
    const documentAttachments = documents?.length ? documents : undefined;
    if (this.turnAbort) {
      if (this.runningSessionId !== session.id) {
        throw new Error("Another conversation is still generating. Stop it before sending here.");
      }
      const id = queueId ?? randomUUID();
      await session.appendQueuedPrompt(id, text);
      await session.flush();
      // 图片随队列项留在内存：排队期间进程退出会丢掉它们（和截图一致，不进磁盘）
      this.promptQueue.push({
        id,
        text,
        ...(attachments ? { images: attachments } : {}),
        ...(documentAttachments ? { documents: documentAttachments } : {}),
      });
      return;
    }
    await this.runPrompt(session, text, queueId, attachments, documentAttachments);
    while (this.promptQueue.length) {
      // 关停期间不启动下一轮；队列条目留在文件里，下次启动恢复为待发送
      if (this.shuttingDown) break;
      const current = this.currentSession;
      if (!current || current.id !== session.id) {
        await this.clearQueuedPrompts("discarded", session);
        break;
      }
      const next = this.promptQueue.shift()!;
      await this.runPrompt(current, next.text, next.id, next.images, next.documents);
    }
  }

  removeQueuedPrompt(id: string): boolean {
    const index = this.promptQueue.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.promptQueue.splice(index, 1);
    void this.currentSession?.appendQueuedPromptRemoved(id, "user").catch(() => undefined);
    return true;
  }

  /** 强制插话：中止当前回合，并把指定排队项提到队首立即执行。 */
  steerQueuedPrompt(id: string): void {
    const index = this.promptQueue.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("Queued prompt not found.");
    if (!this.turnAbort) throw new Error("No active turn to steer.");
    const [item] = this.promptQueue.splice(index, 1);
    this.promptQueue.unshift(item);
    // 审批弹窗打开时只 abort 信号没用：先按拒绝结算，回合才能真正退出
    this.settlePendingApprovals();
    this.abortSubagents();
    this.turnAbort.abort();
  }

  /** 每个模型轮次开始时重置半截回答检查点。 */
  private async startPartialRound(session: SessionStore): Promise<void> {
    if (!this.currentTurnId) return;
    if (this.partialDraft) await this.finishPartialRound(session);
    this.partialRound += 1;
    this.partialDraft = {
      session,
      turnId: this.currentTurnId,
      round: this.partialRound,
      content: "",
      reasoning: "",
      lastWriteAt: 0,
      lastLength: 0,
      chain: Promise.resolve(),
    };
  }

  private appendPartialDelta(kind: "content" | "reasoning", delta: string): void {
    const draft = this.partialDraft;
    if (!draft || !delta) return;
    if (kind === "content") draft.content += delta;
    else draft.reasoning += delta;
    const now = Date.now();
    const length = draft.content.length + draft.reasoning.length;
    // 1s / 2KB 节流：足够覆盖崩溃丢字窗口，又不会把每个 delta 都写盘
    if (now - draft.lastWriteAt < 1_000 && length - draft.lastLength < 2_048) return;
    draft.lastWriteAt = now;
    draft.lastLength = length;
    const snapshot = { content: draft.content, reasoning: draft.reasoning };
    draft.chain = draft.chain
      .then(() =>
        draft.session.writePartial({
          turnId: draft.turnId,
          round: draft.round,
          ...snapshot,
        }),
      )
      .catch(() => undefined);
  }

  /** 一轮模型调用已完整落盘，删除临时检查点。 */
  private async finishPartialRound(session: SessionStore): Promise<void> {
    const draft = this.partialDraft;
    if (!draft) return;
    this.partialDraft = null;
    await draft.chain.catch(() => undefined);
    await session.clearPartial().catch(() => undefined);
  }

  /** 回合异常/中止时把已收到的半截文本补成 assistant 消息。 */
  private async finalizePartial(session: SessionStore): Promise<void> {
    const draft = this.partialDraft;
    if (!draft) return;
    this.partialDraft = null;
    await draft.chain.catch(() => undefined);
    if (draft.content.trim() || draft.reasoning.trim()) {
      await session.appendMessage({
        role: "assistant",
        content: draft.content,
        ...(draft.reasoning ? { reasoning: draft.reasoning } : {}),
      });
      await session.flush();
    }
    await session.clearPartial().catch(() => undefined);
  }

  private async runPrompt(
    session: SessionStore,
    text: string,
    queuedId?: string,
    images?: ToolImage[],
    documents?: ToolDocument[],
  ): Promise<void> {
    // 先置位再 await：避免运行中的第二个 prompt 在 appendMessage 窗口里并发开跑
    this.turnAbort = new AbortController();
    this.runningSessionId = session.id;
    this.turnApprovalMode = this.approvalMode;
    this.turnChatMode = this.chatMode;
    this.lastErrorMessage = null;
    const turnId = randomUUID();
    this.currentTurnId = turnId;
    this.partialRound = 0;
    this.partialDraft = null;
    this.subagentsStartedThisTurn = 0;
    this.verifyFailuresThisTurn = 0;
    const provider = this.activeProvider();
    let status: TurnStatus = "completed";
    let errorMessage: string | undefined;
    try {
      // 插件 hook：prompt_submit（可 block / 改写文本）。改写后的文本参与落盘与请求；
      // blocked → 落盘用户消息后直接给一条 assistant 说明，回合正常收尾。
      const submitted = await runHook(this.plugins, "prompt_submit", {
        hook: "prompt_submit",
        sessionId: session.id,
        text,
      });
      if (typeof submitted?.text === "string") text = submitted.text;
      // 技能引用回合不受会话权限模式影响：技能里的写文件/命令直接执行，回合结束自动恢复原模式
      if (hasSkillReference(text)) this.turnApprovalMode = "full";
      await session.appendTurnStart({
        turnId,
        ...(queuedId ? { queueId: queuedId } : { text }),
        providerId: provider.id,
        model: provider.model,
        approvalMode: this.turnApprovalMode ?? this.approvalMode,
      });
      await session.appendMessage({
        role: "user",
        content: text,
        ...(images?.length ? { images } : {}),
        ...(documents?.length ? { documents } : {}),
      });
      await session.flush();
      this.emit({
        type: "message_start",
        sessionId: session.id,
        ...(queuedId ? { queuedId } : {}),
      });
      if (submitted?.block) {
        const reason = submitted.reason
          ? `Prompt blocked by plugin: ${submitted.reason}`
          : "Prompt blocked by plugin.";
        await session.appendMessage({ role: "assistant", content: reason });
        await session.flush();
        this.emit({ type: "assistant_delta", sessionId: session.id, delta: reason });
        this.emit({ type: "message_complete", sessionId: session.id, text: reason });
        return;
      }
      // 插件 hook：turn_start（观察）
      await runHook(this.plugins, "turn_start", {
        hook: "turn_start",
        sessionId: session.id,
        turnId,
        text,
      });
      // @文件引用：内容作为上下文条目参与本轮请求，不显示在聊天时间线。
      // 预算跟随模型窗口；已注入过的文件只留占位，避免多轮重复烧 token。
      try {
        const fileContext = await buildFileMentionContext(session.cwd, text, {
          tokenBudget: mentionTokenBudget(provider.contextWindow),
          seen: collectInjectedPaths(session.effectiveMessages),
          // 被编辑过的文件：历史里的注入内容已过期，这一轮重新注入最新内容
          mutated: this.mutatedPaths.get(session.id),
        });
        if (fileContext) {
          await session.appendContextNote(fileContext, "file");
          await session.flush();
        }
      } catch {
        // 引用读取失败不应打断回合
      }
      // 新的用户请求 = 新任务：上一条已完成的治理 run 清空，门禁重新武装。
      // 架构图快照按 run 冻结（metis 同款）：只在空闲时装载当前档位的架构图。
      // 治理关闭时也要装载：角色节点的工具/提示词覆盖与治理无关。
      if (this.enableTaskTool && !this.workflow.active) {
        try {
          this.workflow.setHarness(
            await loadHarnessDocument(session.cwd, this.currentHarnessArchitecture),
          );
        } catch {
          // 读取失败保持当前图
        }
      }
      if (this.workflow.state?.completed) this.workflow.reset();
      this.mutationsSincePlanCheck = 0;
      await this.runTurn(session);
      // 宿主续命循环（metis _unfinishedPerformanceContinuation）：治理 run 仍活跃
      // 而模型停止了回答 → 注入 frontier 强制继续，最多 2 次；谎报完成不许蒙混过关
      let continuations = 0;
      while (continuations < MAX_WORKFLOW_CONTINUATIONS && (await this.handlePostPrompt(session))) {
        continuations += 1;
        await this.runTurn(session);
      }
    } catch (error) {
      // 用户中止（停止 / 强制插话）不是错误：fetch、SSE、退避等待的文案各不相同
      const aborted = isAbortError(error) || this.turnAbort?.signal.aborted === true;
      status = aborted ? "aborted" : "error";
      if (!aborted) {
        errorMessage = error instanceof Error ? error.message : String(error);
        this.lastErrorMessage = errorMessage;
        this.emit({ type: "error", sessionId: session.id, message: errorMessage });
      }
    } finally {
      try {
        await this.finalizePartial(session);
        await session.appendTurnEnd({
          turnId,
          status,
          ...(errorMessage ? { error: errorMessage } : {}),
        });
        await session.flush();
      } catch {
        // 落盘失败也必须发出 turn_complete，否则前端一直显示生成中
      }
      this.turnAbort = null;
      this.runningSessionId = null;
      this.turnApprovalMode = null;
      this.turnChatMode = null;
      this.currentTurnId = null;
      this.partialDraft = null;
      for (const resolver of this.pendingApprovals.values()) resolver(false);
      this.pendingApprovals.clear();
      this.pendingApprovalDetails = null;
      for (const resolver of this.pendingAsks.values()) resolver([]);
      this.pendingAsks.clear();
      this.pendingAskDetails = null;
      // 插件 hook：turn_end（观察）；不阻断 turn_complete
      try {
        await runHook(this.plugins, "turn_end", {
          hook: "turn_end",
          sessionId: session.id,
          turnId,
          status,
          ...(errorMessage !== undefined ? { error: errorMessage } : {}),
        });
      } catch {
        // 收尾阶段的 hook 异常一律吞掉
      }
      this.emit({ type: "turn_complete", sessionId: session.id });
      // 标题生成放在回合结束后；后台子 Agent 还在跑时先不抢 provider 并发，
      // 等它们结束后再补。
      if (!session.hasTitle) {
        // 标题只看用户真正写的话：首部引用块（【附件】/【技能引用】…）不是需求本身。
        // 只挂附件没写正文时退回"附件：a.pdf"这类标签，别让标题变成一串绝对路径。
        const titleSource = stripReferenceHeader(text) || referenceLabel(text) || text;
        if (this.hasLiveSubagents) this.pendingTitle = { session, text: titleSource };
        else this.spawnTitleGeneration(session, titleSource);
      }
    }
  }

  /** 若之前因后台子 Agent 暂缓了标题生成，现在没有 live 子 Agent 时补上。 */
  private flushPendingTitle(): void {
    const pending = this.pendingTitle;
    if (!pending || this.hasLiveSubagents) return;
    this.pendingTitle = null;
    if (pending.session.hasTitle) return;
    this.spawnTitleGeneration(pending.session, pending.text);
  }

  /**
   * 后台生成会话标题并广播。
   * 只在首条用户消息时调用（hasTitle 保证幂等）；生成失败就静默放弃，
   * 列表和头部继续显示回退文案，不影响主对话。
   */
  private spawnTitleGeneration(session: SessionStore, userMessage: string): void {
    const provider = this.activeProvider();
    this.asyncTasks += 1;
    void generateSessionTitle({
      // 辅助请求缓存亲和（P1-4）：标题请求与会话绑定，Responses 协议命中前缀缓存
      provider: this.applyCachePolicy(provider, session.id, "title"),
      userMessage,
      signal: this.turnAbort?.signal,
      onUsage: (usage) => {
        void session
          .appendUsage({
            ...usage,
            source: "title",
            providerId: provider.id,
            model: provider.model,
          })
          .catch(() => undefined);
      },
    })
      .then(async (title) => {
        if (this.currentSession !== session) return; // 期间切走了会话就丢弃
        await session.appendTitle(title);
        this.emit({ type: "session_title", sessionId: session.id, title });
      })
      .catch(() => undefined) // 标题失败不值得打扰用户
      .finally(() => {
        this.asyncTasks = Math.max(0, this.asyncTasks - 1);
      });
  }

  /**
   * 用当前模型生成 commit message（Git 面板的「AI 生成」按钮）。
   *
   * 与标题生成同构：复用当前 provider、绑定会话缓存亲和、不写会话、不计 usage
   * （避免为了一行文案动 UsageSource 与统计 UI）。失败直接抛错，由前端降级为手写。
   */
  async generateCommitMessage(
    context: CommitContext,
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const session = this.currentSession;
    const provider = this.activeProvider();
    return generateCommitMessage({
      provider: session
        ? this.applyCachePolicy(provider, session.id, "commit")
        : provider,
      context,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  /** 用户手动改名（会话列表暂未提供入口，接口先备好）。 */
  async renameSession(title: string): Promise<string> {
    const session = this.currentSession;
    if (!session) throw new Error("No active session.");
    const trimmed = title.trim().slice(0, 100);
    if (!trimmed) throw new Error("Title must not be empty.");
    await session.appendTitle(trimmed);
    this.emit({ type: "session_title", sessionId: session.id, title: trimmed });
    return trimmed;
  }

  private async runTurn(session: SessionStore): Promise<void> {
    const provider = this.activeProvider();
    // 原生压缩点的加密 item 与端点/模型绑定：每回合开始先判定能否重放
    this.syncNativeReplay();
    await this.refreshInstructions(session);
    await this.ensurePlanContext(session);
    // 每回合重置循环检测：跨回合的相同调用多是用户再次要求，不算循环
    this.resetLoopState(session.id);
    // 薄循环/厚宿主：轮次迭代在 agent-loop.ts，这里把 runtime 能力按接口交出去
    await runAgentLoop(this.createLoopHost(session, provider));
  }

  /**
   * 回合结束后的宿主续命判定（metis _handlePostAgentRun 的治理分支）：
   * run 活跃且未卡死 → 持久化一条 workflow 上下文并要求继续；
   * 全部剩余 lane 都 blocked（修复上限）→ 不再催，让模型把阻塞如实上报用户。
   */
  private async handlePostPrompt(session: SessionStore): Promise<boolean> {
    if (!this.workflow.shouldContinue) return false;
    if (this.turnAbort?.signal.aborted) return false;
    if (!this.governanceApplies()) return false;
    const frontier = this.workflow.frontier();
    if (!frontier) return false;
    await session
      .appendContextNote(
        `[workflow] The governed run is still active — do not claim completion yet.\n${frontier}`,
        "workflow",
      )
      .catch(() => undefined);
    await session.flush().catch(() => undefined);
    return true;
  }

  /**
   * 薄循环的宿主适配层：会话落盘、事件广播、上下文记账、工具执行全部
   * 经 AgentLoopHost 委托给 AgentRuntime；治理 hooks（Step 4）后续在此注册。
   */
  private createLoopHost(session: SessionStore, provider: ProviderConfig): AgentLoopHost {
    // 增量传输（实验 incrementalResponses，codex 式 previous_response_id）：
    // 链签名锁定 provider/model/工具集/系统提示；压缩、裁剪、纪要都会改写前缀，
    // 消息引用快照校验不过就自动全量重发（store:true 重建链首）。
    const incrementalOn =
      Boolean(this.experimental?.incrementalResponses) && provider.protocol === "openai-responses";
    const incrementalSig = incrementalOn
      ? [
          provider.id,
          provider.model,
          this.activeTools.map((tool) => tool.function.name).join(","),
          this.systemMessages().map((message) => message.content).join("\n"),
        ].join("|")
      : "";

    // 本回合实际使用的 provider：故障转移会就地替换它（用户的全局配置不动），
    // 后续每一跳的 maxTokens / 缓存 key / 增量链都按当前值重算。
    let turnProvider = provider;
    /** 已尝试过的 provider id：切链去重，防止 A→B→A 反复跳 */
    const triedProviders = new Set<string>([provider.id]);

    return {
      initialMessages: () => {
        const messages: ChatMessage[] = [
          ...this.systemMessages(),
          ...projectForRequest(session.effectiveMessages, turnProvider),
        ];
        // 治理 run 活跃时在尾部注入 frontier 提醒（ephemeral：不落盘，随回合结束消失）
        const frontier = this.workflow.frontier();
        if (frontier && this.governanceApplies()) {
          messages.push({ role: "user", content: `[workflow]\n${frontier}` });
        }
        return messages;
      },
      provider: () => turnProvider,
      tools: () => this.activeTools,
      usageAnchor: () => this.usageAnchor,
      aborted: () => this.turnAbort?.signal.aborted === true,
      abortSignal: () => this.turnAbort?.signal,
      incremental: () => ({
        enabled: incrementalOn && turnProvider.protocol === "openai-responses",
        signature: incrementalSig,
      }),
      /**
       * 故障转移：只有「换一家可能就好了」的错误才会走到这里（见 provider-fallback）。
       * 返回 null = 不切，让循环把原错误抛给用户。
       */
      fallbackProvider: (error) => {
        const reason = failoverReason(error);
        if (!reason) return null;
        const chain = planFallbacks(
          this.providers,
          turnProvider.id,
          undefined,
          turnProvider.fallbackIds,
        );
        const next = chain.find((candidate) => !triedProviders.has(candidate.id));
        if (!next) return null;
        const from = turnProvider;
        triedProviders.add(next.id);
        turnProvider = next;
        // 换端点等于换缓存分片与上下文计量基准：用量锚点失效，增量链作废。
        this.usageAnchor = null;
        this.responsesChains.delete(session.id);
        // 加密的 native compaction item 只认生成它的端点：新 provider 不能重放就退回本地摘要
        this.syncNativeReplay(next);
        this.cancelWarmupCompaction();
        this.emit({
          type: "provider_switched",
          sessionId: session.id,
          from: from.id,
          to: next.id,
          reason,
        });
        return next;
      },
      resolveRequestProvider: ({ messages, maxTokens }) => {
        let requestProvider: ProviderConfig = {
          ...this.applyCachePolicy(turnProvider, session.id),
          maxTokens,
        };
        // 思考档位按会话模式升一档（plan/goal 要更长的推理链）；显式预算不参与升档，
        // 用户手填的数字是精确意图，不该被模式悄悄改掉。
        const mode = this.turnChatMode ?? this.chatMode;
        if ((mode === "plan" || mode === "goal") && turnProvider.thinkingBudget === undefined) {
          const boosted = boostEffort(turnProvider.reasoningEffort, turnProvider.reasoningLevels);
          if (boosted && boosted !== turnProvider.reasoningEffort) {
            requestProvider = { ...requestProvider, reasoningEffort: boosted };
          }
        }
        if (incrementalOn && turnProvider.protocol === "openai-responses") {
          // 增量链按迭代验证：消息列表必须是上次快照的严格追加（引用未变 ⇒ 内容未变）
          const chain = this.responsesChains.get(session.id);
          if (
            chain &&
            chain.requestSig === incrementalSig &&
            messages.length > chain.sentRefs.length &&
            chain.sentRefs.every((ref, index) => messages[index] === ref)
          ) {
            requestProvider = {
              ...requestProvider,
              incremental: { responseId: chain.responseId, fromIndex: chain.sentInputLength },
            };
          } else {
            // 链首请求：全量发送但 store:true，响应成为下一轮可续接的链
            requestProvider = { ...requestProvider, incremental: {} };
          }
        }
        return requestProvider;
      },
      commitResponseChain: ({ responseId, messages }) => {
        if (responseId) {
          this.responsesChains.set(session.id, {
            responseId,
            sentInputLength: toResponsesInput(messages).length,
            sentRefs: [...messages],
            requestSig: incrementalSig,
          });
        } else {
          this.responsesChains.delete(session.id);
        }
      },
      onRoundStart: async () => {
        await this.startPartialRound(session);
        this.earlyToolRuns.clear();
      },
      onDelta: (delta) => {
        this.appendPartialDelta("content", delta);
        this.emit({ type: "assistant_delta", sessionId: session.id, delta });
      },
      onThinking: (delta) => {
        this.appendPartialDelta("reasoning", delta);
        this.emit({ type: "thinking_delta", sessionId: session.id, delta });
      },
      onToolCallProgress: (progress) => {
        this.emit({
          type: "tool_call_progress",
          sessionId: session.id,
          count: progress.count,
          ...(progress.tool ? { tool: progress.tool } : {}),
          ...(progress.names?.length ? { names: progress.names } : {}),
          ...(progress.path ? { path: progress.path } : {}),
          chars: progress.chars,
        });
      },
      // 流中提前执行（实验开关 midstreamToolExec）：startEarlyToolRun 内部自检开关
      onToolCallComplete: (call, messages) => this.startEarlyToolRun(session, call, messages),
      stream: (options) => streamChatCompletion(options),
      persistAssistantMessage: async (message) => {
        await session.appendMessage(message);
        await session.flush();
        await this.finishPartialRound(session);
      },

      recordUsage: async (usage) => {
        if (usage.inputTokens && this.currentSession?.id === session.id) {
          // 后台会话的用量不能覆盖当前正在看的会话的上下文占用。
          // 锚点覆盖到「刚 append 的assistant 回复」为止：之后新增的工具结果/回合
          // 由 estimateContextTokens 单独补算，不再整段重估。
          this.usageAnchor = {
            inputTokens: usage.inputTokens,
            messageCount: session.effectiveMessages.length,
          };
        }
        if (
          usage.inputTokens !== undefined ||
          usage.outputTokens !== undefined ||
          usage.cacheReadTokens !== undefined ||
          usage.cacheWriteTokens !== undefined
        ) {
          await session.appendUsage({
            ...usage,
            source: "chat",
            ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
            // 用量记在实际应答的那一家头上（切链后与用户配置的 provider 可能不同）
            providerId: turnProvider.id,
            model: turnProvider.model,
          });
        }
        this.emit({
          type: "usage",
          sessionId: session.id,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          ...(usage.cacheReadTokens !== undefined
            ? { cacheReadTokens: usage.cacheReadTokens }
            : {}),
          ...(usage.cacheWriteTokens !== undefined
            ? { cacheWriteTokens: usage.cacheWriteTokens }
            : {}),
        });
        // 真实用量过阈值：后台预热压缩（codex PostTurn 阶段），不阻塞当前回合
        if (usage.inputTokens && this.currentSession?.id === session.id) {
          this.maybeStartCompactionWarmup(session, turnProvider);
          // 85%+ 的主动压缩档：采纳就绪的预热摘要或补启预热，把压缩放在回合之间
          void this.maybeProactiveCompaction(session, turnProvider).catch(() => undefined);
        }
      },
      onMessageComplete: (result) => {
        this.emit({
          type: "message_complete",
          sessionId: session.id,
          text: result.message.content ?? "",
          ...(result.message.reasoning ? { reasoning: result.message.reasoning } : {}),
        });
      },
      onError: (message) => this.emit({ type: "error", sessionId: session.id, message }),
      persistMetrics: (timing) =>
        this.persistTurnMetrics(session, timing.startedAt, timing.firstDeltaAt, timing.lastSpeed),
      escalateOnOverflow: (messages, stage) =>
        this.escalateOnOverflow(session, turnProvider, messages, stage),
      executeToolCall: (call, messages) => this.executeToolCallTracked(session, messages, call),
      executeTaskToolCall: (call) => this.executeTaskToolCall(session, call),
      executeReadOnlyToolCall: (call, messages) =>
        this.executeReadOnlyToolCall(session, call, messages),
      pushToolMessage: async (messages, message) => {
        await this.pushToolMessage(session, messages, message);
      },
      earlyRun: (callId) => this.earlyToolRuns.get(callId),
      onToolBlocked: (call, message) => {
        // 门禁拦截也要有完整 UI 事件（与插件 block 的形态一致）
        this.emit({
          type: "tool_started",
          sessionId: session.id,
          callId: call.id,
          tool: call.function.name,
          input: safeToolInput(call),
        });
        this.emit({
          type: "tool_output",
          sessionId: session.id,
          callId: call.id,
          output: message.content,
          truncated: false,
        });
        this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: false });
      },
      hooks: this.createLoopHooks(session),
    };
  }

  /** 治理是否对当前会话生效：off 永不；goal 仅 goal 模式；always 恒生效。 */
  private governanceApplies(): boolean {
    if (this.governance === "off") return false;
    if (this.governance === "always") return true;
    return (this.turnChatMode ?? this.chatMode) === "goal";
  }

  /** 治理 roadmap 快照事件（每次状态变化后全量推送，前端面板单一数据源）。 */
  private emitWorkflowRoadmap(session: SessionStore): void {
    const snapshot = this.workflow.snapshot();
    if (!snapshot) return;
    this.emit({
      type: "workflow_roadmap",
      sessionId: session.id,
      tier: snapshot.tier,
      completed: snapshot.completed,
      lanes: snapshot.lanes,
    });
  }

  /**
   * 重新装载工作区架构图（PUT /harness 后由 server 调用）：
   * 异步、只在空闲时装载 —— 活跃 run 的快照冻结，不中途换图（metis 同款）。
   */
  refreshHarness(): void {
    if (!this.enableTaskTool) return;
    const session = this.currentSession;
    if (!session || this.workflow.active) return;
    void loadHarnessDocument(session.cwd, this.currentHarnessArchitecture)
      .then((doc) => this.workflow.setHarness(doc))
      .catch(() => undefined);
  }

  /**
   * 治理 hooks（只在根 runtime 生效；子 Agent 的 enableTaskTool=false 天然跳过）：
   * - beforeToolCall：admit 之前拦截变更类工具（含 task 派发）
   * - afterToolCall：根侧文件改动即 T1 G4 证据；计数未更新清单的变更
   * - prepareNextTurn：run 活跃注入 frontier；连续 8 次变更没 update_plan 则 nudge
   */
  private createLoopHooks(session: SessionStore): AgentLoopHooks | undefined {
    if (!this.enableTaskTool) return undefined;
    return {
      beforeToolCall: async (call) => {
        if (!this.governanceApplies() || !this.workflow.needsAdmission) return;
        if (!GOVERNANCE_GATED_TOOLS.has(call.function.name)) return;
        return {
          block: true,
          reason:
            "governance gate — call admit first to declare the task shape (tier T0/T1/T2, lanes), then mutating tools unlock",
        };
      },
      afterToolCall: async (call) => {
        const tool = call.function.name;
        if (tool === "update_plan") {
          this.mutationsSincePlanCheck = 0;
          return;
        }
        if (!this.workflow.active) return;
        if (tool === "write_file" || tool === "edit_file" || tool === "multi_edit") {
          this.mutationsSincePlanCheck += 1;
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
          } catch {
            input = {};
          }
          const first = writablePaths(tool, input)[0];
          if (first) {
            const gateMessage = this.workflow.noteRootMutation(String(first));
            if (gateMessage) {
              const laneId = this.workflow.state?.lanes[0]?.id ?? "main";
              await session
                .appendGateReport({
                  laneId,
                  gate: "G4",
                  verdict: "pass",
                  agentId: "root",
                  message: gateMessage,
                })
                .catch(() => undefined);
              this.emit({
                type: "workflow_gate",
                sessionId: session.id,
                laneId,
                gate: "G4",
                verdict: "pass",
                agentId: "root",
                message: gateMessage,
              });
              this.emitWorkflowRoadmap(session);
            }
          }
        }
      },
      prepareNextTurn: async (messages) => {
        const injections: ChatMessage[] = [];
        if (this.workflow.active && this.governanceApplies()) {
          const frontier = this.workflow.frontier();
          if (frontier) injections.push({ role: "user", content: `[workflow]\n${frontier}` });
          if (this.mutationsSincePlanCheck >= 8) {
            injections.push({
              role: "user",
              content:
                "[workflow] You have made several file changes without updating the plan checklist. Call update_plan so the user can see current progress.",
            });
          }
        }
        return injections.length ? [...messages, ...injections] : undefined;
      },
    };
  }

  private async persistTurnMetrics(
    session: SessionStore,
    turnStartedAt: number,
    firstDeltaAt: number | null,
    lastSpeed: number | null,
  ): Promise<void> {
    await session
      .appendMetrics({
        responseMs: Date.now() - turnStartedAt,
        ...(firstDeltaAt != null ? { firstTokenMs: firstDeltaAt - turnStartedAt } : {}),
        ...(lastSpeed != null ? { tokensPerSecond: lastSpeed } : {}),
        ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
        status: "completed",
      })
      .catch(() => undefined);
  }

  /** 只读工具并发执行：事件按 callId 匹配，结果仍按原顺序落盘。 */
  /**
   * tool_call_started 只是崩溃恢复用的标记，写失败不能取消本应执行的工具。
   * 并行批里尤其重要：Promise.all 一旦 reject，同批已完成的结果会全部丢掉。
   */
  private async markToolCallStarted(
    session: SessionStore,
    entry: { turnId: string; callId: string; tool: string; input: unknown },
  ): Promise<void> {
    try {
      await session.appendToolCallStarted(entry);
      await session.flush();
    } catch (error) {
      console.error(
        `[meowcode] failed to journal tool_call_started for ${entry.tool}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * 流中提前执行（实验开关 midstreamToolExec）：模型还在输出后续工具调用时，
   * 参数已完整闭合的只读调用立即启动执行。只读白名单保证最坏情形（流中断后
   * 参数被判错）也只是多跑一次搜索；结果等分派阶段按原序落盘，事件顺序不变。
   */
  private startEarlyToolRun(
    session: SessionStore,
    call: ToolCall,
    messages: ChatMessage[],
  ): void {
    if (!this.experimental?.midstreamToolExec) return;
    if (!READ_ONLY_PARALLEL_TOOLS.has(call.function.name)) return;
    if (!call.id || this.earlyToolRuns.has(call.id)) return;
    if (this.turnAbort?.signal.aborted) return;
    this.earlyToolRuns.set(call.id, this.executeReadOnlyToolCall(session, call, messages));
  }

  private async executeReadOnlyToolCall(
    session: SessionStore,
    call: ToolCall,
    messages: ChatMessage[],
  ): Promise<Extract<ChatMessage, { role: "tool" }>> {    let input: unknown = {};
    try {
      input = JSON.parse(call.function.arguments || "{}");
    } catch {
      input = {};
    }
    const tool = call.function.name;
    const turnId = this.currentTurnId;
    if (turnId) await this.markToolCallStarted(session, { turnId, callId: call.id, tool, input });
    this.emit({ type: "tool_started", sessionId: session.id, callId: call.id, tool, input });
    if (!this.toolAllowed(tool)) {
      const output = `Tool ${tool} is not available for this agent profile.`;
      this.emit({ type: "tool_output", sessionId: session.id, callId: call.id, output, truncated: false });
      this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: false });
      return { role: "tool", content: output, tool_call_id: call.id, name: tool };
    }
    // context_status 是 runtime 的虚拟工具：executeTool 拿不到用量锚点，这里直接作答
    if (tool === "context_status") {
      const output = this.contextStatusOutput();
      this.emit({ type: "tool_output", sessionId: session.id, callId: call.id, output, truncated: false });
      this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: true });
      return { role: "tool", content: output, tool_call_id: call.id, name: tool };
    }
    // 循环拦截（P1-2）：零信息重复达 8 次就不再执行
    const blocked = this.loopBlockFor(session, tool, input);
    if (blocked) {
      this.emit({ type: "tool_output", sessionId: session.id, callId: call.id, output: blocked, truncated: false });
      this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: false });
      return { role: "tool", content: blocked, tool_call_id: call.id, name: tool };
    }
    const allowOutsideWorkspace =
      (this.turnApprovalMode ?? this.approvalMode) === "full";
    // 重复读短路：只读快路径同样生效
    if (tool === "read_file") {
      const stub = await this.repeatedReadStub(
        session,
        messages,
        call,
        input,
        allowOutsideWorkspace,
      );
      if (stub) {
        const loopNote = this.noteLoopResult(session, tool, input, stub);
        const output = loopNote ? `${stub}\n\n${loopNote}` : stub;
        this.emit({
          type: "tool_output",
          sessionId: session.id,
          callId: call.id,
          output,
          truncated: false,
        });
        this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: true });
        return { role: "tool", content: output, tool_call_id: call.id, name: tool };
      }
    }
    const result = await executeTool(tool, input, session.cwd, {
      allowOutsideWorkspace,
      signal: this.turnAbort?.signal,
      vision: this.toolVisionEnabled(),
      shrinkImage: this.imageShrinker(),
      hostToolBridge: (bridgeTool, bridgeArgs) =>
        this.runCodeHostTool(session, call.id, bridgeTool, bridgeArgs),
    });
    if (tool === "read_file" && result.ok && !result.images?.length) {
      await this.rememberReadVersion(session, call.id, input, allowOutsideWorkspace);
    }
    const loopNote = this.noteLoopResult(session, tool, input, result.output);
    const output = loopNote ? `${result.output}\n\n${loopNote}` : result.output;
    this.emit({
      type: "tool_output",
      sessionId: session.id,
      callId: call.id,
      output,
      truncated: result.truncated ?? output.length > 20000,
    });
    this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: result.ok });
    return {
      role: "tool",
      content: output,
      tool_call_id: call.id,
      name: tool,
      ...(result.images?.length ? { images: result.images } : {}),
    };
  }

  /** task 在并发批次里的入口：自己完成校验/落盘/事件，然后等待子 Agent。 */
  private async executeTaskToolCall(
    session: SessionStore,
    call: ToolCall,
  ): Promise<Extract<ChatMessage, { role: "tool" }>> {
    const validated = validateToolArguments("task", call.function.arguments);
    const input = validated.ok ? validated.input : {};
    const turnId = this.currentTurnId;
    if (validated.ok && turnId) {
      await this.markToolCallStarted(session, { turnId, callId: call.id, tool: "task", input });
    }
    this.emit({ type: "tool_started", sessionId: session.id, callId: call.id, tool: "task", input });
    if (!validated.ok) {
      const output = `Tool call rejected: ${validated.error}`;
      this.emit({ type: "tool_output", sessionId: session.id, callId: call.id, output, truncated: false });
      this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: false });
      return { role: "tool", content: output, tool_call_id: call.id, name: "task" };
    }
    // 计划模式禁止子 Agent：子代理会绕过 plans/ 门控，直接拒绝
    if ((this.turnChatMode ?? this.chatMode) === "plan") {
      const output = planModeRejection("task");
      this.emit({ type: "tool_output", sessionId: session.id, callId: call.id, output, truncated: false });
      this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: false });
      return { role: "tool", content: output, tool_call_id: call.id, name: "task" };
    }
    const result = await this.runSubagentTask(session, call, input);
    const truncated = truncateOutput(result.output);
    this.emit({
      type: "tool_output",
      sessionId: session.id,
      callId: call.id,
      output: truncated.output,
      truncated: truncated.truncated,
    });
    this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: result.ok });
    return { role: "tool", content: truncated.output, tool_call_id: call.id, name: "task" };
  }

  /**
   * 派发一个通用子 Agent：独立 runtime/会话/abort/审批，工具集去掉 task。
   * 父 turn 会等待它结束，把最终报告作为 task 工具结果交还模型。
   */
  private resolveSubagentProvider(input: unknown): {
    providers: ProviderConfig[];
    providerId: string;
  } {
    const providers = JSON.parse(JSON.stringify(this.providers)) as ProviderConfig[];
    const args = (input ?? {}) as Record<string, unknown>;
    const requestedId = typeof args.provider === "string" ? args.provider.trim() : "";
    const chosen =
      providers.find(
        (provider) => provider.id === requestedId && provider.enabled !== false,
      ) ??
      providers.find((provider) => provider.id === this.providerId) ??
      providers[0];
    const effort =
      typeof args.reasoning_effort === "string" ? args.reasoning_effort.trim() : "";
    if (
      chosen &&
      effort &&
      (!chosen.reasoningLevels?.length || chosen.reasoningLevels.includes(effort))
    ) {
      chosen.reasoningEffort = effort;
    }
    return { providers, providerId: chosen?.id ?? this.providerId };
  }

  private createSubagentRuntime(params: {
    session: SessionStore;
    agentId: string;
    parentSessionId: string;
    cwd: string;
    description: string;
    agentType: SubagentType;
    providers: ProviderConfig[];
    providerId: string;
    observations: SubagentObservations;
  }): AgentRuntime {
    // 角色装配走注册表：提示词 / 工具白名单 / AGENTS.md 注入随角色定义；
    // 架构图角色节点可以覆盖提示词与工具白名单（空提示词 = 回落内置）。
    const definition = definitionFor(params.agentType);
    const override = this.workflow.roleOverride(params.agentType);
    const overridePrompt = override?.systemPrompt;
    const effectivePrompt = overridePrompt?.trim() ? overridePrompt : definition.systemPrompt;
    const roleTools = override?.tools
      ? new Set(override.tools.filter((tool) => tool !== "task"))
      : definition.tools;
    // 档位白名单也约束子 Agent：极简档的 general 同样只有 read_file / run_command
    const profileTools = this.activeProfile.tools;
    const effectiveTools = !profileTools
      ? roleTools
      : new Set(
          [...(roleTools ?? profileTools)].filter(
            (tool) => tool === "task" || tool === "admit" || profileTools.has(tool),
          ),
        );
    const child = new AgentRuntime({
      providers: params.providers,
      providerId: params.providerId,
      sessionsDir: path.join(this.sessionsDir, "subagents", params.parentSessionId),
      workspace: params.cwd,
      browserHost: this.browserHost,
      enableTaskTool: false,
      systemPrompt: effectivePrompt,
      ...(effectiveTools ? { allowedTools: effectiveTools } : {}),
      ...(definition.injectInstructions === false ? { injectInstructions: false } : {}),
      onFileChange: async (change) => {
        // 宿主观测：子 Agent 的文件改动即 ground truth（不信任自述）
        params.observations.filesChanged.add(change.path);
        await params.session.appendFileChange(change.path, change.operation, change.diff);
        await params.session.flush();
        // 不带 agentId：父级 file_changed 要触发主界面审阅，而不是被当成子事件过滤掉。
        this.emit({
          type: "file_changed",
          sessionId: params.parentSessionId,
          path: change.path,
          operation: change.operation,
        });
      },
    });
    child.onEvent((event) => {
      // 宿主观测：run_command 的起止配对（argv 来自 tool_started 的 input，
      // exitCode 以 ok 近似 —— 治理门禁只关心"是否全 0"）
      if (event.type === "tool_started" && event.tool === "run_command") {
        const command = (event.input as { command?: unknown } | undefined)?.command;
        if (typeof command === "string" && command.trim()) {
          params.observations.pendingCommands.set(event.callId, command.trim().slice(0, 300));
        }
      } else if (event.type === "tool_finished") {
        const argv = params.observations.pendingCommands.get(event.callId);
        if (argv !== undefined) {
          params.observations.pendingCommands.delete(event.callId);
          params.observations.commands.push({ argv, exitCode: event.ok ? 0 : 1 });
        }
      }
      this.emit({
        ...event,
        agentId: params.agentId,
        parentSessionId: params.parentSessionId,
        agentDescription: params.description,
      });
    });
    return child;
  }

  /** 创建子会话、启动 child runtime，并返回一个最终结算的 promise。 */
  private async beginSubagent(
    session: SessionStore,
    call: ToolCall,
    input: unknown,
  ): Promise<StartedSubagent> {
    const args = (input ?? {}) as Record<string, unknown>;
    const description = String(args.description ?? "").trim().slice(0, 100);
    const promptInput = String(args.prompt ?? "").trim();
    const requestedRole = args.agent_type;
    const allowedRoles = this.activeProfile.roles;
    if (requestedRole !== undefined && !allowedRoles.includes(requestedRole as SubagentType)) {
      throw new Error(
        `${this.activeProfile.name} cannot dispatch agent_type "${String(requestedRole)}". Allowed roles: ${allowedRoles.join(", ")}.`,
      );
    }
    const agentType: SubagentType = isAgentRole(requestedRole) ? requestedRole : "general";
    const background = args.background === true;
    const laneId = typeof args.lane_id === "string" ? args.lane_id.trim().slice(0, 64) : undefined;
    const parentGoal = lastUserMessage(session);
    const prompt =
      promptInput ||
      buildSubagentPrompt({
        description,
        ...(parentGoal ? { parentGoal } : {}),
        plan: session.currentPlan,
      });
    const { providers, providerId } = this.resolveSubagentProvider(input);
    const agentId = randomUUID();
    const parentSessionId = session.id;
    const subagentsDir = path.join(this.sessionsDir, "subagents", parentSessionId);
    const filePath = path.join(subagentsDir, `${agentId}.jsonl`);
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    const approvalMode = this.turnApprovalMode ?? this.approvalMode;
    const maxSubagents = this.activeProfile.maxSubagents;
    if (this.liveSubagents.size + this.startingSubagents >= maxSubagents) {
      throw new Error(
        `Subagent concurrency limit reached: at most ${maxSubagents} agents may run at once (${this.activeProfile.name}).`,
      );
    }
    this.startingSubagents += 1;
    let child: AgentRuntime | null = null;
    const observations: SubagentObservations = {
      filesChanged: new Set(),
      commands: [],
      pendingCommands: new Map(),
    };

    try {
      await SessionStore.create(filePath, session.cwd, {
        id: agentId,
        parentSessionId,
        rootSessionId: session.id,
        agentKind: "subagent",
        agentType,
        parentCallId: call.id,
        description,
      });
      child = this.createSubagentRuntime({
        session,
        agentId,
        parentSessionId,
        cwd: session.cwd,
        description,
        agentType,
        providers,
        providerId,
        observations,
      });
      await child.switchSession(filePath);
      await child.setApprovalMode(definitionFor(agentType).readOnly ? "read-only" : approvalMode);
      await child.current?.appendTitle(description);
      await child.current?.flush();

      const live: LiveSubagent = {
        runtime: child,
        parentSessionId,
        callId: call.id,
        description,
        agentType,
        background,
        startedAt,
        startedAtMs,
      };
      this.liveSubagents.set(agentId, live);
      await session.appendSubagent({
        agentId,
        callId: call.id,
        description,
        agentType,
        background,
        status: "running",
        startedAt,
      });
      await session.flush();
      this.emit({
        type: "subagent_started",
        sessionId: parentSessionId,
        parentSessionId,
        agentId,
        callId: call.id,
        description,
        agentType,
        background,
        prompt,
        startedAt,
      });

      const completion = this.completeSubagent({
        session,
        child,
        agentId,
        callId: call.id,
        description,
        agentType,
        background,
        prompt,
        startedAt,
        startedAtMs,
        observations,
        ...(laneId ? { laneId } : {}),
        // 后台任务不跟随父回合 abort；用户可用单个 Agent 的停止按钮结束它。
        ...(background ? {} : { parentSignal: this.turnAbort?.signal }),
      });
      this.startingSubagents = Math.max(0, this.startingSubagents - 1);
      return { agentId, description, background, completion };
    } catch (error) {
      this.startingSubagents = Math.max(0, this.startingSubagents - 1);
      this.liveSubagents.delete(agentId);
      if (child) await child.closeSession().catch(() => undefined);
      throw error;
    }
  }

  private async completeSubagent(ctx: {
    session: SessionStore;
    child: AgentRuntime;
    agentId: string;
    callId: string;
    description: string;
    agentType: SubagentType;
    background: boolean;
    prompt: string;
    startedAt: string;
    startedAtMs: number;
    observations: SubagentObservations;
    /** 治理 run 的 lane 绑定（task 参数 lane_id） */
    laneId?: string;
    parentSignal?: AbortSignal;
  }): Promise<SubagentTaskResult> {
    let status: SubagentStatus = "failed";
    let errorMessage: string | undefined;
    let report = "";
    let usage: UsageSummary | undefined;
    let onParentAbort: (() => void) | null = null;
    let childResult: ChildResult | null = null;
    let gateMessage: string | null = null;

    try {
      if (ctx.parentSignal?.aborted) {
        ctx.child.abort();
      } else if (ctx.parentSignal) {
        onParentAbort = () => ctx.child.abort();
        ctx.parentSignal.addEventListener("abort", onParentAbort, { once: true });
      }
      if (!ctx.parentSignal?.aborted) await ctx.child.prompt(ctx.prompt);

      const lastTurn = ctx.child.lastTurn;
      status = this.mapSubagentStatus(
        lastTurn?.status,
        ctx.parentSignal?.aborted === true,
      );
      errorMessage = ctx.child.lastError ?? lastTurn?.error ?? undefined;
      const messages = ctx.child.current?.messages ?? [];
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (
          message.role === "assistant" &&
          typeof message.content === "string" &&
          message.content.trim()
        ) {
          report = message.content;
          break;
        }
      }
      const totals = ctx.child.current?.usageTotals;
      if (totals?.hasUsage) {
        usage = {
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          cacheReadTokens: totals.cacheReadTokens,
          cacheWriteTokens: totals.cacheWriteTokens,
        };
      }
      // ChildResult 契约（implementer/reviewer/verifier）：归一化报告 →
      // 宿主观测覆盖自述 → fail-closed 校验；其余角色保持自由文本报告
      childResult = buildChildResult({
        role: ctx.agentType,
        report,
        turnStatus: status,
        ...(errorMessage ? { errorMessage } : {}),
        observations: {
          filesChanged: [...ctx.observations.filesChanged],
          commands: [...ctx.observations.commands],
        },
      });
      // 治理 run 活跃：把 gate 角色的结果记入状态机（角色绑定/独立性/证据校验在彼处）
      if (childResult && CHILD_RESULT_ROLES.has(ctx.agentType) && this.workflow.active) {
        const outcome = this.workflow.applyChildGate({
          ...(ctx.laneId ? { laneId: ctx.laneId } : {}),
          role: ctx.agentType,
          agentId: ctx.agentId,
          childResult,
        });
        gateMessage = outcome.message;
        if (outcome.verdict !== "none" && outcome.laneId && outcome.gateId) {
          await ctx.session
            .appendGateReport({
              laneId: outcome.laneId,
              gate: outcome.gateId,
              verdict: outcome.verdict,
              agentId: ctx.agentId,
              message: outcome.message,
            })
            .catch(() => undefined);
          this.emit({
            type: "workflow_gate",
            sessionId: ctx.session.id,
            laneId: outcome.laneId,
            gate: outcome.gateId,
            verdict: outcome.verdict,
            agentId: ctx.agentId,
            message: outcome.message,
          });
          this.emitWorkflowRoadmap(ctx.session);
        }
      }
      // 契约角色结算上报（无论治理是否活跃，UI 都要看宿主校验结论）
      if (childResult && CHILD_RESULT_ROLES.has(ctx.agentType)) {
        await ctx.session
          .appendChildResult({
            agentId: ctx.agentId,
            callId: ctx.callId,
            role: ctx.agentType,
            payload: {
              status: childResult.status,
              valid: childResult.valid,
              ...(childResult.invalidReason ? { invalidReason: childResult.invalidReason } : {}),
              summary: childResult.summary.slice(0, 600),
              filesChanged: childResult.filesChanged.slice(0, 20),
              commands: childResult.commands.slice(0, 20),
              findingsCount: childResult.findings.length,
            },
          })
          .catch(() => undefined);
        this.emit({
          type: "child_result",
          sessionId: ctx.session.id,
          agentId: ctx.agentId,
          callId: ctx.callId,
          role: ctx.agentType,
          result: {
            status: childResult.status,
            valid: childResult.valid,
            ...(childResult.invalidReason ? { invalidReason: childResult.invalidReason } : {}),
            summary: clipText(childResult.summary, 300),
            filesChangedCount: childResult.filesChanged.length,
            commandsCount: childResult.commands.length,
            criticalFindings: childResult.findings.filter((finding) => finding.severity === "critical")
              .length,
          },
        });
      }
    } catch (error) {
      status = ctx.parentSignal?.aborted ? "aborted" : "failed";
      errorMessage = error instanceof Error ? error.message : String(error);
      ctx.child.abort();
    } finally {
      if (onParentAbort && ctx.parentSignal) {
        ctx.parentSignal.removeEventListener("abort", onParentAbort);
      }
      const endedAt = new Date().toISOString();
      const durationMs = Date.now() - ctx.startedAtMs;
      await ctx.session
        .appendSubagent({
          agentId: ctx.agentId,
          callId: ctx.callId,
          description: ctx.description,
          agentType: ctx.agentType,
          background: ctx.background,
          status,
          startedAt: ctx.startedAt,
          endedAt,
          durationMs,
          ...(errorMessage ? { error: errorMessage } : {}),
          ...(usage ? { usage } : {}),
        })
        .catch(() => undefined);
      await ctx.session.flush().catch(() => undefined);
      this.emit({
        type: "subagent_completed",
        sessionId: ctx.session.id,
        parentSessionId: ctx.session.id,
        agentId: ctx.agentId,
        callId: ctx.callId,
        description: ctx.description,
        agentType: ctx.agentType,
        background: ctx.background,
        status,
        ...(errorMessage ? { error: errorMessage } : {}),
        ...(report ? { report: clipText(report, 4000) } : {}),
        endedAt,
        durationMs,
        ...(usage ? { usage } : {}),
      });
      if (ctx.background) {
        // 主回合不等待后台子 Agent：把报告放入父会话上下文，下一次父回合能看到。
        const notice = report
          ? `Background subagent "${ctx.description}" ${status}:\n${clipText(report, 4000)}`
          : `Background subagent "${ctx.description}" ${status}${errorMessage ? `: ${errorMessage}` : "."}`;
        await ctx.session.appendContextNote(notice, "subagent").catch(() => undefined);
        await ctx.session.flush().catch(() => undefined);
      }
      this.liveSubagents.delete(ctx.agentId);
      await ctx.child.flush().catch(() => undefined);
      await ctx.child.closeSession().catch(() => undefined);
      this.flushPendingTitle();
    }

    if (status === "completed") {
      const parts: string[] = [];
      if (report) parts.push(`Subagent report:\n${clipText(report, 4000)}`);
      else parts.push("Subagent finished without a final report.");
      if (childResult) parts.push(renderChildResult(childResult));
      if (gateMessage) parts.push(`[workflow] ${gateMessage}`);
      return {
        output: parts.join("\n\n"),
        ok: true,
        status,
        ...(usage ? { usage } : {}),
        ...(childResult ? { childResult } : {}),
      };
    }
    if (status === "aborted") {
      return {
        output: "Subagent aborted before completing the task.",
        ok: false,
        status,
        ...(errorMessage ? { error: errorMessage } : {}),
        ...(usage ? { usage } : {}),
      };
    }
    return {
      output: `Subagent failed: ${errorMessage ?? report ?? "unknown error"}`,
      ok: false,
      status,
      ...(errorMessage ? { error: errorMessage } : {}),
      ...(usage ? { usage } : {}),
    };
  }

  private async runSubagentTask(
    session: SessionStore,
    call: ToolCall,
    input: unknown,
  ): Promise<SubagentTaskResult> {
    const args = (input ?? {}) as Record<string, unknown>;
    const description = String(args.description ?? "").trim().slice(0, 100);
    if (!this.enableTaskTool) {
      return {
        output: "Subagents cannot spawn other subagents.",
        ok: false,
        status: "failed",
        error: "nested subagent rejected",
      };
    }
    if (!description) {
      return {
        output: 'Tool call rejected: "description" must not be empty.',
        ok: false,
        status: "failed",
        error: "missing task description",
      };
    }
    if (this.subagentsStartedThisTurn >= this.activeProfile.maxSubagents) {
      const limit = this.activeProfile.maxSubagents;
      return {
        output: `Subagent limit reached: at most ${limit} subagents per turn in ${this.activeProfile.name}. Handle the remaining work in the main conversation, or group related items into fewer tasks.`,
        ok: false,
        status: "failed",
        error: "subagent limit reached",
      };
    }
    // 先同步占位再 await：并行的多个 task 调用也不能突破上限
    this.subagentsStartedThisTurn += 1;

    try {
      const started = await this.beginSubagent(session, call, input);
      if (started.background) {
        void started.completion.catch(() => undefined);
        return {
          output: `Subagent "${started.description}" started in background. Continue with other work; its completion will be reported separately.`,
          ok: true,
          status: "running",
        };
      }
      return await started.completion;
    } catch (error) {
      return {
        output: `Subagent failed to start: ${
          error instanceof Error ? error.message : String(error)
        }`,
        ok: false,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** 停止单个子 Agent；返回是否命中正在运行的子 Agent。 */
  abortSubagent(agentId: string): boolean {
    const live = this.liveSubagents.get(agentId);
    if (!live) return false;
    live.runtime.abort();
    return true;
  }

  /** 用户对一个已结束的子 Agent 继续发消息：恢复子会话并启动新回合。 */
  async continueSubagent(agentId: string, message: string): Promise<void> {
    const session = this.currentSession;
    if (!session) throw new Error("No active session.");
    const text = message.trim();
    if (!text) throw new Error("Message must not be empty.");
    if (!/^[0-9a-f-]{36}$/i.test(agentId)) throw new Error("Invalid subagent id.");
    if (this.liveSubagents.has(agentId)) throw new Error("Subagent is still running.");
    const parentSessionId = session.id;
    const parentDir = path.join(this.sessionsDir, "subagents", parentSessionId);
    const filePath = path.join(parentDir, `${agentId}.jsonl`);
    const relative = path.relative(path.resolve(parentDir), path.resolve(filePath));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Invalid subagent path.");
    }
    let meta: SessionStore;
    try {
      meta = await SessionStore.load(filePath);
    } catch {
      throw new Error("Subagent not found.");
    }
    const header = meta.entries[0];
    if (
      !header ||
      header.type !== "session" ||
      header.agentKind !== "subagent" ||
      header.parentSessionId !== parentSessionId
    ) {
      throw new Error("Subagent not found.");
    }
    const agentType = header.agentType ?? "general";
    const description = header.description ?? meta.title ?? "子 Agent";
    const callId = header.parentCallId ?? "";
    const providers = JSON.parse(JSON.stringify(this.providers)) as ProviderConfig[];
    const storedSettings = meta.sessionSettings;
    const storedProvider = storedSettings?.providerId;
    const providerId =
      storedProvider && providers.some((provider) => provider.id === storedProvider)
        ? storedProvider
        : this.providerId;
    const chosenProvider = providers.find((provider) => provider.id === providerId);
    if (chosenProvider) {
      if (storedSettings?.model) chosenProvider.model = storedSettings.model;
      if (storedSettings?.reasoningEffort) {
        chosenProvider.reasoningEffort = storedSettings.reasoningEffort;
      }
    }
    let child: AgentRuntime | null = null;
    // 继续对话只观测本轮新增：此前回合的文件改动已在父会话审阅面板里
    const observations: SubagentObservations = {
      filesChanged: new Set(),
      commands: [],
      pendingCommands: new Map(),
    };
    try {
      child = this.createSubagentRuntime({
        session,
        agentId,
        parentSessionId,
        cwd: session.cwd,
        description,
        agentType,
        providers,
        providerId,
        observations,
      });
      await child.switchSession(filePath);
      await child.setApprovalMode(definitionFor(agentType).readOnly ? "read-only" : this.approvalMode);
      const startedAt = new Date().toISOString();
      const startedAtMs = Date.now();
      this.liveSubagents.set(agentId, {
        runtime: child,
        parentSessionId,
        callId,
        description,
        agentType,
        background: true,
        startedAt,
        startedAtMs,
      });
      await session.appendSubagent({
        agentId,
        callId,
        description,
        agentType,
        background: true,
        status: "running",
        startedAt,
      });
      await session.flush();
      this.emit({
        type: "subagent_resumed",
        sessionId: parentSessionId,
        parentSessionId,
        agentId,
        callId,
        description,
        agentType,
        background: true,
        prompt: text,
        startedAt,
      });
      const completion = this.completeSubagent({
        session,
        child,
        agentId,
        callId,
        description,
        agentType,
        background: true,
        prompt: text,
        startedAt,
        startedAtMs,
        observations,
      });
      void completion.catch(() => undefined);
    } catch (error) {
      this.liveSubagents.delete(agentId);
      if (child) await child.closeSession().catch(() => undefined);
      throw error;
    }
  }

  private mapSubagentStatus(
    status: TurnStatus | undefined,
    parentAborted: boolean,
  ): SubagentStatus {
    // 子 Agent 已完整结束时不因父回合随后停止而误报中止
    if (status === "completed") return "completed";
    if (parentAborted) return "aborted";
    if (status === "aborted") return "aborted";
    if (status === "interrupted") return "interrupted";
    if (status === "error") return "failed";
    return "failed";
  }

  /**
   * 溢出后的分层降级（参考 opencode 的 SHRINK_STEPS：先做便宜的，再动模型）：
   *  1) 确定性收缩：旧工具输出抽头尾（无模型调用，零成本，先试这个）；
   *  2) 工具输出纪要：只把旧工具输出交给模型压成短纪要，对话正文逐字保留；
   *  3) 全量压缩：performCompaction（生成整段对话摘要）。
   * 每档先判断是否有东西可压，没有就直接跳到下一档，不浪费请求。
   */
  private async escalateOnOverflow(
    session: SessionStore,
    provider: ProviderConfig,
    messages: ChatMessage[],
    stage: number,
  ): Promise<{ messages: ChatMessage[]; stage: 1 | 2 | 3 }> {
    // 第 0 档：后台预热已就绪 —— 直接采用，零等待（codex take_ready）
    const ready = this.takeReadyWarmup(session);
    if (ready) {
      console.error("[meowcode] stage 0: adopting pre-warmed compaction summary (no model call)");
      return { messages: await this.applyWarmupSummary(session, provider, ready), stage: 3 };
    }

    if (stage < 1) {
      const shrunk = shrinkToolOutputs(messages);
      if (shrunk.changed) {
        console.error("[meowcode] stage 1: trimming old tool outputs (no model call)");
        return { messages: shrunk.messages, stage: 1 };
      }
    }

    // 第 1.5 档：预热还在后台生成 —— 等它落地（通常已跑了几秒），不再发起新的摘要请求
    const running = this.warmupCompaction;
    if (running && running.session === session && running.state === "running") {
      await running.task;
      const warmed = this.takeReadyWarmup(session);
      if (warmed) {
        console.error("[meowcode] stage 1.5: awaited in-flight warmup and adopted it");
        return { messages: await this.applyWarmupSummary(session, provider, warmed), stage: 3 };
      }
    }

    if (stage < 2) {
      const outputs = collectOldToolOutputs(messages, { keepRecentUnits: 2, minChars: 400 });
      if (outputs.length) {
        try {
          const digests = await summarizeToolOutputs({
            provider: this.applyCachePolicy(provider, session.id, "digest"),
            outputs,
            signal: this.turnAbort?.signal,
            onUsage: (usage) => {
              void session
                .appendUsage({
                  ...usage,
                  source: "compaction",
                  providerId: provider.id,
                  model: provider.model,
                })
                .catch(() => undefined);
            },
          });
          if (digests.size) {
            await session.appendToolDigests(
              [...digests].map(([callId, digest]) => ({ callId, digest })),
            );
            await session.flush().catch(() => undefined);
            // 纪要改变了后续请求的组成，真实用量锚点随之失效
            this.usageAnchor = null;
            console.error(
              `[meowcode] stage 2: summarized ${digests.size} old tool outputs (conversation text kept verbatim)`,
            );
            return {
              messages: messages.map((message) => {
                if (message.role !== "tool") return message;
                const digest = digests.get(message.tool_call_id);
                return digest
                  ? { ...message, content: `[summarized] ${digest}`, images: undefined }
                  : message;
              }),
              stage: 2,
            };
          }
        } catch (error) {
          if (isAbortError(error)) throw error;
          // 纪要请求失败不打断回合：直接进入全量压缩
          console.error(
            `[meowcode] stage 2 failed, falling back to full compaction: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    return { messages: await this.performCompaction(session, provider, messages), stage: 3 };
  }

  /**
   * 尝试服务端原生压缩。返回 null 表示「这次走本地摘要」：
   *  - 协议/端点不支持，或用户关闭了 nativeCompaction；
   *  - 连续失败已达 2 次（避免每轮都白花一次请求去撞同一堵墙）；
   *  - 服务端明确拒绝（400/404：网关不认 context_management 或没有 /compact 端点）。
   *
   * 中止与网络错误不吞：中止原样抛出，网络错误计数后回退（下一次请求可能就好了）。
   */
  private async tryNativeCompaction(
    session: SessionStore,
    provider: ProviderConfig,
    messages: ChatMessage[],
    turnId: string | null,
  ): Promise<{ summary: string; native?: NativeCompactionPayload } | null> {
    // 实验开关：false 全局关闭；true 在兼容网关上强制尝试（与 provider 级开关同义）
    const flag = this.experimental?.nativeCompaction;
    if (flag === false) return null;
    const effectiveProvider =
      flag === true ? { ...provider, nativeCompaction: true } : provider;
    if (!nativeCompactionMode(effectiveProvider)) return null;
    if (this.nativeCompactionFailures >= 2) return null;
    try {
      const result = await requestNativeCompaction({
        provider: this.applyCachePolicy(effectiveProvider, session.id),
        messages,
        tools: this.activeTools,
        signal: this.turnAbort?.signal,
      });
      if (result.usage) {
        void session
          .appendUsage({
            ...result.usage,
            source: "compaction",
            ...(turnId ? { turnId } : {}),
            providerId: provider.id,
            model: provider.model,
          })
          .catch(() => undefined);
      }
      this.nativeCompactionFailures = 0;
      console.error(
        `[meowcode] server-side compaction succeeded (${result.native ? "encrypted item" : "readable summary"})`,
      );
      return result;
    } catch (error) {
      if (isAbortError(error)) throw error;
      this.nativeCompactionFailures += 1;
      console.error(
        `[meowcode] server-side compaction unavailable, falling back to local summary: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /**
   * 压缩当前上下文：生成一次摘要、落盘、广播事件，并返回重建后的消息数组。
   * 「服务商报溢出后的自动压缩」与「用户手动压缩」共用。
   */
  private async performCompaction(
    session: SessionStore,
    provider: ProviderConfig,
    messages: ChatMessage[],
  ): Promise<ChatMessage[]> {
    this.compactingSession = true;
    const compactionId = randomUUID();
    const turnId = this.currentTurnId;
    // 同步压缩开始前先停掉预热：两者都会改写有效历史，并行会互相踩
    this.cancelWarmupCompaction();
    await session.appendCompactionStarted({
      compactionId,
      ...(turnId ? { turnId } : {}),
      reason: this.turnAbort ? "overflow" : "manual",
    });
    await session.flush().catch(() => undefined);
    this.emit({ type: "compaction_started", sessionId: session.id });
    try {
      // 服务端原生压缩优先：Anthropic 直接返回可读摘要，OpenAI 返回加密 item。
      // 不可用（端点不支持/输入低于触发值/连续失败）时静默退回下面的本地摘要。
      const native = await this.tryNativeCompaction(session, provider, messages, turnId);
      if (native) {
        // 原生摘要覆盖整段历史，不再保留近期消息（服务端已决定保留哪些）
        return await this.commitCompaction(
          session,
          provider,
          compactionId,
          turnId,
          native.summary,
          0,
          messages,
          native.native,
        );
      }
      // 近期对话逐字保留：摘要只覆盖旧历史，最近 ~16K tokens 的消息原样参与后续请求，
      // 模型压缩后仍能看到刚读过的文件内容与最新报错，减少重复劳动（参考 metis/opencode）。
      // recentKeptMessages 只返回真实落盘条目且按不可拆单元切段，keepRecentMessages
      // 计数与 effectiveMessages 的回放口径严格一致。
      const recent = session.recentKeptMessages({
        tokens: COMPACTION_KEEP_RECENT_TOKENS,
        contextWindow: provider.contextWindow,
      });
      // recent 是有效历史的尾部：按条数切前缀即可。不要按对象引用过滤——
      // 纪要/摘要重放会生成新对象，引用匹配不上会把同一条消息算进摘要两遍。
      const messagesToSummarize = recent.length
        ? messages.slice(0, Math.max(0, messages.length - recent.length))
        : messages;
      const summary = await createCompactionSummary({
        provider: this.applyCachePolicy(provider, session.id),
        // 复用路径发全量投影对话（与主请求前缀一致）；专用回退路径只发旧前缀
        messages,
        summaryMessages: messagesToSummarize,
        reusePrefix: true,
        systemMessages: this.systemMessages(),
        tools: this.activeTools,
        signal: this.turnAbort?.signal,
        onUsage: (usage) => {
          if (usage.cacheReadTokens) {
            console.error(
              `[meowcode] compaction cache read: ${usage.cacheReadTokens} tokens`,
            );
          }
          void session
            .appendUsage({
              ...usage,
              source: "compaction",
              ...(turnId ? { turnId } : {}),
              providerId: provider.id,
              model: provider.model,
            })
            .catch(() => undefined);
        },
      });
      if (!summary) {
        throw new Error("Context compaction produced an empty summary.");
      }
      return await this.commitCompaction(
        session,
        provider,
        compactionId,
        turnId,
        summary,
        recent.length,
        messages,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await session
        .appendCompactionEnd({ compactionId, status: "failed", error: message })
        .catch(() => undefined);
      await session.flush().catch(() => undefined);
      this.emit({
        type: "compaction_failed",
        sessionId: session.id,
        message,
      });
      throw error;
    } finally {
      this.compactingSession = false;
    }
  }

  /** 从消息里的工具调用提取读写过的文件（去重、按出现顺序），只用于压缩后的路径提示。 */
  private recentlyTouchedPaths(
    workspace: string,
    messages: ChatMessage[],
    max = 20,
  ): string[] {
    const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
    for (const message of messages) {
      if (message.role !== "assistant" || !message.tool_calls?.length) continue;
      for (const call of message.tool_calls) {
        try {
          const parsed = JSON.parse(call.function.arguments) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            calls.set(call.id, {
              name: call.function.name,
              args: parsed as Record<string, unknown>,
            });
          }
        } catch {
          // 参数不是合法 JSON 的历史记录跳过
        }
      }
    }

    const paths: string[] = [];
    const seen = new Set<string>();
    const add = (value: unknown): void => {
      if (typeof value !== "string" || !value.trim()) return;
      const display = displayPath(workspace, value);
      const key = process.platform === "win32" ? display.toLowerCase() : display;
      if (seen.has(key)) return;
      seen.add(key);
      paths.push(display);
    };

    for (const message of messages) {
      if (message.role !== "tool") continue;
      const call = calls.get(message.tool_call_id);
      if (!call) continue;
      if (call.name === "read_file" || call.name === "write_file" || call.name === "edit_file") {
        add(call.args.path);
      } else if (call.name === "read_many" && Array.isArray(call.args.paths)) {
        for (const item of call.args.paths) add(item);
      } else if (call.name === "multi_edit") {
        for (const item of multiEditPaths(call.args)) add(item);
      }
      if (paths.length >= max) break;
    }
    return paths.slice(0, max);
  }

  /**
   * 落一个压缩点：写摘要 + 计划快照 + 起止日志，广播事件，返回重建后的消息数组。
   * 「同步生成摘要的压缩」与「采用后台预热摘要」共用，保证会话日志与恢复语义一致。
   */
  private async commitCompaction(
    session: SessionStore,
    provider: ProviderConfig,
    compactionId: string,
    turnId: string | null,
    summary: string,
    keepRecentMessages: number,
    messages: ChatMessage[],
    native?: NativeCompactionPayload,
  ): Promise<ChatMessage[]> {
    if (native) {
      await session.appendNativeCompaction(summary, native);
      // 刚生成的原生压缩点一定可以在当前端点上重放
      session.nativeCompactionReplayable = true;
    } else {
      await session.appendCompactionSummary(summary, keepRecentMessages);
    }
    // 摘要之后补一份计划快照：压缩把计划相关的工具历史截掉了，避免模型丢失当前计划
    const plan = session.currentPlan;
    if (plan?.steps.length) {
      await session.appendContextNote(
        `${PLAN_CONTEXT_PREFIX} (latest snapshot; supersedes earlier plans):\n${renderPlan(plan)}`,
      );
    }
    // 只注路径不注内容：让模型记得“这些文件已经碰过”，需要细节再 read_file，
    // 避免压缩后从零开始重新探索（参考 ZCode 的 post-compact read-state reminder）。
    const touched = this.recentlyTouchedPaths(session.cwd, messages);
    if (touched.length) {
      let list = touched.join("\n");
      if (list.length > 1_200) list = `${list.slice(0, 1_200)}\n...`;
      await session.appendContextNote(
        `Runtime context: files already read or changed before compaction (paths only; re-read if you need contents):\n${list}`,
      );
    }
    // 压缩前的真实用量已不代表当前上下文，回退到估算，下一次响应再刷新
    this.usageAnchor = null;
    await session.appendCompactionEnd({ compactionId, status: "completed" });
    await session.flush().catch(() => undefined);
    this.emit({
      type: "compaction_completed",
      sessionId: session.id,
      summary:
        summary ||
        "Earlier history was compacted server-side by the provider (encrypted checkpoint; no readable summary).",
    });
    const rebuilt: ChatMessage[] = [
      ...this.systemMessages(),
      ...projectForRequest(session.effectiveMessages, provider),
    ];
    const toolTokens = estimateToolDefinitionsTokens(this.activeTools);
    const outputTokens = clampOutputTokens(provider, estimateMessagesTokens(rebuilt) + toolTokens);
    // 有声明窗口就按真实窗口裁剪；固定的 32k 上限会让 200k 模型在压缩后无故丢历史
    return trimMessages(
      rebuilt,
      provider.contextWindow ?? 32_000,
      outputTokens,
      toolTokens,
    );
  }

  /**
   * 达到占用阈值就启动后台预热压缩：对「近期保留段之前」的旧历史预生成摘要。
   * 不置位 compactingSession、不阻塞回合；生成结果等溢出/需要压缩时一次性消费。
   */
  private maybeStartCompactionWarmup(session: SessionStore, provider: ProviderConfig): void {
    if (!provider.contextWindow || this.warmupCompaction || this.compactingSession) return;
    if (this.warmupFailures >= 2) return;
    const usage = this.getContextUsage();
    if (!usage.contextWindow || usage.source !== "usage") return;
    const ratio = usage.usedTokens / usage.contextWindow;
    if (ratio < COMPACTION_WARMUP_RATIO || ratio >= COMPACTION_WARMUP_MAX_RATIO) return;
    // 没有可摘要的旧历史（全部都在逐字保留预算内）就不预热
    const recent = session.recentKeptMessages({
      tokens: COMPACTION_KEEP_RECENT_TOKENS,
      contextWindow: provider.contextWindow,
    });
    if (!recent.length) return;
    const effective = projectForRequest(session.effectiveMessages, provider);
    const prefixLength = Math.max(0, effective.length - recent.length);
    if (prefixLength <= 0) return;

    // 稳定快照：摘要输入取自当下落盘的历史，之后新增的消息由 keepRecentMessages 兜住
    const systems = this.systemMessages();
    const prefix = effective.slice(0, prefixLength);
    // 复用路径发全量投影对话（主请求刚跑过，前缀缓存最热）；回退路径只发旧前缀
    const fullMessages = [...systems, ...effective];
    const summaryMessages = [...systems, ...prefix];
    const controller = new AbortController();
    const warmup: WarmupCompaction = {
      session,
      providerId: provider.id,
      model: provider.model,
      controller,
      prefixLength,
      messages: fullMessages,
      state: "running",
      summary: "",
      task: Promise.resolve(),
    };
    const turnId = this.currentTurnId;
    warmup.task = (async () => {
      try {
        const summary = await createCompactionSummary({
          provider: this.applyCachePolicy(provider, session.id),
          messages: fullMessages,
          summaryMessages,
          reusePrefix: true,
          systemMessages: systems,
          tools: this.activeTools,
          signal: controller.signal,
          onUsage: (usage2) => {
            if (usage2.cacheReadTokens) {
              console.error(
                `[meowcode] compaction cache read: ${usage2.cacheReadTokens} tokens`,
              );
            }
            void session
              .appendUsage({
                ...usage2,
                source: "compaction",
                ...(turnId ? { turnId } : {}),
                providerId: provider.id,
                model: provider.model,
              })
              .catch(() => undefined);
          },
        });
        if (controller.signal.aborted) return;
        if (!summary) throw new Error("Context compaction produced an empty summary.");
        warmup.summary = summary;
        warmup.state = "ready";
        this.warmupFailures = 0;
        this.emit({ type: "compaction_warmup", sessionId: session.id, phase: "completed" });
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return;
        warmup.state = "failed";
        this.warmupFailures += 1;
        this.emit({
          type: "compaction_warmup",
          sessionId: session.id,
          phase: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    this.warmupCompaction = warmup;
    this.emit({ type: "compaction_warmup", sessionId: session.id, phase: "started" });
  }

  /** 取消并丢弃后台预热（会话切换/换模型/手动压缩/用户中止时）。 */
  private cancelWarmupCompaction(): void {
    const warmup = this.warmupCompaction;
    if (!warmup) return;
    this.warmupCompaction = null;
    warmup.controller.abort();
  }

  /**
   * 回合间隙的主动压缩档：真实用量过 85% 时收一轮上下文，不等溢出。
   * 全程零同步模型请求：
   *  1) 预热摘要已就绪 → 直接采纳落盘（毫秒级，codex take_ready → install）；
   *  2) 预热还在生成 → 等下一轮 usage 回来再判（不阻塞当轮工具执行）；
   *  3) 没有预热可消费 → 当场启动一次后台预热，下一轮就绪后走 1)。
   * 95% 以上的高危区间不在此处理——下一轮大概率直接溢出，由溢出路径的
   * 四级降级（含等待预热）兜底更稳。
   */
  private async maybeProactiveCompaction(
    session: SessionStore,
    provider: ProviderConfig,
  ): Promise<void> {
    if (!provider.contextWindow || this.compactingSession) return;
    if (this.currentSession?.id !== session.id) return;
    const usage = this.getContextUsage();
    if (!usage.contextWindow || usage.source !== "usage") return;
    const ratio = usage.usedTokens / usage.contextWindow;
    if (ratio < COMPACTION_PROACTIVE_RATIO || ratio >= COMPACTION_WARMUP_MAX_RATIO) return;

    const ready = this.takeReadyWarmup(session);
    if (ready) {
      console.error(
        "[meowcode] proactive: adopting pre-warmed compaction summary (no model call)",
      );
      // 与手动压缩互斥：采纳虽是纯落盘（毫秒级），期间用户触发压缩仍会踩
      this.compactingSession = true;
      try {
        await this.applyWarmupSummary(session, provider, ready);
      } catch (error) {
        if (!isAbortError(error)) {
          console.error(
            `[meowcode] proactive adoption failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      } finally {
        this.compactingSession = false;
      }
      return;
    }

    const warmup = this.warmupCompaction;
    if (warmup?.session === session && warmup.state === "running") {
      console.error("[meowcode] proactive: warmup already in flight, waiting for next turn");
      return;
    }
    // 没有可消费的预热（未启动/已失败/已消费）：现在启动，下一轮高位时采纳。
    // 熔断（连续失败 2 次）与 95%+ 区间由 maybeStartCompactionWarmup 自己拒绝。
    this.maybeStartCompactionWarmup(session, provider);
  }

  /** 消费一份已就绪的预热摘要；不属于当前会话或还没就绪时返回 null。 */
  private takeReadyWarmup(session: SessionStore): WarmupCompaction | null {
    const warmup = this.warmupCompaction;
    if (!warmup || warmup.session !== session || warmup.state !== "ready") return null;
    this.warmupCompaction = null; // 一次性消费
    return warmup;
  }

  /**
   * 采用后台预热好的摘要：摘要在后台生成时就已经确定了，这里只做落盘与重建，
   * 毫秒级完成 —— 溢出时不再等一次摘要请求（codex take_ready → install）。
   * 摘要覆盖捕获时的前缀 [0, prefixLength)；这之后新增的消息全部逐字保留。
   */
  private async applyWarmupSummary(
    session: SessionStore,
    provider: ProviderConfig,
    warmup: WarmupCompaction,
  ): Promise<ChatMessage[]> {
    const compactionId = randomUUID();
    const turnId = this.currentTurnId;
    await session.appendCompactionStarted({
      compactionId,
      ...(turnId ? { turnId } : {}),
      reason: "overflow",
    });
    await session.flush().catch(() => undefined);
    this.emit({ type: "compaction_started", sessionId: session.id });
    const keepRecentMessages = Math.max(0, session.effectiveMessages.length - warmup.prefixLength);
    return this.commitCompaction(
      session,
      provider,
      compactionId,
      turnId,
      warmup.summary,
      keepRecentMessages,
      warmup.messages,
    );
  }

  /**
   * 超限图片缩图器：桌面端经 Electron nativeImage 实现（支持 PNG/JPEG/WebP 等）。
   * 无桌面桥（CLI / 测试）时返回 undefined，read_file 走「卸载」降级而不是报错。
   */
  private imageShrinker(): ToolRunOptions["shrinkImage"] {
    const host = this.browserHost;
    if (!host?.shrinkImage) return undefined;
    return (request, signal) => host.shrinkImage!(request, signal);
  }

  /**
   * run_code 沙箱里的宿主工具调用（meow.write / edit / multiEdit / run）。
   *
   * 刻意复用与普通工具调用完全相同的判定链：只读/计划模式拦截 → 可写根检查 →
   * 审批（含 diff 预览与命令风险提示）→ 执行 → 审阅记录。沙箱不自己复制这些规则，
   * 否则 run_code 就成了绕过审批的后门。返回 {ok, output} 给模型代码自行判断，
   * 拒绝时 ok=false 而不是抛异常（代码可以用普通控制流处理）。
   */
  private async runCodeHostTool(
    session: SessionStore,
    parentCallId: string,
    tool: "write_file" | "edit_file" | "multi_edit" | "run_command",
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; output: string }> {
    const approvalMode = this.turnApprovalMode ?? this.approvalMode;
    const allowOutsideWorkspace = approvalMode === "full";
    const chatMode = this.turnChatMode ?? this.chatMode;
    const turnId = this.currentTurnId;
    this.bridgeCallSeq += 1;
    const call: ToolCall = {
      id: `${parentCallId}:host:${this.bridgeCallSeq}`,
      type: "function",
      function: { name: tool, arguments: JSON.stringify(args) },
    };
    const reject = (output: string): { ok: false; output: string } => ({ ok: false, output });

    if (!this.toolAllowed(tool)) {
      return reject(`Tool ${tool} is not available for this agent profile.`);
    }
    // 计划模式：只允许 plans/ 下的计划文档写入，命令一律拒绝
    const planPaths =
      chatMode === "plan" && WRITABLE_ROOT_TOOLS.has(tool)
        ? await withinPlansDir(session.cwd, tool, args)
        : null;
    if (chatMode === "plan" && !planPaths) {
      return reject(planModeRejection(tool));
    }
    if (approvalMode === "read-only" && !planPaths) {
      return reject(`Tool ${tool} blocked: the session is in read-only mode.`);
    }
    const violation = WRITABLE_ROOT_TOOLS.has(tool)
      ? await writableRootViolation(session.cwd, tool, args)
      : null;
    const writableTarget = WRITABLE_ROOT_TOOLS.has(tool) && violation === null;
    if (approvalMode !== "full" && WRITABLE_ROOT_TOOLS.has(tool) && !writableTarget) {
      return reject(
        `Tool ${tool} rejected: ${violation || "the target path"} is outside the workspace. Switch to full-access mode to write outside it.`,
      );
    }

    let approved = planPaths !== null;
    if (!approved && approvalMode === "full") {
      approved = true;
      await session.appendApproval(call.id, tool, args, true, { ...(turnId ? { turnId } : {}) });
    } else if (!approved && approvalMode === "auto" && writableTarget) {
      approved = true;
      await session.appendApproval(call.id, tool, args, true, {
        ...(turnId ? { turnId } : {}),
        reason: "writable_root",
      });
    } else if (!approved) {
      const risk =
        tool === "run_command" ? assessCommandRisk(String(args.command ?? "")) : undefined;
      const diff = await previewDiff(tool, args, session.cwd, allowOutsideWorkspace).catch(
        () => undefined,
      );
      approved = await this.awaitApproval(session, call, tool, args, diff, risk, turnId, false);
      await session.appendApproval(call.id, tool, args, approved, {
        ...(turnId ? { turnId } : {}),
      });
    }
    if (!approved) return reject("User denied this tool call.");

    const reviewCaptures = WRITABLE_ROOT_TOOLS.has(tool)
      ? await captureBeforeAll(session.cwd, tool, args, allowOutsideWorkspace)
      : [];
    const result = await executeTool(tool, args, session.cwd, {
      allowOutsideWorkspace,
      signal: this.turnAbort?.signal,
      vision: this.toolVisionEnabled(),
      shrinkImage: this.imageShrinker(),
      // 不把宿主桥再传下去：防止 run_code → run_code 的递归
    });
    if (result.ok) await this.noteMutatedPath(session, tool, args);
    if (result.ok && reviewCaptures.length) {
      const operation: "write_file" | "edit_file" =
        tool === "write_file" ? "write_file" : "edit_file";
      for (const capture of reviewCaptures) {
        const diff = await buildFileChangeDiff(tool, args, capture);
        if (!diff) continue;
        await session.appendFileChange(capture.target, operation, diff);
        this.emit({
          type: "file_changed",
          sessionId: session.id,
          path: capture.target,
          operation,
        });
        await this.onFileChange?.({ path: capture.target, operation, diff });
      }
    }
    return { ok: result.ok, output: result.output };
  }

  /**
   * executeToolCall 的宿主适配：该方法的每个出口都会 push 一条带本次 call.id
   * 的工具消息（pushToolMessage 同步追加进 messages），倒序扫描即可取回
   * 实际进入上下文的回执——薄循环的 afterToolCall 钩子用它采集证据。
   */
  private async executeToolCallTracked(
    session: SessionStore,
    messages: ChatMessage[],
    call: ToolCall,
  ): Promise<ToolResultMessage> {
    await this.executeToolCall(session, messages, call);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "tool" && message.tool_call_id === call.id) return message;
    }
    return { role: "tool", content: "", tool_call_id: call.id, name: call.function.name };
  }

  private async executeToolCall(
    session: SessionStore,
    messages: ChatMessage[],
    call: ToolCall,
  ): Promise<void> {
    const tool = call.function.name;
    const validated = validateToolArguments(tool, call.function.arguments);
    let input: unknown = validated.ok ? validated.input : {};
    const approvalMode = this.turnApprovalMode ?? this.approvalMode;
    const allowOutsideWorkspace = approvalMode === "full";
    this.emit({ type: "tool_started", sessionId: session.id, callId: call.id, tool, input });

    if (!validated.ok) {
      const output = `Tool call rejected: ${validated.error}`;
      await this.pushToolMessage(session, messages, {
        role: "tool",
        content: output,
        tool_call_id: call.id,
        name: tool,
      });
      this.emit({
        type: "tool_output",
        sessionId: session.id,
        callId: call.id,
        output,
        truncated: false,
      });
      this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: false });
      return;
    }

    const turnId = this.currentTurnId;
    if (turnId) await this.markToolCallStarted(session, { turnId, callId: call.id, tool, input });
    if (!this.toolAllowed(tool)) {
      const output = `Tool ${tool} is not available for this agent profile.`;
      await this.pushToolMessage(session, messages, {
        role: "tool",
        content: output,
        tool_call_id: call.id,
        name: tool,
      });
      this.emit({ type: "tool_output", sessionId: session.id, callId: call.id, output, truncated: false });
      this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: false });
      return;
    }

    // 插件 hook：tool_call（可 block / 改写执行参数）。blocked → 不执行，原因作为工具结果返回；
    // 改写只影响本次执行，tool_started / 会话审计仍记录模型原始参数。
    const toolCallHook = await runHook(this.plugins, "tool_call", {
      hook: "tool_call",
      sessionId: session.id,
      callId: call.id,
      tool,
      // validated.ok 时必为 JSON object（validateToolArguments 保证）
      input: input as Record<string, unknown>,
    });
    if (toolCallHook?.block) {
      const output = toolCallHook.reason
        ? `Tool call blocked by plugin: ${toolCallHook.reason}`
        : "Tool call blocked by plugin.";
      await this.pushToolMessage(session, messages, {
        role: "tool",
        content: output,
        tool_call_id: call.id,
        name: tool,
      });
      this.emit({ type: "tool_output", sessionId: session.id, callId: call.id, output, truncated: false });
      this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: false });
      return;
    }
    if (toolCallHook?.input) input = toolCallHook.input;

    // ask_user 是"等待用户回答"的虚拟工具：emit 问题卡片并挂起回合，回答文本作为工具结果。
    // 与审批同构（await pending promise），plan/只读模式同样可用（纯交互、零副作用）。
    // questions 批量问（1-4 题，一次调用），兼容旧的单题 {question, options} 格式。
    if (tool === "ask_user") {
      const askInput = input as { questions?: unknown; question?: unknown; options?: unknown };
      type AskQuestion = { question: string; options: string[] };
      let questions: AskQuestion[] = [];
      if (Array.isArray(askInput.questions)) {
        questions = askInput.questions
          .slice(0, 4)
          .map((item) => {
            const record = (item ?? {}) as { question?: unknown; options?: unknown };
            return {
              question: String(record.question ?? "").slice(0, 500),
              options: Array.isArray(record.options)
                ? record.options.map((option) => String(option)).slice(0, 4)
                : [],
            };
          })
          .filter((item) => item.question.trim());
      } else if (typeof askInput.question === "string" && askInput.question.trim()) {
        questions = [
          {
            question: askInput.question.slice(0, 500),
            options: Array.isArray(askInput.options)
              ? askInput.options.map((option) => String(option)).slice(0, 4)
              : [],
          },
        ];
      }
      if (!questions.length) {
        questions = [{ question: "请补充说明你的需求", options: [] }];
      }
      const answers = await this.awaitUserAnswer(session, call.id, questions);
      const output = questions
        .map((item, index) => `${index + 1}. ${item.question}\n   → ${answers[index]?.trim() || "（未回答）"}`)
        .join("\n");
      await this.pushToolMessage(session, messages, {
        role: "tool",
        content: output,
        tool_call_id: call.id,
        name: tool,
      });
      this.emit({
        type: "tool_output",
        sessionId: session.id,
        callId: call.id,
        output,
        truncated: false,
      });
      this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: true });
      return;
    }

    // context_status 是 runtime 的虚拟工具：plan 模式与只读模式都放行（纯读侧信息）
    if (tool === "context_status") {      const output = this.contextStatusOutput();
      await this.pushToolMessage(session, messages, {
        role: "tool",
        content: output,
        tool_call_id: call.id,
        name: tool,
      });
      this.emit({ type: "tool_output", sessionId: session.id, callId: call.id, output, truncated: false });
      this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: true });
      return;
    }
    // 循环拦截（P1-2）：放在审批之前 —— 被判死的调用不该再打扰用户弹审批
    const loopBlock = this.loopBlockFor(session, tool, input);
    if (loopBlock) {
      await this.pushToolMessage(session, messages, {
        role: "tool",
        content: loopBlock,
        tool_call_id: call.id,
        name: tool,
      });
      this.emit({ type: "tool_output", sessionId: session.id, callId: call.id, output: loopBlock, truncated: false });
      this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: false });
      return;
    }

    // plan 模式：唯一放行的是 plans/ 下的计划文档写入；子 Agent 直接拒绝（不弹审批）
    const chatMode = this.turnChatMode ?? this.chatMode;
    const planPaths =
      chatMode === "plan" && WRITABLE_ROOT_TOOLS.has(tool)
        ? await withinPlansDir(session.cwd, tool, input)
        : null;
    if (chatMode === "plan" && tool === "task") {
      const output = planModeRejection(tool);
      await this.pushToolMessage(session, messages, {
        role: "tool",
        content: output,
        tool_call_id: call.id,
        name: tool,
      });
      this.emit({ type: "tool_output", sessionId: session.id, callId: call.id, output, truncated: false });
      this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: false });
      return;
    }

    if (tool === "task") {
      const result = await this.runSubagentTask(session, call, input);
      const truncated = truncateOutput(result.output);
      await this.pushToolMessage(session, messages, {
        role: "tool",
        content: truncated.output,
        tool_call_id: call.id,
        name: tool,
      });
      this.emit({
        type: "tool_output",
        sessionId: session.id,
        callId: call.id,
        output: truncated.output,
        truncated: truncated.truncated,
      });
      this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: result.ok });
      return;
    }

    if (tool === "update_plan") {
      const validation = validatePlanInput(input);
      let output: string;
      if (validation.ok) {
        await session.appendPlan(validation.steps, validation.explanation);
        this.emit({
          type: "plan_updated",
          sessionId: session.id,
          steps: validation.steps,
          ...(validation.explanation ? { explanation: validation.explanation } : {}),
        });
        // 计划直接写进工具结果：随历史一起落盘，下一轮前缀可原样复用，不再改写 system。
        output = `Updated plan:\n${renderPlan({ steps: validation.steps })}`;
      } else {
        output = validation.error;
      }
      await this.pushToolMessage(session, messages, {
        role: "tool",
        content: output,
        tool_call_id: call.id,
        name: tool,
      });
      this.emit({ type: "tool_output", sessionId: session.id, callId: call.id, output, truncated: false });
      this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: validation.ok });
      return;
    }

    // admit 是治理控制面虚拟工具：不走审批，直接驱动 WorkflowRuntime
    if (tool === "admit") {
      const admitted = this.workflow.admit(input);
      if (admitted.ok) {
        const state = this.workflow.state;
        await session
          .appendAdmission({
            tier: state!.tier,
            taskShape: state!.taskShape,
            lanes: state!.lanes.map((lane) => ({
              id: lane.id,
              objective: lane.objective,
              ownedPaths: lane.ownedPaths,
              verificationCommands: lane.verificationCommands,
              dependsOn: lane.dependsOn,
            })),
          })
          .catch(() => undefined);
        this.emit({
          type: "workflow_admitted",
          sessionId: session.id,
          tier: state!.tier,
          taskShape: state!.taskShape,
          lanes: state!.lanes.map((lane) => ({
            id: lane.id,
            objective: lane.objective,
            status: lane.status,
            dependsOn: lane.dependsOn,
          })),
        });
        this.emitWorkflowRoadmap(session);
      }
      const output = admitted.ok
        ? admitted.report
        : `Admission rejected: ${admitted.error}`;
      await this.pushToolMessage(session, messages, {
        role: "tool",
        content: output,
        tool_call_id: call.id,
        name: tool,
      });
      this.emit({ type: "tool_output", sessionId: session.id, callId: call.id, output, truncated: false });
      this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: admitted.ok });
      return;
    }

    // 浏览器写操作/外站导航与文件、命令一样受审批和只读模式约束。
    const browserTool = isBrowserTool(tool);
    const browserUrl =
      tool === "browser_navigate"
        ? String(((input ?? {}) as Record<string, unknown>).url ?? "")
        : "";
    const browserExternalNavigation =
      tool === "browser_navigate" && !isLocalBrowserUrl(browserUrl);
    const browserNeedsApproval = BROWSER_APPROVAL_TOOLS.has(tool) || browserExternalNavigation;
    const browserReadOnlyBlocked = BROWSER_APPROVAL_TOOLS.has(tool) || browserExternalNavigation;
    // 插件/MCP 动态工具按注册时的 requiresApproval 声明走审批（MCP 工具默认免审批）
    const dynamicNeedsApproval = isDynamicToolRequiringApproval(tool);
    const mcpTool = tool.startsWith("mcp__");
    const requiresApproval = APPROVAL_TOOLS.has(tool) || browserNeedsApproval || dynamicNeedsApproval;

    // plan 模式下除 plans/ 内的写操作外，其余需要审批的（写/命令/浏览器写/MCP）一律直接拒绝
    if (chatMode === "plan" && !planPaths && (requiresApproval || mcpTool)) {
      const output = planModeRejection(tool);
      await this.pushToolMessage(session, messages, {
        role: "tool",
        content: output,
        tool_call_id: call.id,
        name: tool,
      });
      this.emit({ type: "tool_output", sessionId: session.id, callId: call.id, output, truncated: false });
      this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: false });
      return;
    }

    let approved = !requiresApproval || planPaths !== null;
    if (
      approvalMode === "read-only" &&
      planPaths === null &&
      (APPROVAL_TOOLS.has(tool) || (browserTool && browserReadOnlyBlocked) || dynamicNeedsApproval || mcpTool)
    ) {
      const output = `Tool ${tool} blocked: the session is in read-only mode.`;
      await this.pushToolMessage(session, messages, {
        role: "tool",
        content: output,
        tool_call_id: call.id,
        name: tool,
      });
      this.emit({ type: "tool_output", sessionId: session.id, callId: call.id, output, truncated: false });
      this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: false });
      return;
    }
    // 非完全访问模式下，工作区外的写/改注定被路径守卫拒绝：直接报错，不弹一次没用的审批
    const violation = WRITABLE_ROOT_TOOLS.has(tool)
      ? await writableRootViolation(session.cwd, tool, input)
      : null;
    const writableTarget = WRITABLE_ROOT_TOOLS.has(tool) && violation === null;
    if (approvalMode !== "full" && WRITABLE_ROOT_TOOLS.has(tool) && !writableTarget) {
      const target = violation || "the target path";
      const output = `Tool ${tool} rejected: ${target} is outside the workspace. Switch to full-access mode to write outside it.`;
      await this.pushToolMessage(session, messages, {
        role: "tool",
        content: output,
        tool_call_id: call.id,
        name: tool,
      });
      this.emit({ type: "tool_output", sessionId: session.id, callId: call.id, output, truncated: false });
      this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: false });
      return;
    }

    if (!approved && approvalMode === "full") {
      // 完全访问：不弹审批直接放行，仍写一条 approved 记录到会话文件留痕
      approved = true;
      await session.appendApproval(call.id, tool, input, true, {
        ...(turnId ? { turnId } : {}),
      });
    } else if (!approved && approvalMode === "auto" && writableTarget) {
      // codex 式：可写根内的写/改自动批准；越界路径与命令仍然走审批
      approved = true;
      await session.appendApproval(call.id, tool, input, true, {
        ...(turnId ? { turnId } : {}),
        reason: "writable_root",
      });
    } else if (!approved) {
      const risk =
        tool === "run_command"
          ? assessCommandRisk(String(((input ?? {}) as Record<string, unknown>).command ?? ""))
          : undefined;
      // 审批预览与真正落盘之间隔着用户思考的时间：先记下目标文件版本，批准后再比对。
      const targets = WRITABLE_ROOT_TOOLS.has(tool)
        ? await this.approvalTargetFiles(session, tool, input)
        : [];
      const versions = await Promise.all(targets.map((file) => captureVersion(file)));

      let diff = await previewDiff(tool, input, session.cwd, allowOutsideWorkspace).catch(
        () => undefined,
      );
      approved = await this.awaitApproval(session, call, tool, input, diff, risk, turnId, false);

      let rechecked = false;
      if (approved && targets.length) {
        const current = await Promise.all(targets.map((file) => captureVersion(file)));
        const changed = current.some((version, index) => version !== versions[index]);
        if (changed) {
          // 文件在审批期间被外部改动：重算预览再确认一次（只重问一次，防死循环）
          rechecked = true;
          diff = await previewDiff(tool, input, session.cwd, allowOutsideWorkspace).catch(
            () => undefined,
          );
          approved = await this.awaitApproval(session, call, tool, input, diff, risk, turnId, true);
          if (approved) {
            const settled = await Promise.all(targets.map((file) => captureVersion(file)));
            if (settled.some((version, index) => version !== current[index])) {
              // 还在变：放弃执行，避免"批的是 A、写的是 B"
              await session.appendApproval(call.id, tool, input, false, {
                ...(turnId ? { turnId } : {}),
                reason: "stale",
              });
              const output =
                "The target file kept changing while the approval was open, so nothing was written. Re-read the file and retry.";
              await this.pushToolMessage(session, messages, {
                role: "tool",
                content: output,
                tool_call_id: call.id,
                name: tool,
              });
              this.emit({
                type: "tool_output",
                sessionId: session.id,
                callId: call.id,
                output,
                truncated: false,
              });
              this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: false });
              return;
            }
          }
        }
      }
      await session.appendApproval(call.id, tool, input, approved, {
        ...(turnId ? { turnId } : {}),
        ...(rechecked ? { reason: "stale_rechecked" } : {}),
      });
    }

    if (!approved) {
      const output = "User denied this tool call.";
      await this.pushToolMessage(session, messages, {
        role: "tool",
        content: output,
        tool_call_id: call.id,
        name: tool,
      });
      this.emit({ type: "tool_output", sessionId: session.id, callId: call.id, output, truncated: false });
      this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: false });
      return;
    }

    // 计划文档写入是自动批准的：补一条审批记录留痕（与会话回放保持一致）
    if (planPaths) {
      await session.appendApproval(call.id, tool, input, true, {
        ...(turnId ? { turnId } : {}),
        reason: "plan_mode",
      });
    }

    // 重复读短路：同一文件、同一区间、版本未变、上一次结果还在上下文里 → 不再重发全文
    if (tool === "read_file") {
      const stub = await this.repeatedReadStub(
        session,
        messages,
        call,
        input,
        allowOutsideWorkspace,
      );
      if (stub) {
        const loopNote = this.noteLoopResult(session, tool, input, stub);
        const output = loopNote ? `${stub}\n\n${loopNote}` : stub;
        await this.pushToolMessage(session, messages, {
          role: "tool",
          content: output,
          tool_call_id: call.id,
          name: tool,
        });
        this.emit({
          type: "tool_output",
          sessionId: session.id,
          callId: call.id,
          output,
          truncated: false,
        });
        this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: true });
        return;
      }
    }

    if (browserTool) {
      // 截图是否作为图片回传给模型，由模型模态决定（responses 协议下由序列化层
      // 拆成紧随的 user 消息，不再丢图）。
      const provider = this.activeProvider();
      const keepImages = (provider.inputModalities ?? []).includes("image");
      const result = this.browserHost
        ? await executeBrowserTool(tool, input, this.browserHost, { keepImages }, this.turnAbort?.signal)
        : {
            ok: false,
            output: "Browser tools are unavailable: the desktop browser host is not connected.",
            images: undefined,
          };
      await this.pushToolMessage(session, messages, {
        role: "tool",
        content: result.output,
        tool_call_id: call.id,
        name: tool,
        ...(result.images?.length ? { images: result.images } : {}),
      });
      this.emit({
        type: "tool_output",
        sessionId: session.id,
        callId: call.id,
        output: result.output,
        truncated: result.truncated ?? result.output.length > 20000,
      });
      this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: result.ok });
      return;
    }

    // 审阅记录：写/改文件前先捕获 before（读不到就跳过这次记录）；跨文件 multi_edit 逐文件记录
    const reviewCaptures =
      tool === "write_file" || tool === "edit_file" || tool === "multi_edit"
        ? await captureBeforeAll(session.cwd, tool, input, allowOutsideWorkspace)
        : [];
    // 审阅页签只有 write_file / edit_file 两种操作，批量编辑归入 edit_file
    const reviewOperation: "write_file" | "edit_file" =
      tool === "write_file" ? "write_file" : "edit_file";

    let result = await executeTool(tool, input, session.cwd, {
      allowOutsideWorkspace,
      signal: this.turnAbort?.signal,
      vision: this.toolVisionEnabled(),
      pdfDocuments: this.toolPdfEnabled(),
      shrinkImage: this.imageShrinker(),
      // run_code 的 meow.write/edit/multiEdit/run 走宿主审批链（同一次调用内可多次触发）
      hostToolBridge: (bridgeTool, bridgeArgs) =>
        this.runCodeHostTool(session, call.id, bridgeTool, bridgeArgs),
    });
    // 插件 hook：tool_result（可改写 output/ok，链式累积）。只覆盖普通工具分支；
    // task / update_plan / browser_* 走各自的提前 return，第一版不经过此 hook。
    const toolResultHook = await runHook(this.plugins, "tool_result", {
      hook: "tool_result",
      sessionId: session.id,
      callId: call.id,
      tool,
      output: result.output,
      ok: result.ok,
      ...(result.truncated !== undefined ? { truncated: result.truncated } : {}),
    });
    if (toolResultHook) {
      if (typeof toolResultHook.output === "string") result = { ...result, output: toolResultHook.output };
      if (typeof toolResultHook.ok === "boolean") result = { ...result, ok: toolResultHook.ok };
    }
    // 写成功就标记：下一轮 @ 同一文件时不能再用"已读"占位（内容是旧的）
    if (result.ok) await this.noteMutatedPath(session, tool, input);
    // 计划文档落盘成功：通知前端弹出「开始执行 / 调整计划」确认面板
    if (result.ok && planPaths) {
      this.emit({
        type: "plan_documented",
        sessionId: session.id,
        path: displayPath(session.cwd, planPaths[0]),
      });
    }
    if (result.ok && reviewCaptures.length) {
      for (const capture of reviewCaptures) {
        const diff = await buildFileChangeDiff(tool, input, capture);
        if (!diff) continue;
        await session.appendFileChange(capture.target, reviewOperation, diff);
        this.emit({
          type: "file_changed",
          sessionId: session.id,
          path: capture.target,
          operation: reviewOperation,
        });
        await this.onFileChange?.({
          path: capture.target,
          operation: reviewOperation,
          diff,
        });
      }
    }
    // 验证闭环：写成功后自动跑验证命令，失败反馈附加到工具回执（模型同回合修复）
    let toolOutput = result.output;
    // 循环登记（P1-2）：参数+输出双一致才计数，提醒附加到回执末尾
    const loopNote = this.noteLoopResult(session, tool, input, result.output);
    if (loopNote) toolOutput = `${toolOutput}\n\n${loopNote}`;
    if (result.ok && (tool === "write_file" || tool === "edit_file" || tool === "multi_edit")) {
      const verifyFeedback = await this.runPostWriteVerification(session, tool, input);
      if (verifyFeedback) toolOutput = `${toolOutput}\n\n${verifyFeedback}`;
    }
    await this.pushToolMessage(session, messages, {
      role: "tool",
      content: toolOutput,
      tool_call_id: call.id,
      name: tool,
      ...(result.images?.length ? { images: result.images } : {}),
      ...(result.documents?.length ? { documents: result.documents } : {}),
    });
    if (tool === "read_file" && result.ok && !result.images?.length) {
      await this.rememberReadVersion(session, call.id, input, allowOutsideWorkspace);
    }
    const truncated = result.truncated ?? toolOutput.length > 20000;
    this.emit({
      type: "tool_output",
      sessionId: session.id,
      callId: call.id,
      output: toolOutput,
      truncated,
    });
    this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: result.ok });
  }

  /**
   * 验证闭环：写类工具成功后的自动验证。跑 .meowcode/verify.json 声明的命令
   * （缺省启发式探测 typecheck），失败结果结构化压缩后作为返回值附加到工具回执；
   * 每回合最多 maxFeedbackPerTurn 次失败回灌，超过后改为"如实告知用户"指令防死循环。
   * 任何异常都不允许影响写结果本身：整体 try/catch，catch 时 console.warn + 返回 null。
   */
  private async runPostWriteVerification(
    session: SessionStore,
    tool: string,
    input: unknown,
  ): Promise<string | null> {
    try {
      const targets = writablePaths(tool, input);
      if (!targets.length) return null;
      const config = await loadVerifyConfig(session.cwd);
      if (!config.include.length) return null;
      const hit = targets.some((target) =>
        config.include.includes(path.extname(target).replace(/^\./, "").toLowerCase()),
      );
      if (!hit) return null;
      if (!config.commands.length) return null;
      // 用户已中止回合：中止不算验证结果，不回灌任何反馈
      if (this.turnAbort?.signal.aborted) return null;

      const verification = await runVerification(config, session.cwd, this.turnAbort?.signal);
      if (!verification.ran || verification.passed) return null;

      const failedIds = verification.steps
        .filter((step) => !step.passed)
        .map((step) => step.id)
        .join(", ");
      if (this.verifyFailuresThisTurn >= config.maxFeedbackPerTurn) {
        return [
          `--- auto-verify: ${failedIds} FAILED ---`,
          `Automatic fix-and-retry feedback is disabled for this turn (limit of ${config.maxFeedbackPerTurn} reached) to avoid an endless loop. Do NOT keep editing silently.`,
          "Finish your turn now and honestly tell the user that the changes do not pass verification, including the first error message.",
        ].join("\n");
      }
      this.verifyFailuresThisTurn += 1;
      return verification.feedback ?? null;
    } catch (error) {
      console.warn(
        `[meowcode] post-write verification skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * 工具结果与 assistant 一起落盘：下一轮请求能完整重放 tool_calls/结果，
   * 前缀不会被截断；截图 base64 只回传当轮请求，不写会话文件。
   */
  private async pushToolMessage(
    session: SessionStore,
    messages: ChatMessage[],
    message: Extract<ChatMessage, { role: "tool" }>,
  ): Promise<Extract<ChatMessage, { role: "tool" }>> {
    // 工具携带的图片/文档只回传当轮请求：base64 落盘会让会话文件膨胀几个数量级
    const persisted =
      message.images || message.documents
        ? { ...message, images: undefined, documents: undefined }
        : message;
    try {
      await session.appendMessage(persisted);
      await session.flush();
    } catch (error) {
      // 已经执行的副作用不能因为一次落盘失败就从上下文里消失：那会让模型以为工具没跑过并重复执行。
      // 内存照常带上这条结果，磁盘上的配对缺口交给恢复时的 repairToolPairs。
      console.error(
        `[meowcode] failed to journal ${message.name} result: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.emit({
        type: "error",
        sessionId: session.id,
        message: `工具 ${message.name} 已执行，但会话记录写入失败，重启后该结果可能缺失。`,
      });
    }
    messages.push(message);
    return message;
  }

  /** 老会话/异常中止后，确保当前计划在有效历史里可见（工具结果或压缩后的 note）。 */
  private async ensurePlanContext(session: SessionStore): Promise<void> {    const plan = session.currentPlan;
    if (!plan?.steps.length) return;
    const history = session.effectiveMessages;
    const visible =
      history.some((message) => message.role === "tool" && message.name === "update_plan") ||
      history.some(
        (message) => message.role === "user" && message.content.startsWith(PLAN_CONTEXT_PREFIX),
      );
    if (visible) return;
    await session.appendContextNote(
      `${PLAN_CONTEXT_PREFIX} (latest snapshot; supersedes earlier plans):\n${renderPlan(plan)}`,
    );
  }

  /** 稳定系统提示 + 当前工作区规则；两者都放在消息开头，前缀可复用。 */
  private systemMessages(): ChatMessage[] {
    const system: ChatMessage = { role: "system", content: this.effectiveSystemPrompt };
    const messages: ChatMessage[] = this.instructions
      ? [system, { role: "system", content: this.instructions }]
      : [system];
    // 模式指令追加在最后：稳定前缀（主提示词 + 工作区说明）不动，切换模式只多一条尾部消息
    const mode = this.turnChatMode ?? this.chatMode;
    if (mode === "plan") messages.push({ role: "system", content: PLAN_MODE_PROMPT });
    if (mode === "goal") messages.push({ role: "system", content: GOAL_MODE_PROMPT });
    return messages;
  }

  private async refreshInstructions(session: SessionStore): Promise<void> {
    this.instructions = this.injectInstructions
      ? await loadWorkspaceInstructions(session.cwd, this.homeDir)
      : undefined;
  }

  /**
   * 当前模型是否接受图片输入（用户附图与截图回传都受它控制）。
   * 未配置模态的老数据一律按纯文本处理。
   */
  get acceptsImages(): boolean {
    try {
      return (this.activeProvider().inputModalities ?? []).includes("image");
    } catch {
      return false;
    }
  }

  /**
   * 当前模型是否接受 PDF 文档块：既要声明 pdf 模态，也要协议能承载
   * （Anthropic document / Responses input_file；chat completions 无 file 块）。
   */
  get acceptsPdf(): boolean {
    try {
      const provider = this.activeProvider();
      return (
        (provider.inputModalities ?? []).includes("pdf") &&
        (provider.protocol ?? "openai-chat-completions") !== "openai-chat-completions"
      );
    } catch {
      return false;
    }
  }

  /**
   * 工具结果能否带图片：只看模型是否声明了 image 模态。
   * Responses 协议的 function_call_output 虽然只收字符串，但序列化层会把工具图片
   * 拆成紧随的 user 消息（见 toResponsesInput），所以不再按协议排除。
   */
  private toolVisionEnabled(): boolean {
    try {
      const provider = this.activeProvider();
      return (provider.inputModalities ?? []).includes("image");
    } catch {
      return false;
    }
  }

  /**
   * 工具结果能否带 PDF 文档块：模型声明了 pdf 模态，且协议能承载
   * （Anthropic document / Responses input_file；chat completions 没有可移植的 file 块）。
   */
  private toolPdfEnabled(): boolean {
    try {
      const provider = this.activeProvider();
      return (
        (provider.inputModalities ?? []).includes("pdf") &&
        (provider.protocol ?? "openai-chat-completions") !== "openai-chat-completions"
      );
    } catch {
      return false;
    }
  }

  private activeProvider(): ProviderConfig {
    const provider = this.providers.find((item) => item.id === this.providerId) ?? this.providers[0];
    if (!provider) throw new Error("No configured model provider.");
    return provider;
  }

  private async loadLatestForWorkspace(workspace: string): Promise<void> {
    const sessions = await listSessions(this.sessionsDir);
    const resolved = path.resolve(workspace);
    const latest = sessions.find((session) => path.resolve(session.cwd) === resolved);
    if (latest) {
      await this.switchSession(latest.filePath);
    }
  }
}

export function validatePlanInput(
  input: unknown,
): { ok: true; steps: PlanStep[]; explanation?: string } | { ok: false; error: string } {
  const args = (input ?? {}) as Record<string, unknown>;
  const rawSteps = Array.isArray(args.steps) ? args.steps : [];
  if (!rawSteps.length) return { ok: false, error: "steps must be a non-empty array." };
  if (rawSteps.length > 12) return { ok: false, error: "A plan can contain at most 12 steps." };

  const steps: PlanStep[] = [];
  for (const rawStep of rawSteps) {
    const step = (rawStep ?? {}) as Record<string, unknown>;
    const title = typeof step.title === "string" ? step.title.trim() : "";
    const status = step.status;
    if (!title) return { ok: false, error: "Every plan step must have a non-empty title." };
    if (
      status !== "pending" &&
      status !== "in_progress" &&
      status !== "completed" &&
      status !== "cancelled"
    ) {
      return { ok: false, error: `Invalid plan step status: ${String(status)}` };
    }
    steps.push({ title, status });
  }
  const explanation = typeof args.explanation === "string" ? args.explanation.trim() : undefined;
  return { ok: true, steps, ...(explanation ? { explanation } : {}) };
}

export type SessionHeaderLike = {
  id: string;
  cwd: string;
  filePath: string;
  messages: ChatMessage[];
};


