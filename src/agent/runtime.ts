import { promises as fs } from "node:fs";
import { persistToolOutput } from "./tool-output.js";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { assessCommandRisk, isFileDeletionCommand } from "./command-risk.js";
import {
  COMPACTION_KEEP_RECENT_TOKENS,
  createCompactionSummary,
  summarizeToolOutputs,
} from "./compaction.js";
import { countDiffStats, previewDiff, renderDiff } from "./diff.js";
import {
  buildFileMentionContext,
  collectInjectedPaths,
  mentionPathKey,
  mentionTokenBudget,
  referenceLabel,
  stripReferenceHeader,
} from "./file-mentions.js";
import {
  instructionSourceSignature,
  loadWorkspaceInstructionsDetail,
  type InstructionSettings,
} from "./instructions.js";
import {
  applyMemoryOps,
  collectManifest,
  formatMemoryNotice,
  generateMemoryOps,
  hasNewUserMessage,
  lastRealUserMessageIndex,
  serializeMessages,
  shouldExtractMemory,
  wroteMemoryDirectly,
} from "./memory-extraction.js";
import { isAbortError } from "./http.js";
import { LearningController, type LearningSnapshot } from "./learning/index.js";
import { formatLearningNotice } from "./learning/recall.js";
import { createTurnTrace, recordToolCall, type TurnTrace } from "./learning/signals.js";
import { canReplayNativeCompaction, nativeCompactionMode, requestNativeCompaction } from "./native-compaction.js";
import { createWebSearchBackend, WEB_SEARCH_MAX_RESULTS, type WebSearchResult } from "./web-search.js";
import { fetchWebPage, type WebFetchOutcome } from "./web-fetch.js";
import { multiEditPaths, readMultiEditGroups } from "./multi-edit.js";
import {
  displayPath,
  isWithinAppDataRoot,
  isWithinWorkspace,
  resolveToolPath,
  resolveWithinWorkspace,
  setAppDataRoot,
} from "./paths.js";
import { captureVersion } from "./read-state.js";
import { LoopGuard, type ReadCoverageSnapshot } from "./loop-guard.js";
import { SessionStore, listSessions, sessionFileName, type SessionSummary } from "./session-store.js";
import { SnapshotStore, type SnapshotTarget } from "./snapshot-store.js";
import { recoverSession } from "./session-recovery.js";
import { TraceRecorder, type TraceSpan, type TraceSummary } from "./trace.js";
import {
  addApprovalRule,
  commandPrefix,
  matchApprovalRule,
  readApprovalRules,
  toRulePath,
} from "./approval-rules.js";
import { createJobManager, type JobManager } from "./jobs.js";
import { isForceApprovalGitAction, isMutatingGitAction } from "./git-tools.js";
import { patchPaths } from "./patch.js";
import {
  executeTool,
  isDynamicToolRequiringApproval,
  isToolParallelSafe,
  listDynamicToolDefinitions,
  dynamicToolDefinitionsTrimmed,
  dynamicToolsVersion,
  toolDefinitions,
  admitToolDefinition,
  truncateOutput,
  READ_MANY_MAX_PATHS,
  type ToolRunOptions,
} from "./tools.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type {
  HookCommandApprovalRequest,
  PluginHookContext,
  PluginHookEventMap,
  PluginHookName,
  PluginHookScope,
} from "../plugins/types.js";
import { runHook } from "../plugins/hooks.js";
import { loadVerifyConfig, parseTscErrors, runVerification } from "./verify.js";
import { getLspManager } from "../lsp/manager.js";
import { formatLspFeedback } from "../lsp/format.js";
import { type BrowserHostClient } from "./browser-host.js";
import { browserToolDefinitions, executeBrowserTool, isBrowserTool } from "./browser-tools.js";
import { streamChatCompletion, utilityProvider } from "./provider.js";
import {
  sessionAffinityKey,
  isOfficialAnthropicEndpoint,
  isOfficialOpenAIEndpoint,
  resolveCachePlan,
  supportsLineageAffinity,
} from "./cache-profile.js";
import {
  classifyCache,
  diffPrefix,
  prefixChangeSegments,
  TTL_MS,
  type CacheState,
  type PrefixSnapshot,
} from "./cache-diagnostics.js";
import { createToolCatalog, reconcileToolCatalog, type ToolCatalog } from "./tool-catalog.js";
import { FAILOVER_WALL_CLOCK_MS, failoverReason, planFallbacks } from "./provider-fallback.js";
import { boostEffort } from "./thinking-budget.js";
import { projectForMainPath, projectForRequest } from "./request-projection.js";
import { SUGGESTION_SYSTEM_PROMPT, SUGGESTION_USER_PROMPT, usableSuggestion } from "./prompt-suggestion.js";
import { toResponsesInput } from "./responses.js";
import { normalizeSpeechStyle, readSpeechStyleFromEnv, speechStylePrompt, type SpeechStyle } from "./speech-style.js";
import { generateSessionTitle } from "./title-generator.js";
import { generateCommitMessage, type CommitContext } from "./commit-message.js";
import { polishPrompt } from "./prompt-polish.js";
import {
  breakdownMessages,
  collectOldToolOutputs,
  clampOutputTokens,
  compactionTriggerTokens,
  estimateContextTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTokens,
  estimateToolDefinitionsTokens,
  PromptTooLargeError,
  shouldRecommendCompaction,
  shrinkToolOutputs,
  trimMessages,
  type ContextUsageAnchor,
  type MessageBreakdown,
} from "./context.js";
import { CONTEXT_SAFETY_TOKENS } from "./output-budget.js";
import {
  runAgentLoop,
  type AgentLoopHost,
  type AgentLoopHooks,
  type AgentStreamOptions,
  type ToolResultMessage,
} from "./agent-loop.js";
import { AGENT_ROLE_HINTS, definitionFor, isAgentRole, roleDeniesTool } from "./agent-definition.js";
import {
  BASE_SYSTEM_PROMPT,
  MAX_BACKGROUND_SUBAGENTS,
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
  type ApprovalDecision,
  type ApprovalRememberScope,
  type ChatMessage,
  type ContextEditing,
  type CommandRisk,
  type CommandRiskCategory,
  type MeowEvent,
  type NativeCompactionPayload,
  type PendingApproval,
  type PlanStep,
  type ProviderConfig,
  type TokenUsage,
  type SessionCheckpoint,
  type SessionMode,
  type SessionWorktree,
  type SubagentStatus,
  type SubagentType,
  type ToolCall,
  type ToolCatalogReason,
  type ToolDefinition,
  type ToolDocument,
  type ToolImage,
  type ToolResult,
  type TurnFileChangeStat,
  type TurnStatus,
  type UsageSource,
  type UsageSummary,
} from "./types.js";
import type { SandboxDenial } from "./sandbox/types.js";
import { getSandboxSettings } from "./sandbox/policy.js";

export type { ApprovalMode, SessionMode } from "./types.js";

export { BASE_SYSTEM_PROMPT };

const PLAN_CONTEXT_PREFIX = "Runtime context: current task plan";
const MODE_NOTE_PREFIX = "Runtime context: [mode]";

/**
 * 语色注记：以前语色是第 3 条 system，运行中切换会改变 system 条数，
 * 让 tools 之后整段前缀失效（OpenAI 上整段 instructions 变）。改成 in-history
 * 注记后切换只追加一条，前缀字节不变。
 */
const SPEECH_STYLE_PREFIX = "Runtime context: [speech style]";

/**
 * fork 契约：子 Agent 复制父历史后追加在尾部（不动前缀），只约束交互方式。
 * 语色沿用父对话，是预期行为，不在这里中和。
 */
const FORK_CONTRACT_NOTE =
  "Runtime context: [fork] You are a fork of the main conversation. You cannot ask the user questions; return a report instead. Keep the parent's speech style.";

/** 历史里最后一条语色注记；没有注记按 normal 处理（只看最近 30 条，被压缩挤掉就重挂）。 */
function lastSpeechStyleFrom(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0 && index >= messages.length - 30; index -= 1) {
    const message = messages[index];
    if (message.role !== "user" || typeof message.content !== "string") continue;
    if (!message.content.startsWith(SPEECH_STYLE_PREFIX)) continue;
    const match = /\[speech style\]\s+(\S+)/.exec(message.content);
    return match?.[1] ?? "normal";
  }
  return "normal";
}
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

