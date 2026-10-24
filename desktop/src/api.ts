import { marked } from "marked";
import DOMPurify from "dompurify";

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
  report?: string;
  prompt?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  status?: SubagentStatus;
  usage?: UsageSummary;
  error?: string;
  /** tool_call_progress：已生成的工具调用数量/名字/参数字符数 */
  count?: number;
  names?: string[];
  chars?: number;
  sessionId?: string;
  callId?: string;
  tool?: string;
  input?: unknown;
  output?: string;
  truncated?: boolean;
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
  questions?: Array<{ question: string; options: string[] }>;
  /** usage 事件：缓存读取的输入 token；未报告时不带 */
  cacheReadTokens?: number;
  /** usage 事件：写入缓存的输入 token（Anthropic 类协议）；未报告时不带 */
  cacheWriteTokens?: number;
  /** message_start 事件：由排队消息启动的回合对应的排队项 id */
  queuedId?: string;
  /** approval_required 事件：写文件/改文件的预览差异 */
  diff?: string;
  /** approval_required 事件：明显危险的命令特征（仅提示） */
  risk?: { level: "high"; reasons: string[] };
  /** approval_required 事件：审批期间文件被改动，diff 已重新生成 */
  stale?: boolean;
  /** file_changed 事件：Agent 改动的文件（工作区相对路径）与操作 */
  path?: string;
  operation?: "write_file" | "edit_file";
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
  risk?: { level: "high"; reasons: string[] };
  /** 审批期间文件被改动，diff 已重新生成 */
  stale?: boolean;
};

