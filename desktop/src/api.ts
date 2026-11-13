import { marked } from "marked";
import DOMPurify from "dompurify";
import type {
  MailAccountSavePayload,
  MailAccountSaveResult,
  MailAccountTestPayload,
  MailAccountTestResult,
  MailAccountsResult,
  MailAttachmentDownloadPayload,
  MailAttachmentDownloadResult,
  MailCounts,
  MailDeletePayload,
  MailDeleteResult,
  MailDraft,
  MailDraftSaveResult,
  MailDraftsListResult,
  MailEvent,
  MailListPayload,
  MailListResult,
  MailMessagePayload,
  MailMessageResult,
  MailOutboxListResult,
  MailOutboxResult,
  MailPickAttachmentsResult,
  MailSeenPayload,
  MailSendPayload,
  MailSendResult,
  MailSyncPayload,
  MailSyncResult,
} from "./mail/types";

export type SubagentStatus = "running" | "completed" | "failed" | "aborted" | "interrupted";

export type SubagentType =
  | "general"
  | "explore"
  | "planner"
  | "scoper"
  | "depth-prober"
  | "implementer"
  | "reviewer"
  | "verifier"
  | "fresh-verifier"
  | "juror"
  | "sweeper"
  | "goal-checker"
  | "custom";

export type UsageSummary = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export type SubagentSummary = {
  agentId: string;
  parentSessionId: string;
  callId: string;
  description: string;
  agentType?: SubagentType;
  background?: boolean;
  status: SubagentStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  error?: string;
  usage?: UsageSummary;
};

/** 会话模式（与工具审批模式互不干扰）：plan = 只写 plans/ 计划文档；goal = 围绕目标连续推进。 */
export type SessionMode = "default" | "plan" | "goal";

/** 主 Agent 档位（会话级）：标准 / 极简 / 复杂，定义见 src/agent/agent-profiles.ts */
export type AgentProfileId = "standard" | "minimal" | "complex";

/** 一个回合主对话消耗的 Token 汇总（历史回放与 turn_complete 共用） */
export type TurnUsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** input + output：悬停卡片里「使用 Token」的展示口径 */
  totalTokens: number;
};

export type MeowEvent = {
  type: string;
  /** 侧边聊天 runtime 的事件标记；主会话列表不显示它的运行圆点 */
  side?: boolean;
  /** 子 Agent 事件：发起它的父会话 / 子 Agent 标识 */
  agentId?: string;
  parentSessionId?: string;
  agentDescription?: string;
  /** subagent_started / subagent_completed：任务描述与完整提示 */
  description?: string;
  agentType?: SubagentType;
  background?: boolean;
  /** compaction_quality：压缩质量观测结算结果 */
  compactionId?: string;
  baselineCount?: number;
  rereadPaths?: string[];
  windowTurns?: number;
  report?: string;
  prompt?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  status?: SubagentStatus;
  usage?: UsageSummary;
  /** turn_complete：本回合主对话 Token 汇总 */
  turnUsage?: TurnUsageTotals;
  error?: string;
  /** turn_complete：本轮改过的文件（按路径聚合，含增删行数） */
  files?: TurnFileChangeStat[];
  /** turn_complete：本轮 id（同一回合重复投递时前端按它去重） */
  turnId?: string;
  /** turn_complete：该检查点是否带文件快照（false = 只能回滚对话，撤销按钮禁用） */
  canRewind?: boolean;
  /** tool_call_progress：已生成的工具调用数量/名字/参数字符数 */
  count?: number;
  names?: string[];
  chars?: number;
  /** 子 Agent 插话事件：本次插话的 id */
  steerId?: string;
  sessionId?: string;
  callId?: string;
  tool?: string;
  input?: unknown;
  output?: string;
  truncated?: boolean;
  /** 完整内容已落盘的相对路径 */
  spilled?: string;
  /** assistant_delta / message_complete：思考时长（毫秒） */
  thinkingMs?: number;
  ok?: boolean;
  delta?: string;
  text?: string;
  message?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** session_title 事件：AI 生成或手动设置后的会话标题 */
  title?: string;
  /** 思考过程全文（message_complete 时随事件带回） */
  reasoning?: string;
  /** plan_updated 事件：最新任务计划 */
  steps?: PlanStep[];
  explanation?: string;
  /** ask_user 事件：模型提出的澄清问题（可批量多题）与每题候选选项 */
  questions?: AskUserQuestion[];
  /** usage 事件：本轮模型调用的稳定 id（实时样本与最终真值共用，前端按 id 替换） */
  roundId?: string;
  /** usage 事件：true = 该轮最终真值 */
  final?: boolean;
  /** usage 事件：该轮被放弃（重试/中止），前端应撤回该样本 */
  retracted?: boolean;
  /** usage 事件：缓存读取的输入 token；未报告时不带 */
  cacheReadTokens?: number;
  /** usage 事件：写入缓存的输入 token（Anthropic 类协议）；未报告时不带 */
  cacheWriteTokens?: number;
  /** usage 事件：实际应答的模型名（cache-bust 检测按模型分基线） */
  model?: string;
  /** usage 事件：前缀缓存诊断状态 */
  cacheState?: "warm" | "cold" | "evicted" | "unsupported" | "unknown";
  /** usage 事件：状态变化原因；未变化时不带 */
  cacheReason?: string;
  /** message_start 事件：由排队消息启动的回合对应的排队项 id */
  queuedId?: string;
  /** approval_required 事件：写文件/改文件的预览差异 */
  diff?: string;
  /** approval_required 事件：明显危险的命令特征（仅提示） */
  risk?: { level: "medium" | "high"; categories?: string[]; reasons: string[] };
  /** approval_required 事件：审批期间文件被改动，diff 已重新生成 */
  stale?: boolean;
  /** approval_required / approval_resolved 事件：审批种类与 hook 命令详情 */
  kind?: "tool" | "hook";
  command?: string;
  hookEvent?: string;
  matcher?: string;
  /** approval_required / usage 事件：来源；usage 缺省 = 主对话 */
  source?: string;
  hookReason?: string;
  /** approval_required 事件：沙箱拒绝后的「沙箱外重试」审批 */
  sandboxEscape?: { command: string; detail: string };
  /** approval_resolved 事件：最终决定与来源 */
  approved?: boolean;
  by?: "user" | "hook" | "abort";
  /** file_changed 事件：Agent 改动的文件（工作区相对路径）与操作 */
  path?: string;
  /**
   * checkpoint_created：回合开始打的可回滚点（流式用户气泡据此挂回退入口）；
   * turn_complete：本轮起始检查点（编辑汇总卡片的「撤销」目标）。
   */
  checkpointId?: string;
  /** checkpoint_created 事件：该点是否有文件快照 */
  hasSnapshot?: boolean;
  operation?: "write_file" | "edit_file" | "delete_file" | "move_file";
  /** provider_switched 事件：切换前后的服务商 id 与原因（timeout/rate_limit/server） */
  from?: string;
  to?: string;
  reason?: string;
  /** session_mode 事件：切换后的会话模式 */
  mode?: SessionMode;
  /** agent_profile 事件：切换后的主 Agent 档位 */
  profile?: AgentProfileId;
  /** compaction_completed 事件：压缩生成的历史摘要 */
  summary?: string;
  /** 治理事件（workflow_admitted / workflow_roadmap） */
  tier?: "T0" | "T1" | "T2";
  taskShape?: string;
  completed?: boolean;
  lanes?: WorkflowLane[];
  /** workflow_gate 事件：gate 判定落账 */
  laneId?: string;
  gate?: "G4" | "G5" | "G6";
  verdict?: "pass" | "fail";
  /** child_result 事件：契约角色的宿主校验结论 */
  role?: SubagentType;
  result?: {
    status: string;
    valid: boolean;
    invalidReason?: string;
    summary: string;
    filesChangedCount: number;
    commandsCount: number;
    criticalFindings: number;
  };
};

/** 治理 roadmap 的单个 lane 快照（workflow_roadmap 事件 / 计划页签展示） */
export type WorkflowLane = {
  id: string;
  objective: string;
  status: string;
  gates?: Record<string, string>;
  dependsOn?: string[];
  repairCount?: number;
};

/** 治理 run 快照：admit 之后每次状态变化全量推送 */
export type WorkflowRoadmap = {
  tier: "T0" | "T1" | "T2";
  completed: boolean;
  lanes: WorkflowLane[];
};

/** 工具审批弹窗需要的字段（approval_required 事件 / GET /session.pendingApproval） */
export type ApprovalRequest = {
  callId: string;
  tool: string;
  input: unknown;
  diff?: string;
  risk?: { level: "medium" | "high"; categories?: string[]; reasons: string[] };
  /** 审批期间文件被改动，diff 已重新生成 */
  stale?: boolean;
  /** tool = 工具审批；hook = 每次询问模式下 hook 命令运行审批 */
  kind?: "tool" | "hook";
  /** hook 命令审批的展示字段 */
  command?: string;
  hookEvent?: string;
  matcher?: string;
  source?: string;
  /** PreToolUse hook 要求人工确认的原因 */
  hookReason?: string;
  /** 沙箱拒绝后的「沙箱外重试」审批 */
  sandboxEscape?: { command: string; detail: string };
};

/** 全局待审批：后台会话也在等，所以带 sessionId 供切回时恢复 */
export type PendingApproval = ApprovalRequest & {
  sessionId: string;
  /** 子 Agent 审批：sessionId 为父会话，这里标记来源 */
  parentSessionId?: string;
  agentId?: string;
  agentDescription?: string;
};

/** ask_user 的一题：options 为纯文本，descriptions 与 options 同下标（可为空串） */
export type AskUserQuestion = {
  question: string;
  options: string[];
  descriptions?: string[];
};

export type PlanStepStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type PlanStep = {
  title: string;
  status: PlanStepStatus;
};

export type PlanState = {
  steps: PlanStep[];
  explanation?: string;
};

/** 运行中排队等待发送的用户消息 */
export type QueuedPrompt = {
  id: string;
  text: string;
};

/** 会话时间线上的压缩点（可能是完成、失败或进程中断） */
export type CompactionPoint = {
  messageIndex: number;
  summary?: string;
  status: "completed" | "interrupted" | "failed";
};

/**
 * 压缩质量观测（GET /session/messages 的 compactionQuality）：
 * 压缩后窗口期内重复读了哪些「压缩前已读过」的文件 —— 摘要漏上下文的信号。
 */
export type CompactionQuality = {
  compactionId: string;
  baselineCount: number;
  rereadPaths: string[];
  windowTurns: number;
};

/** 单个文件的回合级改动统计（路径已聚合） */
export type TurnFileChangeStat = {
  /** 工作区相对路径 */
  path: string;
  added: number;
  removed: number;
};

/** GET /session/messages 的 turnChanges：历史回放按回合插回「已编辑 N 个文件」卡片 */
export type TurnFileChangeGroup = {
  turnId: string;
  /** 该回合结束时的消息下标（与 checkpoints 同口径） */
  messageIndex: number;
  /** 回合起始检查点（撤销目标） */
  checkpointId?: string;
  /** 检查点是否带文件快照 */
  canRewind: boolean;
  files: TurnFileChangeStat[];
};

/** GET /session/messages 的 turnDurations：历史回放按回合在末尾显示运行耗时 */
export type TurnDurationGroup = {
  turnId: string;
  /** 该回合结束时的消息下标（与 turnChanges 同口径） */
  messageIndex: number;
  /** 本回合总耗时（毫秒，墙钟） */
  durationMs: number;
  /** 回合收尾状态：中止/中断用中性样式，不标红 */
  status?: "completed" | "aborted" | "error" | "interrupted";
  /** 回合结束时间（ISO）：操作行的时间 chip */
  endedAt?: string;
  /** 本回合主对话 Token 汇总 */
  usage?: TurnUsageTotals;
};

/** 会话检查点（GET /session/messages 的 checkpoints 与 GET /session/checkpoints 共用） */
export type SessionCheckpoint = {
  id: string;
  timestamp: string;
  label?: string;
  auto: boolean;
  turnId?: string;
  fileChanges: string[];
  /** 检查点之前有多少条对话消息（时间线定位） */
  messageIndex: number;
  /** 文件快照引用；旧会话缺省 = 该点没有代码可回滚 */
  snapshot?: CheckpointSnapshotRef;
  /** = Boolean(snapshot)，前端免嵌套取值 */
  hasSnapshot: boolean;
  /** = snapshot?.count */
  fileCount: number;
};