/** 插件 payload 的 input 统一成对象：非对象一律给空对象，插件侧不必再判空。 */
function hookInput(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
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

/** 子 Agent 运行中插话：队列上限与单条长度上限（防刷屏/注入超长文本）。 */
export const MAX_PENDING_STEERS = 8;
const MAX_STEER_CHARS = 4000;

/**
 * 计划模式指令：走 in-history 尾注（ensureModeContext），会话中途切换模式只追加
 * 一条 user 注记，请求前缀（system 段 + 已有历史）保持字节不变，缓存不失效。
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

/** 连续 N 次文件变更没有更新计划 → 轮间提醒一次（每再涨 N 次再提醒） */
const PLAN_NUDGE_STEP = 4;
/** 计入「计划新鲜度」的文件变更工具 */
const PLAN_MUTATION_TOOLS = new Set([
  "write_file",
  "edit_file",
  "multi_edit",
  "apply_patch",
  "delete_file",
  "move_file",
]);

const APPROVAL_TOOLS = new Set([
  "write_file",
  "edit_file",
  "multi_edit",
  "delete_file",
  "move_file",
  "apply_patch",
  "run_command",
]);

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

// READ_ONLY_PARALLEL_TOOLS / clampOutputTokens / estimateRequestInputTokens
// 已随薄循环抽到 agent-loop.ts 与 context.ts（循环与宿主共用）

/**
 * 循环检测（P1-2）：同一回合内「参数完全相同 且 输出逐字节相同」的连续工具调用，
 * 状态与阈值见 loop-guard.ts（3/5/8 分级，参考 dsh repeat-tool-reminder）。
 */
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
  job: { required: ["action"], nonEmpty: ["action"] },
  git: { required: ["action"], nonEmpty: ["action"] },
  delete_file: { required: ["path"], nonEmpty: ["path"] },
  move_file: { required: ["from", "to"], nonEmpty: ["from", "to"] },
  apply_patch: { required: ["patch"], nonEmpty: ["patch"] },
  web_search: { required: ["query"], nonEmpty: ["query"] },
  web_fetch: { required: ["url"], nonEmpty: ["url"] },
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
 *  - "auto"：可写根（工作区 + <home>/.meowcode）内的写/改、常规开发命令自动批准；
 *    凭据读取、下载执行、系统设置、发布部署、破坏性 git、其它工作区外路径与高危特征仍弹审批（启发式护栏）
 *  - "full"：全部工具自动放行，并允许工作区外的绝对路径
 * 审批模式按会话持久化；旧会话里存的 "default" 读出来归一到 "ask"。
 */
export { isApprovalMode, normalizeApprovalMode, isSessionMode, normalizeSessionMode };

/** 只有写类工具参与"可写根"判定；命令走独立的高危判定，见 autoApprovalReason。 */
const WRITABLE_ROOT_TOOLS = new Set([
  "write_file",
  "edit_file",
  "multi_edit",
  "delete_file",
  "move_file",
  "apply_patch",
]);

/**
 * auto 模式下这次调用能否自动批准，以及归到哪一类留痕原因。
 * 命令没有路径可校验，改用 assessCommandRisk 的启发式护栏：命中即仍要人确认。
 * 这不是沙箱；真正的执行边界在 run_code 隔离与 full 模式的显式授权上。
 */
/**
 * 命令风险按类别独立授权（codex AskForApproval::Granular 同款策略对象）：
 * "ask" = auto 模式也必须弹审批；"auto" = 可自动放行。
 * 默认全 ask —— 与既往一刀切行为完全一致；将来设置页暴露「XX 类自动放行」时改这张表。
 */
const COMMAND_RISK_POLICY: Record<CommandRiskCategory, "ask" | "auto"> = {
  disk_system: "ask",
  recursive_delete: "ask",
  credential_access: "ask",
  env_dump: "ask",
  remote_exec: "ask",
  inline_exec: "ask",
  system_config: "ask",
  privilege_escalation: "ask",
  process_kill: "ask",
  destructive_git: "ask",
  publish_deploy: "ask",
};

function autoApprovalReason(
  tool: string,
  writableTarget: boolean,
  commandRisk?: CommandRisk,
): "writable_root" | "low_risk_command" | null {
  if (tool === "run_command") {
    if (!commandRisk) return "low_risk_command";
    return commandRisk.categories.some((category) => COMMAND_RISK_POLICY[category] === "ask")
      ? null
      : "low_risk_command";
  }
  return writableTarget ? "writable_root" : null;
}

/** 「文件删除确认」只在工作区写入沙箱模式下生效；完全访问模式跳过。 */
function shouldConfirmFileDelete(): boolean {
  const settings = getSandboxSettings();
  return settings.enabled && settings.confirmDelete;
}

/** 写类工具涉及的所有路径：multi_edit 可跨文件，必须逐个判定。 */
function writablePaths(tool: string, input: unknown): string[] {
  const args = (input ?? {}) as Record<string, unknown>;
  if (tool === "multi_edit") {
    const paths = multiEditPaths(input);
    if (paths.length) return paths;
  }
  if (tool === "move_file") {
    const from = String(args.from ?? "").trim();
    const to = String(args.to ?? "").trim();
    return [from, to].filter(Boolean);
  }
  if (tool === "apply_patch") {
    return patchPaths(String(args.patch ?? ""));
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
 * <home>/.meowcode（应用自己的记忆/技能/插件数据）与工作区同属可信根。
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
      if (isWithinAppDataRoot(target)) continue;
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
 * 后台预热触发的占用区间：达到软阈值开始预生成摘要；
 * 已过 95% 说明下一轮请求大概率直接溢出，预热来不及，留给前台压缩处理。
 * 参考 codex 的 async_compaction_threshold_percent 与 token_limit_reached 短路。
 *
 * 阈值本身由 compactionTriggerTokens 计算：在比值之外还要减掉输出预留 + headroom
 * （开源同类都这么做），否则小窗口上 80% 就已经没有输出的余地。
 */
/**
 * 服务端 context editing 的门槛与参数（仅实验开关下启用）：
 * 越过窗口 75% 才武装；保留最近 3 次工具调用；一次至少清 20k token。
 * 默认关闭：keep「最近 3 次」会让清理边界随每个新 tool_use 前移，边界之后的
 * messages 每轮重写；本地压缩（80%/85%）已经兜住溢出。
 */
const CONTEXT_EDITING_TRIGGER_RATIO = 0.75;
const CONTEXT_EDITING_KEEP_TOOL_USES = 3;
const CONTEXT_EDITING_CLEAR_AT_LEAST_TOKENS = 20_000;

const COMPACTION_WARMUP_RATIO = 0.8;
/** 总量硬闸：按窗口比值算，不随预留口径移动（codex 的全窗守卫同款纪律）。 */
const COMPACTION_WARMUP_MAX_RATIO = 0.95;

/**
 * 主动压缩档阈值：占用过软阈值就在回合间隙收一轮上下文，不等溢出。
 * 参考 codex 的三层触发链（采样前预压缩 / 90% 阈值 / 手动）——溢出才压缩
 * 的体验是突然卡住一拍，主动档让压缩发生在回合之间，模型无感。
 */
const COMPACTION_PROACTIVE_RATIO = 0.85;

/**
 * 压缩质量观测窗口：压缩后多少回合内重复读「压缩前已读过」的文件算摘要漏了上下文。
 * 5 轮足够覆盖「重新探索」的典型节奏，又不会把无关的后续工作算进来。
 */
const COMPACTION_QUALITY_WINDOW_TURNS = 5;

/**
 * 缓存保活间隔：Anthropic 5m TTL 过期前重放一次前缀（290s 留 10s 余量）。
 * 参考 aider 的 warm_cache（295s 周期、max_tokens=1）；本地六个参考项目都没有
 * 保活实现，只有 hermes 用「按请求来源选 TTL」替代。
 */
const CACHE_KEEPALIVE_DELAY_MS = 290_000;
/**
 * 连续保活上限：4 次 ≈ 19 分钟空档覆盖。
 * 每次保活都要读回整段前缀，次数太多反而比让它过期后重写一次更贵；
 * Codex 也不做定时重放。超过覆盖期允许下一轮重新写缓存。
 */
const CACHE_KEEPALIVE_MAX_PINGS = 4;

/** 下一句建议：单次请求输出预算（含思考 token）；失败不重试 */
const SUGGESTION_MAX_TOKENS = 1_200;

/**
 * 空闲压缩：1h TTL 的会话空到 ~54min 缓存已死（CC v2.1.299 的 idle compaction ~54min
 * 同思路）。占用过 60% 就趁「反正要冷」后台预热压缩，把重写搭在本来就要失效的便车上。
 */
const IDLE_COMPACTION_DELAY_MS = 54 * 60_000;
const IDLE_COMPACTION_MIN_RATIO = 0.6;

/**
 * 本地摘要连续失败上限：超过就不再尝试，直接走零模型兜底。
 * 每次失败都要把整段历史发给模型，撞三次墙的代价比丢一次历史更高。
 * 参考 ZCode 的 MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES。
 */
const COMPACTION_FAILURE_LIMIT = 3;
/** 摘要连续失败 / 连续压不下去后的冷却时间：冷却期内溢出直接零模型兜底。 */
const COMPACTION_COOLDOWN_MS = 600_000;
const SHRINK_SPILL_MAP_MAX = 400;

/**
 * 零模型兜底的替代摘要：不生成摘要，只丢最旧的整单元历史。
 * 模型必须知道「历史是被丢弃而不是被总结」，否则会以为自己漏读了什么。
 */
const HISTORY_DROPPED_SUMMARY =
  "[meowcode] Earlier history was dropped without a summary because the context window was exhausted. The plan snapshot and the touched-file list below are current; re-read any file you need instead of assuming what it contains.";

/**
 * Code Mode 的取舍以开源共识为准（2026-10-30 复核后回滚了「摘只读工具定义」的做法）：
 *  - OpenCode：read/grep/glob/write/edit/shell/question/subagent 等内置工具全部
 *    `codemode: false` 留在原生目录，只有 MCP 等第三方工具折进 execute 沙箱
 *    （tool/plugin/*.ts 的 options；tool/AGENTS.md:33 的规则原文）。
 *  - Hermes：`_core_tool_names()` 注释「Names that never defer by default」——
 *    核心工具默认永不推迟，tool_search 只覆盖 MCP 与非核心会话面。
 *  - Codex：`ToolExposure::Deferred` 定义在 mcp_tool_exposure.rs，同样只针对 MCP。
 *  - DSH：PTC 全量折叠存在但 bundle 里 `disabled: true`。
 * 即：内置读写/搜索是模型的反射动作，留在原生目录；折叠预算花在第三方目录膨胀上。
 * 沙箱里保留 meow.listDir/readMany/grep/glob 供批处理，与原生工具并存，不二选一。
 */

/** 上下文占用的分类明细（token 数），五项之和恒等于 usedTokens。 */
export type ContextBreakdown = {
  /** 系统提示词（稳定前缀） */
  system: number;
  /** 工具定义 */
  tools: number;
  /** 技能索引（含 always 技能的全文） */
  skills: number;
  /** 对话消息 */
  messages: number;
  /** 项目规则 / 记忆等其余注入 */
  other: number;
};

const BREAKDOWN_KEYS = ["system", "tools", "skills", "messages", "other"] as const;
const EMPTY_BREAKDOWN: ContextBreakdown = {
  system: 0,
  tools: 0,
  skills: 0,
  messages: 0,
  other: 0,
};

/** 估算各项之和 → 按比例摊分到真实总量；舍入误差补进最大一项，保证加总一致。 */
function allocateByRatio(parts: ContextBreakdown, total: number): ContextBreakdown {
  const sum = BREAKDOWN_KEYS.reduce((acc, key) => acc + parts[key], 0);
  if (sum <= 0 || total <= 0) return { ...EMPTY_BREAKDOWN };
  const scaled: ContextBreakdown = { ...EMPTY_BREAKDOWN };
  for (const key of BREAKDOWN_KEYS) {
    scaled[key] = Math.round((parts[key] / sum) * total);
  }
  const diff = total - BREAKDOWN_KEYS.reduce((acc, key) => acc + scaled[key], 0);
  if (diff !== 0) {
    const key = BREAKDOWN_KEYS.reduce((a, b) => (scaled[a] >= scaled[b] ? a : b));
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
  // 删除/移动源：文件已不在，用「before → 空」表达删除
  if (after == null) {
    if (capture.before == null) return undefined;
    return renderDiff(capture.target, capture.before, "");
  }
  return renderDiff(capture.target, capture.before ?? "", after);
}

/** 审阅面板的操作类型：删除/移动单独标记，其它写工具按 write/edit 区分。 */
function fileChangeOperation(tool: string): "write_file" | "edit_file" | "delete_file" | "move_file" {
  if (tool === "write_file") return "write_file";
  if (tool === "delete_file") return "delete_file";
  if (tool === "move_file") return "move_file";
  return "edit_file";
}

/** 记忆总开关关闭时要撤下的工具：读写删除三条一起，避免「关了但还能写」 */
const MEMORY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "memory_read",
  "memory_write",
  "memory_delete",
]);

/**
 * 记忆总开关的环境默认值：桌面端经 MEOWCODE_MEMORY 传入 settings.json 的开关。
 * 兼容旧的 MEOWCODE_MEMORY_EXTRACTION（那时候只关蒸馏，语义是现在的一个子集）。
 * 测试环境在 vitest.setup.ts 里统一置 0。
 */
function readMemoryEnvDefault(): boolean {
  const raw = process.env.MEOWCODE_MEMORY ?? process.env.MEOWCODE_MEMORY_EXTRACTION;
  if (raw === undefined || raw.trim() === "") return true;
  const normalized = raw.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false";
}

/**
 * 回合后蒸馏的环境开关（MEOWCODE_MEMORY_DISTILL，默认开）。
 *
 * 只在「记忆总开关开着、但不想付蒸馏请求」的场合需要单独关：测试环境就是这么用的——
 * 记忆工具与索引要保留（用例断言它们常驻），后台蒸馏却会吃掉排队的 mock 响应。
 * 产品界面不暴露它：用户关记忆就是整体关。
 */
function readMemoryDistillEnvDefault(): boolean {
  const raw = process.env.MEOWCODE_MEMORY_DISTILL;
  if (raw === undefined || raw.trim() === "") return true;
  const normalized = raw.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false";
}

/** 会话回滚（文件快照）的 env 默认值：桌面端经 MEOWCODE_REWIND* 传入；默认开启。 */
function readRewindEnvDefaults(): { enabled: boolean; maxBlobBytes?: number; keepCheckpoints?: number } {
  const raw = process.env.MEOWCODE_REWIND;
  const enabled = raw === undefined || raw.trim() === "" ? true : raw.trim().toLowerCase() !== "0" && raw.trim().toLowerCase() !== "false";
  const maxMb = Number(process.env.MEOWCODE_REWIND_MAX_MB);
  const keep = Number(process.env.MEOWCODE_REWIND_KEEP);
  return {
    enabled,
    ...(Number.isFinite(maxMb) && maxMb > 0
      ? { maxBlobBytes: Math.max(64 * 1024, Math.round(maxMb * 1024 * 1024)) }
      : {}),
    ...(Number.isFinite(keep) && keep > 0 ? { keepCheckpoints: Math.round(keep) } : {}),
  };
}

/** 自我学习开关的 env 初值：**默认关闭**（实验性能力，需用户显式开启）。 */
function readLearningEnvDefault(): boolean {  const raw = process.env.MEOWCODE_SELF_LEARNING;
  if (raw === undefined || raw.trim() === "") return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on";
}

/** 供应商故障转移开关的 env 初值：**默认关闭**，设置里显式开启才切备用服务商。 */
function readProviderFallbackEnvDefault(): boolean {
  const raw = process.env.MEOWCODE_PROVIDER_FALLBACK;
  if (raw === undefined || raw.trim() === "") return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on";
}

type ApprovalBy = "user" | "hook" | "abort";

type ApprovalHandle = {
  wait: Promise<ApprovalDecision>;
  /** 返回 false 表示已被更早的结算（用户/hook/中止）抢先，本次不生效 */
  settle: (decision: ApprovalDecision | boolean, by?: ApprovalBy) => boolean;
};

function normalizeApprovalDecision(decision: ApprovalDecision | boolean): ApprovalDecision {
  if (typeof decision === "boolean") return { approved: decision };
  const feedback = decision.feedback?.trim().slice(0, 2000);
  return {
    approved: decision.approved,
    ...(feedback ? { feedback } : {}),
    ...(decision.approved && decision.remember ? { remember: decision.remember } : {}),
  };
}

/** 拒绝文案：带用户理由时一并回灌，模型下一轮可直接据此修正。 */
function denialOutput(decision: ApprovalDecision): string {
  return decision.feedback
    ? `User denied this tool call. Reason: ${decision.feedback}`
    : "User denied this tool call.";
}

export class AgentRuntime {
  private providers: ProviderConfig[];
  private providerId: string;
  private sessionsDir: string;
  /** 用户主目录：全局技能索引扫描根（~/.meowcode/skills）；测试注入临时目录隔离真实环境 */
  private homeDir: string;
  /**
   * shrink 前已落盘的旧工具输出（callId → 相对路径）：摘录替换后全文仍可 read_file 找回。
   * 只在首次遇到时写盘，之后复用路径，避免每轮请求重复落盘同一份内容。
   */
  private shrinkSpills = new Map<string, string>();
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
  /**
   * 当前进行中的模型调用 id。流中实时 usage 与最终真值共用它，前端按 id 替换样本；
   * 重试/中止时发 retracted 撤回，避免统计虚高。
   */
  private pendingUsageRoundId: string | null = null;

  /** 流中实时样本：只发事件，不落盘、不动 usageAnchor（这些仍归 recordUsage）。 */
  private emitUsageSample(
    session: SessionStore,
    roundId: string,
    usage: TokenUsage,
    source: UsageSource = "chat",
  ): void {
    this.emit({ type: "usage", sessionId: session.id, roundId, source, ...usage });
  }

  /** 放弃上一轮未提交的样本（模型重试、回合被中止）。 */
  private retractPendingUsage(session: SessionStore): void {
    if (!this.pendingUsageRoundId) return;
    this.emit({
      type: "usage",
      sessionId: session.id,
      roundId: this.pendingUsageRoundId,
      retracted: true,
    });
    this.pendingUsageRoundId = null;
  }
  /** 服务端原生压缩连续失败次数：达上限后本运行时不再尝试，直接走本地摘要。 */
  private nativeCompactionFailures = 0;
  /** 本地摘要连续失败次数：到上限后不再尝试模型摘要，直接走零模型兜底。 */
  private localCompactionFailures = 0;
  /**
   * 压缩质量观测：压缩后窗口期内重复读了哪些「压缩前已读过」的文件。
   * 只观测，不影响任何请求组装。
   */
  private compactionQuality: {
    compactionId: string;
    paths: Set<string>;
    hits: string[];
    turnsLeft: number;
  } | null = null;
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
  private pendingApprovals = new Map<
    string,
    { details: PendingApproval; resolve: (decision: ApprovalDecision) => void; settled: boolean }
  >();

  /** ask_user 虚拟工具：挂起中的澄清问题（callId → resolver），回答文本作为工具结果 */
  private pendingAsks = new Map<string, (answers: string[]) => void>();
  private pendingAskDetails: {
    callId: string;
    sessionId: string;
    questions: Array<{ question: string; options: string[] }>;
  } | null = null;
  /** 最近一次回合失败原因（按 runtime/会话保留，切回时展示） */
  private lastErrorMessage: string | null = null;
  private compactingSession = false;
  /** 输入建议请求：新回合/切会话时中止，避免晚到的结果覆盖新草稿 */
  private suggestionAbort: AbortController | null = null;
  /** 服务端 context editing 已武装（粘滞到压缩/新会话）：避免阈值附近开关抖动。 */
  private contextEditingArmed = false;
  /** 实验开关（默认全关），见 constructor options.experimental */
  private experimental: {
    midstreamToolExec?: boolean;
    incrementalResponses?: boolean;
    nativeCompaction?: boolean;
    /** 服务端 clear_tool_uses：默认关，见 contextEditingFor 的说明 */
    contextEditing?: boolean;
    /** fork 继承父 system/instructions 以复用前缀缓存；默认开，置 false 回退旧行为 */
    forkPrefixReuse?: boolean;
  } | null = null;
  /**
   * 治理层（metis 式 admission + gate 状态机）。只有根 runtime 驱动它：
   * 子 Agent 的 createSubagentRuntime 不注册治理 hooks。governance=off 时
   * 状态机仍在（admit 工具不注册，门禁不生效）。
   */
  private readonly governance: GovernanceMode;
  private workflow = new WorkflowRuntime();
  /** 连续文件变更没更新 update_plan 的计数（所有会话都算，不只治理模式） */
  private mutationsSincePlanCheck = 0;
  /** 上次注入计划提醒时的计数：再涨 PLAN_NUDGE_STEP 次才提醒下一次 */
  private planNudgeAt = 0;
  /** 本轮思考计时：首个 thinking_delta 开始，到首个正文增量（没有正文则在消息落盘时结算） */
  private thinkingStartedAt: number | null = null;
  /** 本轮思考时长（毫秒）：只算一次，后续事件与落盘复用 */
  private thinkingMs: number | null = null;
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
  /** 循环守卫（loop-guard.ts）：循环判重 + 重复读短路的全部状态 */
  private readonly loopGuard = new LoopGuard();
  /**
   * 后台预热压缩（codex 式 speculative compaction）：真实用量达到窗口阈值就在后台
   * 预生成摘要，溢出/需要压缩时直接采用 —— 摘要请求不再阻塞当前回合。
   * 参考 codex session/async_compaction.rs 的 maybe_start / take_ready / wait_for_pending。
   */
  private warmupCompaction: WarmupCompaction | null = null;
  /** 连续预热失败计数：达到上限后本会话不再预热，避免失败请求反复烧 token */
  private warmupFailures = 0;
  /** 摘要失败后的冷却截止：连续 2 次失败进 600s，避免每轮白烧全量输入。 */
  private compactionCooldownUntil = 0;
  private compactionFailureStreak = 0;
  /** 摘要成功但占用仍 ≥80% 的无效压缩次数；连续 2 次进冷却。 */
  private ineffectiveCompactions = 0;
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
  /** 诊断：turn/llm/tool 三层 span，环形缓冲；日志由 server 注入 sink 落盘 */
  private readonly traceRecorder: TraceRecorder;
  /** 后台任务：桌面端走主进程 job-host（PTY 可在终端页签接管），CLI/测试走本地子进程 */
  private readonly jobManager: JobManager = createJobManager();
  /** 子 Agent 树深度（顶层 0）与该 trace 剩余配额（含嵌套） */
  private readonly subagentDepth: number;
  private subagentBudget: number;
  /** 当前工作区的 AGENTS.md 内容（每轮重新读取，内容变化时下一轮生效） */
  private instructions: string | undefined;
  /** AGENTS.md / CLAUDE.md 读取开关：设置页切换后实时生效 */
  private instructionSettings: InstructionSettings = {};
  /** 内置技能根（server 注入；测试/嵌入场景缺省不加载随包技能） */
  private readonly builtinSkillsDir?: string;
  /** instructions 里技能索引的大小与数量：上下文来源归因用 */
  private instructionSkills: { tokens: number; count: number } = { tokens: 0, count: 0 };
  /** 桌面端内嵌浏览器桥；无桌面环境（测试 / CLI）时为 null，浏览器工具不注册 */
  private browserHost: BrowserHostClient | null;
  /** 子 Agent 开关：side 聊天与子 Agent 自身关闭，避免嵌套派发 */
  private enableTaskTool: boolean;
  /**
   * 会话节奏（缓存 TTL 的 auto 判据）：主会话/side 是 interactive，
   * 子代理与后台批量是 machine。整个会话恒定，绝不中途改——改 TTL 会让断点块失配。
   */
  private sessionPace: "interactive" | "machine";
  private systemPrompt: string;
  /** 调用方显式传了 systemPrompt：此时档位提示词不覆盖它（子 Agent / side 聊天 / 测试） */
  private customSystemPrompt: boolean;
  /** 子 Agent 写/改文件后回写父会话（审阅聚合） */
  private onFileChange?: (change: {
    path: string;
    operation: "write_file" | "edit_file" | "delete_file" | "move_file";
    diff: string;
  }) => void | Promise<void>;
  /** 工具白名单：Explore 子 Agent 只挂只读工具 */
  private allowedTools: Set<string> | null;
  /** 禁止 run_code 宿主写桥（验证类角色：能跑命令、不能改文件） */
  private denyHostWrites = false;
  /** 插件注册表（server 启动时注入；null = 未启用插件系统，hook 直通） */
  private plugins: PluginRegistry | null;
  /** 子 Agent 标识：hook payload 的 agent_id/agent_type 与 SubagentStop 判定 */
  private readonly hookScope: PluginHookScope | null;
  /** Explore 子 Agent 不注入 AGENTS.md，减少上下文 */
  private injectInstructions: boolean;
  /** 正在运行的子 Agent（agentId → 子 runtime） */
  private liveSubagents = new Map<string, LiveSubagent>();
  /** 当前回合已派发的子 Agent 数：硬上限 3，避免一个回合放大 token 消耗 */
  private subagentsStartedThisTurn = 0;
  /** 当前回合已回灌的验证失败反馈次数：硬上限防"写→验证失败→修"无限循环 */
  private verifyFailuresThisTurn = 0;
  /** 当前回合已回灌的 LSP 诊断次数（与 verify 分开计数） */
  private lspFeedbackThisTurn = 0;
  /** 子 Agent 运行中用户插话：下一个安全步骤注入（不打断当前工具/流） */
  private pendingSteers: Array<{ id: string; text: string }> = [];
  /** 当前回合内真实改动过的文件（宿主观测）：审阅面板与快照归因用 */
  private turnFileChanges = new Set<string>();
  /** 当前回合改动的行数统计（按路径聚合）：回合末汇总卡片数据源 */
  private turnFileStats = new Map<string, TurnFileChangeStat>();
  /** 当前回合主对话累计 Token：turn_complete 带给前端「使用 Token」展示 */
  private turnUsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  /** 文件快照开关与参数（会话回滚）；关闭时所有打点 no-op，checkpoint 不带 snapshot */
  private readonly snapshotOptions: {
    enabled: boolean;
    maxBlobBytes?: number;
    keepCheckpoints?: number;
  };
  /** 快照存储实例（ownerId → store；派生会话共享源 owner） */
  private readonly snapshotStores = new Map<string, SnapshotStore>();
  /** 有后台子 Agent 时暂缓标题生成，等它们结束后再补 */
  private pendingTitle: { session: SessionStore; text: string } | null = null;
  /**
   * 记忆总开关（server 的 /config/memory 可实时切换）：
   *  - 开：回合后自动蒸馏 + 记忆索引注入系统指令 + 下发 memory_read/write/delete
   *  - 关：三件事全部停掉，但记忆文件仍留在磁盘上，需要时用普通 read_file 读
   * 用 getter/setter 而不是裸字段：切换要同时让工具目录与指令快照失效，
   * 否则这一轮还挂旧工具、下一轮还在注旧索引，等于开关没关干净。
   */
  private memoryEnabledState = true;
  /** 蒸馏子开关：总开关开着时仍可单独关（测试用；产品 UI 不暴露） */
  private distillEnabled = true;
  get memoryEnabled(): boolean {
    return this.memoryEnabledState;
  }
  set memoryEnabled(value: boolean) {
    if (this.memoryEnabledState === value) return;
    this.memoryEnabledState = value;
    // 工具表 / 系统指令各有快照：一起置空，下一轮按新状态重建
    this.toolCatalog = null;
    this.rawToolsCache = null;
    this.instructionsSessionId = null;
    this.instructions = undefined;
  }
  /** 用户可见回复的语色：server 的 /config/speech-style 可实时切换；子 Agent 不生效 */
  speechStyle: SpeechStyle = "normal";
  /** 供应商故障转移：默认关闭；server 的 /config/provider-fallback 可实时切换 */
  providerFallbackEnabled = false;
  /** 蒸馏一次只跑一个：请求在途时的新增量并入下回合（游标已推进到当次快照末尾） */
  private memoryExtractionBusy = false;
  /** 蒸馏成功后的下回合通知（绑定会话：切换会话即丢弃，避免跨会话误注入） */
  private memoryNoticePending: { sessionId: string; text: string } | null = null;
  /** 每会话蒸馏游标（messages 下标）：进程内存级，重启后从最后一个用户回合重计 */
  private memoryCursors = new Map<string, number>();
  /** 距上次蒸馏累积的完成回合数：未达阈值时不推进游标，下轮把增量一起带上 */
  private memoryPendingTurns = new Map<string, number>();
  /**
   * 自我学习（观察 → 学习 → 召回 → 评估）：server 的 /config/learning 可实时切换。
   * 与记忆总开关是两条独立通道 —— 记忆存「事实」，学习存「怎么做」。
   *
   * 用 getter/setter 而不是裸字段：开关必须同步到 LearningController，
   * 否则「关掉了」但控制器里仍认为开启，子 Agent 也会跟着学。
   */
  private learningEnabled = true;
  get learning(): boolean {
    return this.learningEnabled;
  }
  set learning(value: boolean) {
    this.learningEnabled = value;
    this.learningController?.setEnabled(value);
  }
  private learningController: LearningController;
  /** 本回合的工具/命令轨迹；afterToolCall 逐次填充，回合末交给学习层。 */
  private learningTrace: TurnTrace | null = null;
  /** 本回合的召回归因上下文（turnIndex / 命中条目 / 是否对照组）。 */
  private turnLearning: { turnIndex: number; recalledIds: string[]; holdout: boolean } | null = null;
  /** 学习产出后的下回合通知（绑定会话，切走即丢弃）。 */
  private learningNoticePending: { sessionId: string; text: string } | null = null;
  /** tool_finished 的 ok 快照：afterToolCall 只拿得到结果消息，拿不到成功标志。 */
  private toolOutcomes = new Map<string, boolean>();
  /** 正在创建、尚未进入 liveSubagents 的子 Agent；用于并发上限的同步占位 */
  private startingSubagents = 0;

  /** 本会话内被写/改过的文件（mentionPathKey 归一）：@ 去重占位对这些路径失效，必须重新注入。 */
  private mutatedPaths = new Map<string, Set<string>>();
  /** 动态工具 schema 超预算只提示一次，避免每轮刷日志 */
  private dynamicToolBudgetWarned = false;
  /** MCP 工具注册完成只等一次：就绪前不发首个模型请求，避免工具中途追加整段重算 */
  private mcpWaited = false;
  /** AGENTS.md 快照归属的会话 id；配合 instructionsSignature 判定是否需要重读 */
  private instructionsSessionId: string | null = null;
  /** 上次读到的指令源指纹（AGENTS.md / CLAUDE.md / 规则目录的 mtime+size） */
  private instructionsSignature = "";
  /** MCP 就绪信号：由 server 注入 plugins.mcpReady；缺省跳过等待 */
  private readonly mcpReady: Promise<void> | null;
  /** 会话级工具目录快照：新增立即追加，删除/改写延后到缓存安全边界 */
  private toolCatalog: ToolCatalog | null = null;
  /** 原始工具表缓存：只有目录输入（动态版本 / 档位 / provider 等）变化才重建 */
  private rawToolsCache: { key: string; tools: ToolDefinition[] } | null = null;
  /** 每个 provider 上一次请求的前缀指纹与时间：缓存诊断用 */
  private providerRequestMeta = new Map<
    string,
    { key: string; at: number; snapshot: PrefixSnapshot }
  >();
  /** 本次请求的前缀信息（stream 前置记录，recordUsage 消费） */
  private currentRequest: {
    providerId: string;
    key: string;
    samePrefix: boolean;
    hadPrevious: boolean;
    idleMs: number;
    /** 前缀变化落在哪几段（tools / system_count / system[i]）；空表示无从归因 */
    changedSegments: string[];
  } | null = null;
  /** 每个会话+provider 已提示过的缓存状态，避免重复提醒 */
  private emittedCacheStates = new Map<string, CacheState>();
  /** 最近一次前缀变化原因（工具追加 / instructions 变化） */
  private lastPrefixChangeReason: string | null = null;

  constructor(options: {
    providers: ProviderConfig[];
    providerId?: string;
    sessionsDir: string;
    /** 全局技能目录扫描根（缺省 os.homedir()）；测试注入临时目录隔离真实 ~/.meowcode */
    homeDir?: string;
    workspace?: string;
    browserHost?: BrowserHostClient | null;
    enableTaskTool?: boolean;
    /**
     * 缓存 TTL 的 auto 判据：人驱动的会话用 "interactive"，子代理/后台批量用
     * "machine"。缺省 "interactive"。
     */
    sessionPace?: "interactive" | "machine";
    systemPrompt?: string;
    allowedTools?: Iterable<string>;
    /**
     * 禁止 run_code 的宿主写桥（meow.write / edit / multiEdit / delete / move）。
     * 验证类角色（verifier / fresh-verifier）用它：能跑命令，但不能改文件。
     */
    denyHostWrites?: boolean;
    injectInstructions?: boolean;
    instructionSettings?: InstructionSettings;
    /** 内置技能根：server 传入 MEOWCODE_MARKETPLACE_DIR/builtin-skills；缺省不加载 */
    builtinSkillsDir?: string;
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
      contextEditing?: boolean;
      forkPrefixReuse?: boolean;
    };
    /** 插件注册表（server 级单例）：null/缺省 = 未启用插件系统，hook 直通、无动态工具 */
    plugins?: PluginRegistry | null;
    /** 子 Agent 的 hook 作用域（根 runtime 不传；rootSessionId 缺省取当前会话） */
    hookScope?: {
      rootSessionId?: string;
      agentId?: string;
      agentType?: string;
      parentSessionId?: string;
    };
    /** MCP 就绪信号（plugins.mcpReady）：首个模型请求前等它（≤10s），避免工具中途追加整段重算 */
    mcpReady?: Promise<void> | null;
    /** 记忆总开关：缺省开启；server 从设置/env 传入初始值（关掉后不蒸馏、不注入、不下发记忆工具） */
    memory?: boolean;
    /** 只关回合后蒸馏（记忆工具与索引保留）：缺省按 MEOWCODE_MEMORY_DISTILL，测试用它 */
    distill?: boolean;
    /** 会话回滚的文件快照（缺省按 MEOWCODE_REWIND* env，默认开启）；关闭后打点 no-op */
    snapshots?: { enabled?: boolean; maxBlobBytes?: number; keepCheckpoints?: number };
    /** 自我学习（技能/经验/用户模型）：缺省开启；server 从设置/env 传入 */
    learning?: boolean;
    /** 供应商故障转移：缺省按 MEOWCODE_PROVIDER_FALLBACK，默认关闭；server 可实时切换 */
    providerFallback?: boolean;
    /** 用户可见回复的语色：缺省普通；server 从设置/env 传入并支持热更新 */
    speechStyle?: SpeechStyle;
    /**
     * 治理模式（metis 式 admission 门禁）：off = 完全关闭；goal = 仅 goal 模式
     * 强制先 admit 再变更（默认）；always = 所有会话模式都强制。
     */
    governance?: GovernanceMode;
    onFileChange?: (change: {
      path: string;
      operation: "write_file" | "edit_file" | "delete_file" | "move_file";
      diff: string;
    }) => void | Promise<void>;
    /** 诊断 span 落盘回调（server 注入 agent 日志）；缺省只进环形缓冲 */
    traceSink?: (span: TraceSpan) => void;
    /** 子 Agent 树深度（顶层 0）；决定是否还能继续嵌套 */
    subagentDepth?: number;
    /** 该 trace 剩余可派发的子 Agent 数（含嵌套）；缺省 8 */
    subagentBudget?: number;
  }) {
    this.providers = options.providers;
    this.providerId = options.providerId ?? options.providers[0]?.id ?? "";
    this.sessionsDir = options.sessionsDir;
    this.homeDir = options.homeDir ?? os.homedir();
    // 路径守卫和应用保持一致的可信根：user 记忆/技能/插件都在 <home>/.meowcode
    setAppDataRoot(path.join(this.homeDir, ".meowcode"));
    this.browserHost = options.browserHost ?? null;
    this.enableTaskTool = options.enableTaskTool ?? true;
    this.sessionPace = options.sessionPace ?? "interactive";
    this.systemPrompt = options.systemPrompt ?? BASE_SYSTEM_PROMPT;
    this.customSystemPrompt = options.systemPrompt !== undefined;
    this.allowedTools = options.allowedTools ? new Set(options.allowedTools) : null;
    this.denyHostWrites = options.denyHostWrites === true;
    this.injectInstructions = options.injectInstructions ?? true;
    this.instructionSettings = options.instructionSettings ?? {};
    this.builtinSkillsDir = options.builtinSkillsDir;
    this.experimental = options.experimental ?? null;
    this.plugins = options.plugins ?? null;
    this.hookScope = options.hookScope ?? null;
    this.mcpReady = options.mcpReady ?? null;
    this.memoryEnabled = options.memory ?? readMemoryEnvDefault();
    this.distillEnabled = options.distill ?? readMemoryDistillEnvDefault();
    const envRewind = readRewindEnvDefaults();
    this.snapshotOptions = {
      enabled: options.snapshots?.enabled ?? envRewind.enabled,
      ...(options.snapshots?.maxBlobBytes ?? envRewind.maxBlobBytes
        ? { maxBlobBytes: options.snapshots?.maxBlobBytes ?? envRewind.maxBlobBytes }
        : {}),
      ...(options.snapshots?.keepCheckpoints ?? envRewind.keepCheckpoints
        ? { keepCheckpoints: options.snapshots?.keepCheckpoints ?? envRewind.keepCheckpoints }
        : {}),
    };
    this.learningEnabled = options.learning ?? readLearningEnvDefault();
    this.learningController = new LearningController({
      workspace: options.workspace ?? process.cwd(),
      homeDir: this.homeDir,
      config: { enabled: this.learningEnabled },
      onProgress: (event) => this.emit({ type: "learning_progress", ...event }),
    });
    this.speechStyle = normalizeSpeechStyle(options.speechStyle ?? readSpeechStyleFromEnv());
    this.providerFallbackEnabled = options.providerFallback ?? readProviderFallbackEnvDefault();
    this.governance = options.governance ?? "goal";
    this.onFileChange = options.onFileChange;
    this.traceRecorder = new TraceRecorder(
      options.traceSink ? { sink: options.traceSink } : {},
    );
    this.subagentDepth = options.subagentDepth ?? 0;
    this.subagentBudget = options.subagentBudget ?? 8;
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

  /** 命中项目级规则则跳过弹窗；高危命令、文件版本已变都不算命中。 */
  private async tryRememberedApproval(
    session: SessionStore,
    tool: string,
    input: unknown,
    risk: CommandRisk | undefined,
  ): Promise<ReturnType<typeof matchApprovalRule>> {
    if (risk?.level === "high") return undefined;
    const rules = await readApprovalRules(session.cwd);
    if (!rules.length) return undefined;
    if (tool === "run_command") {
      const command = String(((input ?? {}) as Record<string, unknown>).command ?? "");
      return matchApprovalRule(rules, { tool, command });
    }
    if (WRITABLE_ROOT_TOOLS.has(tool)) {
      const files = await this.approvalTargetFiles(session, tool, input);
      const targets = await Promise.all(
        files.map(async (file) => ({
          path: toRulePath(session.cwd, file),
          version: await captureVersion(file),
        })),
      );
      return matchApprovalRule(rules, { tool, targets });
    }
    return matchApprovalRule(rules, { tool });
  }

  /** 用户批准时勾选「本项目不再询问」：按工具类型落一条规则。 */
  private async rememberApproval(
    session: SessionStore,
    tool: string,
    input: unknown,
    scope: ApprovalRememberScope,
    targets: string[],
    versions: string[],
  ): Promise<string | undefined> {
    if (WRITABLE_ROOT_TOOLS.has(tool)) {
      if (scope !== "path" || !targets.length) return undefined;
      let lastId: string | undefined;
      for (let index = 0; index < targets.length; index += 1) {
        const rule = await addApprovalRule(session.cwd, {
          tool,
          kind: "path",
          value: toRulePath(session.cwd, targets[index]),
          fileSha: versions[index],
        });
        lastId = rule.id;
      }
      return lastId;
    }
    if (tool === "run_command") {
      const command = String(((input ?? {}) as Record<string, unknown>).command ?? "").trim();
      if (!command) return undefined;
      if (scope === "command-prefix") {
        const prefix = commandPrefix(command);
        if (!prefix) return undefined;
        return (
          await addApprovalRule(session.cwd, { tool, kind: "command-prefix", value: prefix })
        ).id;
      }
      return (
        await addApprovalRule(session.cwd, { tool, kind: "command-exact", value: command })
      ).id;
    }
    if (scope !== "tool") return undefined;
    return (await addApprovalRule(session.cwd, { tool, kind: "tool", value: tool })).id;
  }

  /** 登记审批并广播；hook 审批不进会话历史（kind!=="tool"）。 */
  private registerApproval(details: PendingApproval): ApprovalHandle {
    let resolveWait: (decision: ApprovalDecision) => void = () => {};
    const wait = new Promise<ApprovalDecision>((resolve) => {
      resolveWait = resolve;
    });
    this.pendingApprovals.set(details.callId, {
      details,
      resolve: resolveWait,
      settled: false,
    });
    // 回合中止即结算：审批 Promise 不响应 abort 时，任何一条漏掉
    // settlePendingApprovals 的路径都会让 runTurn 永远挂着。
    const signal = this.turnAbort?.signal;
    const onAbort = () => {
      this.settleApproval(details.callId, { approved: false }, "abort");
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      wait.finally(() => signal.removeEventListener("abort", onAbort)).catch(() => undefined);
    }
    this.emit({ type: "approval_required", ...details });
    return {
      wait,
      settle: (decision, by = "user") => this.settleApproval(details.callId, decision, by),
    };
  }

  /** 结算一条审批：只生效一次，并广播 approval_resolved 用于关闭弹窗。 */
  private settleApproval(
    callId: string,
    decision: ApprovalDecision | boolean,
    by: ApprovalBy,
  ): boolean {
    const entry = this.pendingApprovals.get(callId);
    if (!entry || entry.settled) return false;
    entry.settled = true;
    this.pendingApprovals.delete(callId);
    const normalized = normalizeApprovalDecision(decision);
    this.emit({
      type: "approval_resolved",
      sessionId: entry.details.sessionId,
      callId,
      approved: normalized.approved,
      by,
      ...(normalized.feedback ? { feedback: normalized.feedback } : {}),
    });
    entry.resolve(normalized);
    return true;
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
    hookReason?: string,
  ): Promise<ApprovalDecision> {
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
    if (this.turnAbort?.signal.aborted) return { approved: false };
    const handle = this.registerApproval({
      callId: call.id,
      sessionId: session.id,
      workspace: session.cwd,
      tool,
      input,
      ...(diff ? { diff } : {}),
      ...(risk ? { risk } : {}),
      ...(stale ? { stale: true } : {}),
      ...(hookReason ? { hookReason } : {}),
    });
    return handle.wait;
  }

  /**
   * 人工审批 + PermissionRequest hook 并行：弹窗先发，hook 先答则关闭弹窗；
   * 用户先答则中止 hook，迟到结果丢弃。stale 二次确认不走这里。
   */
  private async awaitApprovalWithPermissionHooks(
    session: SessionStore,
    call: ToolCall,
    tool: string,
    input: unknown,
    diff: string | undefined,
    risk: CommandRisk | undefined,
    turnId: string | null,
    hookReason?: string,
  ): Promise<{ decision: ApprovalDecision; byHook: boolean; reason?: string }> {
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
    if (this.turnAbort?.signal.aborted) {
      return { decision: { approved: false }, byHook: false };
    }
    const handle = this.registerApproval({
      callId: call.id,
      sessionId: session.id,
      workspace: session.cwd,
      tool,
      input,
      ...(diff ? { diff } : {}),
      ...(risk ? { risk } : {}),
      ...(hookReason ? { hookReason } : {}),
    });
    if (!this.plugins?.hasHooks("permission_request")) {
      return { decision: await handle.wait, byHook: false };
    }

    const hookAbort = new AbortController();
    const hookSignal = this.combineSignals(this.turnAbort?.signal, hookAbort.signal);
    const hookRun = runHook(
      this.plugins,
      "permission_request",
      {
        hook: "permission_request",
        sessionId: session.id,
        callId: call.id,
        tool,
        input: input as Record<string, unknown>,
        ...this.hookScopeFields(session),
      },
      this.hookContext(session, hookSignal),
    )
      .then((result) => ({ source: "hook" as const, result }))
      .catch(() => ({ source: "hook" as const, result: undefined }));
    const userRun = handle.wait.then((decision) => ({ source: "user" as const, decision }));

    const first = await Promise.race([hookRun, userRun]);
    if (first.source === "user") {
      hookAbort.abort();
      return { decision: first.decision, byHook: false };
    }
    if (first.result?.permission === "allow" || first.result?.permission === "deny") {
      const approved = first.result.permission === "allow";
      if (handle.settle(approved, "hook")) {
        return {
          decision: { approved },
          byHook: true,
          ...(first.result.reason ? { reason: first.result.reason } : {}),
        };
      }
      // 用户抢先结算：以用户为准
      return { decision: await handle.wait, byHook: false };
    }
    // hook 没有决定：继续等用户
    return { decision: await handle.wait, byHook: false };
  }

  /**
   * 沙箱拒绝后的唯一一次「沙箱外重试」审批。
   * 刻意不使用 PermissionRequest hook：hook 只能放行普通工具审批，
   * 不能替用户决定「出沙箱」。
   */
  private async awaitSandboxEscape(
    session: SessionStore,
    escapeCallId: string,
    tool: string,
    input: unknown,
    denial: SandboxDenial,
    turnId: string | null,
  ): Promise<boolean> {
    const sandboxEscape = {
      command: String((input as { command?: unknown } | null)?.command ?? ""),
      detail: denial.evidence,
    };
    if (turnId) {
      await session.appendApprovalRequested({
        turnId,
        callId: escapeCallId,
        tool,
        input,
        sandboxEscape,
      });
      await session.flush();
    }
    if (this.turnAbort?.signal.aborted) return false;
    const handle = this.registerApproval({
      callId: escapeCallId,
      sessionId: session.id,
      workspace: session.cwd,
      tool,
      input,
      sandboxEscape,
    });
    const decision = await handle.wait;
    return decision.approved;
  }

  /**
   * 沙箱拒绝 → 一次审批 → 沙箱外重试。只重试一次，不递归；
   * approvalMode=full 也照常弹（沙箱与审批模式正交）。
   */
  private async runToolWithSandboxEscape(
    session: SessionStore,
    call: ToolCall,
    tool: string,
    input: unknown,
    turnId: string | null,
    run: (sandbox: "enforce" | "bypass") => Promise<ToolResult>,
  ): Promise<ToolResult> {
    const first = await run("enforce");
    if (!first.sandboxDenial || first.sandboxDenial.kind === "unknown_denied") return first;
    const escapeCallId = `${call.id}:outside`;
    const approved = await this.awaitSandboxEscape(
      session,
      escapeCallId,
      tool,
      input,
      first.sandboxDenial,
      turnId,
    );
    if (!approved) {
      await session.appendApproval(escapeCallId, tool, input, false, {
        ...(turnId ? { turnId } : {}),
        reason: "sandbox_denied",
      });
      return first;
    }
    const retried = await run("bypass");
    await session.appendApproval(escapeCallId, tool, input, retried.ok, {
      ...(turnId ? { turnId } : {}),
      reason: "sandbox_escape",
    });
    return {
      ...retried,
      output: `[sandbox] The first attempt was blocked; retried without the sandbox after user approval.\n${retried.output}`,
    };
  }

  /** 每次询问模式：hook 命令运行前的审批（合成 kind=hook，不进会话历史）。 */
  private async requestHookCommandApproval(
    session: SessionStore,
    request: HookCommandApprovalRequest,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    const handle = this.registerApproval({
      callId: `hook_${randomUUID()}`,
      sessionId: session.id,
      tool: "hook",
      input: {},
      kind: "hook",
      command: request.command,
      hookEvent: request.event,
      ...(request.matcher ? { matcher: request.matcher } : {}),
      ...(request.source ? { source: request.source } : {}),
    });
    if (!signal) return (await handle.wait).approved;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<ApprovalDecision>((resolve) => {
      onAbort = () => resolve({ approved: false });
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const decision = await Promise.race([handle.wait, aborted]);
    if (onAbort) signal.removeEventListener("abort", onAbort);
    if (!decision.approved) handle.settle(false, "abort");
    return decision.approved;
  }

  /** PreToolUse ask 的统一落地：审批 + 记录；返回拒绝时的工具结果文案。 */
  private async approveHookAsk(
    session: SessionStore,
    call: ToolCall,
    tool: string,
    input: unknown,
    turnId: string | null,
    hookReason: string | undefined,
  ): Promise<{ approved: boolean; output?: string }> {
    const decision = await this.awaitApprovalWithPermissionHooks(
      session,
      call,
      tool,
      input,
      undefined,
      undefined,
      turnId,
      hookReason,
    );
    await session.appendApproval(call.id, tool, input, decision.decision.approved, {
      ...(turnId ? { turnId } : {}),
      ...(decision.byHook ? { reason: "permission_request_hook" } : {}),
    });
    if (decision.decision.approved) return { approved: true };
    return {
      approved: false,
      output: decision.byHook
        ? `Permission denied by hook: ${decision.reason ?? "PermissionRequest hook"}`
        : denialOutput(decision.decision),
    };
  }

  private combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
    const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
    if (active.length === 0) return undefined;
    if (active.length === 1) return active[0];
    const controller = new AbortController();
    for (const signal of active) {
      if (signal.aborted) {
        controller.abort();
        break;
      }
      signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    return controller.signal;
  }

  private hookContext(session: SessionStore, signal?: AbortSignal): PluginHookContext {
    return {
      ...(signal ? { signal } : {}),
      permissionMode: this.turnApprovalMode ?? this.approvalMode,
      chatMode: this.turnChatMode ?? this.chatMode,
      requestApproval: (request) => this.requestHookCommandApproval(session, request, signal),
    };
  }

  private hookScopeFields(session: SessionStore): PluginHookScope {
    return {
      rootSessionId: this.hookScope?.rootSessionId ?? session.id,
      ...(this.hookScope?.agentId ? { agentId: this.hookScope.agentId } : {}),
      ...(this.hookScope?.agentType ? { agentType: this.hookScope.agentType } : {}),
      ...(this.hookScope?.parentSessionId
        ? { parentSessionId: this.hookScope.parentSessionId }
        : {}),
    };
  }

  /**
   * 观察类 hook：无阻断语义，await 保证事件顺序可预测。
   * 先 hasHooks 判空 —— 没有插件订阅时零开销，这是高频事件（每轮 / 每个工具）的前提。
   */
  private async emitHook<N extends PluginHookName>(
    name: N,
    event: PluginHookEventMap[N],
    session?: SessionStore,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.plugins?.hasHooks(name)) return;
    try {
      await runHook(
        this.plugins,
        name,
        event,
        session ? this.hookContext(session, signal) : undefined,
      );
    } catch {
      // 观察类 hook 的异常不应影响回合；runHook 内部已记录，这里再兜一层
    }
  }

  /** 高频观察类 hook（tool_execution_* / assistant_message_*）：不等待，避免拖慢主流程。 */
  private fireHook<N extends PluginHookName>(
    name: N,
    event: PluginHookEventMap[N],
    session?: SessionStore,
    signal?: AbortSignal,
  ): void {
    if (!this.plugins?.hasHooks(name)) return;
    void runHook(this.plugins, name, event, session ? this.hookContext(session, signal) : undefined).catch(
      () => undefined,
    );
  }

  /** activeProvider 的非抛错版本：切换"之前"可能还没有可用 provider。 */
  private activeProviderOrNull(): ProviderConfig | null {
    try {
      return this.activeProvider();
    } catch {
      return null;
    }
  }

  /** 模型切换通知（用户切换 / 故障转移共用）。 */
  private notifyModelSwitch(
    before: ProviderConfig | null,
    after: { providerId?: string; model?: string },
    source: "user" | "fallback" | "restore",
  ): void {
    const session = this.currentSession;
    if (!session) return;
    this.fireHook(
      "model_switch",
      {
        hook: "model_switch",
        ...this.hookScopeFields(session),
        sessionId: session.id,
        from: before ? { providerId: before.id, model: before.model } : {},
        to: after,
        source,
      },
      session,
    );
  }

  /** tool_result hook：统一 output/ok 改写，所有工具分支共用。 */
  private async applyToolResultHook(
    session: SessionStore,
    callId: string,
    tool: string,
    input: unknown,
    result: ToolResult,
  ): Promise<ToolResult> {
    const hook = await runHook(
      this.plugins,
      "tool_result",
      {
        hook: "tool_result",
        sessionId: session.id,
        callId,
        tool,
        input:
          input && typeof input === "object" && !Array.isArray(input)
            ? (input as Record<string, unknown>)
            : {},
        output: result.output,
        ok: result.ok,
        ...(result.truncated !== undefined ? { truncated: result.truncated } : {}),
        ...this.hookScopeFields(session),
      },
      this.hookContext(session, this.turnAbort?.signal),
    );
    if (!hook) return result;
    return {
      ...result,
      ...(typeof hook.output === "string" ? { output: hook.output } : {}),
      ...(typeof hook.ok === "boolean" ? { ok: hook.ok } : {}),
    };
  }

  /** 工具列表：会话快照优先（新增追加、删除/改写延后到缓存安全边界）。 */
  private get activeTools(): ToolDefinition[] {
    return this.ensureToolCatalog().tools;
  }

  /** Anthropic tools 断点锚点：目录快照末尾；追加工具后旧断点位置不动。 */
  private toolCacheAnchor(): number {
    return this.ensureToolCatalog().anchorIndex;
  }

  /** 原始工具表：桌面端注入了浏览器桥才挂 browser_* 工具；子 Agent / side 不挂 task。 */
  private computeTools(): ToolDefinition[] {
    // 记忆总开关关闭：memory_* 一并撤下。记忆文件仍在磁盘，模型要读就用普通 read_file
    const available = this.memoryEnabled
      ? toolDefinitions
      : toolDefinitions.filter((definition) => !MEMORY_TOOL_NAMES.has(definition.function.name));
    // 没有对应服务商搜索能力的模型不暴露 web_search（web_fetch 走本地 HTTP，始终保留）
    const withWebSearch = this.webSearchSupported()
      ? available
      : available.filter((definition) => definition.function.name !== "web_search");
    let base = this.enableTaskTool
      ? withWebSearch
      : withWebSearch.filter((definition) => definition.function.name !== "task");
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
        return this.withSubagentRoles(
          this.withSubagentBudgetHint(this.withSubagentProviderHint(definition)),
        );
      });
    }
    // 插件 / MCP 动态工具：同样受 allowedTools 白名单约束（Explore 子 Agent 只挂只读工具）
    const pluginTools = listDynamicToolDefinitions().filter((definition) =>
      this.toolAllowed(definition.function.name),
    );
    // 动态工具 schema 已按 8k 预算裁剪（保名字、按档砍描述）；仍被裁剪说明 server 太多，
    // 提示用户关掉不用的 —— 再往下砍就要丢语义了。
    if (dynamicToolDefinitionsTrimmed() && !this.dynamicToolBudgetWarned) {
      this.dynamicToolBudgetWarned = true;
      console.error(
        "[meowcode] dynamic tool schemas exceeded the 8k budget; overflow tools are deferred (call tool_search to surface them) — disable unused MCP servers to reduce the split",
      );
    }
    const combined = this.browserHost ? [...base, ...browser] : base;
    return [...combined, ...pluginTools];
  }

  /** 原始工具表的重建键：任一输入变化（MCP 增删、档位、provider 列表）才重算。 */
  private rawToolsKey(): string {
    return [
      dynamicToolsVersion(),
      this.agentProfile,
      this.enableTaskTool ? 1 : 0,
      this.memoryEnabled ? 1 : 0,
      this.browserHost ? 1 : 0,
      this.governance,
      this.allowedTools ? [...this.allowedTools].sort().join(",") : "",
      this.providers
        .map(
          (provider) =>
            `${provider.id}:${provider.model}:${provider.enabled === false ? 0 : 1}:${provider.baseUrl}:${
              provider.protocol ?? ""
            }:${provider.apiKey ? 1 : 0}`,
        )
        .join(","),
    ].join("|");
  }

  /** 取会话工具目录；新增立即追加，删除/改写保留旧字节并等边界。 */
  private ensureToolCatalog(): ToolCatalog {
    const key = this.rawToolsKey();
    if (!this.rawToolsCache || this.rawToolsCache.key !== key) {
      this.rawToolsCache = { key, tools: this.computeTools() };
    }
    if (!this.toolCatalog) {
      this.toolCatalog = createToolCatalog(this.rawToolsCache.tools);
      return this.toolCatalog;
    }
    const { catalog, appliedAdditions } = reconcileToolCatalog(
      this.toolCatalog,
      this.rawToolsCache.tools,
    );
    this.toolCatalog = catalog;
    if (appliedAdditions.length) this.lastPrefixChangeReason = "tools_added";
    return catalog;
  }

  /**
   * 在缓存安全边界重建工具目录（新会话 / 压缩完成 / 切档 / 插件重载）：
   * 应用所有延后的删除与改写。显式边界意味着允许一次前缀重写。
   */
  rebuildToolCatalog(reason: ToolCatalogReason): void {
    const tools = this.computeTools();
    this.rawToolsCache = { key: this.rawToolsKey(), tools };
    this.toolCatalog = createToolCatalog(tools);
    this.lastPrefixChangeReason = reason;
  }

  /**
   * 回合边界：目录里有已下线或已改写的工具时立刻重建。
   *
   * `reconcileToolCatalog` 为了保前缀缓存，把删除与改写一直延后，等一个「缓存
   * 反正要重写」的边界。但代码里原本没有任何回合级触发点——停用 MCP server 之后，
   * 模型仍会对着已经不存在的工具反复调用，然后拿到一个莫名其妙的错误。
   * 一次前缀重建远比一轮错误的工具调用便宜。
   */
  private rebuildToolCatalogAtTurnBoundary(): void {
    const catalog = this.ensureToolCatalog();
    if (!catalog.delta.removed.length && !catalog.delta.rewritten.length) return;
    this.rebuildToolCatalog("turn_boundary");
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
   * 把本档的每回合子 Agent 预算写进 task 描述：模型要按整个回合规划派发，
   * 而不是看到上限数字后再按“每批”理解。
   */
  private withSubagentBudgetHint(definition: ToolDefinition): ToolDefinition {
    const max = this.activeProfile.maxSubagents;
    const unit = max === 1 ? "subagent start" : "subagent starts";
    return {
      ...definition,
      function: {
        ...definition.function,
        description: `${definition.function.description} This session allows at most ${max} ${unit} per user turn, counted across the whole turn (background: at most ${MAX_BACKGROUND_SUBAGENTS} at once). Calls over the cap are rejected — do not exceed it.`,
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
    // 学习层需要「这次工具到底成没成」，而 afterToolCall 钩子只拿得到结果消息。
    // tool_finished 是唯一同时携带 callId 与 ok 的地方，在这里留一份短命副本。
    if (event.type === "tool_finished") {
      this.toolOutcomes.set(event.callId, event.ok);
      if (this.toolOutcomes.size > 256) {
        const oldest = this.toolOutcomes.keys().next().value;
        if (oldest !== undefined) this.toolOutcomes.delete(oldest);
      }
    }
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

  /** 当前会话的诊断链路 id；无会话时为 null。子 Agent 继承父会话的 traceId。 */
  getTraceId(): string | null {
    return this.currentSession?.traceId ?? null;
  }

  getTraceSpans(limit = 100): TraceSpan[] {
    return this.traceRecorder.list(limit);
  }

  getTraceSummary(): TraceSummary {
    return this.traceRecorder.summary();
  }

  get activeTurnSessionId(): string | null {
    return this.runningSessionId;
  }

  get pendingApproval(): PendingApproval | null {
    const entries = [...this.pendingApprovals.values()];
    const hook = entries.find((entry) => entry.details.kind === "hook");
    return hook?.details ?? entries[0]?.details ?? null;
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
    const list: PendingApproval[] = [...this.pendingApprovals.values()]
      .sort(
        (a, b) =>
          (a.details.kind === "hook" ? 0 : 1) - (b.details.kind === "hook" ? 0 : 1),
      )
      .map((entry) => ({ ...entry.details }));
    for (const [agentId, live] of this.liveSubagents) {
      for (const pending of live.runtime.pendingApprovalList) {
        list.push({
          ...pending,
          sessionId: live.parentSessionId,
          parentSessionId: live.parentSessionId,
          agentId,
          agentDescription: live.description,
        });
      }
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

  async newSession(
    cwd?: string,
    options: { worktree?: SessionWorktree } = {},
  ): Promise<SessionHeaderLike> {
    const workspace = path.resolve(cwd ?? this.currentSession?.cwd ?? process.cwd());
    let filePath = path.join(this.sessionsDir, sessionFileName(workspace, new Date()));
    let session: SessionStore;
    for (let attempt = 0; ; attempt += 1) {
      try {
        session = await SessionStore.create(filePath, workspace, options);
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
    this.contextEditingArmed = false;
    this.cancelIdleTimers(); // 换会话：旧保活计时器作废
    // 新会话 = 缓存本来就是冷的：工具目录整体重建，顺带应用所有延后的删除/改写。
    this.toolCatalog = null;
    this.rawToolsCache = null;
    this.emittedCacheStates.clear();
    this.providerRequestMeta.clear();
    this.currentRequest = null;
    this.lastPrefixChangeReason = null;
    this.cancelWarmupCompaction();
    this.warmupFailures = 0;
    this.compactionCooldownUntil = 0;
    this.compactionFailureStreak = 0;
    this.ineffectiveCompactions = 0;
    this.approvalMode = "auto";
    // 新会话没有模式记录：显式回到 default，避免沿用上一个会话的 plan/goal
    this.chatMode = "default";
    this.turnChatMode = null;
    // 新会话默认标准 Agent：档位是会话级设置，不跨会话继承
    this.agentProfile = "standard";
    this.harnessArchitecture = null;
    this.promptQueue = [];
    this.pendingSteers = [];
    this.lastErrorMessage = null;
    this.compactingSession = false;
    this.currentTurnId = null;
    this.partialDraft = null;
    this.loopGuard.clearReadVersions();
    // 同一会话的落盘快照可能仍然成立（文件没变）：恢复它，省掉重启后的整段重读
    await this.restoreReadCoverage(session);
    // 压缩基线与熔断计数都是「当前会话」的状态：切走必须清掉，
    // 否则会把 compaction_quality 写进新会话，或让新会话继承旧会话的熔断。
    this.compactionQuality = null;
    this.localCompactionFailures = 0;
    this.dynamicToolBudgetWarned = false;
    await this.refreshInstructions(session);
    // 插件 hook：session_start（观察）
    await runHook(
      this.plugins,
      "session_start",
      {
        hook: "session_start",
        sessionId: session.id,
        cwd: session.cwd,
        ...this.hookScopeFields(session),
      },
      this.hookContext(session),
    );
    return {
      id: session.id,
      cwd: session.cwd,
      filePath: session.filePath,
      messages: session.messages,
      ...(session.worktree ? { worktree: session.worktree } : {}),
    };
  }

  async switchSession(filePath: string): Promise<SessionHeaderLike> {
    this.suggestionAbort?.abort();
    this.suggestionAbort = null;
    const session = await SessionStore.load(filePath);
    const previous = this.currentSession;
    await this.clearQueuedPrompts("discarded");
    // 切走旧会话：先通知观察者，再释放文件句柄
    if (previous && previous !== session) {
      await this.emitHook(
        "session_end",
        {
          hook: "session_end",
          ...this.hookScopeFields(previous),
          sessionId: previous.id,
          cwd: previous.cwd,
          reason: "switch",
        },
        previous,
      );
    }
    // 正在跑的回合仍持有旧 store：等它自然结束，不能在这里关闭句柄
    if (previous && previous !== session && this.runningSessionId !== previous.id) {
      await previous.close().catch(() => undefined);
    }
    this.currentSession = session;
    this.usageAnchor = null;
    this.contextEditingArmed = false;
    this.cancelIdleTimers(); // 换会话：旧保活计时器作废
    // 新会话 = 缓存本来就是冷的：工具目录整体重建，顺带应用所有延后的删除/改写。
    this.toolCatalog = null;
    this.rawToolsCache = null;
    this.emittedCacheStates.clear();
    this.providerRequestMeta.clear();
    this.currentRequest = null;
    this.lastPrefixChangeReason = null;
    this.cancelWarmupCompaction();
    this.warmupFailures = 0;
    this.compactionCooldownUntil = 0;
    this.compactionFailureStreak = 0;
    this.ineffectiveCompactions = 0;
    this.approvalMode = "auto";
    this.promptQueue = [];
    this.pendingSteers = [];
    this.lastErrorMessage = null;
    this.compactingSession = false;
    this.currentTurnId = null;
    this.partialDraft = null;
    this.loopGuard.clearReadVersions();
    // 同一会话的落盘快照可能仍然成立（文件没变）：恢复它，省掉重启后的整段重读
    await this.restoreReadCoverage(session);
    // 压缩基线与熔断计数都是「当前会话」的状态：切走必须清掉，
    // 否则会把 compaction_quality 写进新会话，或让新会话继承旧会话的熔断。
    this.compactionQuality = null;
    this.localCompactionFailures = 0;
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
    await runHook(
      this.plugins,
      "session_start",
      {
        hook: "session_start",
        sessionId: session.id,
        cwd: session.cwd,
        ...this.hookScopeFields(session),
      },
      this.hookContext(session),
    );
    return {
      id: session.id,
      cwd: session.cwd,
      filePath: session.filePath,
      messages: session.messages,
      ...(session.worktree ? { worktree: session.worktree } : {}),
    };
  }

  async setModel(providerId: string, modelId: string): Promise<void> {
    const provider = this.providers.find((item) => item.id === providerId);
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    const before = this.activeProviderOrNull();
    provider.model = modelId;
    this.providerId = providerId;
    this.usageAnchor = null; // 换模型后旧用量不再代表当前上下文
    this.syncNativeReplay();
    this.cancelWarmupCompaction();
    this.cancelIdleTimers(); // 换模型 = 换缓存分片，旧保活计划作废
    await this.persistSessionSettings().catch(() => undefined);
    this.notifyModelSwitch(before, { providerId, model: modelId }, "user");
  }

  /** 只切换当前激活的服务商（不改它的模型 id）。 */
  setActiveProvider(providerId: string): void {
    const provider = this.providers.find((item) => item.id === providerId);
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    if (provider.enabled === false) throw new Error(`Provider is disabled: ${providerId}`);
    const before = this.activeProviderOrNull();
    this.providerId = providerId;
    this.usageAnchor = null; // 换模型后旧用量不再代表当前上下文
    this.syncNativeReplay();
    this.cancelWarmupCompaction();
    this.cancelIdleTimers(); // 换端点 = 换缓存分片，旧保活计划作废
    this.notifyModelSwitch(before, { providerId, model: provider.model }, "user");
  }

  /**
   * 运行中替换服务商列表（设置页增删改模型）：不清会话、不中断回合。
   * 显式缓存边界：子 Agent 可选模型提示写在工具描述里，列表变化必须重建目录。
   * 进行中的请求继续用旧配置，下一次请求起生效。
   */
  replaceProviders(providers: ProviderConfig[], activeProviderId?: string): void {
    this.providers = JSON.parse(JSON.stringify(providers)) as ProviderConfig[];
    if (activeProviderId) this.providerId = activeProviderId;
    else if (!this.providers.some((item) => item.id === this.providerId)) {
      // 当前项被删掉：和 activeProviderId getter 一样回退到首个可用项
      this.providerId = this.activeProviderId;
    }
    this.usageAnchor = null; // 服务商/模型变了，旧用量不再代表当前上下文
    this.syncNativeReplay();
    this.cancelWarmupCompaction();
    this.cancelIdleTimers(); // 换端点 = 换缓存分片，旧保活计划作废
    this.rebuildToolCatalog("providers");
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

  /** 当前激活的服务商 id（跳过被停用的），供 /config/providers 回给前端；未配置模型时为空，不抛错。 */
  get activeProviderId(): string {
    const active =
      this.providers.find((item) => item.id === this.providerId && item.enabled !== false) ??
      this.providers.find((item) => item.enabled !== false) ??
      this.providers[0];
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
    const signal = this.turnAbort?.signal;
    if (signal?.aborted) return questions.map(() => "");
    // abort 必须能把挂起解掉：只要有一条路径漏掉 settlePendingApprovals，
    // runTurn 就永远退不出来（UI 显示已停止，后台回合还挂着）。
    return new Promise<string[]>((resolve) => {
      const settle = (answers: string[]): void => {
        this.pendingAsks.delete(callId);
        if (this.pendingAskDetails?.callId === callId) this.pendingAskDetails = null;
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        resolve(answers);
      };
      let onAbort: (() => void) | undefined;
      if (signal) {
        onAbort = () => settle(questions.map(() => ""));
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.pendingAsks.set(callId, settle);
    });
  }

  respondToApproval(callId: string, decision: ApprovalDecision | boolean): boolean {
    if (this.pendingApprovals.has(callId)) {
      return this.settleApproval(callId, decision, "user");
    }
    for (const live of this.liveSubagents.values()) {
      if (live.runtime.respondToApproval(callId, decision)) return true;
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
    // 模式指令是 in-history 尾注：切换即追加，先于用户的下一条消息落盘（runTurn 只兜底压缩后重挂）
    await this.ensureModeContext(session).catch(() => undefined);
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
    // 切档是显式行为：工具白名单整体变化，直接重建目录（允许一次前缀重写）。
    this.rebuildToolCatalog("profile");
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
    for (const callId of this.pendingApprovals.keys()) {
      this.settleApproval(callId, false, "abort");
    }
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
    this.cancelIdleTimers();
    this.settlePendingApprovals();
    this.abortSubagents();
    this.turnAbort?.abort();
    const session = this.currentSession;
    if (session) {
      // 同步方法里发不了 await：观察类 hook 用投递模式，尽力而为
      this.fireHook(
        "interrupt",
        {
          hook: "interrupt",
          ...this.hookScopeFields(session),
          sessionId: session.id,
          reason: "user_abort",
          source: "user",
          ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
        },
        session,
      );
    }
  }

  /** 应用/server 关停：中止回合但保留排队消息，下次启动作为“待发送”恢复。 */
  shutdown(): void {
    this.shuttingDown = true;
    this.cancelIdleTimers();
    this.settlePendingApprovals();
    this.abortSubagents(true);
    this.turnAbort?.abort();
    const session = this.currentSession;
    if (session) {
      this.fireHook(
        "interrupt",
        {
          hook: "interrupt",
          ...this.hookScopeFields(session),
          sessionId: session.id,
          reason: "shutdown",
          source: "system",
        },
        session,
      );
      this.fireHook(
        "session_end",
        {
          hook: "session_end",
          ...this.hookScopeFields(session),
          sessionId: session.id,
          cwd: session.cwd,
          reason: "shutdown",
        },
        session,
      );
    }
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
        ...session.effectiveMessages,
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
    /** 发现的技能数量（用于「Skill（N个）」标签） */
    skillCount: number;
    /** 对话消息的细分归因（纯估算，不受 usage 锚点摊分影响） */
    messageDetail: MessageBreakdown | null;
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
        breakdown: { ...EMPTY_BREAKDOWN },
        skillCount: 0,
        messageDetail: null,
        recommendedCompaction: false,
      };
    }
    // 正常请求不发投影版本：占用估算也必须按实际发送的完整历史计算，
    // 否则旧图片/thinking 不计入窗口，80%/85% 阈值会晚触发。
    const effective = session.effectiveMessages;
    const instructionTokens = this.instructions ? estimateTokens(this.instructions) : 0;
    // 技能索引包含在 instructions 里：单独拎出来归因，其余规则/记忆算「其他」
    const skillTokens = Math.min(instructionTokens, this.instructionSkills.tokens);
    const estimated: ContextBreakdown = {
      system: estimateTokens(this.effectiveSystemPrompt),
      tools: estimateToolDefinitionsTokens(this.activeTools),
      skills: skillTokens,
      messages: estimateMessagesTokens(effective),
      other: Math.max(0, instructionTokens - skillTokens),
    };
    const messageDetail = breakdownMessages(effective);
    // 锚点按「请求覆盖到的有效消息数」定位，能精确算出之后新增了多少（工具结果/新回合）
    const anchored = estimateContextTokens(effective, this.usageAnchor);
    if (anchored.source === "usage") {
      return {
        contextWindow,
        usedTokens: anchored.tokens,
        source: "usage",
        breakdown: allocateByRatio(estimated, anchored.tokens),
        skillCount: this.instructionSkills.count,
        messageDetail,
        recommendedCompaction: shouldRecommendCompaction(
          anchored.tokens,
          contextWindow,
          provider?.maxTokens,
        ),
      };
    }
    const usedTokens = BREAKDOWN_KEYS.reduce((acc, key) => acc + estimated[key], 0);
    return {
      contextWindow,
      usedTokens,
      source: "estimate",
      breakdown: estimated,
      skillCount: this.instructionSkills.count,
      messageDetail,
      recommendedCompaction: shouldRecommendCompaction(usedTokens, contextWindow, provider?.maxTokens),
    };
  }

  /** 每回合开始时清空循环检测状态：跨回合的相同调用不算循环。（状态在 loop-guard.ts） */
  private resetLoopState(sessionId: string): void {
    this.loopGuard.reset(sessionId);
  }

  /** 执行前检查：连续 8 次零信息重复直接拒绝执行 —— 省掉执行本身与整轮上下文重发。 */
  private loopBlockFor(session: SessionStore, tool: string, input: unknown): string | null {
    return this.loopGuard.blockFor(session.id, tool, input);
  }

  /** 执行后登记循环计数，返回要附加到工具结果的提醒（未达阈值返回空串）。 */
  private noteLoopResult(session: SessionStore, tool: string, input: unknown, output: string): string {
    return this.loopGuard.noteResult(session.id, tool, input, output);
  }

  /** 读取成功后登记「看过这一版、这一段」，供后续读区间短路。 */
  private async rememberReadRange(
    session: SessionStore,
    callId: string,
    input: unknown,
    range: { start: number; end: number; total: number } | undefined,
    allowOutsideWorkspace: boolean,
  ): Promise<void> {
    await this.loopGuard.rememberReadRange(
      session.cwd,
      callId,
      input,
      range,
      allowOutsideWorkspace,
    );
    const target = (input as { path?: unknown } | null)?.path;
    if (typeof target === "string") this.noteReread(session.cwd, target);
  }

  /** 批量读逐文件登记：read_many 一次调用会返回多个文件的区间。 */
  private async rememberReadRangeAt(
    session: SessionStore,
    callId: string,
    target: string,
    range: { start: number; end: number; total: number },
    allowOutsideWorkspace: boolean,
  ): Promise<void> {
    await this.loopGuard.rememberReadRangeAt(
      session.cwd,
      callId,
      target,
      range,
      allowOutsideWorkspace,
    );
    this.noteReread(session.cwd, target);
  }

  /** 压缩基线用的路径键：相对工作区、win32 小写、正斜杠。 */
  private qualityPathKey(cwd: string, target: string): string {
    const resolved = path.resolve(cwd, target);
    const relative = path.relative(cwd, resolved) || resolved;
    const normalized = relative.split(path.sep).join("/");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  }

  /** 读取成功后记录「压缩后又读了压缩前已碰过的文件」——摘要漏上下文的唯一信号。 */
  private noteReread(cwd: string, target: string): void {
    const quality = this.compactionQuality;
    if (!quality || !target) return;
    const key = this.qualityPathKey(cwd, target);
    if (!quality.paths.has(key) || quality.hits.includes(key)) return;
    quality.hits.push(key);
  }

  /** 从 read_file 的调用参数里取目标路径并计入观测（read_many 走逐文件登记）。 */
  private noteReadTarget(session: SessionStore, tool: string, input: unknown): void {
    if (tool !== "read_file") return;
    const target = (input as { path?: unknown } | null)?.path;
    if (typeof target === "string") this.noteReread(session.cwd, target);
  }

  /** 回合末推进观测窗口；归零时落一条条目并广播。失败只影响观测，不影响回合。 */
  private async tickCompactionQuality(session: SessionStore): Promise<void> {
    const quality = this.compactionQuality;
    if (!quality) return;
    quality.turnsLeft -= 1;
    if (quality.turnsLeft > 0) return;
    this.compactionQuality = null;
    try {
      await session.appendCompactionQuality({
        compactionId: quality.compactionId,
        baselineCount: quality.paths.size,
        rereadPaths: quality.hits,
        windowTurns: COMPACTION_QUALITY_WINDOW_TURNS,
      });
      await session.flush().catch(() => undefined);
      this.emit({
        type: "compaction_quality",
        sessionId: session.id,
        compactionId: quality.compactionId,
        baselineCount: quality.paths.size,
        rereadPaths: quality.hits,
        windowTurns: COMPACTION_QUALITY_WINDOW_TURNS,
      });
    } catch (error) {
      console.error(
        `[meowcode] failed to journal compaction quality: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** 请求区间已被之前读取完整覆盖时返回占位（文件版本未变且旧结果仍可见）。 */
  private async repeatedReadStub(
    session: SessionStore,
    messages: ChatMessage[],
    call: ToolCall,
    input: unknown,
    allowOutsideWorkspace: boolean,
  ): Promise<string | null> {
    return this.loopGuard.repeatedReadStub(session.cwd, messages, call, input, allowOutsideWorkspace);
  }

  /**
   * 部分覆盖：只保留未读过的尾部，把已读的前缀换成一行说明。
   * 先执行后裁剪 —— 执行便宜，重复正文才是成本。
   */
  private async trimCoveredRead(
    session: SessionStore,
    messages: ChatMessage[],
    input: unknown,
    output: string,
    allowOutsideWorkspace: boolean,
  ): Promise<string | null> {
    return this.loopGuard.trimCoveredReadPrefix(
      session.cwd,
      messages,
      input,
      output,
      allowOutsideWorkspace,
    );
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
    const detail = usage.messageDetail;
    // 细分类只报占比最高的几项：看板要回答的是「谁在吃」，不是给全量账本。
    const topBuckets = detail
      ? [
          ...detail.toolResults.slice(0, 3).map((item) => ({ label: `${item.name} output`, tokens: item.tokens })),
          { label: "assistant text", tokens: detail.assistantText },
          { label: "user text", tokens: detail.userText },
          { label: "injected context", tokens: detail.injected },
          { label: "media", tokens: detail.media },
          { label: "tool call args", tokens: detail.other },
        ]
          .filter((item) => item.tokens > 0)
          .sort((a, b) => b.tokens - a.tokens)
          .slice(0, 4)
      : [];
    return [
      `${head}${source}`,
      `Breakdown: system ${usage.breakdown.system}, tool schemas ${usage.breakdown.tools}, skills ${usage.breakdown.skills}, conversation ${usage.breakdown.messages}, other ${usage.breakdown.other} (estimated).`,
      ...(detail && topBuckets.length
        ? [
            `Largest in conversation (estimated tokens): ${topBuckets
              .map((item) => `${item.label} ${item.tokens}`)
              .join(", ")}.`,
          ]
        : []),
      usage.recommendedCompaction
        ? "Recommendation: past 85% of the window. Finish the current step, avoid bulk reads, and wrap up or start a new session; older tool results are compacted automatically on overflow."
        : "Recommendation: enough headroom for now.",
    ].join("\n");
  }

  /**
   * 回合结束后预测用户下一句：独立提示词 + 最近几条对话摘录（裁 1200 字），
   * 不复用主对话前缀——避免主系统提示词把模型带回「助手回复」模式，输入也更小。
   * 一次性形状（无工具、单 user 轮）由 isOneShotRequest 抑制缓存写入。
   */
  async suggestNextPrompt(): Promise<string | null> {
    const session = this.currentSession;
    const provider = this.activeProviderOrNull();
    if (!session || !provider || this.isRunning || this.compactingSession) return null;
    if (this.chatMode === "plan" || this.pendingApprovalList.length > 0 || this.pendingAskDetails) {
      return null;
    }
    const lastAssistant = [...session.effectiveMessages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (
      !lastAssistant ||
      typeof lastAssistant.content !== "string" ||
      !lastAssistant.content.trim()
    ) {
      return null;
    }

    this.suggestionAbort?.abort();
    const controller = new AbortController();
    this.suggestionAbort = controller;
    const timeout = setTimeout(() => controller.abort(), 20_000);
    // 只带最近几条对话，用独立提示词而不是主对话前缀：避免主系统提示词把模型
    // 带回「助手回复」模式，同时输入更小；失败不重试，建议只是锦上添花。
    const transcript = session.effectiveMessages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .slice(-8)
      .map((message) => {
        if (typeof message.content !== "string") return null;
        const text = message.content.trim();
        if (!text) return null;
        const clipped = text.length > 1_200 ? `${text.slice(0, 1_200)}…` : text;
        return `${message.role === "user" ? "User" : "Assistant"}: ${clipped}`;
      })
      .filter((line): line is string => Boolean(line))
      .join("\n\n");
    if (!transcript) return null;
    try {
      const result = await streamChatCompletion({
        provider: utilityProvider(provider, SUGGESTION_MAX_TOKENS, "suggestion"),
        messages: [
          { role: "system", content: SUGGESTION_SYSTEM_PROMPT },
          { role: "user", content: `${transcript}\n\n${SUGGESTION_USER_PROMPT}` },
        ],
        tools: [],
        signal: controller.signal,
        onDelta: () => undefined,
        onUsageFinal: (usage) => {
          void session
            .appendUsage({
              ...usage,
              source: "suggestion",
              providerId: provider.id,
              model: provider.model,
            })
            .catch(() => undefined);
        },
      });
      return usableSuggestion(result.message.content ?? "");
    } catch {
      // 建议是锦上添花：中止/网关拒绝/超时都静默失败
      return null;
    } finally {
      clearTimeout(timeout);
      if (this.suggestionAbort === controller) this.suggestionAbort = null;
    }
  }

  /**
   * 缓存策略（P0-3/P1-4）：给每个请求的 provider 盖两项会话级章——
   *  - pace：会话节奏，`cacheTtl: "auto"` 的判据（人驱动 vs 子代理/批量）。
   *    **必须在会话开始就定死且整个会话恒定**：TTL 是断点字段的一部分，
   *    中途改会让那个块及之后的整段前缀失配。
   *  - promptCacheKey：会话亲和值，由 sessionId + 用途派生。
   * 三种协议都盖：Responses 与 Anthropic 用它发 `x-session-id`（防止代理把两个
   * 会话的缓存串到一个分片，hermes 实测未钉住时 collapse 率 9.8%）；chat 的 body
   * 字段仍由协议层按端点门禁（只发官方主机），第三方网关只拿到头，不会吃 400。
   */
  private applyCachePolicy(
    provider: ProviderConfig,
    sessionId: string,
    purpose = "main",
  ): ProviderConfig {
    const paced: ProviderConfig = { ...provider, pace: this.sessionPace };
    // 血缘亲和：只有 fork 继承来源键（它复制了父历史）。spawn 子 Agent 的
    // system[0] 与父不同、历史也不复制，共享键命中不了还挤占父分片，因此各用各的。
    // 仅内容寻址的官方 OpenAI 端点启用；切会话窗口里 currentSession 已指向新会话，
    // 用 id 比对避免把 A 的键盖到 B 的请求上。
    const lineage =
      supportsLineageAffinity(provider) && this.currentSession?.id === sessionId
        ? this.currentSession.affinityRootId
        : undefined;
    return { ...paced, promptCacheKey: sessionAffinityKey(lineage ?? sessionId, purpose) };
  }

  async prompt(
    text: string,
    queueId?: string,
    images?: ToolImage[],
    documents?: ToolDocument[],
  ): Promise<void> {
    const session = this.currentSession;
    if (!session) throw new Error("No active session. Create a session first.");
    // 用户已经开始下一轮：上一轮的输入建议请求不再有意义
    this.suggestionAbort?.abort();
    this.suggestionAbort = null;
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
    const session = this.currentSession;
    if (session) {
      this.fireHook(
        "interrupt",
        {
          hook: "interrupt",
          ...this.hookScopeFields(session),
          sessionId: session.id,
          reason: "steer",
          source: "user",
          ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
        },
        session,
      );
    }
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
    this.cancelIdleTimers(); // 用户回来了：让位（保留保活刷新到的热缓存）
    this.turnApprovalMode = this.approvalMode;
    this.turnChatMode = this.chatMode;
    this.lastErrorMessage = null;
    const turnId = randomUUID();
    this.currentTurnId = turnId;
    const turnStartedAtMs = Date.now();
    this.partialRound = 0;
    this.partialDraft = null;
    this.subagentsStartedThisTurn = 0;
    this.verifyFailuresThisTurn = 0;
    this.lspFeedbackThisTurn = 0;
    this.turnFileChanges.clear();
    this.turnFileStats.clear();
    this.turnUsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    // 学习轨迹：本回合的工具/命令成败，回合末交给学习层做门禁与归因
    this.learningTrace = createTurnTrace();
    this.learningTrace.userTexts.push(text);
    this.turnLearning = null;
    const provider = this.activeProvider();
    let status: TurnStatus = "completed";
    let errorMessage: string | undefined;
    /** 本轮开始时的检查点：「已编辑 N 个文件」卡片的撤销目标 */
    let turnCheckpointId: string | undefined;
    let turnCheckpointHasSnapshot = false;
    /** 收尾时 finally 会清空累计，turn_complete 需要这份快照 */
    let turnFiles: TurnFileChangeStat[] = [];
    const turnSpan = this.traceRecorder.startSpan({
      traceId: session.traceId,
      kind: "turn",
      name: "prompt",
      attributes: {
        provider: provider.id,
        model: provider.model,
        approvalMode: this.turnApprovalMode ?? this.approvalMode,
      },
    });
    try {
      // 插件 hook：prompt_submit（可 block / 改写文本）。改写后的文本参与落盘与请求；
      // blocked → 落盘用户消息后直接给一条 assistant 说明，回合正常收尾。
      const submitted = await runHook(
        this.plugins,
        "prompt_submit",
        {
          hook: "prompt_submit",
          sessionId: session.id,
          text,
          ...this.hookScopeFields(session),
        },
        this.hookContext(session, this.turnAbort?.signal),
      );
      if (typeof submitted?.text === "string") text = submitted.text;
      if (this.learningTrace) this.learningTrace.userTexts = [text];
      // 技能引用回合不受会话权限模式影响：技能里的写文件/命令直接执行，回合结束自动恢复原模式
      if (hasSkillReference(text)) this.turnApprovalMode = "full";
      // 本回合的可回滚点（对应用户消息之前的状态）：必须打在 turn_start 之前 ——
      // 若打在之后，回滚派生的会话会带一个孤立 turn_start，switchSession 的崩溃
      // 恢复会把它重放成一条假用户消息并报「上次生成被中断」，回滚结果直接被污染。
      const turnCheckpoint = await this.writeTurnCheckpoint(session, turnId, text);
      turnCheckpointId = turnCheckpoint?.id;
      turnCheckpointHasSnapshot = Boolean(turnCheckpoint?.hasSnapshot);
      if (!turnCheckpointId) {
        // 2s 内同位置被去重：复用该位置最后一条检查点（快照语义等价，仍可撤销本轮）
        const anchor = session.checkpoints.at(-1);
        if (anchor && anchor.messageIndex === session.messages.length) {
          turnCheckpointId = anchor.id;
          turnCheckpointHasSnapshot = Boolean(anchor.hasSnapshot);
        }
      }
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
        // 悬浮岛等订阅方没有乐观追加（排队消息也一样），靠文本补用户气泡
        text,
      });
      if (turnCheckpoint) {
        // 流式回退入口：前端乐观追加的用户气泡靠这条事件补挂 checkpointId
        this.emit({
          type: "checkpoint_created",
          sessionId: session.id,
          checkpointId: turnCheckpoint.id,
          turnId,
          hasSnapshot: turnCheckpoint.hasSnapshot,
          ...(turnCheckpoint.label ? { label: turnCheckpoint.label } : {}),
        });
      }
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
      await this.emitHook(
        "turn_start",
        {
          hook: "turn_start",
          ...this.hookScopeFields(session),
          sessionId: session.id,
          turnId,
          text,
        },
        session,
        this.turnAbort?.signal,
      );
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
      // 蒸馏通知（ZCode consumePendingProjectMemoryUpdate 同款）：随下一条用户
      // 请求注入 in-history 说明（context_note 不上聊天时间线）。绑定会话：
      // 切走即丢弃，跨会话的旧通知只会误导模型。
      if (this.learningNoticePending) {
        const learningNotice = this.learningNoticePending;
        this.learningNoticePending = null;
        if (learningNotice.sessionId === session.id) {
          try {
            await session.appendContextNote(learningNotice.text, "file");
            await session.flush();
          } catch {
            // 注入失败不打断回合
          }
        }
      }
      if (this.memoryNoticePending) {
        const notice = this.memoryNoticePending;
        this.memoryNoticePending = null;
        if (notice.sessionId === session.id) {
          try {
            await session.appendContextNote(notice.text, "file");
            await session.flush();
          } catch {
            // 注入失败不打断回合
          }
        }
      }
      // 新的用户请求 = 新任务：上一条已完成的治理 run 清空，门禁重新武装。
      // 架构图会话级快照：每会话只装载一次（外部改动必须经 PUT /harness 显式重载，
      // 每 prompt 静默重读会让 system[0] 字节漂移、整段缓存失效——AGENTS.md 同纪律）。
      // 治理关闭时也要装载：角色节点的工具/提示词覆盖与治理无关。
      if (this.enableTaskTool && !this.workflow.active) {
        const needsLoad =
          this.harnessSnapshotSessionId !== session.id || this.harnessNoticePending;
        if (needsLoad) {
          try {
            const doc = await loadHarnessDocument(session.cwd, this.currentHarnessArchitecture);
            const noticeDue = this.harnessNoticePending;
            this.workflow.setHarness(doc);
            this.harnessSnapshotSessionId = session.id;
            this.harnessNoticePending = false;
            if (noticeDue) {
              // opencode 同款：变更不悄悄换前缀，in-history 提醒随历史落盘、成为后续回合的稳定前缀
              await session.appendContextNote(
                "Runtime context: the harness architecture document was updated; the refreshed workflow map applies from this turn.",
                "file",
              );
              await session.flush();
            }
          } catch {
            // 读取失败保持当前图
          }
        }
      }
      if (this.workflow.state?.completed) this.workflow.reset();
      this.mutationsSincePlanCheck = 0;
      this.planNudgeAt = 0;
      // 插件 hook：context_inject（往历史尾部追加上下文）。
      // 只走 context_note，不进系统提示 —— 否则请求前缀一变，prompt cache 整段作废。
      const injected = await runHook(
        this.plugins,
        "context_inject",
        {
          hook: "context_inject",
          ...this.hookScopeFields(session),
          sessionId: session.id,
          turnId,
          text,
          phase: "turn_start",
        },
        this.hookContext(session, this.turnAbort?.signal),
      );
      for (const note of injected?.notes ?? []) {
        try {
          await session.appendContextNote(note, "plugin");
          await session.flush();
        } catch {
          // 注入失败不打断回合
        }
      }
      // 学习召回：按 trigger 命中历史经验，追加到历史尾部（不动 system[1]，缓存安全）。
      // 放在 runTurn 之前、且每个用户回合只调一次 —— 续命循环复用同一批召回。
      await this.beginLearningTurn(session, text);
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
      // 先留快照：下面可能清空累计、也可能落盘失败，但 turn_complete 仍要带上本轮统计
      turnFiles = [...this.turnFileStats.values()];
      try {
        await this.finalizePartial(session);
        await session.appendTurnEnd({
          turnId,
          status,
          ...(errorMessage ? { error: errorMessage } : {}),
        });
        // 压缩质量观测窗口按回合推进（纯观测，失败不影响收尾）
        await this.tickCompactionQuality(session);
        this.turnFileChanges.clear();
        this.turnFileStats.clear();
        await session.flush();
      } catch {
        // 落盘失败也必须发出 turn_complete，否则前端一直显示生成中
      }
      // 收尾时仍未提交的实时样本（中止/报错）作废
      this.retractPendingUsage(session);
      this.turnAbort = null;
      this.runningSessionId = null;
      this.turnApprovalMode = null;
      this.turnChatMode = null;
      this.currentTurnId = null;
      this.partialDraft = null;
      for (const callId of this.pendingApprovals.keys()) {
        this.settleApproval(callId, false, "abort");
      }
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
      this.emit({
        type: "turn_complete",
        sessionId: session.id,
        status,
        turnId,
        // 本回合总耗时（墙钟，含工具调用与续命段）：前端在该轮末尾定格显示
        durationMs: Date.now() - turnStartedAtMs,
        endedAt: new Date().toISOString(),
        ...(() => {
          const totals = this.turnUsageTotals;
          return totals.input || totals.output || totals.cacheRead || totals.cacheWrite
            ? {
                turnUsage: {
                  inputTokens: totals.input,
                  outputTokens: totals.output,
                  cacheReadTokens: totals.cacheRead,
                  cacheWriteTokens: totals.cacheWrite,
                  totalTokens: totals.input + totals.output,
                },
              }
            : {};
        })(),
        // 有文件改动才带：前端据此在本轮末尾显示「已编辑 N 个文件」卡片
        ...(turnFiles.length ? { files: turnFiles } : {}),
        ...(turnCheckpointId ? { checkpointId: turnCheckpointId } : {}),
        ...(turnCheckpointId ? { canRewind: turnCheckpointHasSnapshot } : {}),
      });
      this.traceRecorder.endSpan(turnSpan, {
        status: status === "completed" ? "ok" : status === "aborted" ? "aborted" : "error",
        ...(errorMessage ? { error: errorMessage } : {}),
        attributes: { files: turnFiles.length },
      });
      // 回合结束 = 蒸馏时机（ZCode turn.completed 同款）：只分析本轮增量
      this.scheduleMemoryExtraction(session, status);
      // 回合结束 = 学习时机：先落 outcome + 归因，再判断值不值得调用学习器
      this.finishLearningTurn(session, status);
      // 回合结束 = 前缀刚写入缓存：安排保活（5m TTL 空档）与空闲压缩（1h TTL 长空档）
      this.scheduleCacheKeepalive(session);
      // 已读区间随回合落盘：重启后仍能短路「已读过且未变更」的整段重读
      this.persistReadCoverage(session);
      this.scheduleIdleCompaction(session);
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

  /**
   * 何时下发服务端 context editing。
   *
   * 默认关闭：服务端只支持 keep「最近 3 次」，每出现新 tool_use 清理边界就前移，
   * 边界之后的 messages 每轮重写；本地压缩（80%/85%）已经兜住溢出。
   * 实验开关打开后，只对官方 Anthropic 端点、越过窗口 75% 武装，且粘滞到
   * 压缩/新会话才解除 —— 避免阈值附近「这轮开、下轮关」的抖动。
   */
  private contextEditingFor(provider: ProviderConfig): ContextEditing | undefined {
    if (this.experimental?.contextEditing !== true) return undefined;
    if ((provider.protocol ?? "openai-chat-completions") !== "anthropic-messages") return undefined;
    if (!isOfficialAnthropicEndpoint(provider)) return undefined;
    const window = provider.contextWindow;
    // 服务端对 trigger 有下限（50k），小窗口模型不适用
    if (!window || window < 100_000) return undefined;
    if (!this.contextEditingArmed) {
      if (this.getContextUsage().usedTokens < window * CONTEXT_EDITING_TRIGGER_RATIO) {
        return undefined;
      }
      this.contextEditingArmed = true;
    }
    return {
      triggerTokens: Math.floor(window * CONTEXT_EDITING_TRIGGER_RATIO),
      keepToolUses: CONTEXT_EDITING_KEEP_TOOL_USES,
      clearAtLeastTokens: CONTEXT_EDITING_CLEAR_AT_LEAST_TOKENS,
    };
  }

  /** 恢复落盘的已读区间（重启/换窗口后仍能命中「已读过且未变更」的短路）。 */
  private async restoreReadCoverage(session: SessionStore): Promise<void> {
    const snapshot = await session.loadReadCoverage<ReadCoverageSnapshot>();
    if (!snapshot?.length) return;
    await this.loopGuard.restoreCoverage(snapshot);
  }

  /** 回合结束落盘已读区间（best-effort：失败只影响下次重启的效率）。 */
  private persistReadCoverage(session: SessionStore): void {
    const snapshot = this.loopGuard.exportCoverage();
    if (!snapshot.length) return;
    void session.saveReadCoverage(snapshot).catch(() => undefined);
  }

  /**
   * stage 1 免模型压缩：先把将被摘录的旧工具输出补落盘（每条只写一次盘），
   * 再让 shrinkToolOutputs 在摘录标注里带上 locator —— 被裁掉的全文仍可 read_file 找回。
   */
  private async shrinkWithSpill(
    session: SessionStore,
    messages: ChatMessage[],
  ): Promise<{ messages: ChatMessage[]; changed: boolean }> {
    if (this.shrinkSpills.size < SHRINK_SPILL_MAP_MAX) {
      for (const ref of collectOldToolOutputs(messages)) {
        if (this.shrinkSpills.has(ref.callId)) continue;
        const saved = await persistToolOutput(session.cwd, ref.tool, ref.content).catch(() => null);
        if (saved) this.shrinkSpills.set(ref.callId, saved);
        if (this.shrinkSpills.size >= SHRINK_SPILL_MAP_MAX) break;
      }
    }
    return shrinkToolOutputs(messages, this.shrinkSpills.size ? { spilled: this.shrinkSpills } : {});
  }

  /**
   * 冷 resume 预剪枝：空闲超过缓存 TTL 后，服务端前缀确定已过期，重放旧工具输出
   * 只会按全价写一遍。既然这一段无论如何都要按全价重写，就先用零模型的头尾摘录
   * 把它压小（cc-haha timeBasedMCConfig 同思路）。
   *
   * 必须持久化（tool_digest 通道），否则只省下本回合、下回合又按全量历史冷写一次，
   * 净亏。已摘录的内容短到不再可剪，与溢出阶梯 stage 1 天然幂等。
   *
   * 取舍：长空闲后 transcript 里旧工具结果是机械摘录，不再是原文；完整内容仍在
   * JSONL 与 spill locator 里，可随时 read_file 找回。回滚 = 删 runTurn 里的调用。
   */
  private async maybeShrinkColdResume(session: SessionStore, provider: ProviderConfig): Promise<void> {
    // 只有 Anthropic 系（含 qwen/网关画像）能证明「TTL 过了缓存必死」；
    // OpenAI/DeepSeek 的服务端缓存 TTL 不可证伪，剪了可能白白自毁热前缀。
    if ((provider.protocol ?? "openai-chat-completions") !== "anthropic-messages") return;
    const plan = resolveCachePlan(provider);
    if (!plan.enabled) return;
    const meta = this.providerRequestMeta.get(provider.id);
    // 首次请求没有「上次触缓存」的时间点；保活成功的 ping 会刷新 meta.at，
    // 所以被保热的缓存不会在这里误判为已过期。
    if (!meta || Date.now() - meta.at <= TTL_MS[plan.ttl]) return;
    // 前缀确定要按全价整段重写了：延后的工具删除/改写也搭这一班车。
    // 不这么做的话，被下线的工具 schema 会一直留在请求里计费到下次压缩。
    const pending = this.toolCatalog?.delta;
    if (pending && (pending.removed.length || pending.rewritten.length)) {
      this.rebuildToolCatalog("cold_resume");
    }
    const projected = projectForMainPath(session.effectiveMessages);
    const shrunk = await this.shrinkWithSpill(session, projected);
    if (!shrunk.changed) return;
    // shrinkToolOutputs 保证等长（不等长会放弃改写），按下标对齐即可
    const digests: Array<{ callId: string; digest: string }> = [];
    for (let index = 0; index < projected.length; index += 1) {
      const before = projected[index];
      const after = shrunk.messages[index];
      if (before.role !== "tool" || !before.tool_call_id) continue;
      if (after.content !== before.content) {
        digests.push({ callId: before.tool_call_id, digest: after.content ?? "" });
      }
    }
    if (!digests.length) return;
    await session.appendToolDigests(digests);
    await session.flush().catch(() => undefined);
    // 纪要改变了后续请求的组成，真实用量锚点随之失效
    this.usageAnchor = null;
    console.error(
      `[meowcode] cold resume: shrunk ${digests.length} old tool outputs after cache TTL expiry`,
    );
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

  /** 蒸馏请求超时：后台增强不阻塞关停，超时即放弃本轮增量 */
  private static readonly MEMORY_EXTRACTION_TIMEOUT_MS = 120_000;

  /**
   * 回合结束后调度记忆蒸馏（ZCode scheduleProjectMemoryExtraction 同款）。
   * 门槛：总开关开、回合正常完成、游标以来有新的真实用户消息、模型本回合
   * 没直接写过记忆（写了就不必再蒸馏，ZCode direct-memory-write 同款）。
   * 静默运行：失败不影响对话，成功有变更时挂一条下回合注入的 [memory] 通知。
   */
  private scheduleMemoryExtraction(session: SessionStore, status: string): void {
    if (!this.memoryEnabled || !this.distillEnabled) return;
    if (status !== "completed" || this.memoryExtractionBusy) return;
    const messages = session.messages;
    let cursor = this.memoryCursors.get(session.id) ?? -1;
    if (cursor < 0 || cursor > messages.length) {
      // 未知游标（新会话/进程重启/压缩收缩）：以最后一个用户回合为增量
      cursor = lastRealUserMessageIndex(messages);
      if (cursor < 0) return;
    }
    if (!hasNewUserMessage(messages, cursor)) return;
    if (wroteMemoryDirectly(messages, cursor)) {
      // 模型本回合直接写过记忆：推进游标并清计数，不必再蒸馏
      this.memoryCursors.set(session.id, messages.length);
      this.memoryPendingTurns.set(session.id, 0);
      return;
    }
    const transcript = serializeMessages(messages.slice(cursor));
    if (!transcript.trim()) {
      this.memoryCursors.set(session.id, messages.length);
      this.memoryPendingTurns.set(session.id, 0);
      return;
    }
    const pendingTurns = (this.memoryPendingTurns.get(session.id) ?? 0) + 1;
    if (!shouldExtractMemory({ pendingTurns, transcriptTokens: estimateTokens(transcript) })) {
      // 未达阈值：只记计数，游标不动；下轮蒸馏会把这几轮增量一起带上
      this.memoryPendingTurns.set(session.id, pendingTurns);
      return;
    }
    // 游标先推进再发请求：在途期间的新消息并入下回合，同一增量绝不蒸馏两次
    this.memoryPendingTurns.set(session.id, 0);
    this.memoryCursors.set(session.id, messages.length);
    const workspace = session.cwd;
    if (!workspace) return;
    const provider = this.activeProvider();
    this.asyncTasks += 1;
    this.memoryExtractionBusy = true;
    void (async () => {
      const manifest = await collectManifest(workspace, this.homeDir);
      const ops = await generateMemoryOps({
        provider: this.applyCachePolicy(provider, session.id, "memory"),
        transcript,
        manifest,
        today: new Date().toISOString().slice(0, 10),
        signal: AbortSignal.timeout(AgentRuntime.MEMORY_EXTRACTION_TIMEOUT_MS),
        onUsage: (usage) => {
          void session
            .appendUsage({
              ...usage,
              source: "memory",
              providerId: provider.id,
              model: provider.model,
            })
            .catch(() => undefined);
        },
      });
      if (!ops.length) return;
      const result = await applyMemoryOps(ops, workspace, this.homeDir);
      const notice = formatMemoryNotice(result);
      if (notice) {
        // 期间切走会话就丢弃：通知绑定产生它的会话，跨会话注入会误导模型
        if (this.currentSession === session) {
          this.memoryNoticePending = { sessionId: session.id, text: notice };
        }
      }
    })()
      .catch(() => undefined) // 蒸馏失败不值得打扰用户（与标题生成同纪律）
      .finally(() => {
        this.memoryExtractionBusy = false;
        this.asyncTasks = Math.max(0, this.asyncTasks - 1);
      });
  }

  // -------------------------------------------------------------------------
  // 自我学习（观察 → 学习 → 召回 → 评估）
  // -------------------------------------------------------------------------

  /** 学习请求超时：后台增强不阻塞关停，超时即放弃本回合增量。 */
  private static readonly LEARNING_TIMEOUT_MS = 90_000;

  /**
   * 回合开始：归因上一轮（用户是否在纠正）+ 按 trigger 召回经验。
   * 召回注记走 appendContextNote 追加到历史尾部 —— 绝不改 system[1]，
   * 否则整段 prompt cache 每回合作废（见 refreshInstructions 的注释）。
   */
  private async beginLearningTurn(session: SessionStore, text: string): Promise<void> {
    this.learningController.setWorkspace(session.cwd);
    try {
      const result = await this.learningController.beginTurn(session.id, text, {
        text,
        commands: [],
        errors: [],
      });
      this.turnLearning = {
        turnIndex: result.turnIndex,
        recalledIds: result.recalledIds,
        holdout: result.holdout,
      };
      if (result.note) {
        await session.appendContextNote(result.note, "file");
        await session.flush();
      }
    } catch {
      // 召回失败不打断回合
      this.turnLearning = null;
    }
  }

  /** 回合结束：落 outcome + 归因 helped/hurt，然后决定要不要调用学习器。 */
  private finishLearningTurn(session: SessionStore, status: TurnStatus): void {
    const trace = this.learningTrace;
    const turn = this.turnLearning;
    this.learningTrace = null;
    this.turnLearning = null;
    if (!trace || !turn || !this.learning) return;

    const normalized: "completed" | "error" | "aborted" =
      status === "completed" ? "completed" : status === "aborted" ? "aborted" : "error";

    this.asyncTasks += 1;
    void (async () => {
      await this.learningController
        .endTurn({
          sessionId: session.id,
          turnIndex: turn.turnIndex,
          status: normalized,
          trace,
          recalledIds: turn.recalledIds,
          holdout: turn.holdout,
        })
        .catch(() => undefined);
      if (normalized !== "completed") return;
      await this.scheduleTurnLearning(session, trace);
    })().finally(() => {
      this.asyncTasks = Math.max(0, this.asyncTasks - 1);
    });
  }

  /**
   * 回合级学习调度。门禁全部在 LearningController 里：开关 → 单飞 → 配额 →
   * 零 token 信号。无信号的回合连模型都不会调用，这是成本可控的前提。
   */
  private async scheduleTurnLearning(session: SessionStore, trace: TurnTrace): Promise<void> {
    if (!this.learning || this.learningController.busy) return;
    const provider = this.activeProvider();
    try {
      const result = await this.learningController.learnFromTurn({
        sessionId: session.id,
        messages: session.messages,
        trace,
        provider: this.applyCachePolicy(provider, session.id, "learning"),
        signal: AbortSignal.timeout(AgentRuntime.LEARNING_TIMEOUT_MS),
        onUsage: (usage) => {
          void session
            .appendUsage({
              ...usage,
              source: "learning",
              providerId: provider.id,
              model: provider.model,
            })
            .catch(() => undefined);
        },
      });
      if (!result?.applied.length) return;
      const notice = formatLearningNotice(result);
      // 期间切走会话就丢弃：通知绑定产生它的会话
      if (notice && this.currentSession === session) {
        this.learningNoticePending = { sessionId: session.id, text: notice };
      }
    } catch {
      // 学习失败不值得打扰用户（与记忆蒸馏同纪律）
    }
  }

  /** 会话级整理：合并近义经验、蒸技能。由切会话或设置页按钮触发。 */
  async consolidateLearning(session?: SessionStore): Promise<{ applied: string[] }> {
    const target = session ?? this.currentSession;
    if (!target || !this.learning) return { applied: [] };
    this.learningController.setWorkspace(target.cwd);
    const provider = this.activeProvider();
    const result = await this.learningController
      .consolidate({
        sessionId: target.id,
        messages: target.messages,
        provider: this.applyCachePolicy(provider, target.id, "learning"),
        signal: AbortSignal.timeout(AgentRuntime.LEARNING_TIMEOUT_MS * 2),
        onUsage: (usage) => {
          void target
            .appendUsage({
              ...usage,
              source: "learning",
              providerId: provider.id,
              model: provider.model,
            })
            .catch(() => undefined);
        },
      })
      .catch(() => null);
    return { applied: result?.applied ?? [] };
  }

  /** 设置页读取：用户模型 / 经验 / 技能 / 账本 / 审计。 */
  async learningSnapshot(): Promise<LearningSnapshot> {
    const session = this.currentSession;
    if (session) this.learningController.setWorkspace(session.cwd);
    return this.learningController.snapshot();
  }

  /** 设置页操作：删除 / 重新启用 / 回滚一个学习技能。 */
  async manageLearnedSkill(
    action: "delete" | "reactivate" | "rollback",
    scope: "user" | "project",
    name: string,
  ): Promise<boolean> {
    const session = this.currentSession;
    if (session) this.learningController.setWorkspace(session.cwd);
    if (action === "delete") return this.learningController.removeSkill(scope, name);
    if (action === "reactivate") return this.learningController.reactivateSkill(scope, name);
    return this.learningController.rollbackSkill(scope, name);
  }

  /** 设置页操作：清除所有学到的（不可撤销）。 */
  async clearLearning(): Promise<{ cleared: string[] }> {
    const session = this.currentSession;
    if (session) this.learningController.setWorkspace(session.cwd);
    return this.learningController.clearAll();
  }

  /**
   * 用当前模型生成 commit message（Git 面板的「AI 生成」按钮）。
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

  /**
   * 用当前模型美化用户草稿提示词（输入框的「美化提示词」按钮）。
   *
   * 与 commit-message 同构：不写会话、不计 usage；无会话时跳过缓存亲和。
   */
  async polishPrompt(text: string, options: { signal?: AbortSignal } = {}): Promise<string> {
    const session = this.currentSession;
    const provider = this.activeProvider();
    return polishPrompt({
      provider: session
        ? this.applyCachePolicy(provider, session.id, "polish")
        : provider,
      text,
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
    await this.emitHook(
      "session_info_changed",
      {
        hook: "session_info_changed",
        ...this.hookScopeFields(session),
        sessionId: session.id,
        title: trimmed,
      },
      session,
    );
    return trimmed;
  }

  /** 会话的快照存储（按快照目录 owner 缓存）；快照关闭时返回 null（打点全部 no-op）。 */
  private snapshotFor(session: SessionStore): SnapshotStore | null {
    if (!this.snapshotOptions.enabled) return null;
    const ownerId = session.snapshotOwnerId;
    let store = this.snapshotStores.get(ownerId);
    if (!store) {
      store = new SnapshotStore({
        dir: path.join(this.sessionsDir, "snapshots", ownerId),
        cwd: session.cwd,
        ...(this.snapshotOptions.maxBlobBytes
          ? { maxBlobBytes: this.snapshotOptions.maxBlobBytes }
          : {}),
        ...(this.snapshotOptions.keepCheckpoints
          ? { keepCheckpoints: this.snapshotOptions.keepCheckpoints }
          : {}),
      });
      this.snapshotStores.set(ownerId, store);
    }
    return store;
  }

  /** 回滚引擎用：取会话的快照存储（与打点共用同一实例，内存 state 才一致）。 */
  snapshotStoreOf(session: SessionStore): SnapshotStore | null {
    return this.snapshotFor(session);
  }

  /** 回合级改动记账：同一文件多次编辑累加行数，供 turn_complete 的「已编辑 N 个文件」卡片使用。 */
  private recordTurnFileChange(filePath: string, stats: { added: number; removed: number }): void {
    const existing = this.turnFileStats.get(filePath);
    if (existing) {
      existing.added += stats.added;
      existing.removed += stats.removed;
      return;
    }
    this.turnFileStats.set(filePath, { path: filePath, added: stats.added, removed: stats.removed });
  }

  /**
   * 回合开始的自动检查点：对应用户这条消息之前的状态，任意用户消息都能作为回滚目标。
   * 与上一条检查点落在同一位置且 2s 内时跳过（手动点后立刻发消息不重复打）。
   */
  private async writeTurnCheckpoint(session: SessionStore, turnId: string, text: string): Promise<SessionCheckpoint | null> {
    const store = this.snapshotFor(session);
    const messageCount = session.messages.length;
    const last = session.checkpoints.at(-1);
    if (last && last.messageIndex === messageCount && Date.now() - Date.parse(last.timestamp) < 2_000) {
      return null;
    }
    const label = text.replace(/\s+/g, " ").trim().slice(0, 40);
    return session.appendCheckpoint(
      { auto: true, turnId, ...(label ? { label } : {}), fileChanges: [] },
      // 快照关闭时仍是有效的对话回滚点，只是没有文件快照（hasSnapshot=false）
      store ? (checkpointId) => store.checkpoint(checkpointId) : undefined,
    );
  }

  /** 手动检查点：记录当前对话位置与文件快照，供之后恢复（截断分支出新会话）。 */
  async createCheckpoint(label?: string): Promise<SessionCheckpoint> {
    const session = this.currentSession;
    if (!session) throw new Error("No active session.");
    const trimmed = label?.trim();
    const store = this.snapshotFor(session);
    return session.appendCheckpoint(
      {
        ...(trimmed ? { label: trimmed.slice(0, 100) } : {}),
        auto: false,
        fileChanges: [],
      },
      store ? (checkpointId) => store.checkpoint(checkpointId) : undefined,
    );
  }

  private async runTurn(session: SessionStore): Promise<void> {
    const provider = this.activeProvider();
    // 原生压缩点的加密 item 与端点/模型绑定：每回合开始先判定能否重放
    this.syncNativeReplay();
    await this.awaitMcpReadyOnce();
    await this.refreshInstructions(session);
    await this.ensurePlanContext(session);
    await this.ensureModeContext(session);
    await this.ensureSpeechStyleContext(session);
    // 缓存确定已过期（空闲 > TTL）时先做免费剪枝，把冷重写体积直接压小
    await this.maybeShrinkColdResume(session, provider);
    // 回合边界：上一回合下线的工具不能继续被广告
    this.rebuildToolCatalogAtTurnBoundary();
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
   * 请求前置记录：工具 + system 的分段前缀指纹、是否与上一次相同、距上次请求的空闲。
   * 只记主循环请求；标题/压缩等辅助请求不走这里，不会污染诊断。
   *
   * 分段而不是整段拼接：掉缓存时要说得出是「工具块换了」还是「第几条 system 换了」，
   * 否则 MCP 上线、AGENTS.md 重载、语色切换在日志里长得一模一样。
   */
  private noteRequestStart(options: AgentStreamOptions): void {
    const systemTexts: string[] = [];
    for (const message of options.messages) {
      if (message.role !== "system" || !message.content) continue;
      systemTexts.push(message.content);
    }
    const hash = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 16);
    const toolsFingerprint = this.ensureToolCatalog().fingerprint;
    const snapshot: PrefixSnapshot = {
      tools: toolsFingerprint,
      system: systemTexts.map(hash),
    };
    // 整段拼接的 key 保留：samePrefix 的判定口径必须与历史一致
    const key = `${toolsFingerprint}|${hash(systemTexts.join("\n"))}`;
    const providerId = options.provider.id;
    const previous = this.providerRequestMeta.get(providerId);
    const now = Date.now();
    const diff = diffPrefix(previous?.snapshot, snapshot);
    this.currentRequest = {
      providerId,
      key,
      samePrefix: previous?.key === key,
      hadPrevious: previous !== undefined,
      idleMs: previous ? now - previous.at : 0,
      changedSegments: previous && previous.key !== key ? prefixChangeSegments(diff) : [],
    };
    this.providerRequestMeta.set(providerId, { key, at: now, snapshot });
  }

  /**
   * 薄循环的宿主适配层：会话落盘、事件广播、上下文记账、工具执行全部
   * 经 AgentLoopHost 委托给 AgentRuntime；治理 hooks（Step 4）后续在此注册。
   */
  private createLoopHost(session: SessionStore, provider: ProviderConfig): AgentLoopHost {
    // 增量传输（codex 式 previous_response_id）：
    // 链签名锁定 provider/model/工具集/系统提示；压缩、裁剪、纪要都会改写前缀，
    // 消息引用快照校验不过就自动全量重发（store:true 重建链首）。
    //
    // 默认打开，但只在官方 OpenAI 端点：第三方「Responses 兼容」端点认不认
    // previous_response_id 无法离线证伪，猜错就是每个回合多一趟 400。
    // 显式设置 experimental.incrementalResponses 可以覆写这个默认（任意端点强制开/关）。
    const incrementalDefault = isOfficialOpenAIEndpoint(provider);
    const incrementalOn =
      provider.protocol === "openai-responses" &&
      (this.experimental?.incrementalResponses ?? incrementalDefault);
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
    /** 故障转移墙钟起点：本回合第一次请求就是这个 host 创建的时刻 */
    const failoverStartedAt = Date.now();

    return {
      initialMessages: () => {
        // 主路径滞回投影：旧截图/扫描件总量越过 8MiB 触发线才裁到 4MiB（opencode 同款）。
        // 切点单调、两次裁剪之间前缀字节零变化；未变化的沿用原对象引用，增量链不受影响。
        // thinking 不投影：它的「保留最近 1 回合」边界每轮移动，逐轮投影等于每轮自爆缓存。
        const history = projectForMainPath(session.effectiveMessages);
        const messages: ChatMessage[] = [
          ...this.systemMessages(),
          ...history,
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
      toolCacheAnchor: () => this.toolCacheAnchor(),
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
        // 设置里的「供应商故障转移」默认关闭：关闭时不切，原错误直接抛给用户
        if (!this.providerFallbackEnabled) return null;
        const reason = failoverReason(error);
        if (!reason) return null;
        // 墙钟预算：超过就认输，让循环把错误抛给用户，而不是继续换 provider 磨时间
        if (Date.now() - failoverStartedAt > FAILOVER_WALL_CLOCK_MS) return null;
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
        this.notifyModelSwitch(
          from,
          { providerId: next.id, model: next.model },
          "fallback",
        );
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
        this.thinkingStartedAt = null;
        this.thinkingMs = null;
        this.fireHook(
          "assistant_message_start",
          {
            hook: "assistant_message_start",
            ...this.hookScopeFields(session),
            sessionId: session.id,
            ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
          },
          session,
          this.turnAbort?.signal,
        );
      },
      onDelta: (delta) => {
        this.appendPartialDelta("content", delta);
        // 首个正文增量 = 思考结束：带上时长，思考块右侧立即显示
        let thinkingMs: number | null = null;
        if (this.thinkingStartedAt !== null && this.thinkingMs === null) {
          this.thinkingMs = Math.max(0, Date.now() - this.thinkingStartedAt);
          thinkingMs = this.thinkingMs;
        }
        this.emit({
          type: "assistant_delta",
          sessionId: session.id,
          delta,
          ...(thinkingMs !== null ? { thinkingMs } : {}),
        });
      },
      onThinking: (delta) => {
        if (this.thinkingStartedAt === null) this.thinkingStartedAt = Date.now();
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
      stream: async (options) => {
        this.noteRequestStart(options);
        // 新一轮模型调用：上一轮没等到 recordUsage 的样本作废（agent-loop 内部重试会走到这里）
        this.retractPendingUsage(session);
        const roundId = randomUUID();
        this.pendingUsageRoundId = roundId;
        // 插件 hook：before_provider_request（语义层改写，三套协议共用这一处）
        let requestOptions = options;
        if (this.plugins?.hasHooks("before_provider_request")) {
          try {
            const hook = await runHook(
              this.plugins,
              "before_provider_request",
              {
                hook: "before_provider_request",
                ...this.hookScopeFields(session),
                sessionId: session.id,
                providerId: options.provider.id,
                model: options.provider.model,
                protocol: options.provider.protocol ?? "openai-chat-completions",
                messages: options.messages,
                toolNames: options.tools.map((tool) => tool.function.name),
                ...(options.provider.maxTokens ? { maxTokens: options.provider.maxTokens } : {}),
              },
              this.hookContext(session, this.turnAbort?.signal),
            );
            if (hook) {
              requestOptions = {
                ...options,
                ...(hook.messages ? { messages: hook.messages } : {}),
                ...(hook.tools ? { tools: hook.tools as typeof options.tools } : {}),
                ...(hook.extraBody || options.provider.extraBody
                  ? {
                      provider: {
                        ...options.provider,
                        extraBody: { ...options.provider.extraBody, ...hook.extraBody },
                      },
                    }
                  : {}),
              };
            }
          } catch {
            // 改写失败按原请求走，宁可少一个 hook 也不能打断请求
          }
        }
        const llmSpan = this.traceRecorder.startSpan({
          traceId: session.traceId,
          kind: "llm",
          name: requestOptions.provider.model,
          attributes: {
            provider: requestOptions.provider.id,
            protocol: requestOptions.provider.protocol ?? "openai-chat-completions",
            messages: requestOptions.messages.length,
            tools: requestOptions.tools.length,
          },
        });
        let lastUsage: TokenUsage | undefined;
        try {
          const result = await streamChatCompletion({
            ...requestOptions,
            // 主循环每次只试 2 次：fetchWithRetry 已经带退避，3 次尝试 + 30s 上限
            // 意味着一个挂死的 provider 要 ~90s 才轮到 fallback。少一次尝试换更快的切换。
            fetchAttempts: requestOptions.fetchAttempts ?? 2,
            // 服务端清理旧工具结果：不改本地历史，被清掉的部分也不计输入
            ...(() => {
              const contextEditing = this.contextEditingFor(requestOptions.provider);
              return contextEditing ? { contextEditing } : {};
            })(),
            onUsage: (usage) => {
              lastUsage = usage;
              this.emitUsageSample(session, roundId, usage);
            },
          });
          this.traceRecorder.endSpan(llmSpan, {
            attributes: {
              ...(result.finishReason ? { finishReason: result.finishReason } : {}),
              ...(result.usage?.inputTokens !== undefined
                ? { inputTokens: result.usage.inputTokens }
                : {}),
              ...(result.usage?.outputTokens !== undefined
                ? { outputTokens: result.usage.outputTokens }
                : {}),
              ...(result.usage?.cacheReadTokens !== undefined
                ? { cacheReadTokens: result.usage.cacheReadTokens }
                : {}),
              ...(result.usage?.cacheWriteTokens !== undefined
                ? { cacheWriteTokens: result.usage.cacheWriteTokens }
                : {}),
            },
          });
          return result;
        } catch (error) {
          // 流已开始后中止/断流：输入与缓存可能已经计费，把最后观察到的累计快照
          // 落一次账；成功路径仍由 agent-loop 的 recordUsage 负责，避免双计。
          if (lastUsage) {
            this.turnUsageTotals.input += lastUsage.inputTokens ?? 0;
            this.turnUsageTotals.output += lastUsage.outputTokens ?? 0;
            this.turnUsageTotals.cacheRead += lastUsage.cacheReadTokens ?? 0;
            this.turnUsageTotals.cacheWrite += lastUsage.cacheWriteTokens ?? 0;
            await session
              .appendUsage({
                ...lastUsage,
                source: "chat",
                ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
                providerId: requestOptions.provider.id,
                model: requestOptions.provider.model,
              })
              .catch(() => undefined);
            this.emit({
              type: "usage",
              sessionId: session.id,
              roundId,
              final: true,
              source: "chat",
              model: requestOptions.provider.model,
              ...(lastUsage.inputTokens !== undefined
                ? { inputTokens: lastUsage.inputTokens }
                : {}),
              ...(lastUsage.outputTokens !== undefined
                ? { outputTokens: lastUsage.outputTokens }
                : {}),
              ...(lastUsage.cacheReadTokens !== undefined
                ? { cacheReadTokens: lastUsage.cacheReadTokens }
                : {}),
              ...(lastUsage.cacheWriteTokens !== undefined
                ? { cacheWriteTokens: lastUsage.cacheWriteTokens }
                : {}),
            });
            // 已提交的部分用量不能再被回合收尾的 retractPendingUsage 撤回
            this.pendingUsageRoundId = null;
          }
          this.traceRecorder.endSpan(llmSpan, {
            status: isAbortError(error) ? "aborted" : "error",
            error,
          });
          throw error;
        }
      },
      persistAssistantMessage: async (message) => {
        // 思考时长：正文轮在首个正文增量时已结算；只有工具调用的轮次在这里补算
        if (message.role === "assistant" && message.reasoning && this.thinkingStartedAt !== null) {
          if (this.thinkingMs === null) {
            this.thinkingMs = Math.max(0, Date.now() - this.thinkingStartedAt);
          }
          message.thinkingMs = this.thinkingMs;
          this.emit({ type: "thinking_complete", sessionId: session.id, thinkingMs: this.thinkingMs });
        }
        await session.appendMessage(message);
        await session.flush();
        await this.finishPartialRound(session);
        const text = typeof message.content === "string" ? message.content : "";
        this.fireHook(
          "assistant_message_end",
          {
            hook: "assistant_message_end",
            ...this.hookScopeFields(session),
            sessionId: session.id,
            ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
            text,
            toolCallCount:
              message.role === "assistant" ? (message.tool_calls?.length ?? 0) : 0,
          },
          session,
          this.turnAbort?.signal,
        );
      },

      recordUsage: async (usage, meta) => {
        // 回合级汇总：只累计主对话（本回调仅处理 chat 源），turn_complete 带给前端
        if (usage.inputTokens) this.turnUsageTotals.input += usage.inputTokens;
        if (usage.outputTokens) this.turnUsageTotals.output += usage.outputTokens;
        if (usage.cacheReadTokens) this.turnUsageTotals.cacheRead += usage.cacheReadTokens;
        if (usage.cacheWriteTokens) this.turnUsageTotals.cacheWrite += usage.cacheWriteTokens;
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
            ...(meta?.tokensPerSecond != null ? { tokensPerSecond: meta.tokensPerSecond } : {}),
            ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
            // 用量记在实际应答的那一家头上（切链后与用户配置的 provider 可能不同）
            providerId: turnProvider.id,
            model: turnProvider.model,
          });
        }
        // 前缀缓存诊断：区分「我们自己改了前缀 / 服务端逐出 / 服务商未报告或不支持」。
        let cacheState: CacheState | undefined;
        let cacheReason: string | undefined;
        const request = this.currentRequest;
        if (request && request.providerId === turnProvider.id && usage.inputTokens !== undefined) {
          const plan = resolveCachePlan(turnProvider);
          const result = classifyCache({
            protocol: plan.protocol,
            // 用解析后的实际 TTL（auto 已按节奏与端点白名单定档），而不是用户配置原文
            ...(plan.enabled ? { cacheTtl: plan.ttl } : {}),
            ...(usage.cacheReadTokens !== undefined
              ? { cacheReadTokens: usage.cacheReadTokens }
              : {}),
            ...(usage.cacheWriteTokens !== undefined
              ? { cacheWriteTokens: usage.cacheWriteTokens }
              : {}),
            inputTokens: usage.inputTokens,
            prefixChanged: request.hadPrevious && !request.samePrefix,
            ...(request.changedSegments.length
              ? { changedSegments: request.changedSegments }
              : {}),
            hadSamePrefixBefore: request.samePrefix,
            idleMs: request.idleMs,
          });
          cacheState = result.state;
          if (request.hadPrevious && !request.samePrefix) {
            cacheReason = this.lastPrefixChangeReason ?? result.reason;
            this.lastPrefixChangeReason = null;
          }
          const stateKey = `${session.id}:${turnProvider.id}`;
          if (this.emittedCacheStates.get(stateKey) !== result.state) {
            this.emittedCacheStates.set(stateKey, result.state);
            cacheReason = cacheReason ?? result.reason;
            if (result.state === "evicted" || result.state === "unsupported") {
              console.warn(
                `[meowcode] cache ${result.state} (${turnProvider.name}/${turnProvider.model}): ${
                  result.reason ?? "no cached tokens"
                }`,
              );
            }
          }
        }
        this.emit({
          type: "usage",
          sessionId: session.id,
          roundId: this.pendingUsageRoundId ?? randomUUID(),
          final: true,
          source: "chat",
          // 前端 cache-bust 检测按模型分基线：换模型后的读数跌落不算失配
          model: turnProvider.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          ...(usage.cacheReadTokens !== undefined
            ? { cacheReadTokens: usage.cacheReadTokens }
            : {}),
          ...(usage.cacheWriteTokens !== undefined
            ? { cacheWriteTokens: usage.cacheWriteTokens }
            : {}),
          ...(cacheState ? { cacheState } : {}),
          ...(cacheReason ? { cacheReason } : {}),
        });
        this.pendingUsageRoundId = null;
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
          ...(this.thinkingMs !== null ? { thinkingMs: this.thinkingMs } : {}),
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
        this.executeReadOnlyToolCallTraced(session, call, messages),
      pushToolMessage: async (messages, message) => {
        await this.pushToolMessage(session, messages, message);
      },
      earlyRun: (callId) => this.earlyToolRuns.get(callId),
      isParallelSafe: (toolName) => isToolParallelSafe(toolName),
      /**
       * 回合 token 预算：按窗口的 3 倍给（输入每轮重发，长回合本来就会在窗口里
       * 反复计费）。窗口未知时按 200k 兜底，仍远高于任何真实任务；
       * 命中只是「别再跑了」，不是正常工作限制。
       */
      turnBudget: () => ({
        maxTokens: Math.max(200_000, (turnProvider.contextWindow ?? 200_000) * 3),
      }),
      pushUserMessage: (messages, content) => this.pushUserMessage(session, messages, content),
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
   * 重新装载工作区架构图（PUT /harness / 切档 / 切图后由 runtime 调用）：
   * 异步、只在空闲时装载 —— 活跃 run 的快照冻结，不中途换图（metis 同款）。
   *
   * `notice = true`（PUT /harness 保存了文档内容）时，装载成功后标记待提醒：
   * 下一回合在历史尾部追加一条 in-history 说明——架构文档变了但前缀不动声色地
   * 换掉，模型会把「没被告知的上下文漂移」当成事实变化（opencode 的合成消息同款）。
   */
  refreshHarness(notice = false): void {
    if (!this.enableTaskTool) return;
    const session = this.currentSession;
    if (!session) return;
    if (notice) this.harnessNoticePending = true;
    if (this.workflow.active) return;
    void loadHarnessDocument(session.cwd, this.currentHarnessArchitecture)
      .then((doc) => {
        this.workflow.setHarness(doc);
        this.harnessSnapshotSessionId = session.id;
        this.harnessNoticePending = false;
      })
      .catch(() => undefined);
  }

  /** 架构图会话级快照：每会话只装载一次；外部改动经 PUT /harness 显式重载（AGENTS.md 同纪律）。 */
  private harnessSnapshotSessionId: string | null = null;
  private harnessNoticePending = false;

  /**
   * 治理 hooks（根 runtime 还额外注册治理门禁；子 Agent 始终注册 turn_stop 与 steer）：
   * - beforeToolCall：admit 之前拦截变更类工具（含 task 派发）
   * - afterToolCall：根侧文件改动即 T1 G4 证据；计数未更新清单的变更
   * - prepareNextTurn：run 活跃注入 frontier；连续 8 次变更没 update_plan 则 nudge；送达插话
   * - takeSteer：模型准备收尾时优先注入用户插话
   */
  private createLoopHooks(session: SessionStore): AgentLoopHooks | undefined {
    // 回合收尾闸（turn_stop / Claude Code Stop hook）是插件级能力，与治理无关：
    // task 工具关闭的子 Agent runtime 也要生效（CC 的 SubagentStop 同理）。
    const beforeTurnEnd: NonNullable<AgentLoopHooks["beforeTurnEnd"]> = async ({
      result,
      stopHookActive,
    }) => {
      const verdict = await runHook(
        this.plugins,
        "turn_stop",
        {
          hook: "turn_stop",
          sessionId: session.id,
          turnId: this.currentTurnId ?? "",
          stopHookActive,
          text: typeof result.message.content === "string" ? result.message.content : "",
          ...this.hookScopeFields(session),
        },
        this.hookContext(session, this.turnAbort?.signal),
      );
      return verdict?.block ? { block: true, reason: verdict.reason } : undefined;
    };
    const prepareNextTurn: NonNullable<AgentLoopHooks["prepareNextTurn"]> = async (
      messages,
    ) => {
      const injections: ChatMessage[] = [];
      // 计划新鲜度提醒：所有会话生效（不只在治理模式）。模型连续做文件变更却不更新清单时，
      // 用户看到的 todolist 会卡在某一步；轮间提醒它把完成/开始的步骤同步过去。
      if (this.enableTaskTool) {
        const plan = session.currentPlan;
        const hasOpenSteps = Boolean(
          plan?.steps.some((step) => step.status !== "completed" && step.status !== "cancelled"),
        );
        const due =
          this.mutationsSincePlanCheck >= PLAN_NUDGE_STEP &&
          this.mutationsSincePlanCheck - this.planNudgeAt >= PLAN_NUDGE_STEP;
        if (hasOpenSteps && due) {
          this.planNudgeAt = this.mutationsSincePlanCheck;
          injections.push({
            role: "user",
            content:
              "[plan] You have made several file changes since the checklist was last updated. Call update_plan now: mark finished steps completed, mark the step you are working on in_progress, and keep titles current. Do not batch several finished steps into a later update.",
          });
        }
      }
      if (this.enableTaskTool && this.workflow.active && this.governanceApplies()) {
        const frontier = this.workflow.frontier();
        if (frontier) injections.push({ role: "user", content: `[workflow]\n${frontier}` });
      }
      // 插话排在 workflow 注入之后，保证用户的最后一句在上下文末尾
      const prepared = injections.length ? [...messages, ...injections] : messages;
      await this.flushPendingSteers(session, prepared);
      return prepared === messages ? undefined : prepared;
    };

    const takeSteerHook: NonNullable<AgentLoopHooks["takeSteer"]> = async () =>
      this.takeSteer();

    /**
     * 工具结果钩子：先采集学习轨迹（所有 runtime 都要，含子 Agent 的父级统计），
     * 再做治理证据采集。两者互不影响，采集失败绝不阻断工具链。
     */
    const afterToolCall: NonNullable<AgentLoopHooks["afterToolCall"]> = async (call, message) => {
      this.recordLearningToolCall(call, message);
      if (!this.enableTaskTool) return;
      const tool = call.function.name;
      if (tool === "update_plan") {
        this.mutationsSincePlanCheck = 0;
        this.planNudgeAt = 0;
        return;
      }
      // 计划新鲜度计数对每个会话都跑（治理模式之外也要提醒模型同步 todolist）
      if (PLAN_MUTATION_TOOLS.has(tool)) this.mutationsSincePlanCheck += 1;
      if (!this.workflow.active) return;
      if (tool === "write_file" || tool === "edit_file" || tool === "multi_edit") {
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
    };

    const hooks: AgentLoopHooks = { prepareNextTurn, takeSteer: takeSteerHook, beforeTurnEnd, afterToolCall };
    if (!this.enableTaskTool) return hooks;
    return {
      ...hooks,
      beforeToolCall: async (call) => {
        if (!this.governanceApplies() || !this.workflow.needsAdmission) return;
        if (!GOVERNANCE_GATED_TOOLS.has(call.function.name)) return;
        return {
          block: true,
          reason:
            "governance gate — call admit first to declare the task shape (tier T0/T1/T2, lanes), then mutating tools unlock",
        };
      },
    };
  }

  /** 把一次工具调用记进本回合的学习轨迹；ok 从 tool_finished 快照里取。 */
  private recordLearningToolCall(call: ToolCall, message: { content: string }): void {
    const trace = this.learningTrace;
    if (!trace) return;
    const ok = this.toolOutcomes.get(call.id) ?? true;
    this.toolOutcomes.delete(call.id);
    let args: unknown = {};
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      args = {};
    }
    recordToolCall(trace, {
      name: call.function.name,
      args,
      ok,
      output: typeof message.content === "string" ? message.content : "",
    });
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
    if (!isToolParallelSafe(call.function.name)) return;
    // 有 tool_call hook 时不能提前执行：流中启动发生在分派前，hook 无法拦截。
    if (this.plugins?.hasHooks("tool_call")) return;
    if (!call.id || this.earlyToolRuns.has(call.id)) return;
    if (this.turnAbort?.signal.aborted) return;
    this.earlyToolRuns.set(call.id, this.executeReadOnlyToolCallTraced(session, call, messages));
  }

  private async executeReadOnlyToolCall(
    session: SessionStore,
    call: ToolCall,
    messages: ChatMessage[],
  ): Promise<Extract<ChatMessage, { role: "tool" }>> {
    let input: unknown = {};
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

    // 只读批同样经过 PreToolUse（Read/Grep/Glob 等 CC matcher 才能生效）
    const inputRecord =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    const toolCallHook = await runHook(
      this.plugins,
      "tool_call",
      {
        hook: "tool_call",
        sessionId: session.id,
        callId: call.id,
        tool,
        input: inputRecord,
        ...this.hookScopeFields(session),
      },
      this.hookContext(session, this.turnAbort?.signal),
    );
    if (toolCallHook?.block) {
      const output = toolCallHook.reason
        ? `Tool call blocked by plugin: ${toolCallHook.reason}`
        : "Tool call blocked by plugin.";
      this.emit({ type: "tool_output", sessionId: session.id, callId: call.id, output, truncated: false });
      this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: false });
      return { role: "tool", content: output, tool_call_id: call.id, name: tool };
    }
    const hookAsk = toolCallHook?.permission === "ask";
    const hookReason = hookAsk
      ? toolCallHook.reason ?? "The PreToolUse hook requests approval."
      : undefined;
    if (toolCallHook?.input) {
      const revalidated = validateToolArguments(tool, JSON.stringify(toolCallHook.input));
      if (!revalidated.ok) {
        const output = `Tool call rejected: hook returned invalid arguments (${revalidated.error})`;
        this.emit({ type: "tool_output", sessionId: session.id, callId: call.id, output, truncated: false });
        this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: false });
        return { role: "tool", content: output, tool_call_id: call.id, name: tool };
      }
      input = revalidated.input;
    }

    // 循环拦截（P1-2）：零信息重复达 8 次就不再执行
    const blocked = this.loopBlockFor(session, tool, input);
    if (blocked) {
      this.emit({ type: "tool_output", sessionId: session.id, callId: call.id, output: blocked, truncated: false });
      this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: false });
      return { role: "tool", content: blocked, tool_call_id: call.id, name: tool };
    }

    if (hookAsk) {
      const decision = await this.approveHookAsk(session, call, tool, input, turnId, hookReason);
      if (!decision.approved) {
        const output = decision.output ?? "User denied this tool call.";
        this.emit({ type: "tool_output", sessionId: session.id, callId: call.id, output, truncated: false });
        this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: false });
        return { role: "tool", content: output, tool_call_id: call.id, name: tool };
      }
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
        // 命中占位本身也是「模型想再读一次」的信号，计入压缩质量观测
        this.noteReadTarget(session, tool, input);
        const loopNote = this.noteLoopResult(session, tool, input, stub);
        const result = await this.applyToolResultHook(session, call.id, tool, input, {
          output: stub,
          ok: true,
        });
        const output = loopNote ? `${result.output}\n\n${loopNote}` : result.output;
        this.emit({
          type: "tool_output",
          sessionId: session.id,
          callId: call.id,
          output,
          truncated: false,
        });
        this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: result.ok });
        return { role: "tool", content: output, tool_call_id: call.id, name: tool };
      }
    }
    const startedAt = Date.now();
    this.fireHook(
      "tool_execution_start",
      {
        hook: "tool_execution_start",
        ...this.hookScopeFields(session),
        sessionId: session.id,
        callId: call.id,
        tool,
        input: hookInput(input),
        parallel: true,
        startedAt,
      },
      session,
      this.turnAbort?.signal,
    );
    // 只读并行分支也必须注入联网工具：web_fetch 在 READ_ONLY_PARALLEL_TOOLS 里，
    // 漏注入会让模型拿到 "Web fetch is not available."（而不是真正抓取失败）。
    const webTools = this.webToolsForTurn(session);
    let result = await executeTool(tool, input, session.cwd, {
      allowOutsideWorkspace,
      signal: this.turnAbort?.signal,
      vision: this.toolVisionEnabled(),
      shrinkImage: this.imageShrinker(),
      jobs: this.jobManager,
      // 批量读复用已读区间：整份读过的文件只回一行占位
      readCoverage: (target) =>
        this.loopGuard.fullyCovered(session.cwd, messages, target, allowOutsideWorkspace),
      hostToolBridge: (bridgeTool, bridgeArgs) =>
        this.runCodeHostTool(session, call.id, bridgeTool, bridgeArgs),
      ...(webTools.search ? { webSearch: webTools.search } : {}),
      ...(webTools.fetch ? { webFetch: webTools.fetch } : {}),
    });
    if (result.usage) {
      const sideProvider = this.activeProviderOrNull();
      this.emitUsageSample(session, `tool:${call.id}`, result.usage, "web_search");
      await session.appendUsage({
        ...result.usage,
        source: "web_search",
        ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
        ...(sideProvider ? { providerId: sideProvider.id, model: sideProvider.model } : {}),
      });
    }
    this.fireHook(
      "tool_execution_end",
      {
        hook: "tool_execution_end",
        ...this.hookScopeFields(session),
        sessionId: session.id,
        callId: call.id,
        tool,
        input: hookInput(input),
        output: result.output,
        ok: result.ok,
        durationMs: Date.now() - startedAt,
      },
      session,
      this.turnAbort?.signal,
    );
    result = await this.applyToolResultHook(session, call.id, tool, input, result);
    // 部分覆盖：只回未读过的尾部
    let readOutput = result.output;
    if (tool === "read_file" && result.ok && result.readRange && !result.images?.length) {
      const trimmed = await this.trimCoveredRead(
        session,
        messages,
        input,
        result.output,
        allowOutsideWorkspace,
      );
      if (trimmed) readOutput = trimmed;
    }
    // 跨回合结果去重：同参同输出且旧结果仍可见 → 一行占位
    const deduped = this.loopGuard.dedupeRepeatedResult(
      tool,
      input,
      result.output,
      call.id,
      messages,
    );
    if (deduped) readOutput = deduped;
    if (tool === "read_file" && result.ok && !result.images?.length) {
      await this.rememberReadRange(
        session,
        call.id,
        input,
        result.readRange,
        allowOutsideWorkspace,
      );
    }
    // 批量读逐文件登记：之后 read_file 同一文件可以直接命中区间
    if (tool === "read_many" && result.ok && result.readRanges?.length) {
      for (const range of result.readRanges) {
        await this.rememberReadRangeAt(session, call.id, range.path, range, allowOutsideWorkspace);
      }
    }
    const loopNote = this.noteLoopResult(session, tool, input, result.output);
    const output = loopNote ? `${readOutput}\n\n${loopNote}` : readOutput;
    this.emit({
      type: "tool_output",
      sessionId: session.id,
      callId: call.id,
      output,
      truncated: result.truncated ?? output.length > 20000,
      ...(result.spilled ? { spilled: result.spilled } : {}),
      ...(result.images?.length ? { images: result.images } : {}),
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
    let input = validated.ok ? validated.input : {};
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

    const toolCallHook = await runHook(
      this.plugins,
      "tool_call",
      {
        hook: "tool_call",
        sessionId: session.id,
        callId: call.id,
        tool: "task",
        input: input as Record<string, unknown>,
        ...this.hookScopeFields(session),
      },
      this.hookContext(session, this.turnAbort?.signal),
    );
    if (toolCallHook?.block) {
      const output = toolCallHook.reason
        ? `Tool call blocked by plugin: ${toolCallHook.reason}`
        : "Tool call blocked by plugin.";
      this.emit({ type: "tool_output", sessionId: session.id, callId: call.id, output, truncated: false });
      this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: false });
      return { role: "tool", content: output, tool_call_id: call.id, name: "task" };
    }
    const hookAsk = toolCallHook?.permission === "ask";
    const hookReason = hookAsk
      ? toolCallHook.reason ?? "The PreToolUse hook requests approval."
      : undefined;
    if (toolCallHook?.input) {
      const revalidated = validateToolArguments("task", JSON.stringify(toolCallHook.input));
      if (!revalidated.ok) {
        const output = `Tool call rejected: hook returned invalid arguments (${revalidated.error})`;
        this.emit({ type: "tool_output", sessionId: session.id, callId: call.id, output, truncated: false });
        this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: false });
        return { role: "tool", content: output, tool_call_id: call.id, name: "task" };
      }
      input = revalidated.input;
    }

    // 计划模式禁止子 Agent：子代理会绕过 plans/ 门控，直接拒绝
    if ((this.turnChatMode ?? this.chatMode) === "plan") {
      const output = planModeRejection("task");
      this.emit({ type: "tool_output", sessionId: session.id, callId: call.id, output, truncated: false });
      this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: false });
      return { role: "tool", content: output, tool_call_id: call.id, name: "task" };
    }

    if (hookAsk) {
      const decision = await this.approveHookAsk(session, call, "task", input, turnId, hookReason);
      if (!decision.approved) {
        const output = decision.output ?? "User denied this tool call.";
        this.emit({ type: "tool_output", sessionId: session.id, callId: call.id, output, truncated: false });
        this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: false });
        return { role: "tool", content: output, tool_call_id: call.id, name: "task" };
      }
    }

    const taskStartedAt = Date.now();
    this.fireHook(
      "tool_execution_start",
      {
        hook: "tool_execution_start",
        ...this.hookScopeFields(session),
        sessionId: session.id,
        callId: call.id,
        tool: "task",
        input: hookInput(input),
        parallel: true,
        startedAt: taskStartedAt,
      },
      session,
      this.turnAbort?.signal,
    );
    const taskResult = await this.runSubagentTask(session, call, input);
    this.fireHook(
      "tool_execution_end",
      {
        hook: "tool_execution_end",
        ...this.hookScopeFields(session),
        sessionId: session.id,
        callId: call.id,
        tool: "task",
        input: hookInput(input),
        output: taskResult.output,
        ok: taskResult.ok,
        durationMs: Date.now() - taskStartedAt,
      },
      session,
      this.turnAbort?.signal,
    );
    const result = await this.applyToolResultHook(session, call.id, "task", input, taskResult);
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
      providers.find(
        (provider) => provider.id === this.providerId && provider.enabled !== false,
      ) ??
      providers.find((provider) => provider.enabled !== false) ??
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
    /** fork 复用父 system/instructions：只有复制了父历史时才置 true，否则前缀本来就不匹配 */
    inheritPrefix?: boolean;
  }): AgentRuntime {
    // 角色装配走注册表：提示词 / 工具白名单 / AGENTS.md 注入随角色定义；
    // 架构图角色节点可以覆盖提示词与工具白名单（空提示词 = 回落内置）。
    const definition = definitionFor(params.agentType);
    const override = this.workflow.roleOverride(params.agentType);
    const overridePrompt = override?.systemPrompt;
    const inheritPrefix = params.inheritPrefix === true;
    // fork 复用父 system 才能命中父前缀缓存；其余角色照旧走角色提示词。
    const effectivePrompt = inheritPrefix
      ? this.effectiveSystemPrompt
      : overridePrompt?.trim()
        ? overridePrompt
        : definition.systemPrompt;
    const roleTools = override?.tools
      ? new Set(override.tools.filter((tool) => tool !== "task"))
      : definition.tools;
    // writeDenied 角色（verifier / fresh-verifier）连架构图覆盖也不能放开写类工具：
    // 这是角色不变量，不是可配置项。
    const gatedRoleTools = roleTools
      ? new Set([...roleTools].filter((tool) => !roleDeniesTool(definition, tool)))
      : roleTools;
    // 档位白名单也约束子 Agent：极简档的 general 同样只有 read_file / run_command
    const profileTools = this.activeProfile.tools;
    const effectiveTools = !profileTools
      ? gatedRoleTools
      : new Set(
          [...(gatedRoleTools ?? profileTools)].filter(
            (tool) => tool === "task" || tool === "admit" || profileTools.has(tool),
          ),
        );
    const child = new AgentRuntime({
      providers: params.providers,
      providerId: params.providerId,
      sessionsDir: path.join(this.sessionsDir, "subagents", params.parentSessionId),
      workspace: params.cwd,
      // 与父 Agent 同一 home：记忆/技能索引与路径守卫的可信根必须一致
      homeDir: this.homeDir,
      browserHost: this.browserHost,
      // 嵌套深度与 trace 总配额同时限制；只读角色没有 task（白名单不含），不会走到这里
      enableTaskTool:
        this.subagentDepth + 1 < this.activeProfile.maxSubagentDepth &&
        this.subagentBudget - 1 > 0,
      subagentDepth: this.subagentDepth + 1,
      subagentBudget: Math.max(0, this.subagentBudget - 1),
      // 插件 hooks 在子 Agent 内同样生效（SubagentStop / 子会话工具 hook）；
      // hookScope 提供 root session 与 agent_id，审批仍由父会话聚合。
      plugins: this.plugins,
      hookScope: {
        rootSessionId: this.hookScope?.rootSessionId ?? params.parentSessionId,
        agentId: params.agentId,
        agentType: params.agentType,
        parentSessionId: params.parentSessionId,
      },
      // 子代理是机器节奏：连续打点、没有人为空档，1h 档只会多付写入溢价
      sessionPace: "machine",
      systemPrompt: effectivePrompt,
      instructionSettings: { ...this.instructionSettings },
      ...(effectiveTools ? { allowedTools: effectiveTools } : {}),
      // 验证类角色：能跑命令，但 run_code 的写桥一律拒绝
      ...(definition.writeDenied ? { denyHostWrites: true } : {}),
      ...((inheritPrefix ? this.injectInstructions : definition.injectInstructions !== false)
        ? {}
        : { injectInstructions: false }),
      onFileChange: async (change) => {
        // 宿主观测：子 Agent 的文件改动即 ground truth（不信任自述）
        params.observations.filesChanged.add(change.path);
        await params.session.appendFileChange(change.path, change.operation, change.diff);
        const stats = countDiffStats(change.diff);
        // 后台子 Agent 结束时父回合可能已收尾：只在父回合活跃时计入其检查点与汇总
        if (this.runningSessionId === params.parentSessionId) {
          this.turnFileChanges.add(change.path);
          this.recordTurnFileChange(change.path, stats);
        }
        await params.session.flush();
        // 不带 agentId：父级 file_changed 要触发主界面审阅，而不是被当成子事件过滤掉。
        this.emit({
          type: "file_changed",
          sessionId: params.parentSessionId,
          path: change.path,
          operation: change.operation,
          ...stats,
        });
      },
    });
    // 子 Agent 的会话不蒸馏记忆：长期事实只在主会话沉淀（ZCode 只对 main taskType 跑）
    child.memoryEnabled = false;
    // 同理不学习：子 Agent 的任务是被父级切碎的片段，从里面总结「经验」只会得到噪音
    child.learning = false;
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
    const mode: "spawn" | "fork" = args.mode === "fork" ? "fork" : "spawn";
    const requestedRole = args.agent_type;
    const allowedRoles = this.activeProfile.roles;
    if (requestedRole !== undefined && !allowedRoles.includes(requestedRole as SubagentType)) {
      throw new Error(
        `${this.activeProfile.name} cannot dispatch agent_type "${String(requestedRole)}". Allowed roles: ${allowedRoles.join(", ")}.`,
      );
    }
    const agentType: SubagentType = isAgentRole(requestedRole) ? requestedRole : "general";
    if (mode === "fork" && agentType !== "general") {
      throw new Error('mode "fork" only supports agent_type "general".');
    }
    const background = args.background === true;
    const laneId = typeof args.lane_id === "string" ? args.lane_id.trim().slice(0, 64) : undefined;
    const parentGoal = lastUserMessage(session);
    const prompt =
      promptInput ||
      (mode === "fork"
        ? description
        : buildSubagentPrompt({
            description,
            ...(parentGoal ? { parentGoal } : {}),
            plan: session.currentPlan,
          }));
    const { providers, providerId } = this.resolveSubagentProvider(input);
    const agentId = randomUUID();
    const parentSessionId = session.id;
    const subagentsDir = path.join(this.sessionsDir, "subagents", parentSessionId);
    const filePath = path.join(subagentsDir, `${agentId}.jsonl`);
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    const approvalMode = this.turnApprovalMode ?? this.approvalMode;
    const maxSubagents = this.activeProfile.maxSubagents;
    // 后台子 Agent 活过回合边界：上一回合起的后台任务不能占掉这一回合的准入名额，
    // 否则用户看到的是「并发上限」却数不出是哪一个在挡路。前台/后台分开计数。
    const liveForeground = [...this.liveSubagents.values()].filter((item) => !item.background).length;
    const liveBackground = this.liveSubagents.size - liveForeground;
    if (background) {
      if (liveBackground + this.startingSubagents >= MAX_BACKGROUND_SUBAGENTS) {
        throw new Error(
          `Background subagent limit reached: at most ${MAX_BACKGROUND_SUBAGENTS} background agents may run at once. Wait for one to finish, or run this one in the foreground.`,
        );
      }
    } else if (liveForeground + this.startingSubagents >= maxSubagents) {
      throw new Error(
        `Subagent concurrency limit reached: at most ${maxSubagents} foreground agents may run at once (${this.activeProfile.name}).`,
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
      const childStore = await SessionStore.create(filePath, session.cwd, {
        id: agentId,
        parentSessionId,
        rootSessionId: session.id,
        agentKind: "subagent",
        agentType,
        parentCallId: call.id,
        description,
        // 子 Agent 与父会话共享一条诊断链路
        traceId: session.traceId,
        ...(mode === "fork" ? { forkedFrom: session.id } : {}),
      });
      let inheritPrefix = false;
      if (mode === "fork") {
        // fork 的价值是复用父前缀缓存：历史超过窗口 60% 就退回 spawn，避免一次超长请求
        const history = session.effectiveMessages;
        const window = this.activeProviderOrNull()?.contextWindow ?? 128_000;
        if (estimateMessagesTokens(history) <= window * 0.6) {
          for (const message of history) await childStore.appendMessage(message);
          if (this.experimental?.forkPrefixReuse !== false) {
            // 尾部契约：不动前缀，只约束「不能问用户」；语色沿用父对话
            await childStore.appendContextNote(FORK_CONTRACT_NOTE, "subagent");
            inheritPrefix = true;
          }
          await childStore.flush();
        }
      }
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
        inheritPrefix,
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
      await this.emitHook(
        "subagent_start",
        {
          hook: "subagent_start",
          ...this.hookScopeFields(session),
          sessionId: parentSessionId,
          agentId,
          ...(agentType ? { agentType } : {}),
          description,
          background,
          ...(prompt ? { prompt: clipText(prompt, 2000) } : {}),
        },
        session,
      );

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
      await this.emitHook(
        "subagent_stop",
        {
          hook: "subagent_stop",
          ...this.hookScopeFields(ctx.session),
          sessionId: ctx.session.id,
          agentId: ctx.agentId,
          ...(ctx.agentType ? { agentType: ctx.agentType } : {}),
          description: ctx.description,
          status: status === "completed" ? "completed" : status === "failed" ? "failed" : "aborted",
          ...(errorMessage ? { error: errorMessage } : {}),
          durationMs,
        },
        ctx.session,
      );
      if (ctx.background) {
        // 主回合不等待后台子 Agent：把报告放入父会话上下文，下一次父回合能看到。
        const notice = report
          ? `Background subagent "${ctx.description}" ${status}:\n${clipText(report, 4000)}`
          : `Background subagent "${ctx.description}" ${status}${errorMessage ? `: ${errorMessage}` : "."}`;
        await ctx.session.appendContextNote(notice, "subagent").catch(() => undefined);
        await ctx.session.flush().catch(() => undefined);
      }
      ctx.child.dropPendingSteers(status === "aborted" ? "aborted" : "completed");
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
      parts.push(
        `[agent id: ${ctx.agentId}] Use this id with task mode "resume" to continue this subagent later.`,
      );
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

  /** task 结果回带本回合剩余派发数：模型能自己收手，而不是撞上限才发现。 */
  private subagentStartsLeftNote(): string {
    const max = this.activeProfile.maxSubagents;
    const left = Math.max(0, max - this.subagentsStartedThisTurn);
    const exhausted =
      left === 0 ? " Further task calls this turn will be rejected — do the remaining work yourself." : "";
    return `Subagent starts left this turn: ${left}/${max}.${exhausted}`;
  }

  /** 本回合的派发准入：spawn / resume 共用，超限时返回模型可读的拒绝结果。 */
  private subagentAdmissionError(): SubagentTaskResult | null {
    if (this.subagentBudget <= 0) {
      return {
        output:
          "Subagent budget for this task is exhausted (8 agents including nested ones). Handle the remaining work yourself.",
        ok: false,
        status: "failed",
        error: "subagent budget exhausted",
      };
    }
    if (this.subagentsStartedThisTurn >= this.activeProfile.maxSubagents) {
      const limit = this.activeProfile.maxSubagents;
      return {
        output: `Subagent limit reached: at most ${limit} subagents per turn in ${this.activeProfile.name}. Do not retry this turn; handle the remaining work in the main conversation, or group related items into fewer tasks.`,
        ok: false,
        status: "failed",
        error: "subagent limit reached",
      };
    }
    return null;
  }

  private async runSubagentTask(
    session: SessionStore,
    call: ToolCall,
    input: unknown,
  ): Promise<SubagentTaskResult> {
    const args = (input ?? {}) as Record<string, unknown>;
    const description = String(args.description ?? "").trim().slice(0, 100);
    const mode =
      args.mode === "resume" ? "resume" : args.mode === "fork" ? "fork" : "spawn";
    if (mode === "resume") {
      const agentId = String(args.agent_id ?? "").trim();
      if (!agentId) {
        return {
          output: 'Tool call rejected: mode "resume" requires agent_id (the id of a previous subagent).',
          ok: false,
          status: "failed",
          error: "missing agent_id",
        };
      }
      const message = String(args.prompt ?? "").trim() || description;
      if (!message) {
        return {
          output: 'Tool call rejected: mode "resume" requires prompt or description.',
          ok: false,
          status: "failed",
          error: "missing resume message",
        };
      }
      // 模型发起的续聊同样是一次派发：与 spawn 共用本回合准入，防止绕过上限。
      const admission = this.subagentAdmissionError();
      if (admission) return admission;
      this.subagentsStartedThisTurn += 1;
      this.subagentBudget -= 1;
      try {
        const resumed = await this.startSubagentResume(agentId, message, {
          wait: true,
          background: false,
          ...(this.turnAbort?.signal ? { parentSignal: this.turnAbort.signal } : {}),
        });
        if (!resumed) {
          this.subagentBudget += 1;
          this.subagentsStartedThisTurn = Math.max(0, this.subagentsStartedThisTurn - 1);
          return {
            output: "Subagent resume did not start.",
            ok: false,
            status: "failed" as const,
            error: "resume did not start",
          };
        }
        return { ...resumed, output: `${resumed.output}\n\n${this.subagentStartsLeftNote()}` };
      } catch (error) {
        this.subagentBudget += 1;
        this.subagentsStartedThisTurn = Math.max(0, this.subagentsStartedThisTurn - 1);
        return {
          output: `Subagent resume failed: ${error instanceof Error ? error.message : String(error)}`,
          ok: false,
          status: "failed" as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    if (!this.enableTaskTool) {
      return {
        output: `Subagent nesting depth reached for ${this.activeProfile.name}. Finish the remaining work in the current agent.`,
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
    const admission = this.subagentAdmissionError();
    if (admission) return admission;
    // 先同步占位再 await：并行的多个 task 调用也不能突破上限
    this.subagentsStartedThisTurn += 1;
    this.subagentBudget -= 1;

    try {
      const started = await this.beginSubagent(session, call, input);
      if (started.background) {
        void started.completion.catch(() => undefined);
        return {
          output: `Subagent "${started.description}" started in background. Continue with other work; its completion will be reported separately. ${this.subagentStartsLeftNote()}`,
          ok: true,
          status: "running",
        };
      }
      const result = await started.completion;
      return { ...result, output: `${result.output}\n\n${this.subagentStartsLeftNote()}` };
    } catch (error) {
      // 没真正启动：把本回合准入与总预算都还回去
      this.subagentBudget += 1;
      this.subagentsStartedThisTurn = Math.max(0, this.subagentsStartedThisTurn - 1);
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

  /** 一键审查：用 reviewer 子 Agent 审当前工作区未提交改动（prompt 由服务端拼好）。 */
  async reviewChanges(prompt: string): Promise<{ ok: boolean; output: string }> {
    const session = this.currentSession;
    if (!session) throw new Error("No active session.");
    const args = {
      description: "Review changes",
      prompt,
      agent_type: "reviewer",
    };
    const call: ToolCall = {
      id: randomUUID(),
      type: "function",
      function: { name: "task", arguments: JSON.stringify(args) },
    };
    const result = await this.runSubagentTask(session, call, args);
    return { ok: result.ok, output: result.output };
  }

  /** 停止单个子 Agent；返回是否命中正在运行的子 Agent。 */
  abortSubagent(agentId: string): boolean {
    const live = this.liveSubagents.get(agentId);
    if (!live) return false;
    live.runtime.abort();
    return true;
  }

  /** 运行中的子 Agent 插话：入队，下一个安全步骤注入；不中止当前工具/流。 */
  steerSubagent(agentId: string, message: string): void {
    const session = this.currentSession;
    if (!session) throw new Error("No active session.");
    const live = this.liveSubagents.get(agentId);
    if (!live || live.parentSessionId !== session.id) throw new Error("Subagent not found.");
    live.runtime.enqueueSteer(message);
  }

  /** 子 Agent runtime：把一条插话加入当前回合的待注入队列。 */
  enqueueSteer(text: string): string {
    const value = text.trim();
    if (!value) throw new Error("Steer message must not be empty.");
    if (!this.turnAbort) throw new Error("Subagent is not running.");
    if (value.length > MAX_STEER_CHARS) {
      throw new Error(`Steer message is too long (max ${MAX_STEER_CHARS} characters).`);
    }
    if (this.pendingSteers.length >= MAX_PENDING_STEERS) {
      throw new Error(`At most ${MAX_PENDING_STEERS} pending steers per turn.`);
    }
    const steer = { id: randomUUID(), text: value };
    this.pendingSteers.push(steer);
    this.emit({
      type: "subagent_steer_queued",
      sessionId: this.currentSession?.id ?? "",
      steerId: steer.id,
      text: steer.text,
    });
    return steer.id;
  }

  /** 模型准备收尾时取一条插话；由 agent-loop 的 takeSteer 钩子调用。 */
  takeSteer(): string | undefined {
    const steer = this.pendingSteers.shift();
    if (!steer) return undefined;
    this.emit({
      type: "subagent_steer_delivered",
      sessionId: this.currentSession?.id ?? "",
      steerId: steer.id,
      text: steer.text,
    });
    return steer.text;
  }

  /** 子 Agent 结束/停止时丢弃未送达插话，前端据此清掉 pending 标记。 */
  dropPendingSteers(reason: "aborted" | "completed"): void {
    while (this.pendingSteers.length) {
      const steer = this.pendingSteers.shift()!;
      this.emit({
        type: "subagent_steer_dropped",
        sessionId: this.currentSession?.id ?? "",
        steerId: steer.id,
        text: steer.text,
        reason,
      });
    }
  }

  /** 用户对一个已结束的子 Agent 继续发消息：恢复子会话并启动新回合。 */
  async continueSubagent(agentId: string, message: string): Promise<void> {
    await this.startSubagentResume(agentId, message, { wait: false });
  }

  /**
   * 续聊一个已完成的子 Agent。wait=true 时等待本轮结束并返回结果（模型 tool 调用用），
   * wait=false 保持原来的后台语义（UI 续聊按钮用）。
   */
  private async startSubagentResume(
    agentId: string,
    message: string,
    options: { wait: boolean; background?: boolean; parentSignal?: AbortSignal },
  ): Promise<SubagentTaskResult | null> {
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
        background: options.background ?? true,
        startedAt,
        startedAtMs,
      });
      await session.appendSubagent({
        agentId,
        callId,
        description,
        agentType,
        background: options.background ?? true,
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
        background: options.background ?? true,
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
        background: options.background ?? true,
        ...(options.parentSignal ? { parentSignal: options.parentSignal } : {}),
        prompt: text,
        startedAt,
        startedAtMs,
        observations,
      });
      if (options.wait) return completion;
      void completion.catch(() => undefined);
      return null;
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
      // 第 0.5 档：投影先行（旧截图/文档滞回裁剪 + 跨轮 thinking 剥离，零信息损失）
      // ——反正 stage 1 起每档都要改写前缀，投影搭同一班车，可能根本不用走到抽尾。
      const projected = projectForRequest(messages, provider);
      if (projected !== messages) {
        console.error("[meowcode] stage 0.5: projecting old images/documents/thinking (no model call)");
        return { messages: projected, stage: 1 };
      }
      const shrunk = await this.shrinkWithSpill(session, messages);
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

    if (stage < 2 && this.localCompactionFailures < COMPACTION_FAILURE_LIMIT) {
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

    return {
      messages: await this.performCompaction(session, provider, messages, true),
      stage: 3,
    };
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
    /**
     * 溢出触发的压缩允许退化为「零模型兜底」；手动压缩不允许 ——
     * 用户明确要求生成摘要，静默丢历史比报错更糟。
     */
    allowEmergency = false,
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
    this.fireHook(
      "compaction_start",
      {
        hook: "compaction_start",
        ...this.hookScopeFields(session),
        sessionId: session.id,
        compactionId,
        reason: this.turnAbort ? "overflow" : "manual",
        messageCount: messages.length,
      },
      session,
    );
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
      // 摘要连续失败到上限、或还在失败冷却期内：不再花请求，直接零模型兜底。
      if (
        allowEmergency &&
        (this.localCompactionFailures >= COMPACTION_FAILURE_LIMIT ||
          Date.now() < this.compactionCooldownUntil)
      ) {
        console.error(
          `[meowcode] local compaction circuit-broken (failures=${this.localCompactionFailures}, cooldown=${
            this.compactionCooldownUntil > Date.now()
          }); dropping oldest history instead`,
        );
        return await this.emergencyCompaction(session, provider, compactionId, turnId, messages);
      }
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
        summaryMessages: projectForRequest(messagesToSummarize, provider),
        reusePrefix: true,
        systemMessages: this.systemMessages(),
        neutralizePersona: this.speechPersonaActive,
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
      this.localCompactionFailures = 0;
      this.compactionFailureStreak = 0;
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
      // 中止是用户行为，不是压缩失败：照常收尾并抛出
      if (isAbortError(error) || !allowEmergency) {
        await this.failCompaction(session, compactionId, message);
        throw error;
      }
      this.localCompactionFailures += 1;
      this.compactionFailureStreak += 1;
      if (this.compactionFailureStreak >= 2) {
        this.compactionCooldownUntil = Date.now() + COMPACTION_COOLDOWN_MS;
        this.compactionFailureStreak = 0;
      }
      console.error(
        `[meowcode] compaction failed (${this.localCompactionFailures}/${COMPACTION_FAILURE_LIMIT}): ${message}; dropping oldest history instead of failing the turn`,
      );
      try {
        return await this.emergencyCompaction(session, provider, compactionId, turnId, messages);
      } catch (fallbackError) {
        console.error(
          `[meowcode] emergency compaction failed too: ${
            fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
          }`,
        );
        await this.failCompaction(session, compactionId, message);
        throw error;
      }
    } finally {
      this.compactingSession = false;
    }
  }

  /** 压缩失败的统一收尾：落一条 failed 状态并广播事件。 */
  private async failCompaction(
    session: SessionStore,
    compactionId: string,
    message: string,
  ): Promise<void> {
    await session
      .appendCompactionEnd({ compactionId, status: "failed", error: message })
      .catch(() => undefined);
    await session.flush().catch(() => undefined);
    this.emit({
      type: "compaction_failed",
      sessionId: session.id,
      message,
    });
    this.fireHook(
      "compaction_end",
      {
        hook: "compaction_end",
        ...this.hookScopeFields(session),
        sessionId: session.id,
        compactionId,
        status: "failed",
      },
      session,
    );
  }

  /**
   * 零模型兜底压缩（参考 codex 的 compact_token_budget：直接换新上下文窗口）。
   *
   * 摘要调用失败时不把整轮打死：丢掉最旧的整单元历史，最近 ~16k 逐字保留，
   * 再照常补计划快照与已碰文件清单。落盘一条说明性摘要，重放时模型能知道
   * 「历史是被丢弃的，不是被总结的」——否则它会以为自己漏读了什么。
   */
  private async emergencyCompaction(
    session: SessionStore,
    provider: ProviderConfig,
    compactionId: string,
    turnId: string | null,
    messages: ChatMessage[],
  ): Promise<ChatMessage[]> {
    const recent = session.recentKeptMessages({
      tokens: COMPACTION_KEEP_RECENT_TOKENS,
      contextWindow: provider.contextWindow,
    });
    // 窗口极小时可能一条都留不下；至少保留最后一条，配对由 trimMessages 修复
    const keep = Math.max(1, recent.length);
    console.error(
      `[meowcode] emergency compaction: dropping history without a summary (keeping ${keep} recent messages)`,
    );
    return this.commitCompaction(
      session,
      provider,
      compactionId,
      turnId,
      HISTORY_DROPPED_SUMMARY,
      keep,
      messages,
    );
  }

  /** 从消息里的工具调用提取读写过的文件（去重、按出现顺序），只用于压缩后的路径提示。 */
  /** 最近执行过的命令（去重保序，最多 12 条，整段截 1200 字符）：压缩后别重复跑。 */
  private recentCommands(messages: ChatMessage[], max = 12): string {
    const seen = new Set<string>();
    const commands: string[] = [];
    for (let index = messages.length - 1; index >= 0 && commands.length < max; index -= 1) {
      const message = messages[index];
      if (message.role !== "assistant" || !message.tool_calls?.length) continue;
      for (const call of message.tool_calls) {
        if (call.function?.name !== "run_command") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(call.function.arguments);
        } catch {
          continue;
        }
        const command = (parsed as { command?: unknown })?.command;
        if (typeof command !== "string") continue;
        const trimmed = command.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        commands.unshift(trimmed);
      }
    }
    const list = commands.join("\n");
    return list.length > 1_200 ? `${list.slice(0, 1_200)}\n...` : list;
  }

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
      // 能查到净改动的补上 +/-：只给路径时模型判断不出「改没改、改了多少」，
      // 压缩后常见动作就是把文件再读一遍。数字来自落盘的 turn_file_change，
      // 纯本地拼装、零模型成本 —— 比把摘要写长便宜得多。
      const diffs = new Map<string, { added: number; removed: number }>();
      for (const group of session.turnFileChangeGroups.slice(-3)) {
        for (const file of group.files) {
          const key = this.qualityPathKey(session.cwd, file.path);
          const previous = diffs.get(key) ?? { added: 0, removed: 0 };
          diffs.set(key, {
            added: previous.added + file.added,
            removed: previous.removed + file.removed,
          });
        }
      }
      let list = touched
        .map((item) => {
          const diff = diffs.get(this.qualityPathKey(session.cwd, item));
          return diff ? `${item} (+${diff.added}/-${diff.removed})` : item;
        })
        .join("\n");
      if (list.length > 1_200) list = `${list.slice(0, 1_200)}\n...`;
      await session.appendContextNote(
        `Runtime context: files already read or changed before compaction (paths and net changes; re-read if you need contents):\n${list}`,
      );
      // 基线：这些文件已经「交代过」了，压缩后模型再读一遍说明摘要没兜住
      this.compactionQuality = {
        compactionId,
        paths: new Set(touched.map((item) => this.qualityPathKey(session.cwd, item))),
        hits: [],
        turnsLeft: COMPACTION_QUALITY_WINDOW_TURNS,
      };
    }
    // 命令账本：路径之外再补一份「跑过什么」，压缩后模型容易把 tsc / test 再跑一遍。
    const commands = this.recentCommands(messages);
    if (commands) {
      await session.appendContextNote(
        `Runtime context: commands already run before compaction (re-run only if you need fresh output):\n${commands}`,
      );
    }
    // 压缩前的真实用量已不代表当前上下文，回退到估算，下一次响应再刷新
    this.usageAnchor = null;
    // 压缩改写了前缀：服务端清理重新从零武装，避免压完立刻又被清
    this.contextEditingArmed = false;
    await session.appendCompactionEnd({ compactionId, status: "completed" });
    // 压完仍 ≥80% 说明这次压缩没解决问题：连续 2 次进冷却，别每轮再烧一遍。
    const window = provider.contextWindow;
    if (window && window > 0) {
      const ratio = this.getContextUsage().usedTokens / window;
      if (ratio >= COMPACTION_WARMUP_RATIO) {
        this.ineffectiveCompactions += 1;
        if (this.ineffectiveCompactions >= 2) {
          this.compactionCooldownUntil = Date.now() + COMPACTION_COOLDOWN_MS;
          this.ineffectiveCompactions = 0;
        }
      } else {
        this.ineffectiveCompactions = 0;
      }
    }
    await session.flush().catch(() => undefined);
    // 压缩已经改写了历史前缀，这是应用延后工具变动的最便宜时机。
    this.rebuildToolCatalog("compaction");
    this.emit({
      type: "compaction_completed",
      sessionId: session.id,
      summary:
        summary ||
        "Earlier history was compacted server-side by the provider (encrypted checkpoint; no readable summary).",
    });
    this.fireHook(
      "compaction_end",
      {
        hook: "compaction_end",
        ...this.hookScopeFields(session),
        sessionId: session.id,
        compactionId,
        status: "completed",
        ...(summary ? { summary } : {}),
        afterTokens: this.getContextUsage().usedTokens,
      },
      session,
    );
    const rebuilt: ChatMessage[] = [
      ...this.systemMessages(),
      ...session.effectiveMessages,
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
  private maybeStartCompactionWarmup(
    session: SessionStore,
    provider: ProviderConfig,
    ratio: number = COMPACTION_WARMUP_RATIO,
  ): void {
    if (!provider.contextWindow || this.warmupCompaction || this.compactingSession) return;
    if (this.warmupFailures >= 2) {
      // 冷却期内不再预热；冷却结束放行一次探测，失败会重新进冷却。
      if (Date.now() < this.compactionCooldownUntil) return;
      this.warmupFailures = 1;
    }
    const usage = this.getContextUsage();
    if (!usage.contextWindow || usage.source !== "usage") return;
    // 软阈值带绝对预留；95% 总量硬闸单独按窗口比值判，不随预留口径移动
    const warmupAt = compactionTriggerTokens(usage.contextWindow, provider.maxTokens, ratio);
    if (warmupAt <= 0 || usage.usedTokens < warmupAt) return;
    if (usage.usedTokens / usage.contextWindow >= COMPACTION_WARMUP_MAX_RATIO) return;
    // 没有可摘要的旧历史（全部都在逐字保留预算内）就不预热
    const recent = session.recentKeptMessages({
      tokens: COMPACTION_KEEP_RECENT_TOKENS,
      contextWindow: provider.contextWindow,
    });
    if (!recent.length) return;
    // 与正常请求使用同一份未投影历史：复用路径才能命中刚写入的前缀缓存
    const effective = session.effectiveMessages;
    const prefixLength = Math.max(0, effective.length - recent.length);
    if (prefixLength <= 0) return;

    // 稳定快照：摘要输入取自当下落盘的历史，之后新增的消息由 keepRecentMessages 兜住
    const systems = this.systemMessages();
    const prefix = effective.slice(0, prefixLength);
    // 复用路径发与主请求逐字节一致的全量对话（主路径带滞回投影，这里同口径，
    // 否则摘要请求与主请求前缀字节不一致、读不回刚写入的缓存）；回退路径只发投影后的旧前缀
    const fullMessages = [...systems, ...projectForMainPath(effective)];
    const summaryMessages = [...systems, ...projectForRequest(prefix, provider)];
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
          neutralizePersona: this.speechPersonaActive || this.hasStyleNote(session),
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
        this.compactionCooldownUntil = 0;
        this.emit({ type: "compaction_warmup", sessionId: session.id, phase: "completed" });
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return;
        warmup.state = "failed";
        this.warmupFailures += 1;
        if (this.warmupFailures >= 2) {
          this.compactionCooldownUntil = Date.now() + COMPACTION_COOLDOWN_MS;
        }
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
   * 缓存保活：回合结束后若人类迟迟不继续，5m TTL 会过期，下一条请求整段冷重写
   * （1.25×）。空闲 290s 后以 max_tokens=1 重放「system + 工具 + 全量历史」刷新
   * TTL，读回成本 0.1×，远低于冷重写（aider warm_cache 同款）。
   *
   * 纪律：
   *  - 只服务 anthropic-messages 且断点启用、TTL 5m 的会话（1h 档本来就能扛空档）；
   *  - 不落盘、不 journal、不广播 usage（与 commit-message/polish 同口径），不污染命中率；
   *  - 用户发消息 / 换会话 / 换模型 / 中止即取消——任何真实活动都让位。
   */
  private keepaliveTimer: ReturnType<typeof setTimeout> | null = null;
  private keepalivePingsLeft = 0;
  private keepaliveAbort: AbortController | null = null;

  private scheduleCacheKeepalive(session: SessionStore): void {
    this.cancelIdleTimers();
    const provider = this.activeProvider();
    if ((provider.protocol ?? "openai-chat-completions") !== "anthropic-messages") return;
    const plan = resolveCachePlan(provider);
    if (!plan.enabled || plan.ttl !== "5m") return;
    this.keepalivePingsLeft = CACHE_KEEPALIVE_MAX_PINGS;
    this.keepaliveTimer = setTimeout(
      () => void this.runCacheKeepalive(session),
      CACHE_KEEPALIVE_DELAY_MS,
    );
  }

  /**
   * 任何真实活动（新回合/换会话/换模型/中止）都取消空闲期后台任务（保活 ping +
   * 空闲压缩）；进行中的 ping 一并中止。两者共享生命周期：都只在「人走开、前缀
   * 静止」时有意义，任何上下文变化（尤其换模型=换缓存分片）都让旧计划作废。
   */
  private cancelIdleTimers(): void {
    if (this.keepaliveTimer) {
      clearTimeout(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    this.keepaliveAbort?.abort();
    this.keepaliveAbort = null;
    if (this.idleCompactionTimer) {
      clearTimeout(this.idleCompactionTimer);
      this.idleCompactionTimer = null;
    }
  }

  /**
   * 空闲压缩触发器：回合结束 54min 后仍无活动、占用在 60%–95% 区间时后台预热。
   * 只对 1h TTL 会话真正省钱（缓存反正要过期）；5m 会话的空档由保活 ping 顶住，
   * 到不了 54min。重用现有 maybeStartCompactionWarmup，只是阈值放宽到 60%。
   */
  private idleCompactionTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleIdleCompaction(session: SessionStore): void {
    if (this.idleCompactionTimer) clearTimeout(this.idleCompactionTimer);
    this.idleCompactionTimer = setTimeout(() => {
      this.idleCompactionTimer = null;
      void this.maybeIdleCompaction(session);
    }, IDLE_COMPACTION_DELAY_MS);
  }

  private async maybeIdleCompaction(session: SessionStore): Promise<void> {
    if (this.currentSession !== session || this.turnAbort || this.shuttingDown) return;
    const provider = this.activeProvider();
    if (!provider.contextWindow) return;
    const usage = this.getContextUsage();
    if (!usage.contextWindow || usage.source !== "usage") return;
    const ratio = usage.usedTokens / usage.contextWindow;
    if (ratio < IDLE_COMPACTION_MIN_RATIO || ratio >= COMPACTION_WARMUP_MAX_RATIO) return;
    this.maybeStartCompactionWarmup(session, provider, IDLE_COMPACTION_MIN_RATIO);
  }

  private async runCacheKeepalive(session: SessionStore): Promise<void> {
    this.keepaliveTimer = null;
    // 期间来了真实活动 / 切走了会话 / 在跑回合：全部让位
    if (this.currentSession !== session || this.turnAbort || this.shuttingDown) return;
    if (this.keepalivePingsLeft <= 0) return;
    const provider = this.activeProvider();
    if ((provider.protocol ?? "openai-chat-completions") !== "anthropic-messages") return;
    const plan = resolveCachePlan(provider);
    if (!plan.enabled || plan.ttl !== "5m") return;
    const tools = this.ensureToolCatalog().tools;
    const systems = this.systemMessages();
    // 与主路径同口径：不带投影的保活请求会和主请求字节不一致，保活反而写不进同一条缓存
    const messages = [...systems, ...projectForMainPath(session.effectiveMessages)];
    if (messages.length <= systems.length) return; // 空会话没什么可保
    this.keepalivePingsLeft -= 1;
    this.keepaliveAbort = new AbortController();
    try {
      await streamChatCompletion({
        // max_tokens=1：只要它开始吐流，本次请求对缓存的读回就完成了，输出丢弃。
        // 思考一并关掉：max_tokens=1 装不下 budget_tokens，开着只会吃 400。
        // purpose 用 main：亲和键与主对话同分片（anthropic 协议不发该字段，仅为口径一致）。
        provider: this.applyCachePolicy(
          { ...provider, maxTokens: 1, reasoningEffort: undefined, thinkingBudget: undefined },
          session.id,
          "main",
        ),
        messages,
        tools,
        toolCacheAnchor: this.toolCacheAnchor(),
        signal: this.keepaliveAbort.signal,
        onDelta: () => undefined,
        // 只 log 不落盘不广播（命中率口径保持干净），但必须能验证 ping 真的读回：
        // cc-haha 实测 fork 参数差异曾让命中率 92.7%→61%，read=0 就说明保活在白写。
        onUsage: (usage) => {
          console.error(
            `[meowcode] cache keepalive: read=${usage.cacheReadTokens ?? 0} write=${usage.cacheWriteTokens ?? 0} input=${usage.inputTokens}`,
          );
        },
      });
    } catch {
      // 端点失败（网络/鉴权/限流）就停止续保：下次真实请求会重新计时
      this.keepalivePingsLeft = 0;
      return;
    } finally {
      this.keepaliveAbort = null;
    }
    // 成功 ping 就是一次真实触缓存：空闲诊断从它起算，
    // 否则冷 resume 判定会把 ping 保热的缓存误判为已过期。
    const meta = this.providerRequestMeta.get(provider.id);
    if (meta && this.currentSession === session) {
      this.providerRequestMeta.set(provider.id, { ...meta, at: Date.now() });
    }
    if (this.keepalivePingsLeft > 0 && this.currentSession === session && !this.turnAbort) {
      this.keepaliveTimer = setTimeout(
        () => void this.runCacheKeepalive(session),
        CACHE_KEEPALIVE_DELAY_MS,
      );
    }
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
    const proactiveAt = compactionTriggerTokens(
      usage.contextWindow,
      provider.maxTokens,
      COMPACTION_PROACTIVE_RATIO,
    );
    if (proactiveAt <= 0 || usage.usedTokens < proactiveAt) return;
    if (usage.usedTokens / usage.contextWindow >= COMPACTION_WARMUP_MAX_RATIO) return;

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
    this.fireHook(
      "compaction_start",
      {
        hook: "compaction_start",
        ...this.hookScopeFields(session),
        sessionId: session.id,
        compactionId,
        reason: "warmup",
        messageCount: session.effectiveMessages.length,
      },
      session,
    );
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
    tool: "write_file" | "edit_file" | "delete_file" | "move_file" | "multi_edit" | "run_command",
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

    // 验证角色（verifier / fresh-verifier）的写后门：run_code 的 meow.write/edit/multiEdit
    // 走的就是这里。不拦的话，full 模式下它们能先把测试改绿再报 PASS。
    if (this.denyHostWrites && tool !== "run_command") {
      return reject(
        `Tool ${tool} blocked: this agent role may run checks but must not modify files. Report the failure instead of fixing it.`,
      );
    }
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
    const commandRisk =
      tool === "run_command" ? assessCommandRisk(String(args.command ?? "")) : undefined;
    const autoReason = autoApprovalReason(tool, writableTarget, commandRisk);
    if (approvalMode !== "full" && WRITABLE_ROOT_TOOLS.has(tool) && !writableTarget) {
      return reject(
        `Tool ${tool} rejected: ${violation || "the target path"} is outside the workspace. Switch to full-access mode to write outside it.`,
      );
    }

    const forceDeleteConfirm =
      tool === "run_command" &&
      shouldConfirmFileDelete() &&
      isFileDeletionCommand(String(args.command ?? ""));
    let approved = planPaths !== null;
    if (!approved && forceDeleteConfirm) {
      const diff = await previewDiff(tool, args, session.cwd, allowOutsideWorkspace).catch(
        () => undefined,
      );
      const forceDecision = await this.awaitApproval(
        session,
        call,
        tool,
        args,
        diff,
        commandRisk,
        turnId,
        false,
      );
      approved = forceDecision.approved;
      await session.appendApproval(call.id, tool, args, approved, (turnId ? { turnId } : {}));
    } else if (!approved && approvalMode === "full") {
      approved = true;
      await session.appendApproval(call.id, tool, args, true, (turnId ? { turnId } : {}));
    } else if (!approved && approvalMode === "auto" && autoReason) {
      approved = true;
      await session.appendApproval(call.id, tool, args, true, {
        ...(turnId ? { turnId } : {}),
        reason: autoReason,
      });
    } else if (!approved) {
      const remembered = await this.tryRememberedApproval(session, tool, args, commandRisk);
      if (remembered) {
        approved = true;
        await session.appendApproval(call.id, tool, args, true, {
          ...(turnId ? { turnId } : {}),
          reason: "rule",
        });
      } else {
        const risk = commandRisk;
        const diff = await previewDiff(tool, args, session.cwd, allowOutsideWorkspace).catch(
          () => undefined,
        );
        const decision = await this.awaitApproval(
          session,
          call,
          tool,
          args,
          diff,
          risk,
          turnId,
          false,
        );
        approved = decision.approved;
        await session.appendApproval(call.id, tool, args, approved, (turnId ? { turnId } : {}));
        if (!approved) return reject(denialOutput(decision));
      }
    }
    if (!approved) return reject("User denied this tool call.");

    const reviewCaptures = WRITABLE_ROOT_TOOLS.has(tool)
      ? await captureBeforeAll(session.cwd, tool, args, allowOutsideWorkspace)
      : [];
    // 快照打点（写前）：state 记下「磁盘此刻」；写失败时 noteAfter 不会被调用，state 保持 before
    const snapshotTargets: SnapshotTarget[] = reviewCaptures.map((capture) => ({
      path: capture.target,
      file: capture.file,
    }));
    await this.snapshotFor(session)?.noteBefore(snapshotTargets);
    const result = await this.runToolWithSandboxEscape(
      session,
      call,
      tool,
      args,
      turnId,
      (sandbox) =>
        executeTool(tool, args, session.cwd, {
          allowOutsideWorkspace,
          signal: this.turnAbort?.signal,
          vision: this.toolVisionEnabled(),
          shrinkImage: this.imageShrinker(),
          sandbox,
          jobs: this.jobManager,
          // 不把宿主桥再传下去：防止 run_code → run_code 的递归
        }),
    );
    if (result.ok) await this.noteMutatedPath(session, tool, args);
    if (result.ok && reviewCaptures.length) {
      await this.snapshotFor(session)?.noteAfter(snapshotTargets);
      const operation = fileChangeOperation(tool);
      for (const capture of reviewCaptures) {
        const diff = await buildFileChangeDiff(tool, args, capture);
        if (!diff) continue;
        await session.appendFileChange(capture.target, operation, diff);
        this.turnFileChanges.add(capture.target);
        const stats = countDiffStats(diff);
        this.recordTurnFileChange(capture.target, stats);
        this.emit({
          type: "file_changed",
          sessionId: session.id,
          path: capture.target,
          operation,
          ...stats,
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
    const span = this.traceRecorder.startSpan({
      traceId: session.traceId,
      kind: "tool",
      name: call.function.name,
      attributes: { callId: call.id },
    });
    try {
      await this.executeToolCall(session, messages, call);
      const message = this.findToolResult(messages, call);
      this.traceRecorder.endSpan(span, {
        status: this.toolOutcomes.get(call.id) === false ? "error" : "ok",
      });
      return message;
    } catch (error) {
      this.traceRecorder.endSpan(span, {
        status: isAbortError(error) ? "aborted" : "error",
        error,
      });
      throw error;
    }
  }

  private findToolResult(messages: ChatMessage[], call: ToolCall): ToolResultMessage {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "tool" && message.tool_call_id === call.id) return message;
    }
    return { role: "tool", content: "", tool_call_id: call.id, name: call.function.name };
  }

  /** 只读批的 trace 包装：执行与状态口径和串行工具一致。 */
  private async executeReadOnlyToolCallTraced(
    session: SessionStore,
    call: ToolCall,
    messages: ChatMessage[],
  ): Promise<ToolResultMessage> {
    const span = this.traceRecorder.startSpan({
      traceId: session.traceId,
      kind: "tool",
      name: call.function.name,
      attributes: { callId: call.id, parallel: true },
    });
    try {
      const message = await this.executeReadOnlyToolCall(session, call, messages);
      this.traceRecorder.endSpan(span, {
        status: this.toolOutcomes.get(call.id) === false ? "error" : "ok",
      });
      return message;
    } catch (error) {
      this.traceRecorder.endSpan(span, {
        status: isAbortError(error) ? "aborted" : "error",
        error,
      });
      throw error;
    }
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

    // 插件 hook：tool_call（可 block / ask / 改写执行参数）。blocked → 不执行，原因作为工具结果返回；
    // 改写只影响本次执行，tool_started / 会话审计仍记录模型原始参数。
    const toolCallHook = await runHook(
      this.plugins,
      "tool_call",
      {
        hook: "tool_call",
        sessionId: session.id,
        callId: call.id,
        tool,
        // validated.ok 时必为 JSON object（validateToolArguments 保证）
        input: input as Record<string, unknown>,
        ...this.hookScopeFields(session),
      },
      this.hookContext(session, this.turnAbort?.signal),
    );
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
    const hookAsk = toolCallHook?.permission === "ask";
    const hookReason = hookAsk
      ? toolCallHook.reason ?? "The PreToolUse hook requests approval."
      : undefined;
    if (toolCallHook?.input) {
      // hook 改写后的参数必须重新校验，防止把非法/越界参数直接送进执行器。
      const revalidated = validateToolArguments(tool, JSON.stringify(toolCallHook.input));
      if (!revalidated.ok) {
        const output = `Tool call rejected: hook returned invalid arguments (${revalidated.error})`;
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
      input = revalidated.input;
    }

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
      if (hookAsk) {
        const decision = await this.approveHookAsk(session, call, tool, input, turnId, hookReason);
        if (!decision.approved) {
          const output = decision.output ?? "User denied this tool call.";
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
      }
      const taskStartedAt = Date.now();
      this.fireHook(
        "tool_execution_start",
        {
          hook: "tool_execution_start",
          ...this.hookScopeFields(session),
          sessionId: session.id,
          callId: call.id,
          tool,
          input: hookInput(input),
          startedAt: taskStartedAt,
        },
        session,
        this.turnAbort?.signal,
      );
      const taskResult = await this.runSubagentTask(session, call, input);
      this.fireHook(
        "tool_execution_end",
        {
          hook: "tool_execution_end",
          ...this.hookScopeFields(session),
          sessionId: session.id,
          callId: call.id,
          tool,
          input: hookInput(input),
          output: taskResult.output,
          ok: taskResult.ok,
          durationMs: Date.now() - taskStartedAt,
        },
        session,
        this.turnAbort?.signal,
      );
      const result = await this.applyToolResultHook(session, call.id, tool, input, taskResult);
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
      if (hookAsk) {
        const decision = await this.approveHookAsk(session, call, tool, input, turnId, hookReason);
        if (!decision.approved) {
          const output = decision.output ?? "User denied this tool call.";
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
      }
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
      const result = await this.applyToolResultHook(session, call.id, tool, input, {
        output,
        ok: validation.ok,
      });
      await this.pushToolMessage(session, messages, {
        role: "tool",
        content: result.output,
        tool_call_id: call.id,
        name: tool,
      });
      this.emit({
        type: "tool_output",
        sessionId: session.id,
        callId: call.id,
        output: result.output,
        truncated: false,
      });
      this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: result.ok });
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
    // git 的只读 action 免审批；写 action（stage/commit/discard/push…）按审批模式走
    const gitMutating = tool === "git" && isMutatingGitAction(input);
    const requiresApproval =
      APPROVAL_TOOLS.has(tool) || browserNeedsApproval || dynamicNeedsApproval || gitMutating;

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
    // hook 明确要求人工确认：即使 auto 自动批准或 full 模式也强制走审批
    if (hookAsk) approved = false;
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
    const commandRisk =
      tool === "run_command"
        ? assessCommandRisk(String(((input ?? {}) as Record<string, unknown>).command ?? ""))
        : undefined;
    const autoReason = autoApprovalReason(tool, writableTarget, commandRisk);
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

    const forceDeleteConfirm =
      (tool === "delete_file" && approvalMode !== "full") ||
      (tool === "run_command" &&
        shouldConfirmFileDelete() &&
        isFileDeletionCommand(
          String(((input ?? {}) as Record<string, unknown>).command ?? ""),
        ));
    // 后台任务跑在主进程 PTY 里，不受命令沙箱约束：除非 full 模式，一律显式确认一次
    const forceBackgroundConfirm =
      tool === "run_command" &&
      ((input ?? {}) as Record<string, unknown>).background === true &&
      approvalMode !== "full";
    // discard / push / pull 影响工作区或远端且不可逆：任何审批模式都显式确认一次
    const forceGitConfirm = tool === "git" && isForceApprovalGitAction(input);
    // 项目级规则：只覆盖普通审批路径；删除确认、后台任务、高危 git、plan/read-only、hookAsk 与沙箱逃逸都不受影响
    const rememberedRule =
      !approved &&
      !forceDeleteConfirm &&
      !forceBackgroundConfirm &&
      !forceGitConfirm &&
      !hookAsk &&
      approvalMode !== "read-only"
        ? await this.tryRememberedApproval(session, tool, input, commandRisk)
        : undefined;
    let denialFeedback: string | undefined;
    if (!approved && (forceDeleteConfirm || forceBackgroundConfirm || forceGitConfirm)) {
      const diff = await previewDiff(tool, input, session.cwd, allowOutsideWorkspace).catch(
        () => undefined,
      );
      const forceDecision = await this.awaitApproval(
        session,
        call,
        tool,
        input,
        diff,
        commandRisk,
        turnId,
        false,
      );
      approved = forceDecision.approved;
      denialFeedback = forceDecision.feedback;
      await session.appendApproval(call.id, tool, input, approved, (turnId ? { turnId } : {}));
    } else if (!approved && approvalMode === "full" && !hookAsk) {
      // 完全访问：不弹审批直接放行，仍写一条 approved 记录到会话文件留痕
      approved = true;
      await session.appendApproval(call.id, tool, input, true, (turnId ? { turnId } : {}));
    } else if (!approved && approvalMode === "auto" && autoReason && !hookAsk) {
      // codex 式：可写根内的写/改与常规命令自动批准；越界路径与高危命令仍然走审批
      approved = true;
      await session.appendApproval(call.id, tool, input, true, {
        ...(turnId ? { turnId } : {}),
        reason: autoReason,
      });
    } else if (!approved && rememberedRule) {
      approved = true;
      await session.appendApproval(call.id, tool, input, true, {
        ...(turnId ? { turnId } : {}),
        reason: "rule",
      });
    } else if (!approved) {
      const risk = commandRisk;
      // 审批预览与真正落盘之间隔着用户思考的时间：先记下目标文件版本，批准后再比对。
      const targets = WRITABLE_ROOT_TOOLS.has(tool)
        ? await this.approvalTargetFiles(session, tool, input)
        : [];
      const versions = await Promise.all(targets.map((file) => captureVersion(file)));

      let diff = await previewDiff(tool, input, session.cwd, allowOutsideWorkspace).catch(
        () => undefined,
      );
      const decision = await this.awaitApprovalWithPermissionHooks(
        session,
        call,
        tool,
        input,
        diff,
        risk,
        turnId,
        hookReason,
      );
      approved = decision.decision.approved;
      denialFeedback = decision.decision.feedback;
      const byHook = decision.byHook;
      const hookDeniedReason =
        !approved && byHook
          ? decision.reason ?? "denied by PermissionRequest hook"
          : undefined;

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
          const staleDecision = await this.awaitApproval(
            session,
            call,
            tool,
            input,
            diff,
            risk,
            turnId,
            true,
            hookReason,
          );
          approved = staleDecision.approved;
          if (!approved) denialFeedback = staleDecision.feedback;
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
      // 批准后可落一条项目级规则：文件按路径+版本，命令按精确/前缀，其它按工具
      if (approved && !byHook && !rechecked && decision.decision.remember) {
        await this.rememberApproval(
          session,
          tool,
          input,
          decision.decision.remember,
          targets,
          versions,
        ).catch(() => undefined);
      }
      await session.appendApproval(call.id, tool, input, approved, {
        ...(turnId ? { turnId } : {}),
        ...(rechecked
          ? { reason: "stale_rechecked" }
          : byHook
            ? { reason: "permission_request_hook" }
            : {}),
      });
      if (hookDeniedReason) {
        const output = `Permission denied by hook: ${hookDeniedReason}`;
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

    if (!approved) {
      const output = denialOutput({ approved, ...(denialFeedback ? { feedback: denialFeedback } : {}) });
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
        // 命中占位本身也是「模型想再读一次」的信号，计入压缩质量观测
        this.noteReadTarget(session, tool, input);
        const loopNote = this.noteLoopResult(session, tool, input, stub);
        const result = await this.applyToolResultHook(session, call.id, tool, input, {
          output: stub,
          ok: true,
        });
        const output = loopNote ? `${result.output}\n\n${loopNote}` : result.output;
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
        this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: result.ok });
        return;
      }
    }

    if (browserTool) {
      // 截图是否作为图片回传给模型，由模型模态决定（responses 协议下由序列化层
      // 拆成紧随的 user 消息，不再丢图）。
      const provider = this.activeProvider();
      const keepImages = (provider.inputModalities ?? []).includes("image");
      let result = this.browserHost
        ? await executeBrowserTool(tool, input, this.browserHost, { keepImages }, this.turnAbort?.signal)
        : {
            ok: false,
            output: "Browser tools are unavailable: the desktop browser host is not connected.",
            images: undefined,
          };
      result = await this.applyToolResultHook(session, call.id, tool, input, result);
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
        ...(result.spilled ? { spilled: result.spilled } : {}),
      });
      this.emit({ type: "tool_finished", sessionId: session.id, callId: call.id, ok: result.ok });
      return;
    }

    // 审阅记录：写/改文件前先捕获 before（读不到就跳过这次记录）；跨文件 multi_edit 逐文件记录
    const reviewCaptures =
      tool === "write_file" || tool === "edit_file" || tool === "multi_edit"
        ? await captureBeforeAll(session.cwd, tool, input, allowOutsideWorkspace)
        : [];
    // 审阅面板按实际工具标记：删除/移动单独展示，批量编辑归入 edit_file
    const reviewOperation = fileChangeOperation(tool);
    // 快照打点（写前）：state 记下「磁盘此刻」；写失败时 noteAfter 不会被调用，state 保持 before
    const snapshotTargets: SnapshotTarget[] = reviewCaptures.map((capture) => ({
      path: capture.target,
      file: capture.file,
    }));
    await this.snapshotFor(session)?.noteBefore(snapshotTargets);

    const execStartedAt = Date.now();
    this.fireHook(
      "tool_execution_start",
      {
        hook: "tool_execution_start",
        ...this.hookScopeFields(session),
        sessionId: session.id,
        callId: call.id,
        tool,
        input: hookInput(input),
        startedAt: execStartedAt,
      },
      session,
      this.turnAbort?.signal,
    );
    const webTools = this.webToolsForTurn(session);
    let result = await this.runToolWithSandboxEscape(
      session,
      call,
      tool,
      input,
      turnId,
      (sandbox) =>
        executeTool(tool, input, session.cwd, {
          allowOutsideWorkspace,
          signal: this.turnAbort?.signal,
          vision: this.toolVisionEnabled(),
          pdfDocuments: this.toolPdfEnabled(),
          shrinkImage: this.imageShrinker(),
          jobs: this.jobManager,
          // 批量读复用已读区间：整份读过的文件只回一行占位
          readCoverage: (target) =>
            this.loopGuard.fullyCovered(session.cwd, messages, target, allowOutsideWorkspace),
          // run_code 的 meow.write/edit/multiEdit/run 走宿主审批链（同一次调用内可多次触发）
          hostToolBridge: (bridgeTool, bridgeArgs) =>
            this.runCodeHostTool(session, call.id, bridgeTool, bridgeArgs),
          ...(webTools.search ? { webSearch: webTools.search } : {}),
          ...(webTools.fetch ? { webFetch: webTools.fetch } : {}),
          sandbox,
        }),
    );
    // 旁路搜索请求的 token 用独立 roundId 上报：计入真实总量，但不覆盖主回合样本，
    // 也不带 cache 字段，因此不会污染前缀缓存命中率。落盘用独立 source，
    // 重启后会话累计仍能对上，同时 lastChatUsage 不会把它当上下文锚点。
    if (result.usage) {
      const sideProvider = this.activeProviderOrNull();
      this.emitUsageSample(session, `tool:${call.id}`, result.usage, "web_search");
      await session.appendUsage({
        ...result.usage,
        source: "web_search",
        ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
        ...(sideProvider ? { providerId: sideProvider.id, model: sideProvider.model } : {}),
      });
    }
    this.fireHook(
      "tool_execution_end",
      {
        hook: "tool_execution_end",
        ...this.hookScopeFields(session),
        sessionId: session.id,
        callId: call.id,
        tool,
        input: hookInput(input),
        output: result.output,
        ok: result.ok,
        durationMs: Date.now() - execStartedAt,
      },
      session,
      this.turnAbort?.signal,
    );
    // 插件 hook：tool_result（可改写 output/ok，链式累积）。
    result = await this.applyToolResultHook(session, call.id, tool, input, result);
    // 已读区间部分覆盖：只回未读过的尾部（执行便宜，重复正文才是成本）
    if (tool === "read_file" && result.ok && result.readRange && !result.images?.length) {
      const trimmed = await this.trimCoveredRead(
        session,
        messages,
        input,
        result.output,
        allowOutsideWorkspace,
      );
      if (trimmed) result = { ...result, output: trimmed };
    }
    // 写成功就标记：下一轮 @ 同一文件时不能再用"已读"占位（内容是旧的）
    if (result.ok) await this.noteMutatedPath(session, tool, input);
    // git 写操作后让 git 面板/胶囊立即刷新（HTTP 路由已有同样的广播）
    if (result.ok && tool === "git" && isMutatingGitAction(input)) {
      this.emit({ type: "git_changed", sessionId: session.id });
    }
    // 计划文档落盘成功：通知前端弹出「开始执行 / 调整计划」确认面板
    if (result.ok && planPaths) {
      this.emit({
        type: "plan_documented",
        sessionId: session.id,
        path: displayPath(session.cwd, planPaths[0]),
      });
    }
    if (result.ok && reviewCaptures.length) {
      await this.snapshotFor(session)?.noteAfter(snapshotTargets);
      for (const capture of reviewCaptures) {
        const diff = await buildFileChangeDiff(tool, input, capture);
        if (!diff) continue;
        await session.appendFileChange(capture.target, reviewOperation, diff);
        this.turnFileChanges.add(capture.target);
        const stats = countDiffStats(diff);
        this.recordTurnFileChange(capture.target, stats);
        this.emit({
          type: "file_changed",
          sessionId: session.id,
          callId: call.id,
          path: capture.target,
          operation: reviewOperation,
          ...stats,
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
    // 跨回合结果去重：同工具同参数同输出且旧结果仍可见 → 一行占位
    const deduped = this.loopGuard.dedupeRepeatedResult(
      tool,
      input,
      result.output,
      call.id,
      messages,
    );
    if (deduped) toolOutput = deduped;
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
      await this.rememberReadRange(
        session,
        call.id,
        input,
        result.readRange,
        allowOutsideWorkspace,
      );
    }
    // 批量读逐文件登记：之后 read_file 同一文件可以直接命中区间
    if (tool === "read_many" && result.ok && result.readRanges?.length) {
      for (const range of result.readRanges) {
        await this.rememberReadRangeAt(session, call.id, range.path, range, allowOutsideWorkspace);
      }
    }
    const truncated = result.truncated ?? toolOutput.length > 20000;
    this.emit({
      type: "tool_output",
      sessionId: session.id,
      callId: call.id,
      output: toolOutput,
      truncated,
      ...(result.images?.length ? { images: result.images } : {}),
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
      // 用户已中止回合：中止不算验证结果，不回灌任何反馈
      if (this.turnAbort?.signal.aborted) return null;
      const config = await loadVerifyConfig(session.cwd);
      const absoluteTargets = targets.map((target) =>
        path.isAbsolute(target) ? path.resolve(target) : path.resolve(session.cwd, target),
      );
      const hit = targets.some((target) =>
        config.include.includes(path.extname(target).replace(/^\./, "").toLowerCase()),
      );
      const verifyEnabled =
        config.include.length > 0 && config.commands.length > 0 && hit;

      // LSP 与命令式 verify 并行：单文件语义诊断快，tsc 仍负责跨文件破坏
      const lspPromise = (async () => {
        try {
          return await getLspManager().diagnose({
            cwd: session.cwd,
            files: absoluteTargets,
            signal: this.turnAbort?.signal,
            timeoutMs: 6_000,
          });
        } catch (error) {
          console.warn(
            `[meowcode] lsp diagnostics skipped: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return null;
        }
      })();
      const verifyPromise = verifyEnabled
        ? runVerification(config, session.cwd, this.turnAbort?.signal)
        : Promise.resolve(null);
      const [lspResult, verification] = await Promise.all([lspPromise, verifyPromise]);
      if (this.turnAbort?.signal.aborted) return null;

      const parts: string[] = [];
      let lspFeedback: string | null = null;
      if (lspResult?.diagnostics.length && this.lspFeedbackThisTurn < 2) {
        // verify 的 tsc 已报过的同一行不再重复回灌
        const seen = new Set<string>();
        for (const step of verification?.steps ?? []) {
          if (step.passed) continue;
          for (const diagnostic of parseTscErrors(step.output)) {
            seen.add(
              `${displayPath(session.cwd, diagnostic.file)}|${diagnostic.line}|${
                diagnostic.col
              }|${diagnostic.code}`,
            );
          }
        }
        lspFeedback = formatLspFeedback(
          lspResult,
          session.cwd,
          (diagnostic) =>
            !seen.has(
              `${displayPath(session.cwd, diagnostic.file)}|${diagnostic.line}|${
                diagnostic.column
              }|${diagnostic.code ?? ""}`,
            ),
        );
        if (lspFeedback) {
          this.lspFeedbackThisTurn += 1;
          parts.push(lspFeedback);
        }
      }

      if (verification?.ran && !verification.passed) {
        const failedIds = verification.steps
          .filter((step) => !step.passed)
          .map((step) => step.id)
          .join(", ");
        if (this.verifyFailuresThisTurn >= config.maxFeedbackPerTurn) {
          parts.push(
            [
              `--- auto-verify: ${failedIds} FAILED ---`,
              `Automatic fix-and-retry feedback is disabled for this turn (limit of ${config.maxFeedbackPerTurn} reached) to avoid an endless loop. Do NOT keep editing silently.`,
              "Finish your turn now and honestly tell the user that the changes do not pass verification, including the first error message.",
            ].join("\n"),
          );
        } else {
          this.verifyFailuresThisTurn += 1;
          if (verification.feedback) parts.push(verification.feedback);
        }
      }

      // verify 的 feedback 自带指令行；只有 LSP 单独命中时补一行
      if (lspFeedback && !verification?.feedback) {
        parts.push(
          "[Automatic verification feedback. Fix these errors in this turn before finishing.]",
        );
      }
      return parts.length ? parts.join("\n\n") : null;
    } catch (error) {
      console.warn(
        `[meowcode] post-write verification skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
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

  /**
   * 工具批次结束后注入所有待送达插话：落盘 + 追加进工作上下文，再广播 delivered。
   * 与 takeSteer 分开：这里一次送达一批，takeSteer 只用于无工具调用的收尾路径。
   */
  private async flushPendingSteers(
    session: SessionStore,
    messages: ChatMessage[],
  ): Promise<void> {
    while (this.pendingSteers.length) {
      const steer = this.pendingSteers.shift()!;
      await this.pushUserMessage(session, messages, steer.text);
      this.emit({
        type: "subagent_steer_delivered",
        sessionId: session.id,
        steerId: steer.id,
        text: steer.text,
      });
    }
  }

  /**
   * user 消息落盘并追加进工作上下文。turn_stop 拦截后续跑用：
   * 落盘保证重启/回放后续跑历史完整；与 pushToolMessage 同一套失败降级
   * （写盘失败只告警，内存照常带上，不能让模型觉得拦截理由没送达）。
   */
  private async pushUserMessage(
    session: SessionStore,
    messages: ChatMessage[],
    content: string,
  ): Promise<void> {
    const message: Extract<ChatMessage, { role: "user" }> = { role: "user", content };
    try {
      await session.appendMessage(message);
      await session.flush();
    } catch (error) {
      console.error(
        `[meowcode] failed to journal stop-hook message: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.emit({
        type: "error",
        sessionId: session.id,
        message: "Stop hook 的续跑指令写入会话记录失败，重启后该指令可能缺失。",
      });
    }
    messages.push(message);
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

  /**
   * 稳定系统提示 + 当前工作区规则；两者都放在消息开头，前缀可复用。模式指令走 in-history 尾注（ensureModeContext）。
   *
   * 返回值按会话缓存对象引用：Responses 增量链靠「消息对象引用相等」判断前缀可复用
   * （runtime 里 chain.sentRefs 的恒等检查），这里每次新建字面量会让链在每个用户回合
   * 开头失效、退回全量重发。内容不变就复用同一对象（codex 增量复用同纪律）；
   * 提示词/指令/会话任一变化即换新对象——内容反正变了，缓存本来就要重写。
   */
  private systemMessagesCache: {
    sessionId: string;
    prompt: string;
    instructions: string | null;
    messages: ChatMessage[];
  } | null = null;

  /** 语色只作用于用户可见的根/侧边 runtime；子 Agent 显式提示词必须保持机器契约中性。 */
  private get speechPersonaActive(): boolean {
    return !this.customSystemPrompt && this.speechStyle !== "normal";
  }

  private systemMessages(): ChatMessage[] {
    const prompt = this.effectiveSystemPrompt;
    const instructions = this.instructions ?? null;
    const sessionId = this.currentSession?.id ?? "";
    const cached = this.systemMessagesCache;
    if (
      cached &&
      cached.sessionId === sessionId &&
      cached.prompt === prompt &&
      cached.instructions === instructions
    ) {
      return cached.messages;
    }
    const system: ChatMessage = { role: "system", content: prompt };
    const instructionsMessage: ChatMessage | null = instructions
      ? { role: "system", content: instructions }
      : null;
    const messages: ChatMessage[] = instructionsMessage ? [system, instructionsMessage] : [system];
    this.systemMessagesCache = sessionId ? { sessionId, prompt, instructions, messages } : null;
    return messages;
  }

  /** MCP 工具注册完成前不发首个模型请求；10s 上限兜底 MCP 卡死（mcpReady 永远 resolve，race 只是保险）。 */
  private async awaitMcpReadyOnce(): Promise<void> {
    if (this.mcpWaited) return;
    this.mcpWaited = true;
    if (!this.mcpReady) return;
    await Promise.race([
      this.mcpReady,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10_000) as { unref?: () => void };
        timer.unref?.();
      }),
    ]);
  }

  /** 模式指令挂成 in-history 尾注：切换只追加、不改前缀；压缩后历史里找不到会重挂一条。 */
  private async ensureModeContext(session: SessionStore): Promise<void> {
    const mode = this.turnChatMode ?? this.chatMode;
    if (mode !== "plan" && mode !== "goal") return;
    const prefix = `${MODE_NOTE_PREFIX} ${mode}`;
    const visible = session.effectiveMessages.some(
      (message) => message.role === "user" && typeof message.content === "string" && message.content.startsWith(prefix),
    );
    if (visible) return;
    const prompt = mode === "plan" ? PLAN_MODE_PROMPT : GOAL_MODE_PROMPT;
    await session.appendContextNote(`${prefix} (supersedes earlier mode notes):\n${prompt}`);
  }

  /**
   * 语色改成 in-history 注记：以前它是第 3 条 system，运行中切换会改变 system 条数，
   * 让 tools 之后整段前缀失效（OpenAI 上更是整段 instructions 变）。注记只追加，
   * 切换代价是一条尾部写入，前缀保持字节不变。
   */
  private async ensureSpeechStyleContext(session: SessionStore): Promise<void> {
    const wanted = this.speechPersonaActive ? this.speechStyle : "normal";
    if (lastSpeechStyleFrom(session.effectiveMessages) === wanted) return;
    const body =
      speechStylePrompt(this.speechStyle) ??
      "Use plain, neutral wording. No persona, no verbal tics, no role-play.";
    await session.appendContextNote(
      `${SPEECH_STYLE_PREFIX} ${wanted} (supersedes earlier style notes; it outranks reply-format preferences):\n${body}`,
      "style",
    );
  }

  /** 历史里仍有生效中的语色注记：压缩摘要需要中和口癖，但子 Agent 的正常输出不受影响。 */
  private hasStyleNote(session: SessionStore): boolean {
    return lastSpeechStyleFrom(session.effectiveMessages) !== "normal";
  }

  /**
   * AGENTS.md / 规则快照：换会话或源文件变了才重读。
   *
   * 原来一个会话只读一次，会话内改 AGENTS.md 永远不生效——为了保前缀缓存，
   * 代价是「我明明改了规则它不听」。现在每回合一次 stat（mtime + size），
   * 变了才重载：重载本来就要换 system[1] 的字节，缓存该断就断；
   * 一次 stat 远比一个不受规则约束的回合便宜。
   */
  private async refreshInstructions(session: SessionStore): Promise<void> {
    const signature = this.injectInstructions
      ? await instructionSourceSignature(session.cwd)
      : "";
    if (this.instructionsSessionId === session.id && this.instructionsSignature === signature) {
      return;
    }
    this.instructionsSessionId = session.id;
    this.instructionsSignature = signature;
    const detail = this.injectInstructions
      ? await loadWorkspaceInstructionsDetail(
          session.cwd,
          this.homeDir,
          {
            ...this.instructionSettings,
            // 记忆总开关优先：关闭时不注入记忆索引，但 AGENTS.md / 规则照常
            includeMemory: this.memoryEnabled,
          },
          this.builtinSkillsDir,
        )
      : undefined;
    this.instructions = detail?.text;
    this.instructionSkills = {
      tokens: detail?.skillIndex ? estimateTokens(detail.skillIndex) : 0,
      count: detail?.skillCount ?? 0,
    };
  }

  /** 设置页切换 AGENTS.md / CLAUDE.md 开关：清掉快照，下一轮重新读取。 */
  setInstructionSettings(settings: InstructionSettings): void {
    this.instructionSettings = { ...settings };
    this.invalidateInstructions();
  }

  /** 规则文件增删改后调用：下一轮重新读取 instructions，但不影响当前正在流式的一轮。 */
  invalidateInstructions(): void {
    this.instructionsSessionId = null;
    this.instructionsSignature = "";
    this.instructions = undefined;
    this.instructionSkills = { tokens: 0, count: 0 };
    this.systemMessagesCache = null;
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
   * 单条新 prompt 本身是否已经放不进当前模型窗口。
   * 历史可以交给压缩处理，但当前 user 回合不能被压缩，必须在入口就明确拒绝。
   */
  promptTooLarge(
    text: string,
    images?: ToolImage[],
    documents?: ToolDocument[],
  ): PromptTooLargeError | null {
    const provider = this.activeProviderOrNull();
    const window = provider?.contextWindow;
    if (!provider || !window || window <= 0) return null;
    const message: ChatMessage = {
      role: "user",
      content: text,
      ...(images?.length ? { images } : {}),
      ...(documents?.length ? { documents } : {}),
    };
    const inputTokens = estimateMessageTokens(message);
    const outputTokens = clampOutputTokens(provider, inputTokens);
    if (inputTokens + outputTokens + CONTEXT_SAFETY_TOKENS > window) {
      return new PromptTooLargeError(inputTokens, outputTokens, window);
    }
    return null;
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

  /** 当前 provider 是否有自己的搜索后端（决定 web_search 是否出现在工具表）。 */
  private webSearchSupported(): boolean {
    const provider = this.activeProviderOrNull();
    return provider !== null && createWebSearchBackend(provider) !== null;
  }

  /** 按当前 provider 构造本轮网页工具；web_fetch 本地始终可用。 */
  private webToolsForTurn(session: SessionStore): {
    search?: (query: string, signal?: AbortSignal) => Promise<WebSearchResult>;
    fetch?: (url: string, signal?: AbortSignal) => Promise<WebFetchOutcome>;
  } {
    const provider = this.activeProviderOrNull();
    if (!provider) return {};
    const backend = createWebSearchBackend(provider);
    const originalQuestion = this.lastUserQuestion(session);
    return {
      ...(backend
        ? {
            search: (query: string, signal?: AbortSignal) =>
              backend.search(query, { originalQuestion, maxResults: WEB_SEARCH_MAX_RESULTS }, signal),
          }
        : {}),
      fetch: (url: string, signal?: AbortSignal) => fetchWebPage(provider, url, signal),
    };
  }

  /** DeepSeek Search API 的 ori_question：最近一条真实用户文本（跳过合成/工具消息）。 */
  private lastUserQuestion(session: SessionStore): string | undefined {
    const messages = session.effectiveMessages;
    const index = lastRealUserMessageIndex(messages);
    if (index === -1) return undefined;
    const message = messages[index];
    return message.role === "user" && typeof message.content === "string"
      ? message.content
      : undefined;
  }

  private activeProvider(): ProviderConfig {
    const configured = this.providers.find((item) => item.id === this.providerId);
    // 配置里的激活项被停用时，引擎与 UI 一起落到第一个启用的模型
    const provider =
      configured && configured.enabled !== false
        ? configured
        : (this.providers.find((item) => item.enabled !== false) ?? configured ?? this.providers[0]);
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
  worktree?: SessionWorktree;
};