/** 全局待审批：后台会话也在等，所以带 sessionId 供切回时恢复 */
export type PendingApproval = ApprovalRequest & {
  sessionId: string;
  /** 子 Agent 审批：sessionId 为父会话，这里标记来源 */
  parentSessionId?: string;
  agentId?: string;
  agentDescription?: string;
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
      | "subagents";
    title: string;
    url?: string;
    path?: string;
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

/** 上下文占用的分类明细（token 数），三项之和 == usedTokens */
export type ContextBreakdown = {
  /** 系统提示词（稳定前缀） */
  system: number;
  /** 工具定义 */
  tools: number;
  /** 对话消息 */
  messages: number;
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
  /** 已到窗口 85%，建议用户手动压缩（自动压缩只在真实溢出时触发） */
  recommendedCompaction: boolean;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** 模型思考过程（会话存档里有就带上） */
  reasoning?: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: unknown[];
  /** 当轮内存里的附图（裸 base64；回放快照里没有，落盘图走 imageRefs） */
  images?: Array<{ data: string; mimeType: string }>;
  /** 落盘图片引用（回放快照附带）；经 window.meow.assetUrl() 转成可加载的 URL */
  imageRefs?: Array<{ file: string; mimeType: string }>;
};

export type CurrentSession = {
  id: string;
  cwd: string;
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
};

/** 服务商 API 协议。三种都在后端有对应实现（见 src/agent/）。 */
export type ApiFormat = "anthropic-messages" | "openai-chat-completions" | "openai-responses";

export type InputModality = "text" | "image" | "pdf";

export type ThemePreference = "system" | "light" | "dark";
export type CloseAction = "ask" | "tray" | "quit";
/** 界面语言：跟随系统 / 简体中文（目前仅 zh-CN 有词条）。 */
export type LanguagePreference = "system" | "zh-CN";

/** 不重启 agent server 的轻量偏好（外观 / 关闭方式 / 归档列表 / 侧栏项目）。 */
export type Preferences = {
  theme: ThemePreference;
  closeAction: CloseAction;
  language?: LanguagePreference;
  /** 首次启动引导是否已完成 */
  onboardingCompleted?: boolean;
  archivedSessions?: string[];
  /** 项目（工作区）自定义显示名：cwd → name */
  projectNames?: Record<string, string>;
  /** 置顶的项目 cwd 列表（顺序即置顶顺序） */
  pinnedProjects?: string[];
  /** 已移除（侧栏隐藏）的项目 cwd 列表 */
  removedProjects?: string[];
};

export type AppInfo = {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
};

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
  /** 上下文窗口（token 数） */
  contextWindow?: number;
  /** 单次最大输出 token 数 */
  maxTokens?: number;
  inputModalities?: InputModality[];
  /** 思考强度：undefined/"" 表示服务商默认，其余下发为 reasoning_effort */
  reasoningEffort?: string;
  /** 显式思考预算（thinking.budget_tokens）；留空则按思考强度档位推导 */
  thinkingBudget?: number;
  /** 前缀缓存 TTL：5m（默认）/ 1h（Anthropic 显式长 TTL） */
  cacheTtl?: "5m" | "1h";
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

export type Settings = {
  workspace?: string;
  providerId?: string;
  providers?: ProviderSettings[];
  theme?: ThemePreference;
  closeAction?: CloseAction;
  language?: LanguagePreference;
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
  plugins?: { disabled?: string[] };
  /** GitHub MCP 的 OAuth 连接状态（不含 token） */
  githubAuth?: GithubAuthStatus;
  /** 已保存的 Gitee/GitCode MCP Token 对应的 env 名（不含 token） */
  mcpCredentialKeys?: string[];
  /** Gitee/GitCode OAuth 连接状态（不含 token/secret） */
  oauthStatus?: Record<OauthPlatform, OauthPlatformStatus>;
};

export type SetMcpCredentialsResult = {
  ok: boolean;
  message?: string;
  warning?: string;
};

export type OauthPlatform = "gitee" | "gitcode";

export const MCP_ENV_PLATFORMS: Record<string, OauthPlatform> = {
  MEOWCODE_GITEE_TOKEN: "gitee",
  MEOWCODE_GITCODE_TOKEN: "gitcode",
};

export const MCP_PLATFORM_LABELS: Record<OauthPlatform, string> = {
  gitee: "Gitee",
  gitcode: "GitCode",
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

export type PluginSource = "project" | "user";

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
};

export type McpServerState = {
  status: "connecting" | "ready" | "failed";
  toolCount: number;
  error?: string;
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

export type InstalledSkill = {
  /** 技能目录名（市场图标 key：skill:<id>） */
  id: string;
  /** frontmatter 里的技能名 */
  name: string;
  description: string;
  source: "project" | "user";
};

export async function listSkills(workspace?: string): Promise<InstalledSkill[]> {
  const query = workspace ? `?cwd=${encodeURIComponent(workspace)}` : "";
  const result = await api<{ skills: InstalledSkill[] }>(`/skills${query}`);
  return result.skills ?? [];
}

export async function reloadPlugins(): Promise<PluginsOverview> {
  return api<PluginsOverview>("/plugins/reload", { method: "POST" });
}

/** 插件启停：写 settings.plugins.disabled 后主进程重启 agent server 生效 */
export async function setPluginsState(disabled: string[]): Promise<Settings> {
  return window.meow.setPluginsState({ disabled }) as Promise<Settings>;
}

// ---- 插件市场（/marketplace 路由）----

export type MarketCategory = "开发工具" | "界面设计" | "内容创作" | "效率提升" | "数据分析";

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
): Promise<MarketplaceDetail> {
  const query = new URLSearchParams({ id, type });
  return api<MarketplaceDetail>(`/marketplace/detail?${query.toString()}`);
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
  streaming?: boolean;
  /** 用户消息附带的图片（仅本进程内存，重载会话后不再保留） */
  images?: TimelineImage[];
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
  ok?: boolean;
  /** 历史回放重建的条目：没有实时的 ok/output，按已完成展示 */
  replayed?: true;
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

type TimelineItem =
  | TimelineMessage
  | TimelineTool
  | TimelineError
  | TimelineNotice
  | TimelineCompaction;

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
};

// ---- Git 源码管理 ----

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

export async function gitUnstage(paths: string[]): Promise<void> {
  await api<unknown>("/git/unstage", jsonPost({ paths }));
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