/** 检查点文件快照引用（服务端只回 id/位置等展示信息，内容按需读） */
export type CheckpointSnapshotRef = {
  ownerId: string;
  file: string;
  count: number;
  bytes: number;
  cwd: string;
};

export type TurnStatus = "completed" | "aborted" | "error" | "interrupted";

/** 窗口/页签/面板/草稿等界面状态（主进程 ui-state.json） */
export type UiState = {
  version: number;
  inspector: { visible: boolean; width: number };
  tabs: Array<{
    id: string;
    kind:
      | "browser"
      | "workspace"
      | "review"
      | "sidechat"
      | "terminal"
      | "plan"
      | "subagent"
      | "subagents"
      | "plugin";
    title: string;
    url?: string;
    path?: string;
    /** 插件页签：插件 id（iframe 走 /plugin-ui/<id>/...） */
    pluginId?: string;
    /** 子 Agent 页签：按父会话分组恢复 */
    agentId?: string;
    parentSessionId?: string;
    callId?: string;
    description?: string;
  }>;
  activeTabId: string;
  drafts: Record<string, { text: string; updatedAt: string }>;
};

/** 当前会话的响应统计与会话累计用量（右侧「会话信息」）：null 表示还没有数据 */
export type TurnMetrics = {
  /** 会话累计输入 token */
  inputTokens: number | null;
  /** 会话累计命中缓存的输入 token */
  cacheReadTokens: number | null;
  /** 会话累计写入缓存的输入 token（Anthropic 类协议）；未报告时为 null */
  cacheWriteTokens: number | null;
  /** 会话累计输出 token */
  outputTokens: number | null;
  /** 最后一轮生成速度（output token / 秒） */
  tokensPerSecond: number | null;
  /** 本回合总耗时（毫秒，含工具调用） */
  responseMs: number | null;
  /** 首字延迟（毫秒，回合开始 → 首个流式增量） */
  firstTokenMs: number | null;
  /** 缓存命中率（0–1）：会话累计、随每次模型调用实时更新；服务商从未报告缓存明细时为 null */
  cacheHitRate: number | null;
};

/**
 * 单次模型调用的生成速度样本（右侧实时曲线）：按时间正序。
 * 历史样本由 /session/messages 的 usageSamples 恢复；流中样本用 roundId 原地替换。
 */
export type SpeedSample = {
  /** 流式样本的轮次 id；历史样本没有（同一轮已落盘，不会重复追加） */
  roundId?: string;
  /** 该次调用的生成速度（output token / 秒，首字之后计时） */
  tokensPerSecond: number;
};

/**
 * 前缀缓存诊断（usage 最终事件聚合）：ContextPopover 缓存行与 HomeTab 失配计数消费。
 * 对标 Claude Code /usage 的 miss 归因：把「自己造成的重建」与「外部造成的失配」分开看。
 */
export type CacheDiagnostics = {
  /** 最近一轮最终用量（弹层「本轮」行）；还没有最终样本时为 null */
  lastRound: { read: number | null; write: number | null } | null;
  /** 最近一次缓存状态与原因（服务端 classifyCache） */
  lastState: "warm" | "cold" | "evicted" | "unsupported" | "unknown" | null;
  lastReason: string | null;
  /** 疑似缓存失配次数：同模型相邻两轮命中读数显著跌落（isCacheBust） */
  busts: number;
  /** 最近一次失配的跌落量（token）；用于悬浮提示 */
  lastBustDrop: number | null;
  /** 缓存重建计数：最终轮状态非 warm 时按原因累加（first_request / idle_exceeded_ttl / …） */
  rebuilds: Record<string, number>;
};

/** 上下文占用的分类明细（token 数），五项之和 == usedTokens */
export type ContextBreakdown = {
  /** 系统提示词（稳定前缀） */
  system: number;
  /** 工具定义 */
  tools: number;
  /** 技能索引 */
  skills: number;
  /** 对话消息 */
  messages: number;
  /** 项目规则 / 记忆等其余注入 */
  other: number;
};

/** 与服务端一致：达到窗口 85% 时提示手动压缩。 */
export const CONTEXT_WARNING_RATIO = 0.85;

export function shouldRecommendCompaction(
  usedTokens: number,
  contextWindow: number | null,
): boolean {
  return Boolean(
    contextWindow && contextWindow > 0 && usedTokens / contextWindow >= CONTEXT_WARNING_RATIO,
  );
}

/** GET /session/context：当前会话的上下文占用 */
export type ContextUsage = {
  /** 当前模型的上下文窗口；未设置则为 null */
  contextWindow: number | null;
  usedTokens: number;
  /** "usage" = 服务商返回的真实 inputTokens；"estimate" = 本地估算（含工具定义） */
  source: "usage" | "estimate";
  /** 分类明细：真实用量下按估算比例摊分，加总恒等于 usedTokens */
  breakdown: ContextBreakdown;
  /** 发现的技能数量（「Skill（N个）」标签用）；老版本服务端可能不返回 */
  skillCount?: number;
  /** 对话消息的细分归因（纯估算）；老版本服务端可能不返回 */
  messageDetail?: {
    system: number;
    toolResults: Array<{ name: string; tokens: number }>;
    userText: number;
    assistantText: number;
    injected: number;
    media: number;
    other: number;
    total: number;
  } | null;
  /** 已到窗口 85%，建议用户手动压缩（自动压缩只在真实溢出时触发） */
  recommendedCompaction: boolean;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** 模型思考过程（会话存档里有就带上） */
  reasoning?: string;
  /** 思考时长（毫秒）：思考块右侧显示 */
  thinkingMs?: number;
  tool_call_id?: string;
  name?: string;
  tool_calls?: unknown[];
  /** 当轮内存里的附图（裸 base64；回放快照里没有，落盘图走 imageRefs） */
  images?: Array<{ data: string; mimeType: string }>;
  /** 落盘图片引用（回放快照附带）；经 window.meow.assetUrl() 转成可加载的 URL */
  imageRefs?: Array<{ file: string; mimeType: string }>;
};

export type SessionWorktree = {
  sourceCwd: string;
  repoRoot: string;
  path: string;
  branch: string;
  baseSha: string;
  createdAt: string;
};

export type CurrentSession = {
  id: string;
  cwd: string;
  /** 独立 worktree 元数据；普通会话为 null/缺省 */
  worktree?: SessionWorktree | null;
  title?: string | null;
  plan?: PlanState | null;
  /** 最近一次上下文压缩摘要；没有压缩过则为 null */
  compactionSummary?: string | null;
  /** "default" 是旧版持久化值，语义等于 "ask" */
  approvalMode?: "read-only" | "ask" | "auto" | "full" | "default";
  /** 会话模式：default 无附加行为；plan 只写 plans/；goal 围绕目标连续推进 */
  mode?: SessionMode;
  /** 主 Agent 档位：standard 完整 / minimal 极简 / complex 复杂 */
  agentProfile?: AgentProfileId;
  /** 当前生效的架构图 id：自定义架构（custom-*）优先，否则等于档位 */
  harnessArchitecture?: string;
  /** 上次进程退出时未交付的排队消息（只展示，不自动执行） */
  recoveredPrompts?: QueuedPrompt[];
  lastTurn?: { status: TurnStatus; error?: string } | null;
  /** 当前父会话派发过的子 Agent（含历史与运行中） */
  subagents?: SubagentSummary[];
};

export type SessionSummary = {
  id: string;
  filePath: string;
  cwd: string;
  createdAt: string;
  /** AI 生成或手动设置的会话标题；还没生成过则为 null */
  title: string | null;
  /** 会话里的消息条数；0 = 还没发过消息（新建未使用的会话，列表里不显示） */
  messageCount: number;
  /** 独立 worktree 元数据；侧栏归组与分支标识用 */
  worktree?: SessionWorktree | null;
};

/** 当前会话已修改文件（GET /session/changes?summary=1）：不含 diff，供输入框悬浮胶囊统计 */
export type SessionChangeSummary = {
  path: string;
  operation: "write_file" | "edit_file" | "delete_file" | "move_file";
  changeCount: number;
  added: number;
  removed: number;
  timestamp: string;
};

export async function getSessionChangesSummary(): Promise<{
  changes: SessionChangeSummary[];
}> {
  return api<{ changes: SessionChangeSummary[] }>("/session/changes?summary=1");
}

/** 会话全文检索单个命中片段；ranges 是相对 text 的命中偏移（前端切段高亮） */
export type SessionSearchSnippet = {
  text: string;
  ranges: Array<{ start: number; end: number }>;
  prefix: boolean;
  suffix: boolean;
  /** 命中消息在 messagesForClient 数组里的下标，跳转锚点用 */
  messageIndex: number;
  role: "user" | "assistant";
};

/** GET /sessions/search 的单会话命中 */
export type SessionSearchHit = {
  sessionId: string;
  filePath: string;
  title: string | null;
  cwd: string;
  createdAt: string;
  titleMatch: boolean;
  totalMatches: number;
  snippets: SessionSearchSnippet[];
};

export type SessionSearchResult = {
  query: string;
  hits: SessionSearchHit[];
  scanned: number;
  reindexed: number;
  /** 有会话正文超过索引上限被截断；命中可能不全 */
  truncated: boolean;
};

/** 会话全文检索（Ctrl+K）：纯本地子串匹配，不消耗模型 token */
export async function searchSessions(
  query: string,
  options: { limit?: number; workspace?: string | null } = {},
): Promise<SessionSearchResult> {
  const params = new URLSearchParams({ q: query });
  if (options.limit && options.limit > 0) params.set("limit", String(Math.floor(options.limit)));
  if (options.workspace) params.set("workspace", options.workspace);
  return api<SessionSearchResult>(`/sessions/search?${params.toString()}`);
}

/** 服务商 API 协议。三种都在后端有对应实现（见 src/agent/）。 */
export type ApiFormat = "anthropic-messages" | "openai-chat-completions" | "openai-responses";

export type InputModality = "text" | "image" | "pdf";

export type ThemePreference = "system" | "light" | "dark";
/**
 * 配色方案：与明暗模式正交。classic = 加入配色之前的中性观感（默认）。
 * 每套配色在深/浅下各有一套手调 token，见 theme/palettes.css。
 */
export type ThemePalette = "classic" | "lava" | "bee" | "mint" | "parchment" | "harmony";
export type CloseAction = "ask" | "tray" | "quit";
/** 用户可见回复的语色：普通（默认）/ 永雏塔菲 / 大嘴。 */
export type SpeechStyle = "normal" | "tafei" | "dazui";
/** 界面语言：跟随系统 + 11 个语种（词条见 desktop/src/i18n/locales）。 */
export type LanguagePreference =
  | "system"
  | "zh-CN"
  | "zh-TW"
  | "en"
  | "ja"
  | "ko"
  | "ru"
  | "de"
  | "fr"
  | "es"
  | "hi"
  | "pt";

/** 不重启 agent server 的轻量偏好（外观 / 关闭方式 / 语言 / 工作区 / 归档列表 / 侧栏项目）。 */
export type SshAuthType = "agent" | "key" | "password";

/** 设置 → 网页搜索与获取：搜索/抓取提供方选择（与 DSH 同口径，分别选择）。 */
export type WebSearchProviderPreference =
  | "auto"
  | "provider-native"
  | "deepseek-search-api"
  | "off";
export type WebFetchProviderPreference = "auto" | "http" | "deepseek-fetch-api";

export type WebOptionsPatch = {
  searchProvider?: WebSearchProviderPreference;
  fetchProvider?: WebFetchProviderPreference;
  sendOriginalQuestion?: boolean;
  /** 显式选择 DeepSeek 后端时可用；空串 = 清除 */
  deepseekApiKey?: string;
};

/** 设置 → 连接：一条 SSH 连接配置（密码不落盘，连接时在终端输入）。 */
export type SshConnection = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: SshAuthType;
  privateKeyPath?: string;
};

export type Preferences = {
  theme: ThemePreference;
  /** 配色方案：缺省视为 classic（轻量通道，不重启 server） */
  palette?: ThemePalette;
  closeAction: CloseAction;
  language?: LanguagePreference;
  /** 用户可见回复的语色：默认 normal；切换走轻量通道，不重启 server */
  speechStyle?: SpeechStyle;
  /** 输入框上方信息胶囊的收起时机：默认 commit（提交后消失） */
  progressPillDismiss?: ProgressPillDismiss;
  /** 下次新建会话的默认工作区；切换走轻量通道，不重启 server */
  workspace?: string;
  /** 首次启动引导是否已完成 */
  onboardingCompleted?: boolean;
  archivedSessions?: string[];
  /** 项目（工作区）自定义显示名：cwd → name */
  projectNames?: Record<string, string>;
  /** 置顶的项目 cwd 列表（顺序即置顶顺序） */
  pinnedProjects?: string[];
  /** 已移除（侧栏隐藏）的项目 cwd 列表 */
  removedProjects?: string[];
  /** 检查到新版本时后台静默下载（默认开；完成后导航栏左下角出现重启按钮） */
  silentUpdate?: boolean;
  /** 系统通知：回合结束 / 需要审批 / 被中断且窗口不在前台时提示（默认开） */
  notifications?: boolean;
  /** 标题栏公告：显示官方公告条（默认开） */
  announcements?: boolean;
  /** AI 悬浮岛：屏幕顶部胶囊显示所有运行中会话状态（默认关） */
  floatingIsland?: boolean;
  /** 输入建议：回合结束后额外请求一次，预测下一句（默认关） */
  nextPromptSuggestions?: boolean;
  /** 邮件「AI 写」使用的模型 id；空串 = 跟随聊天模型 */
  mailAiProviderId?: string;
  /** Worktrees：创建前先 fetch 上游更新（默认关） */
  worktreeFetchUpstream?: boolean;
  /** Worktrees：自动清理旧 worktree（默认开） */
  worktreeAutoCleanup?: boolean;
  /** Worktrees：自动清理的数量上限（默认 15） */
  worktreeMaxKeep?: number;
  /** Worktrees：自定义根目录；空串 = 默认 userData/agent/worktrees */
  worktreeRoot?: string;
  /** Worktrees：手动删除托管工作树前先确认（默认开） */
  worktreeConfirmDelete?: boolean;
  /** 设置 → 连接：SSH 连接列表 */
  sshConnections?: SshConnection[];
  /** 设置 → 网页搜索与获取：搜索提供方（auto = 跟随当前模型） */
  webSearchProvider?: WebSearchProviderPreference;
  /** 设置 → 网页搜索与获取：抓取提供方 */
  webFetchProvider?: WebFetchProviderPreference;
  /** DeepSeek Search API 是否附带最近一条用户提问（默认开） */
  webSearchSendOriginalQuestion?: boolean;
  /** DeepSeek Search / Fetch API 的独立密钥（写入时加密；空串 = 清除） */
  webDeepseekApiKey?: string;
  /** 是否已保存 DeepSeek 网页工具密钥（只读回执） */
  hasWebDeepseekApiKey?: boolean;
  /** 每个主 Agent 档位的并行子 Agent 上限（1..10；缺省用档位内置值） */
  agentProfileLimits?: Partial<Record<"standard" | "minimal" | "complex", number>>;
  /** 会话回滚：文件快照开关（默认开；改后重启应用生效） */
  rewindSnapshots?: boolean;
  /** 会话回滚：每会话保留的快照索引数滑窗（默认 120） */
  rewindKeepCheckpoints?: number;
  /** 会话回滚：单个快照目录总容量上限 MB（默认 512） */
  rewindMaxTotalMb?: number;
  /** 将 AGENTS.md 包含在上下文中（默认开） */
  includeAgentsMd?: boolean;
  /** 将 CLAUDE.md / CLAUDE.local.md 包含在上下文中（默认开） */
  includeClaudeMd?: boolean;
  /** 界面字体：空串或缺省 = 默认 MiSans */
  fontFamily?: string;
  /** 代码字体（等宽表面）：空串或缺省 = 默认等宽栈 */
  codeFontFamily?: string;
  /** 网络代理模式：direct = 直连（默认） */
  proxyMode?: ProxyMode;
  /** manual 模式下的代理地址，如 http://127.0.0.1:7890 */
  proxyUrl?: string;
  /**
   * 插件 UI 授权记忆（按插件 id 合并）：启用插件时弹授权，批准走轻量通道。
   * 不能走 saveSettings —— 那条路会重启 agent server，把运行中的回合直接杀掉。
   */
  pluginApprovals?: Record<
    string,
    { version: string; permissions: PluginPermission[]; approvedAt: string; declined?: boolean }
  >;
};

export type ProxyMode = "direct" | "system" | "manual";

/**
 * 输入框上方信息胶囊（步骤 x/y · n 个文件已修改）的收起时机：
 * - commit：工作区还有未提交改动就一直显示，提交后自动收起（默认，旧行为）
 * - turn-end：回合结束就收起，且下一轮要等新的步骤或改动才重新出现
 */
export type ProgressPillDismiss = "commit" | "turn-end";

export type ProxyConfig = { mode: ProxyMode; url: string };

export type AppInfo = {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
};

/** 更新包（release 资产） */
export type UpdateAsset = {
  name: string;
  /** 下载地址（已把不可达的 test.gitcode.net 换成主站） */
  url: string;
  size: number;
};

/** GitCode release 信息（更新检查用） */
export type UpdateInfo = {
  version: string;
  name: string;
  /** 发布页地址（由仓库 + tag 拼出） */
  url: string;
  publishedAt: string;
  notes: string;
  /** 这次发布的全部附件 */
  assets?: UpdateAsset[];
  /** 当前平台可用的安装包（没有说明这次发布没带安装包） */
  asset?: UpdateAsset | null;
};

export type UpdateCheckResult =
  | { ok: true; current: string; latest: UpdateInfo; hasUpdate: boolean }
  | { ok: false; current: string; error: string };

/**
 * 检查更新：走主进程拉 GitCode releases。
 * 渲染进程直连 api.gitcode.com 会被 CORS 拦（file:// 源），所以必须绕 IPC。
 */
export async function checkForUpdates(): Promise<UpdateCheckResult> {
  return window.meow.checkUpdate();
}

/** 已导入的自定义字体（外观设置用） */
export async function listCustomFonts(): Promise<Array<{ family: string; url: string }>> {
  return window.meow.listCustomFonts();
}

/** 弹系统对话框选一个字体文件导入；取消时返回 { ok:false, canceled:true } */
export async function importFontFile(): Promise<{ ok: boolean; canceled?: boolean; family?: string }> {
  return window.meow.importFont();
}

/** 下载更新包：主进程流式下载，进度通过 onUpdateProgress 回调 */
export async function downloadUpdate(payload: {
  url: string;
  fileName: string;
}): Promise<{ path: string; size: number }> {
  return window.meow.downloadUpdate(payload);
}

/** 打开已下载的安装包：Windows 会顺带退出应用（安装包要覆盖运行中的文件） */
export async function openInstaller(filePath: string): Promise<{ launched: boolean; quit: boolean }> {
  return window.meow.openInstaller(filePath);
}

export type UpdateProgress = { received: number; total: number; percent: number };

/** 订阅下载进度，返回取消订阅函数 */
export function onUpdateProgress(listener: (progress: UpdateProgress) => void): () => void {
  return window.meow.onUpdateProgress(listener);
}

export type ProviderSettings = {
  id: string;
  /** 服务商显示名（来自目录，如 "DeepSeek"）→ 模型表「服务商」列 */
  name: string;
  /** 根地址；路径由协议实现追加，不自动补 */
  baseUrl: string;
  model: string;
  /** 模型显示名；空则回落 model */
  displayName?: string;
  protocol?: ApiFormat;
  /** 目录条目 id，用于取图标 */
  templateId?: string;
  apiKey?: string;
  hasApiKey?: boolean;
  /** 仅保存时使用：新加的模型条目从该服务商已有条目继承密钥，主进程写完即丢弃 */
  apiKeySourceId?: string;
  /** 上下文窗口（token 数） */
  contextWindow?: number;
  /** 单次最大输出 token 数 */
  maxTokens?: number;
  inputModalities?: InputModality[];
  /** 思考强度：undefined/"" 表示服务商默认，其余下发为 reasoning_effort */
  reasoningEffort?: string;
  /** 显式思考预算（thinking.budget_tokens）；留空则按思考强度档位推导 */
  thinkingBudget?: number;
  /**
   * 前缀缓存 TTL：5m（默认，不发字段）/ 1h（Anthropic 显式长 TTL）/
   * auto（按会话节奏：人驱动 1h、子代理与批量 5m，且只在实测支持 1h 的端点上真的发）
   */
  cacheTtl?: "5m" | "1h" | "auto";
  /**
   * 鉴权头风格。缺省按协议传统（Anthropic 系 x-api-key / OpenAI 系 Bearer）。
   * Azure OpenAI 选 "api-key"；Bedrock API key 选 "bedrock-api-key"；
   * 本地推理框架或鉴权全靠额外请求头时选 "none"。
   */
  authStyle?: "bearer" | "api-key" | "bedrock-api-key" | "none";
  /** 额外请求头，原样合并（同名覆盖内置头） */
  extraHeaders?: Record<string, string>;
  /** 额外请求体字段，展开合并进请求体顶层（Qwen enable_thinking / vLLM chat_template_kwargs 等） */
  extraBody?: Record<string, unknown>;
  /** 思考摘要档位（Responses）；缺省 none = 不下发 */
  reasoningSummary?: "none" | "auto" | "concise" | "detailed";
  /** 故障转移链（provider id，按顺序）；留空 = 自动链（其余 enabled 项，最多 2 跳） */
  fallbackIds?: string[];
  /** 该模型可选的思考档位；空则用 effort.ts 的按模型默认表 */
  reasoningLevels?: string[];
  /**
   * 服务端原生压缩开关：undefined = 自动（官方 Anthropic / OpenAI Responses 启用），
   * true = 兼容网关上强制尝试，false = 只用本地摘要。
   */
  nativeCompaction?: boolean;
  /** 是否出现在输入框的模型列表里 */
  enabled?: boolean;
};

export type GithubAuthStatus = {
  connected: boolean;
  expiresAt?: string;
  scope?: string;
};

export type GithubDeviceFlow = {
  flowId: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

export type GithubDeviceStartResult =
  | { ok: true; flow: GithubDeviceFlow }
  | { ok: false; message: string };

export type GithubDevicePollResult =
  | { status: "pending" }
  | { status: "slow_down"; interval: number }
  | { status: "success"; auth: GithubAuthStatus; warning?: string }
  | { status: "error"; message: string };

export type SandboxSettings = {
  enabled: boolean;
  mode: "workspace-write";
  /** 工作区之外的额外可写根（绝对路径） */
  writableRoots: string[];
  allowTemp: boolean;
  grantTimeoutMs: number;
  /** 工作区写入模式下，删除命令是否需要人工确认 */
  confirmDelete: boolean;
};

export type SandboxStatus = SandboxSettings & {
  platform: string;
  supported: boolean;
  workspace: string;
  /** PUT 开启时服务器顺带完成的首次授权耗时 */
  probeDurationMs?: number;
};

export type SandboxProbeResult = {
  ok: boolean;
  backend?: "windows-acl";
  workspace?: string;
  durationMs: number;
  detail?: string;
};

export type SandboxRevokeResult = {
  ok: boolean;
  revoked?: boolean;
  durationMs: number;
  detail?: string;
};

export type Settings = {
  workspace?: string;
  providerId?: string;
  providers?: ProviderSettings[];
  theme?: ThemePreference;
  /** 配色方案：缺省视为 classic */
  palette?: ThemePalette;
  closeAction?: CloseAction;
  language?: LanguagePreference;
  /** 用户可见回复的语色：默认 normal */
  speechStyle?: SpeechStyle;
  /** 输入框上方信息胶囊的收起时机：commit = 提交后消失 / turn-end = 对话结束后消失 */
  progressPillDismiss?: ProgressPillDismiss;
  /** 网络代理模式：direct / system / manual */
  proxyMode?: ProxyMode;
  /** manual 模式下的代理地址 */
  proxyUrl?: string;
  /** 首次启动引导是否已完成 */
  onboardingCompleted?: boolean;
  /** 归档的会话文件路径列表（settings.json 持久化，聊天列表里隐藏） */
  archivedSessions?: string[];
  /** 项目（工作区）自定义显示名：cwd → name */
  projectNames?: Record<string, string>;
  /** 置顶的项目 cwd 列表（顺序即置顶顺序） */
  pinnedProjects?: string[];
  /** 已移除（侧栏隐藏）的项目 cwd 列表 */
  removedProjects?: string[];
  /** 插件启停：禁用的插件 id 列表（全局） */
  plugins?: {
    disabled?: string[];
    /** 插件 UI 首次授权记录：按插件 id 存版本、权限与拒绝标记 */
    approvals?: Record<
      string,
      { version: string; permissions: PluginPermission[]; approvedAt: string; declined?: boolean }
    >;
  };
  /** 会话回滚：文件快照开关（默认开；改后重启 agent server 生效） */
  rewindSnapshots?: boolean;
  /** 会话回滚：每会话保留的快照索引数滑窗（默认 120） */
  rewindKeepCheckpoints?: number;
  /** 会话回滚：单个快照目录总容量上限 MB（默认 512） */
  rewindMaxTotalMb?: number;
  /** Claude Code hooks：运行方式与工作区配置范围（写盘后重启 agent server 生效） */
  hooks?: { runMode?: "auto" | "ask"; includeWorkspace?: boolean };
  /** GitHub MCP 的 OAuth 连接状态（不含 token） */
  githubAuth?: GithubAuthStatus;
  /** 已保存的 Gitee/GitCode MCP Token 对应的 env 名（不含 token） */
  mcpCredentialKeys?: string[];
  /** Gitee/GitCode OAuth 连接状态（不含 token/secret） */
  oauthStatus?: Record<OauthPlatform, OauthPlatformStatus>;
  /** 检查到新版本时后台静默下载（缺省视为开启） */
  silentUpdate?: boolean;
  /** 系统通知：回合结束 / 需要审批 / 被中断且窗口不在前台时提示（缺省视为开启） */
  notifications?: boolean;
  /** 标题栏公告：显示官方公告条（缺省视为开启） */
  announcements?: boolean;
  /** AI 悬浮岛：屏幕顶部胶囊显示所有运行中会话状态（默认关） */
  floatingIsland?: boolean;
  /** 输入建议：回合结束后额外请求一次，预测下一句（默认关） */
  nextPromptSuggestions?: boolean;
  /** 邮件「AI 写」使用的模型 id；空串 = 跟随聊天模型 */
  mailAiProviderId?: string;
  /** Worktrees：创建前先 fetch 上游更新（默认关） */
  worktreeFetchUpstream?: boolean;
  /** Worktrees：自动清理旧 worktree（默认开） */
  worktreeAutoCleanup?: boolean;
  /** Worktrees：自动清理的数量上限（默认 15） */
  worktreeMaxKeep?: number;
  /** Worktrees：自定义根目录；空串 = 默认位置 */
  worktreeRoot?: string;
  /** Worktrees：手动删除托管工作树前先确认（默认开） */
  worktreeConfirmDelete?: boolean;
  /** 设置 → 连接：SSH 连接列表 */
  sshConnections?: SshConnection[];
  /** 设置 → 网页搜索与获取：搜索提供方 */
  webSearchProvider?: WebSearchProviderPreference;
  /** 设置 → 网页搜索与获取：抓取提供方 */
  webFetchProvider?: WebFetchProviderPreference;
  /** DeepSeek Search API 是否附带原问题 */
  webSearchSendOriginalQuestion?: boolean;
  /** 是否已保存 DeepSeek 网页工具密钥（不回显明文） */
  hasWebDeepseekApiKey?: boolean;
  /** 每个主 Agent 档位的并行子 Agent 上限 */
  agentProfileLimits?: Partial<Record<"standard" | "minimal" | "complex", number>>;
  /** 将 AGENTS.md 包含在上下文中（默认开） */
  includeAgentsMd?: boolean;
  /** 将 CLAUDE.md / CLAUDE.local.md 包含在上下文中（默认开） */
  includeClaudeMd?: boolean;
  /** 界面字体：空串或缺省 = 默认 MiSans */
  fontFamily?: string;
  /** 代码字体（等宽表面）：空串或缺省 = 默认等宽栈 */
  codeFontFamily?: string;
  /** 命令沙箱：Windows 受限令牌 + ACL 写隔离（默认关闭） */
  sandbox?: SandboxSettings;
};

export type SetMcpCredentialsResult = {
  ok: boolean;
  message?: string;
  warning?: string;
};

export type OauthPlatform = "gitee" | "gitcode" | "gitcode-community" | "undermind";

export const MCP_ENV_PLATFORMS: Record<string, OauthPlatform> = {
  MEOWCODE_GITEE_TOKEN: "gitee",
  MEOWCODE_UNDERMIND_TOKEN: "undermind",
  MEOWCODE_GITCODE_TOKEN: "gitcode",
};

export const MCP_PLATFORM_LABELS: Record<OauthPlatform, string> = {
  gitee: "Gitee",
  gitcode: "GitCode",
  "gitcode-community": "GitCode 社区", // i18n-allow 平台品牌名，按厂商官方叫法原样展示
  undermind: "Undermind",
};

export type OauthPlatformStatus = {
  configured: boolean;
  connected: boolean;
  /** 生效的 Client ID（内置官方应用，或用户自建应用） */
  clientId?: string;
  /** 本地回跳地址：需要在平台 OAuth 应用里登记 */
  redirectUri?: string;
  /** Client ID 来自内置应用（用户没自建应用） */
  builtinClientId?: boolean;
  /** 还差一次 Client Secret 才能发起授权 */
  needsClientSecret?: boolean;
  /** Secret 来源：设置页保存 / 环境变量 / 本机 oauth-apps.json / 内置应用 */
  secretSource?: "settings" | "env" | "file" | "builtin" | "";
  expiresAt?: string;
};

export type OauthSaveAppPayload = {
  platform: OauthPlatform;
  /** 留空则使用内置应用的 Client ID */
  clientId?: string;
  clientSecret: string;
};

/** 凭据自检结果：credentials-ok = ID/Secret 配对正确；mismatch = 平台不认这对其 */
export type OauthVerifyResult = {
  ok: boolean;
  verdict: "credentials-ok" | "mismatch" | "incomplete" | "unknown";
  message: string;
};

export type OauthConnectStartResult =
  | { ok: true; authorizeUrl: string }
  | { ok: false; message: string; needsClientSecret?: boolean };

export type OauthConnectPollResult =
  | { status: "pending" }
  | { status: "success"; warning?: string }
  | { status: "error"; message: string };

// ---- 插件系统（/plugins 路由）----

export type PluginSource = "project" | "user" | "builtin";

export type PluginPermission =
  | "tools"
  | "hooks"
  | "commands"
  | "storage"
  | "rpc"
  | "ui"
  | "prompt";

export type PluginManifestView = {
  id: string;
  name?: string;
  version: string;
  apiVersion: 2;
  permissions: PluginPermission[];
  engines?: { meowcode?: string };
};

export type PluginDescriptor = {
  id: string;
  path: string;
  source: PluginSource;
  enabled: boolean;
  /** 加载失败 / 被遮蔽等原因（红字展示） */
  error?: string;
  toolNames?: string[];
  commandNames?: string[];
  hookEvents?: string[];
  /** 内置插件显示名（builtin 元数据；其他来源缺省，UI 回落 id） */
  displayName?: string;
  /** 内置插件介绍（其他来源缺省，UI 回落市场条目描述） */
  description?: string;
  /** 内置插件图标 dataUrl（其他来源缺省，UI 回落市场图标表） */
  iconUrl?: string;
  version?: string;
  manifest?: PluginManifestView;
  /** AI 创作工具创建的插件：渲染层免二次授权 */
  aiAuthored?: boolean;
  /**
   * 插件自带界面：panel（`ui/index.html` iframe）与 client（`ui/client.js` 槽位脚本）。
   * 渲染层统一通过 `/plugin-ui/<id>/...` 取资源。
   */
  ui?: {
    panel?: { title: string; entry: string };
    client?: { entry: string; permissions: PluginPermission[] };
  };
};

export type McpServerState = {
  /** needs_auth：远程 server 回 401，等用户点「授权」；不是故障 */
  status: "connecting" | "ready" | "failed" | "unconfigured" | "needs_auth";
  toolCount: number;
  error?: string;
  /** unconfigured 时缺的 ${VAR} 名单 */
  missingEnv?: string[];
};

export type PluginsOverview = {
  plugins: PluginDescriptor[];
  errors: Array<{ path: string; error: string }>;
  mcp: Record<string, McpServerState>;
  mcpErrors: string[];
  commands: Array<{ name: string; description?: string; source: string }>;
};

export async function listPlugins(): Promise<PluginsOverview> {
  return api<PluginsOverview>("/plugins");
}

/** 插件 UI → host 的命名空间 RPC；host 抛错时转成异常，调用方按插件错误展示。 */
export async function pluginRpc<T = unknown>(
  pluginId: string,
  method: string,
  args?: unknown,
  sessionId?: string,
): Promise<T> {
  const response = await api<{ ok: boolean; result?: T; error?: string }>(
    `/plugins/${encodeURIComponent(pluginId)}/rpc`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, args, ...(sessionId ? { sessionId } : {}) }),
    },
  );
  if (!response.ok) throw new Error(response.error ?? "plugin rpc failed");
  return response.result as T;
}

export async function pluginStorageGet<T = unknown>(
  pluginId: string,
  key: string,
): Promise<T | undefined> {
  const response = await api<{ ok: boolean; value?: T }>(
    `/plugins/${encodeURIComponent(pluginId)}/storage?key=${encodeURIComponent(key)}`,
  );
  return response.value;
}

export async function pluginStorageSet(
  pluginId: string,
  key: string,
  value: unknown,
): Promise<void> {
  await api(`/plugins/${encodeURIComponent(pluginId)}/storage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
}

export async function pluginStorageDelete(pluginId: string, key: string): Promise<void> {
  await api(`/plugins/${encodeURIComponent(pluginId)}/storage?key=${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
}

/** 渲染层插件脚本加载/渲染失败：只上报，不阻断其他插件。 */
export async function reportPluginUiError(
  pluginId: string,
  message: string,
  slot?: string,
): Promise<void> {
  await api(`/plugins/${encodeURIComponent(pluginId)}/ui-error`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, ...(slot ? { slot } : {}) }),
  }).catch(() => undefined);
}

export type InstalledSkill = {
  /** 技能目录名（市场图标 key：skill:<id>） */
  id: string;
  /** frontmatter 里的技能名 */
  name: string;
  description: string;
  source: "project" | "user" | "builtin";
  /** 技能目录里的 icon.svg / icon.png（data URL；缺省走字母兜底） */
  iconUrl?: string;
};

export async function listSkills(workspace?: string): Promise<InstalledSkill[]> {
  const query = workspace ? `?cwd=${encodeURIComponent(workspace)}` : "";
  const result = await api<{ skills: InstalledSkill[] }>(`/skills${query}`);
  return result.skills ?? [];
}

export async function reloadPlugins(): Promise<PluginsOverview> {
  return api<PluginsOverview>("/plugins/reload", { method: "POST" });
}

/** 插件启停：写 settings.plugins.disabled 后热更新运行中的 server（不重启，不中断对话） */
export async function setPluginsState(disabled: string[]): Promise<Settings> {
  return window.meow.setPluginsState({ disabled }) as Promise<Settings>;
}

// ---- Claude Code hooks（设置页只读摘要）----

export type HooksLayer = "user" | "project" | "local";
export type HooksRunMode = "auto" | "ask";

export type HooksConfig = {
  enabled: boolean;
  error?: string;
  runMode: HooksRunMode;
  scope: { user: boolean; workspace: boolean };
  files: Array<{
    layer: HooksLayer;
    path: string;
    exists: boolean;
    error?: string;
    excluded: boolean;
    commands: number;
  }>;
  events: Array<{
    event: string;
    commands: Array<{
      event: string;
      layer: HooksLayer;
      source: string;
      matcher?: string;
      command: string;
      timeout: number;
      excluded: boolean;
    }>;
  }>;
  totalCommands: number;
  unsupportedEvents: Array<{ event: string; count: number }>;
};

export async function getHooksConfig(): Promise<HooksConfig> {
  return api<HooksConfig>("/hooks/config");
}

export type HooksSettingsInput = {
  enabled: boolean;
  runMode: HooksRunMode;
  includeWorkspace: boolean;
};

/** 保存 hooks 启停/范围/运行方式：主进程写 settings 后重启 agent server */
export async function saveHooksSettings(input: HooksSettingsInput): Promise<Settings> {
  return window.meow.saveHooksSettings(input) as Promise<Settings>;
}

export type OpenHooksFileResult = {
  ok: boolean;
  path?: string;
  missing?: boolean;
  error?: string;
};

/** 打开 ~/.claude 或工作区 .claude 的配置文件（路径由主进程解析） */
export async function openHooksFile(layer: HooksLayer): Promise<OpenHooksFileResult> {
  return window.meow.openHooksFile(layer) as Promise<OpenHooksFileResult>;
}

// ---- 数据导入（/import 路由，设置页「数据导入」）----

export type ImportAppId = "qoder" | "qoderintl" | "workbuddy" | "workbuddyai" | "zcode" | "opencode" | "dsh" | "codex";
export type ImportGroupId = "mcp" | "memory" | "skills" | "tasks";

export type ImportSource = {
  appId: ImportAppId;
  detected: boolean;
  groups: Array<{ id: ImportGroupId; count: number }>;
};

export type ImportPlanItem = {
  group: ImportGroupId;
  name: string;
  key?: string;
};

export type ImportItemResult = { status: "imported" | "skipped" | "failed"; reason?: string };

export async function getImportSources(): Promise<ImportSource[]> {
  const result = await api<{ sources: ImportSource[] }>("/import/sources");
  return result.sources;
}

/** 列出待导入项：已存在（同名/同 key）的不会出现，客户端按返回顺序逐条驱动进度 */
export async function planDataImport(
  appId: ImportAppId,
  groups: ImportGroupId[],
): Promise<ImportPlanItem[]> {
  const result = await api<{ items: ImportPlanItem[] }>("/import/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appId, groups }),
  });
  return result.items;
}

export async function applyImportOne(
  appId: ImportAppId,
  item: ImportPlanItem,
): Promise<ImportItemResult> {
  return api<ImportItemResult>("/import/apply-one", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appId, group: item.group, name: item.name, key: item.key }),
  });
}

// ---- 记忆（/memory 路由，设置页「记忆」管理）----

export type MemoryScopeId = "user" | "project";

export type MemoryListItem = {
  name: string;
  description: string;
  /** frontmatter 里的创建日期（YYYY-MM-DD）；缺省为 null */
  created: string | null;
  /** 文件 mtime（ISO）；文件丢失为 null */
  mtime: string | null;
};

export async function listMemories(
  workspace?: string,
): Promise<{ user: MemoryListItem[]; project: MemoryListItem[] }> {
  const query = workspace ? `?cwd=${encodeURIComponent(workspace)}` : "";
  return api<{ user: MemoryListItem[]; project: MemoryListItem[] }>(`/memory${query}`);
}

export async function readMemoryFile(
  scope: MemoryScopeId,
  name: string,
  workspace?: string,
): Promise<{ content: string; created: string | null }> {
  const params = new URLSearchParams({ scope, name });
  if (workspace) params.set("cwd", workspace);
  return api<{ content: string; created: string | null }>(`/memory/file?${params.toString()}`);
}

/** 写入记忆文件原文（含 frontmatter）；服务端会同步 MEMORY.md 索引 */
export async function writeMemoryFile(
  scope: MemoryScopeId,
  name: string,
  content: string,
  workspace?: string,
): Promise<void> {
  await api("/memory/file", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope, name, content, ...(workspace ? { cwd: workspace } : {}) }),
  });
}

export async function deleteMemoryFile(
  scope: MemoryScopeId,
  name: string,
  workspace?: string,
): Promise<void> {
  const params = new URLSearchParams({ scope, name });
  if (workspace) params.set("cwd", workspace);
  await api(`/memory/file?${params.toString()}`, { method: "DELETE" });
}

/** 清空某一层记忆（user / project）；返回清掉的条目数。 */
export async function clearAllMemories(
  scope: MemoryScopeId,
  workspace?: string,
): Promise<number> {
  const params = new URLSearchParams({ scope });
  if (workspace) params.set("cwd", workspace);
  const result = await api<{ cleared: number }>(`/memory?${params.toString()}`, {
    method: "DELETE",
  });
  return result.cleared;
}

/**
 * 记忆总开关（运行中实时生效；落盘走 saveProviderPrefs）。
 * 关闭后：不自动蒸馏、不注入记忆索引、不下发 memory_* 工具；
 * 记忆文件仍留在 ~/.meowcode/memory 与 .meowcode/memory，可用普通文件操作读取。
 */
export async function getMemoryEnabled(): Promise<{ enabled: boolean }> {
  return api<{ enabled: boolean }>("/config/memory");
}

export async function setMemoryEnabled(enabled: boolean): Promise<{ enabled: boolean }> {
  return api<{ enabled: boolean }>("/config/memory", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

/**
 * 供应商故障转移开关（默认关闭，运行中实时生效；落盘走 saveProviderPrefs）。
 * 开启后主服务商超时 / 限流 / 5xx 时，本回合自动切到链上的备用服务商。
 */
export async function getProviderFallback(): Promise<{ enabled: boolean }> {
  return api<{ enabled: boolean }>("/config/provider-fallback");
}

export async function setProviderFallback(enabled: boolean): Promise<{ enabled: boolean }> {
  return api<{ enabled: boolean }>("/config/provider-fallback", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

/** 每个主 Agent 的并行子 Agent 上限：运行中实时切换。 */
export async function setAgentLimits(
  limits: Partial<Record<"standard" | "minimal" | "complex", number>>,
): Promise<{ limits: Record<string, number> }> {
  return api("/config/agent-limits", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ limits }),
  });
}

/** 网页搜索与获取：运行中实时切换（搜索/抓取分别选择）。 */
export async function setWebOptions(patch: WebOptionsPatch): Promise<{
  searchProvider: WebSearchProviderPreference;
  fetchProvider: WebFetchProviderPreference;
  sendOriginalQuestion: boolean;
  hasDeepseekApiKey: boolean;
}> {
  return api("/config/web-options", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

// ---------------------------------------------------------------------------
// 自我学习
// ---------------------------------------------------------------------------

export type LearnedSkillItem = {
  name: string;
  description: string;
  status: "tentative" | "active" | "retired";
  created: string;
  revision: number;
  evidence: number;
  body: string;
  path: string;
  scope: "user" | "project";
};

export type LearnedTraitItem = {
  dimension: string;
  statement: string;
  confidence: number;
  evidence: string[];
  lastConfirmed: string;
  status: "tentative" | "active" | "retired";
  userStated?: boolean;
};

export type LearnedGuidelineItem = {
  id: string;
  text: string;
  trigger: Record<string, string>;
  status: "tentative" | "active" | "retired";
  confidence: number;
  created: string;
};

export type LearningLedgerEntry = {
  helped: number;
  hurt: number;
  applied: number;
  status: "tentative" | "active" | "retired";
  revision: number;
  lastOutcomeAt: string;
};

export type LearningSnapshot = {
  enabled: boolean;
  profile: LearnedTraitItem[];
  guidelines: LearnedGuidelineItem[];
  skills: LearnedSkillItem[];
  ledger: Record<string, LearningLedgerEntry>;
  journal: Array<{
    id: string;
    ts: string;
    action: string;
    scope: string;
    kind: string;
    name?: string;
    actor: string;
    reason?: string;
  }>;
  dailyCalls: { date: string; count: number };
};

export async function getLearning(): Promise<{ enabled: boolean }> {
  return api<{ enabled: boolean }>("/config/learning");
}

export async function setLearning(enabled: boolean): Promise<{ enabled: boolean }> {
  return api<{ enabled: boolean }>("/config/learning", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

/** 网络代理：运行中实时生效（下一次对外请求即走新代理，无需重启） */
export async function getProxy(): Promise<ProxyConfig> {
  return api<ProxyConfig>("/config/proxy");
}

export async function setProxy(config: ProxyConfig): Promise<ProxyConfig> {
  return api<ProxyConfig>("/config/proxy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(config),
  });
}

export async function getLearningSnapshot(): Promise<LearningSnapshot> {
  return api<LearningSnapshot>("/learning/items");
}

export async function manageLearnedSkill(
  action: "delete" | "reactivate" | "rollback",
  scope: "user" | "project",
  name: string,
): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>("/learning/skill", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, scope, name }),
  });
}

export async function consolidateLearning(): Promise<{ applied: string[] }> {
  return api<{ applied: string[] }>("/learning/consolidate", { method: "POST" });
}

/** 清除所有学到的（两层学习根全清，不可撤销） */
export async function clearLearning(): Promise<{ cleared: string[] }> {
  return api<{ cleared: string[] }>("/learning/clear", { method: "POST" });
}

export type InstructionSettings = {
  includeAgentsMd: boolean;
  includeClaudeMd: boolean;
};

/** AGENTS.md / CLAUDE.md 导入开关（运行中实时生效；落盘走 savePreferences） */
export async function getInstructionSettings(): Promise<InstructionSettings> {
  return api<InstructionSettings>("/config/instructions");
}

export async function setInstructionSettings(
  settings: Partial<InstructionSettings>,
): Promise<InstructionSettings> {
  return api<InstructionSettings>("/config/instructions", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings),
  });
}

// ---- 项目规则（/rules 路由，设置页「规则」管理）----

export type RuleSummary = {
  name: string;
  title: string;
  size: number;
  /** 文件 mtime（ISO）；文件丢失为 null */
  mtime: string | null;
};

export type RuleRecord = {
  name: string;
  content: string;
  mtime: string | null;
};

export async function listRules(workspace?: string): Promise<RuleSummary[]> {
  const query = workspace ? `?cwd=${encodeURIComponent(workspace)}` : "";
  const result = await api<{ rules: RuleSummary[] }>(`/rules${query}`);
  return result.rules ?? [];
}

export async function readRule(workspace: string | undefined, name: string): Promise<RuleRecord> {
  const params = new URLSearchParams({ name });
  if (workspace) params.set("cwd", workspace);
  return api<RuleRecord>(`/rules/file?${params.toString()}`);
}

export async function writeRule(
  workspace: string | undefined,
  name: string,
  content: string,
): Promise<void> {
  await api("/rules/file", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, content, ...(workspace ? { cwd: workspace } : {}) }),
  });
}

export async function deleteRule(workspace: string | undefined, name: string): Promise<void> {
  const params = new URLSearchParams({ name });
  if (workspace) params.set("cwd", workspace);
  await api(`/rules/file?${params.toString()}`, { method: "DELETE" });
}

/** 语色（运行中实时生效；落盘走 savePreferences） */
export async function getSpeechStyle(): Promise<{ style: SpeechStyle }> {
  return api<{ style: SpeechStyle }>("/config/speech-style");
}

export async function setSpeechStyle(style: SpeechStyle): Promise<{ style: SpeechStyle }> {
  return api<{ style: SpeechStyle }>("/config/speech-style", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ style }),
  });
}

/** 命令沙箱：运行中实时切换；落盘走 saveProviderPrefs({ sandbox }) */
export async function getSandbox(): Promise<SandboxStatus> {
  return api<SandboxStatus>("/config/sandbox");
}

export async function setSandbox(patch: Partial<SandboxSettings>): Promise<SandboxStatus> {
  return api<SandboxStatus>("/config/sandbox", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export async function probeSandbox(): Promise<SandboxProbeResult> {
  return api<SandboxProbeResult>("/config/sandbox/probe", { method: "POST" });
}

export async function revokeSandbox(): Promise<SandboxRevokeResult> {
  return api<SandboxRevokeResult>("/config/sandbox/revoke", { method: "POST" });
}

// ---- 插件市场（/marketplace 路由）----

// i18n-allow-block-start：以下是与后端 / 市场索引一致的规范分类值（数据标识符，不参与翻译）
export type MarketCategory = "开发工具" | "界面设计" | "内容创作" | "效率提升" | "数据分析";
// i18n-allow-block-end

export type MarketplaceItem = {
  id: string;
  type: "skill" | "plugin" | "mcp";
  name: string;
  description: string;
  category: string;
  source: string;
  tags: string[];
  version: string;
  /** 相对 bundles 的图标路径（有图标的条目才有；实际图由 list 的 icons 表给 dataUrl） */
  icon?: string;
  /** plugin 专用：详情页使用说明（markdown） */
  usage?: string;
  requiresEnv?: string[];
};

export type MarketplaceEntry = MarketplaceItem & {
  installed: boolean;
  /** mcp 专用：requiresEnv 是否已在 server 进程环境中 */
  envReady?: boolean;
  /** mcp 专用：远程 server（配了 url）——可走 MCP 协议内 OAuth 授权 */
  oauthCapable?: boolean;
};

export type MarketplaceListResult = {
  items: MarketplaceEntry[];
  /** 图标 dataUrl 表，key = "<type>:<id>" */
  icons: Record<string, string>;
};

export type MarketplaceInstallResult = {
  id: string;
  type: "skill" | "plugin" | "mcp";
  overwritten: boolean;
};

export type MarketplaceDetail = {
  item: MarketplaceItem;
  /** skill → SKILL.md 正文（去 frontmatter）；plugin → 使用说明；mcp → 无 */
  detail?: string;
};

export async function listMarketplace(): Promise<MarketplaceListResult> {
  return api<MarketplaceListResult>("/marketplace");
}

export async function fetchMarketplaceDetail(
  id: string,
  type: MarketplaceEntry["type"],
  channel?: MarketplaceEntryLike["channel"],
): Promise<MarketplaceDetail> {
  const query = new URLSearchParams({ id, type });
  const base =
    channel === "community"
      ? "/marketplace/community/detail"
      : channel === "thirdparty"
        ? "/marketplace/thirdparty/detail"
        : "/marketplace/detail";
  return api<MarketplaceDetail>(`${base}?${query.toString()}`);
}

export async function installMarketplaceItem(id: string, type: MarketplaceEntry["type"]): Promise<MarketplaceInstallResult> {
  return api<MarketplaceInstallResult>("/marketplace/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, type }),
  });
}

export async function uninstallMarketplaceItem(id: string, type: MarketplaceEntry["type"]): Promise<void> {
  await api<unknown>("/marketplace/uninstall", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, type }),
  });
}

// ---- 社区市场（GitCode 收录仓库；/marketplace/community 路由）----

/** 社区条目：官方条目超集 + 社区专属字段 */
export type CommunityMarketplaceEntry = MarketplaceEntry & {
  author?: string;
  homepage?: string;
  channel: "community";
  /** 安装标记版本 ≠ 远端版本（按钮变「更新」= 重装覆盖） */
  updateAvailable?: boolean;
};

/** 卡片/行组件共用的宽松条目类型：官方条目天然满足，社区/第三方条目多出的字段可选 */
export type MarketplaceEntryLike = MarketplaceEntry & {
  author?: string;
  homepage?: string;
  channel?: "community" | "thirdparty";
  updateAvailable?: boolean;
  /** 第三方条目的来源（channel = "thirdparty" 时有值） */
  upstream?: ThirdPartySource;
  /** 合成条目：本机已安装但不在市场索引里的 MCP —— 手动添加 / 直接写进 mcp.json */
  localMcpSource?: "market" | "manual" | "local";
  /** 合成条目：enabled:false 的 MCP 不会被启动，运行状态里查不到 */
  localMcpEnabled?: boolean;
};

export type CommunityListResult = {
  items: CommunityMarketplaceEntry[];
  icons: Record<string, string>;
};

export async function listCommunityMarketplace(refresh = false): Promise<CommunityListResult> {
  return api<CommunityListResult>(`/marketplace/community${refresh ? "?refresh=1" : ""}`);
}

export async function fetchCommunityDetail(
  id: string,
  type: CommunityMarketplaceEntry["type"],
): Promise<MarketplaceDetail> {
  const query = new URLSearchParams({ id, type });
  return api<MarketplaceDetail>(`/marketplace/community/detail?${query.toString()}`);
}

export async function installCommunityMarketplaceItem(
  id: string,
  type: CommunityMarketplaceEntry["type"],
): Promise<MarketplaceInstallResult> {
  return api<MarketplaceInstallResult>("/marketplace/community/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, type }),
  });
}

// ---- 第三方市场（ClawHub + SkillHub 聚合；/marketplace/thirdparty 路由，仅 skill）----

export type ThirdPartySource = "clawhub" | "skillhub";

export type ThirdPartySkillEntry = MarketplaceEntry & {
  upstream: ThirdPartySource;
  channel: "thirdparty";
  slug: string;
  downloads?: number;
  updatedAt?: number;
};

export type ThirdPartyListResult = {
  items: ThirdPartySkillEntry[];
  /** 单源失败不拖垮列表：失败源标记为 failed */
  sources: Record<ThirdPartySource, "ok" | "failed">;
  /** 图标 dataUrl 表，key = "skill:<id>" */
  icons: Record<string, string>;
  /** 各源下一页游标；没有更多就是空对象 */
  nextCursors: Partial<Record<ThirdPartySource, string>>;
};

export async function listThirdPartySkills(
  opts: {
    query?: string;
    source?: ThirdPartySource;
    refresh?: boolean;
    cursors?: Partial<Record<ThirdPartySource, string>>;
  } = {},
): Promise<ThirdPartyListResult> {
  const params = new URLSearchParams();
  if (opts.query) params.set("query", opts.query);
  if (opts.source) params.set("source", opts.source);
  if (opts.refresh) params.set("refresh", "1");
  if (opts.cursors && Object.keys(opts.cursors).length) params.set("cursors", JSON.stringify(opts.cursors));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return api<ThirdPartyListResult>(`/marketplace/thirdparty${suffix}`);
}

export async function fetchThirdPartyDetail(id: string): Promise<MarketplaceDetail> {
  return api<MarketplaceDetail>(`/marketplace/thirdparty/detail?${new URLSearchParams({ id }).toString()}`);
}

export async function installThirdPartySkill(id: string): Promise<MarketplaceInstallResult> {
  return api<MarketplaceInstallResult>("/marketplace/thirdparty/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

// ---- 「我的」（/marketplace/mine 路由）：手动添加的 skill / plugin / MCP ----

export type MineSkillEntry = {
  type: "skill";
  id: string;
  addedAt: string;
  status: "ok" | "missing";
  name: string;
  description: string;
};

export type MinePluginEntry = {
  type: "plugin";
  id: string;
  addedAt: string;
  status: "ok" | "missing";
  /** 路由层 join descriptors 后补齐的运行时字段 */
  displayName?: string;
  description?: string;
  enabled: boolean;
  error?: string;
};

export type MineMcpEntry = {
  type: "mcp";
  id: string;
  addedAt: string;
  status: "ok" | "missing";
  enabled: boolean;
  mcpStatus?: McpServerState["status"];
  toolCount?: number;
  error?: string;
  /** 远程 server（配了 url）：可点「授权 / 重新授权」 */
  oauthCapable?: boolean;
  /** mcpStatus 为 unconfigured 时缺的 ${VAR} 名单 */
  missingEnv?: string[];
};

export type MineListResult = {
  skills: MineSkillEntry[];
  plugins: MinePluginEntry[];
  mcp: MineMcpEntry[];
};

export async function listMine(): Promise<MineListResult> {
  return api<MineListResult>("/marketplace/mine");
}

/**
 * 本机已安装的全部 MCP（mcp.json 里的每个条目）。
 * 市场索引只覆盖有安装标记的条目，这里补上手动添加与直接手写进 mcp.json 的那些。
 */
export type InstalledMcpEntry = {
  id: string;
  /** enabled:false 的条目不会被启动，运行状态里没有它 */
  enabled: boolean;
  /** market = 市场安装；manual = 手动添加；local = 直接写进 mcp.json */
  source: "market" | "manual" | "local";
  /** 连接方式摘要：stdio 是命令行，http 是地址 */
  target: string;
};

export async function listInstalledMcp(): Promise<InstalledMcpEntry[]> {
  return api<InstalledMcpEntry[]>("/marketplace/mcp/installed");
}

/** 删掉 mcp.json 里的一个本地条目（没有市场/手动标记的手写配置也能删） */
export async function removeLocalMcp(id: string): Promise<void> {
  await api<unknown>("/marketplace/mcp/remove", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

/** 手动导入本地内容：skill 传含 SKILL.md 的目录（或 SKILL.md 本身），plugin 传单文件或目录 */
export async function importManualItem(
  type: "skill" | "plugin",
  sourcePath: string,
): Promise<{ id: string; type: "skill" | "plugin" }> {
  return api<{ id: string; type: "skill" | "plugin" }>("/marketplace/manual/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, path: sourcePath }),
  });
}

export async function saveManualMcp(
  id: string,
  server: Record<string, unknown>,
): Promise<{ id: string; overwritten: boolean }> {
  return api<{ id: string; overwritten: boolean }>("/marketplace/manual/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, server }),
  });
}

export async function toggleManualMcp(id: string, enabled: boolean): Promise<{ id: string; enabled: boolean }> {
  return api<{ id: string; enabled: boolean }>("/marketplace/manual/mcp-toggle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, enabled }),
  });
}

/**
 * 手动发起 MCP 的 OAuth 授权（远程 server 专用）。
 * 后端会起浏览器并同步等待回环回调，最长约 5 分钟，授权成功后自动重连。
 * force：先清本机 token 再授权（token 过期 / 换账号时用）。
 */
export async function authorizeMcp(
  name: string,
  force = false,
): Promise<{ ok: boolean; mcp: Record<string, McpServerState> }> {
  return api<{ ok: boolean; mcp: Record<string, McpServerState> }>("/plugins/mcp/authorize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, force }),
  });
}

/**
 * 解除 MCP 的 OAuth 授权：清掉本机 token 并断开连接，状态回到「需要授权」。
 * 不弹浏览器，立即返回；下次要用得重新点「授权」。
 */
export async function revokeMcp(
  name: string,
): Promise<{ ok: boolean; mcp: Record<string, McpServerState> }> {
  return api<{ ok: boolean; mcp: Record<string, McpServerState> }>("/plugins/mcp/revoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

/** 应用内一键提交的载荷：item.json 元数据 + 条目文件（text 内联或 path 本地路径，主进程读取） */
export type CommunitySubmitPayload = {
  type: "skill" | "plugin" | "mcp";
  item: {
    id: string;
    name: string;
    description: string;
    category: string;
    tags: string[];
    version: string;
    homepage?: string;
    requiresEnv?: string[];
    /** mcp 专用：server 配置（command/url/args/env） */
    server?: Record<string, unknown>;
  };
  files: Array<{ name: string; path?: string; text?: string }>;
};

type ApiResult<T> = {
  ok: boolean;
  status: number;
  body: T;
};

/**
 * 带错误码的 API 错误（仍是 Error 子类，现有只有 message 的调用方不受影响）。
 * Git 面板要按 code 区分「不是仓库 / 没上游 / 需要凭据」等分支。
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(requestPath: string, init?: RequestInit): Promise<T> {
  const result = (await window.meow.request(requestPath, init)) as ApiResult<T>;
  if (!result.ok) {
    const error = (result.body as { error?: { code?: string; message?: string } })?.error;
    throw new ApiError(
      error?.message ?? `Request failed (${result.status})`,
      error?.code ?? "request_failed",
      result.status,
    );
  }
  return result.body;
}

// ---- 可编辑架构图（harness 文档，metis 式） ----

export type HarnessNodeType = "agent" | "tier" | "gate" | "role";

export type HarnessNodeData = {
  id?: string;
  name: string;
  description?: string;
  invariant?: string;
  onFail?: string;
  /** 角色节点：内置角色类型（缺省 = 节点 id，兼容旧文档） */
  role?: string;
  /** 覆盖系统提示词：role 节点缺省 = 注册表；agent 节点缺省 = 档位提示词 */
  systemPrompt?: string;
  /** tier 节点：层级提示词（admit 时随准入报告一次性注入；缺省/空 = 不注入） */
  instructions?: string;
  /** 覆盖工具白名单：role 节点缺省 = 注册表；agent 节点缺省 = 跟随档位 */
  tools?: string[];
};

export type HarnessNode = {
  id: string;
  type: HarnessNodeType;
  data: HarnessNodeData;
  position?: { x: number; y: number };
};

export type HarnessEdge = {
  id: string;
  source: string;
  target: string;
  type?: string;
  order?: number;
};

export type HarnessDocument = {
  version: 1;
  nodes: HarnessNode[];
  edges: HarnessEdge[];
  metadata?: {
    /** 自定义架构的显示名（内置三档缺省用档位中文名） */
    name?: string;
    createdAt?: string;
    updatedAt?: string;
    description?: string;
  };
};

/** 架构图 id：内置三档（standard/minimal/complex）或自定义架构（custom-1 …） */
export type HarnessArchitectureId = string;

/** 左栏「主 Agent」列表项 */
export type HarnessArchitectureSummary = {
  id: HarnessArchitectureId;
  /** 自定义架构的显示名；内置三档为 null（前端用本地档位中文名） */
  name: string | null;
  builtin: boolean;
};

/** GET /harness/list —— 内置三档 + 工作区里的自定义架构 */
export async function fetchHarnessArchitectures(
  workspace?: string,
): Promise<HarnessArchitectureSummary[]> {
  const params = new URLSearchParams();
  if (workspace) params.set("workspace", workspace);
  const query = params.toString() ? `?${params.toString()}` : "";
  const body = await api<{ architectures: HarnessArchitectureSummary[] }>(`/harness/list${query}`);
  return body.architectures;
}

/** POST /harness/create —— 复制一张架构图（默认标准 Agent），命名「自定义 Agent」 */
export async function createHarnessArchitecture(
  workspace: string | undefined,
  options?: { name?: string; cloneFrom?: HarnessArchitectureId },
): Promise<{ id: HarnessArchitectureId; name: string; document: HarnessDocument }> {
  return api<{ id: HarnessArchitectureId; name: string; document: HarnessDocument }>(
    "/harness/create",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(workspace ? { workspace } : {}),
        ...(options?.name ? { name: options.name } : {}),
        ...(options?.cloneFrom ? { cloneFrom: options.cloneFrom } : {}),
      }),
    },
  );
}

/** POST /harness/rename —— 自定义架构改名（内置三档不可改） */
export async function renameHarnessArchitecture(
  workspace: string | undefined,
  id: HarnessArchitectureId,
  name: string,
): Promise<void> {
  await api("/harness/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(workspace ? { workspace } : {}), id, name }),
  });
}

/** DELETE /harness/architecture —— 删除自定义架构（内置三档受保护） */
export async function deleteHarnessArchitecture(
  workspace: string | undefined,
  id: HarnessArchitectureId,
): Promise<void> {
  const params = new URLSearchParams();
  if (workspace) params.set("workspace", workspace);
  params.set("id", id);
  await api(`/harness/architecture?${params.toString()}`, { method: "DELETE" });
}

/**
 * GET /harness —— 每个主 Agent 一张独立架构图（内置三档或自定义架构）。
 * `seed: true` 取内置种子（编辑器「重置为内置架构」用，不读磁盘）。
 */
export async function fetchHarness(
  workspace?: string,
  profile?: HarnessArchitectureId,
  options?: { seed?: boolean },
): Promise<HarnessDocument> {
  const detail = await fetchHarnessDetail(workspace, profile, options);
  return detail.document;
}

/**
 * GET /harness 的完整响应：除了文档，还带上该架构对应的**档位默认提示词**
 * （主 Agent 节点没写提示词时，编辑器用它预填，方便直接改）。
 */
export async function fetchHarnessDetail(
  workspace?: string,
  profile?: HarnessArchitectureId,
  options?: { seed?: boolean },
): Promise<{ document: HarnessDocument; agentPrompt: string }> {
  const params = new URLSearchParams();
  if (workspace) params.set("workspace", workspace);
  if (profile) params.set("profile", profile);
  if (options?.seed) params.set("seed", "1");
  const query = params.toString() ? `?${params.toString()}` : "";
  const body = await api<{ document: HarnessDocument; agentPrompt?: string }>(`/harness${query}`);
  return { document: body.document, agentPrompt: body.agentPrompt ?? "" };
}

/** PUT /harness —— 服务端结构校验，非法文档抛错且不落盘 */
export async function saveHarness(
  workspace: string | undefined,
  profile: HarnessArchitectureId | undefined,
  document: HarnessDocument,
): Promise<void> {
  await api("/harness", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(workspace ? { workspace } : {}),
      ...(profile ? { profile } : {}),
      document,
    }),
  });
}

/** 内置角色注册表（只读）：架构图角色节点的面板数据源。 */
export type AgentDefinitionInfo = {
  name: SubagentType;
  description: string;
  /** null = 不限制（general 沿用父级全量工具） */
  tools: string[] | null;
  readOnly: boolean;
  expectedGates: string[];
  injectInstructions: boolean;
  systemPrompt: string;
};

/** 主 Agent 档位（只读展示信息；运行时行为在服务端）。 */
export type AgentProfileInfo = {
  id: AgentProfileId;
  name: string;
  tagline: string;
  description: string;
  roles: SubagentType[];
  /** null = 全量工具 */
  tools: string[] | null;
  maxSubagents: number;
  prompt: string;
};

export async function fetchAgentDefinitions(): Promise<{
  definitions: AgentDefinitionInfo[];
  profiles?: AgentProfileInfo[];
  tools: string[];
}> {
  return api<{
    definitions: AgentDefinitionInfo[];
    profiles?: AgentProfileInfo[];
    tools: string[];
  }>("/agent-definitions");
}

export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }));
}

type TimelineMessage = {
  kind: "message";
  key: string;
  role: ChatMessage["role"];
  content: string;
  /** 思考过程（流式增量累加；会话回放时来自 message.reasoning） */
  thinking?: string;
  /** 思考时长（毫秒）：思考块右侧显示（实时来自事件，回放来自消息存档） */
  thinkingMs?: number;
  streaming?: boolean;
  /** 用户消息附带的图片（仅本进程内存，重载会话后不再保留） */
  images?: TimelineImage[];
  /** 历史回放时该消息在 messagesForClient 里的下标；全文检索跳转锚点用（流式消息无此值） */
  messageIndex?: number;
  /**
   * 挂在该条用户消息上的自动检查点（每个用户回合开始一条）：
   * hover 气泡显示「回滚到此处」；手动检查点仍走独立分隔线（TimelineCheckpoint）。
   */
  checkpointId?: string;
  /** 该自动检查点是否带文件快照（false = 只能回滚对话） */
  checkpointHasSnapshot?: boolean;
  checkpointLabel?: string;
};

/** 时间线里展示用的图片（dataUrl 或 assetUrl 直接喂 <img>） */
export type TimelineImage = {
  mimeType: string;
  dataUrl?: string;
  /** 落盘图片的 asset URL（历史回放）；与 dataUrl 二选一 */
  src?: string;
  name?: string;
};

type TimelineTool = {
  kind: "tool";
  key: string;
  callId: string;
  tool: string;
  input: unknown;
  output?: string;
  truncated?: boolean;
  /** 完整内容已落盘的相对路径（回放不保留） */
  spilled?: string;
  ok?: boolean;
  /** 历史回放重建的条目：没有实时的 ok/output，按已完成展示 */
  replayed?: true;
  /** 本次写/改文件新增、删除行数（来自 file_changed 事件，回合内实时显示） */
  added?: number;
  removed?: number;
};

/** 报错条目：跟在消息流里展示（类似模型发出的报错），不再是顶部横幅 */
type TimelineError = {
  kind: "error";
  key: string;
  message: string;
};

/** 中性提示（例如上次生成被进程退出中断），不是错误 */
type TimelineNotice = {
  kind: "notice";
  key: string;
  message: string;
  /** 可选动作按钮（例如"发现新版本 → 立即更新"） */
  action?: { label: string; run: () => void };
};

/** 上下文压缩分隔线：留在会话时间线的原始位置，后续消息排在它下面 */
type TimelineCompaction = {
  kind: "compaction";
  key: string;
  /** 压缩进行中 */
  running?: boolean;
  /** 进程退出导致的压缩中断；中性提示，不是错误 */
  interrupted?: boolean;
  /** 摘要请求失败 */
  failed?: boolean;
  /** 摘要全文（悬停查看；时间线上只显示一行提示） */
  summary?: string | null;
};

/** 会话检查点分隔线：留在时间线原位，「恢复」从该点截断分支出新会话 */
export type TimelineCheckpoint = {
  kind: "checkpoint";
  key: string;
  id: string;
  label?: string;
  /** 自动（每个用户回合开始）或手动 */
  auto: boolean;
  timestamp: string;
  /** 检查点时改动的文件列表（自动检查点才有） */
  fileChanges: string[];
  /** 是否带文件快照（决定能否回滚代码） */
  hasSnapshot?: boolean;
  fileCount?: number;
};

/** 回滚计划（POST /session/rewind dryRun 返回） */
export type RewindFileAction = {
  path: string;
  action: "restore" | "delete" | "unchanged";
  added?: number;
  removed?: number;
  bytes?: number;
  conflict?: "modified_on_disk";
  skipped?: "too_large" | "outside_workspace" | "unreadable";
};

export type RewindPlan = {
  planId: string;
  mode: "both" | "conversation" | "code";
  checkpoint: { id: string; label?: string; timestamp: string; messageIndex: number };
  cwd: string;
  files: RewindFileAction[];
  skipped: Array<{ path: string; reason: string }>;
  conversation: { dropMessages: number; totalMessages: number };
  warnings: string[];
  requiresForce: boolean;
};

/** 最近一次可撤销的回滚（GET /session/rewind/undoable） */
export type UndoableRewind = {
  rewindId: string;
  checkpointId: string;
  mode: "both" | "conversation" | "code";
  createdAt: string;
  fileCount: number;
  sourceSessionId: string;
  sourceFilePath: string;
};

export type RewindMode = "both" | "conversation" | "code";

/**
 * 回合结束的编辑汇总卡片：有文件改动才出现，列出本轮改过的文件与增删行数。
 * 「撤销」= 回滚到本回合起始检查点（仅代码），「审阅」= 打开右侧审阅页签。
 */
type TimelineTurnChanges = {
  kind: "turn-changes";
  key: string;
  turnId?: string;
  checkpointId?: string;
  canRewind?: boolean;
  files: TurnFileChangeStat[];
};

/** 回合运行耗时：每轮末尾一条，hover 该轮区域才淡入显示（可延展更多信息）。 */
type TimelineTurnInfo = {
  kind: "turn-info";
  key: string;
  turnId?: string;
  /** 本回合总耗时（毫秒）；历史回放与流式结算都走此字段 */
  durationMs: number;
  status?: "completed" | "aborted" | "error" | "interrupted";
  /** 回合结束时间（ISO）：操作行的时间 chip */
  endedAt?: string;
  /** 本回合主对话 Token 汇总 */
  usage?: TurnUsageTotals;
};

type TimelineItem =
  | TimelineMessage
  | TimelineTool
  | TimelineError
  | TimelineNotice
  | TimelineCompaction
  | TimelineCheckpoint
  | TimelineTurnChanges
  | TimelineTurnInfo;

/** 子 Agent 在渲染层累积的只读运行状态 */
export type SubagentRun = SubagentSummary & {
  timeline: TimelineItem[];
  /** 已从服务端拉过完整转录；运行中由事件累积时为 false */
  hydrated: boolean;
  /** 当前进程里仍在运行（SSE 实时事件可继续追加） */
  live: boolean;
  /** subagent_started 带来的任务提示，用于运行中页签的初始内容 */
  prompt?: string;
  /** 模型正在准备工具调用时的进度文案 */
  preparing?: string;
  /** 已发送但尚未在下一步送达子 Agent 的插话 */
  pendingSteers?: Array<{ id: string; text: string }>;
  /** 插话未能送达（子 Agent 刚好结束/被停止） */
  steerError?: string;
  /** child_result 事件：契约角色（implementer/reviewer/verifier）的宿主校验结论 */
  childResult?: {
    status: string;
    valid: boolean;
    invalidReason?: string;
    summary: string;
    criticalFindings: number;
  };
};

/** GET /session/subagents/:agentId/messages */
export type SubagentTranscript = {
  agentId: string;
  parentSessionId: string;
  callId: string;
  description: string;
  agentType?: SubagentType;
  title?: string | null;
  status: SubagentStatus;
  createdAt: string;
  messages: ChatMessage[];
  compaction?: { messageIndex: number; summary: string } | null;
  compactions?: CompactionPoint[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    hasUsage: boolean;
  } | null;
  lastTurn?: { status: TurnStatus; error?: string } | null;
  openTurn?: boolean;
};

export type {
  TimelineCompaction,
  TimelineError,
  TimelineItem,
  TimelineMessage,
  TimelineNotice,
  TimelineTool,
  TimelineTurnChanges,
};

// ---- Git 管理 ----

export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "untracked"
  | "conflicted";

export type GitConflictKind =
  | "both_modified"
  | "both_added"
  | "both_deleted"
  | "added_by_us"
  | "added_by_them"
  | "deleted_by_us"
  | "deleted_by_them";

/** 单个变更文件：index = 暂存侧状态，worktree = 工作区侧状态（null = 该侧无变化） */
export type GitFileEntry = {
  path: string;
  origPath?: string;
  index: GitFileStatus | null;
  worktree: GitFileStatus | null;
  conflict?: GitConflictKind;
  added?: number;
  removed?: number;
  binary?: boolean;
};

export type GitStatus = {
  isRepo: boolean;
  reason?: string;
  root?: string;
  name?: string;
  branch?: string;
  detached?: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  staged: GitFileEntry[];
  unstaged: GitFileEntry[];
  conflicted: GitFileEntry[];
  /** 分组截断前的总数；缺省时按数组长度处理（列表最多 1000 条） */
  stagedCount?: number;
  unstagedCount?: number;
  conflictedCount?: number;
  /** 去重后的总增删行数（全量；untracked 没有 numstat，按 0 计） */
  addedTotal?: number;
  removedTotal?: number;
};

export type GitBranch = {
  name: string;
  sha: string;
  upstream?: string;
  current: boolean;
};

export type GitCommit = {
  sha: string;
  short: string;
  author: string;
  email: string;
  time: number;
  parents: string[];
  subject: string;
  body?: string;
};

export type GitDiffResult = {
  patch: string;
  binary: boolean;
  truncated: boolean;
  added: number;
  removed: number;
};

const jsonPost = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export async function gitStatus(): Promise<GitStatus> {
  return api<GitStatus>("/git/status");
}

export async function gitDiff(params: {
  path?: string;
  scope: "worktree" | "index" | "commit";
  sha?: string;
}): Promise<GitDiffResult> {
  const query = new URLSearchParams({ scope: params.scope });
  if (params.path) query.set("path", params.path);
  if (params.sha) query.set("sha", params.sha);
  return api<GitDiffResult>(`/git/diff?${query.toString()}`);
}

export async function gitStage(paths: string[]): Promise<void> {
  await api<unknown>("/git/stage", jsonPost({ paths }));
}

/** 全部暂存：列表被截断时用它，别把几万个路径塞进请求体 */
export async function gitStageAll(): Promise<void> {
  await api<unknown>("/git/stage", jsonPost({ all: true }));
}

export async function gitUnstage(paths: string[]): Promise<void> {
  await api<unknown>("/git/unstage", jsonPost({ paths }));
}

export async function gitUnstageAll(): Promise<void> {
  await api<unknown>("/git/unstage", jsonPost({ all: true }));
}

export async function gitDiscard(paths: string[]): Promise<{ discarded: number }> {
  return api<{ discarded: number }>("/git/discard", jsonPost({ paths }));
}

export async function gitCommit(message: string): Promise<{ sha: string; short: string; subject: string }> {
  return api<{ sha: string; short: string; subject: string }>("/git/commit", jsonPost({ message }));
}

export async function gitBranches(): Promise<{ current?: string; detached: boolean; branches: GitBranch[] }> {
  return api<{ current?: string; detached: boolean; branches: GitBranch[] }>("/git/branches");
}

export async function gitSwitchBranch(input: {
  name: string;
  force?: boolean;
  stash?: boolean;
}): Promise<{ branch: string }> {
  return api<{ branch: string }>("/git/branches/switch", jsonPost(input));
}

export async function gitCreateBranch(name: string, startPoint?: string): Promise<{ branch: string }> {
  return api<{ branch: string }>(
    "/git/branches/create",
    jsonPost({ name, ...(startPoint ? { startPoint } : {}) }),
  );
}

export async function gitLog(params: { limit?: number; skip?: number } = {}): Promise<{
  commits: GitCommit[];
  hasMore: boolean;
}> {
  const query = new URLSearchParams();
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.skip !== undefined) query.set("skip", String(params.skip));
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return api<{ commits: GitCommit[]; hasMore: boolean }>(`/git/log${suffix}`);
}

export async function gitShowCommit(sha: string): Promise<{
  commit: GitCommit;
  files: GitFileEntry[];
  fileCount: number;
  patch: string;
  truncated: boolean;
}> {
  return api<{
    commit: GitCommit;
    files: GitFileEntry[];
    fileCount: number;
    patch: string;
    truncated: boolean;
  }>(`/git/commit?sha=${encodeURIComponent(sha)}`);
}

export async function gitPull(): Promise<{ ok: boolean; summary: string }> {
  return api<{ ok: boolean; summary: string }>("/git/pull", jsonPost({}));
}

export async function gitPush(input: { setUpstream?: boolean; force?: boolean } = {}): Promise<{
  ok: boolean;
  summary: string;
}> {
  return api<{ ok: boolean; summary: string }>("/git/push", jsonPost(input));
}

export async function gitResolve(input: {
  path: string;
  side: "ours" | "theirs" | "mark";
}): Promise<void> {
  await api<unknown>("/git/resolve", jsonPost(input));
}

export async function gitCommitMessage(hint?: string): Promise<{ message: string }> {
  return api<{ message: string }>("/git/commit-message", jsonPost(hint ? { hint } : {}));
}

/** AI 美化提示词：text 是当前输入框快照；side 让侧边聊使用自己的模型。 */
/** 回合结束后预测用户下一句；失败/无建议返回 null，不打扰对话。 */
export async function getPromptSuggestion(sessionId: string): Promise<string | null> {
  const result = await api<{ suggestion?: string | null }>("/session/suggestion", {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
  return result.suggestion?.trim() || null;
}

export async function polishPrompt(
  text: string,
  options: { side?: boolean } = {},
): Promise<{ text: string }> {
  return api<{ text: string }>(
    "/prompt/polish",
    jsonPost({ text, ...(options.side ? { side: true } : {}) }),
  );
}

// ---- 诊断（设置 → 诊断）----

export type DiagnosticsSpanKind = "turn" | "llm" | "tool" | "subagent" | "approval";
export type DiagnosticsSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: DiagnosticsSpanKind;
  name: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  status: "ok" | "error" | "aborted";
  attributes?: Record<string, unknown>;
  error?: string;
};

export type DiagnosticsSummary = {
  logDir: string;
  logFile: string;
  traceId: string | null;
  summary: {
    total: number;
    errors: number;
    aborted: number;
    averageMs: number;
    maxMs: number;
    byKind: Partial<Record<DiagnosticsSpanKind, number>>;
  };
  spans: DiagnosticsSpan[];
};

export async function getDiagnostics(sessionId?: string): Promise<DiagnosticsSummary> {
  const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : "";
  return api<DiagnosticsSummary>(`/diagnostics/summary${query}`);
}

// ---- 项目级审批规则（设置 → 审批规则）----

export type ApprovalRuleKind = "tool" | "path" | "command-exact" | "command-prefix";

export type ApprovalRule = {
  id: string;
  tool: string;
  match: { kind: ApprovalRuleKind; value: string; fileSha?: string };
  createdAt: string;
};

export async function getApprovalRules(): Promise<{
  workspace: string | null;
  rules: ApprovalRule[];
}> {
  return api<{ workspace: string | null; rules: ApprovalRule[] }>("/approval-rules");
}

export async function deleteApprovalRule(id: string): Promise<void> {
  await api<unknown>(`/approval-rules?id=${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function clearApprovalRules(): Promise<{ cleared: number }> {
  return api<{ cleared: number }>("/approval-rules?all=1", { method: "DELETE" });
}

// ---- 自动化（定时任务）：主进程调度器，触发/执行/结算全在 main.cjs ----

export type AutomationScheduleKind =
  | "interval"
  | "daily"
  | "weekly"
  | "monthly"
  | "cron"
  | "once";

export type AutomationHistoryStatus = "started" | "ok" | "error" | "missed";

export type AutomationHistoryEntry = {
  at: string;
  status: AutomationHistoryStatus;
  sessionId?: string;
  error?: string;
};

export type Automation = {
  id: string;
  title: string;
  /** 触发时投递的正文（主进程会加一行语言前缀） */
  prompt: string;
  /** 目标工作区绝对路径：每次触发都在这里新建会话 */
  cwd: string;
  kind: AutomationScheduleKind;
  enabled: boolean;
  /** once 恒为 false；周期任务 false 表示跑满 maxRuns 后停用 */
  recurring: boolean;
  /** interval：间隔分钟 */
  intervalMinutes?: number;
  /** daily/weekly/monthly：HH:MM */
  time?: string;
  /** weekly：0=周日 … 6=周六（本地时区） */
  weekday?: number;
  /** monthly：几号，缺月收敛到当月最后一天 */
  dayOfMonth?: number;
  /** cron：5 字段表达式（本地时区） */
  cron?: string;
  /** once：指定时间（ISO） */
  onceAt?: string;
  /** 触发 N 次后自动停用 */
  maxRuns?: number;
  createdAt: string;
  updatedAt: string;
  /** 已按调度触发的次数（手动「立即运行」不计入） */
  fireCount: number;
  nextRunAt: string | null;
  /** 最新在前，封顶 20 条 */
  history: AutomationHistoryEntry[];
};

/** 新建/更新输入：id 省略=新建；运行时字段由主进程维护，传了也会被覆盖 */
export type AutomationInput = Partial<
  Omit<Automation, "id" | "createdAt" | "updatedAt" | "fireCount" | "nextRunAt" | "history">
> & { id?: string };

export async function listAutomations(): Promise<Automation[]> {
  return window.meow.listAutomations();
}

export async function saveAutomation(input: AutomationInput): Promise<Automation> {
  return window.meow.saveAutomation(input);
}

export async function deleteAutomation(id: string): Promise<boolean> {
  return window.meow.deleteAutomation(id);
}

export async function toggleAutomation(id: string, enabled: boolean): Promise<Automation> {
  return window.meow.toggleAutomation(id, enabled);
}

export async function runAutomationNow(id: string): Promise<boolean> {
  return window.meow.runAutomationNow(id);
}

/** 打开某次运行的历史会话（唤起主窗口并切过去） */
export async function openAutomationSession(sessionId: string): Promise<void> {
  await window.meow.openAutomationSession(sessionId);
}

export function onAutomationsChanged(listener: (list: Automation[]) => void): () => void {
  return window.meow.onAutomationsChanged(listener);
}

// ---- 邮箱聚合 ----

export async function mailAccounts(): Promise<MailAccountsResult> {
  return window.meow.mailAccountsList();
}

export async function mailSaveAccount(payload: MailAccountSavePayload): Promise<MailAccountSaveResult> {
  return window.meow.mailAccountSave(payload);
}

export async function mailRemoveAccount(accountId: string): Promise<{ ok: boolean }> {
  return window.meow.mailAccountRemove(accountId);
}

export async function mailTestAccount(payload: MailAccountTestPayload): Promise<MailAccountTestResult> {
  return window.meow.mailAccountTest(payload);
}

export async function mailSync(payload: MailSyncPayload): Promise<MailSyncResult> {
  return window.meow.mailSync(payload);
}

export async function mailCounts(accountId: string): Promise<MailCounts> {
  return window.meow.mailCounts(accountId);
}

export async function mailList(payload: MailListPayload): Promise<MailListResult> {
  return window.meow.mailList(payload);
}

export async function mailMessage(payload: MailMessagePayload): Promise<MailMessageResult> {
  return window.meow.mailMessage(payload);
}

export async function mailSetSeen(payload: MailSeenPayload): Promise<{ ok: boolean; code?: string; detail?: string }> {
  return window.meow.mailSetSeen(payload);
}

export async function mailDelete(payload: MailDeletePayload): Promise<MailDeleteResult> {
  return window.meow.mailDelete(payload);
}

export async function mailDownloadAttachment(
  payload: MailAttachmentDownloadPayload,
): Promise<MailAttachmentDownloadResult> {
  return window.meow.mailDownloadAttachment(payload);
}

export async function mailPickAttachments(): Promise<MailPickAttachmentsResult> {
  return window.meow.mailPickAttachments();
}

export async function mailDrafts(accountId: string): Promise<MailDraftsListResult> {
  return window.meow.mailDraftsList(accountId);
}

export async function mailSaveDraft(
  draft: Partial<MailDraft> & { accountId: string },
): Promise<MailDraftSaveResult> {
  return window.meow.mailDraftSave({ draft });
}

export async function mailDeleteDraft(id: string): Promise<{ ok: boolean }> {
  return window.meow.mailDraftDelete(id);
}

export async function mailSend(payload: MailSendPayload): Promise<MailSendResult> {
  return window.meow.mailSend(payload);
}

export async function mailOutbox(accountId: string): Promise<MailOutboxListResult> {
  return window.meow.mailOutboxList(accountId);
}

export async function mailRetryOutbox(id: string): Promise<MailOutboxResult> {
  return window.meow.mailOutboxRetry(id);
}

export async function mailRemoveOutbox(id: string): Promise<MailOutboxResult> {
  return window.meow.mailOutboxDelete(id);
}

export function onMailEvent(listener: (event: MailEvent) => void): () => void {
  return window.meow.onMailEvent?.(listener) ?? (() => {});
}

export type MailAiComposePayload = {
  mode: "new" | "reply" | "forward";
  instruction?: string;
  to?: string;
  subject?: string;
  original?: string;
  draft?: string;
  /** 发件人身份，供模型正确署名 */
  from?: { name?: string; email?: string };
  /** 指定模型；缺省 = 跟随聊天当前激活模型 */
  providerId?: string;
};

/** 写信页「AI 写」：由 agent server 使用当前激活的模型生成正文。 */
export async function composeMailWithAi(payload: MailAiComposePayload): Promise<string> {
  const result = await api<{ text: string }>("/mail/compose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return result.text;
}
