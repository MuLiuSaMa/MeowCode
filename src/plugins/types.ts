import type { ChatMessage, ToolResult } from "../agent/types.js";

/**
 * 插件日志器：所有输出自动带 [plugin:<id>] 前缀，便于在 server 日志里区分来源。
 */
export type PluginLogger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

/** 插件工具执行上下文（由 runtime 在每次调用时传入） */
export type PluginToolContext = {
  /** 当前会话工作区 */
  workspace: string;
  /** 回合中止信号：长任务插件应监听并尽快退出 */
  signal?: AbortSignal;
  logger: PluginLogger;
};

/**
 * 插件注册的自定义工具。parameters 为 JSON Schema（OpenAI function-calling 格式的
 * parameters 字段），execute 抛出的异常由 executeTool 外层兜底 catch 并转为失败结果。
 */
export type PluginTool = {
  /** 工具名；建议带前缀避免与内置工具冲突。保留名（内置工具名、browser_ 前缀、task/update_plan）会被拒绝 */
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  execute: (input: Record<string, unknown>, ctx: PluginToolContext) => Promise<ToolResult>;
  /** 默认 false；true 则每次调用先走现有审批流（approval_required 事件 → 用户确认） */
  requiresApproval?: boolean;
};

// ---------------------------------------------------------------------------
// 生命周期 hooks
// ---------------------------------------------------------------------------

export type PluginHookName =
  | "tool_call"
  | "tool_result"
  | "prompt_submit"
  | "permission_request"
  | "turn_start"
  | "turn_stop"
  | "turn_end"
  | "session_start"
  // ---- 以下为 v2 扩充的观察类 / 可改写事件（对齐 codex 14 事件与 metis 33 事件）----
  | "session_end"
  | "session_info_changed"
  | "model_switch"
  | "subagent_start"
  | "subagent_stop"
  | "compaction_start"
  | "compaction_end"
  | "interrupt"
  | "tool_execution_start"
  | "tool_execution_end"
  | "assistant_message_start"
  | "assistant_message_end"
  | "context_inject"
  | "before_provider_request";

/** 子 Agent / 根会话标识：CC 兼容 hook 用它区分 Stop/SubagentStop 与审批归组 */
export type PluginHookScope = {
  rootSessionId?: string;
  agentId?: string;
  agentType?: string;
  parentSessionId?: string;
};

export type ToolCallHookEvent = PluginHookScope & {
  hook: "tool_call";
  sessionId: string;
  callId: string;
  tool: string;
  input: Record<string, unknown>;
};
/**
 * block=true → 工具不执行，reason 作为工具结果返回给模型；
 * permission="ask" → 即使自动审批/full 模式也强制人工确认；
 * permission="allow" → 不预批准（调用方忽略）；input → 替换实际执行参数（链式传递）。
 */
export type ToolCallHookResult = {
  block?: boolean;
  reason?: string;
  permission?: "allow" | "ask" | "deny";
  input?: Record<string, unknown>;
};

export type ToolResultHookEvent = PluginHookScope & {
  hook: "tool_result";
  sessionId: string;
  callId: string;
  tool: string;
  /** 最终执行参数（含 tool_call hook 的 updatedInput） */
  input: Record<string, unknown>;
  output: string;
  ok: boolean;
  truncated?: boolean;
};
/** output/ok 可被改写（链式传递，后注册的 handler 看到前者改过的值） */
export type ToolResultHookResult = {
  output?: string;
  ok?: boolean;
};

export type PromptSubmitHookEvent = PluginHookScope & {
  hook: "prompt_submit";
  sessionId: string;
  text: string;
};
/** block=true → 本回合直接结束，reason 以 assistant 消息呈现；text → 替换提交文本 */
export type PromptSubmitHookResult = {
  block?: boolean;
  reason?: string;
  text?: string;
};

/**
 * 审批弹窗出现前的自动应答出口（CC PermissionRequest 语义）：
 * allow → 关闭弹窗并放行；deny → 关闭弹窗并拒绝。没有决定则照常等用户。
 */
export type PermissionRequestHookEvent = PluginHookScope & {
  hook: "permission_request";
  sessionId: string;
  callId: string;
  tool: string;
  input: Record<string, unknown>;
};
export type PermissionRequestHookResult = {
  permission?: "allow" | "deny";
  reason?: string;
};

export type TurnStartHookEvent = {
  hook: "turn_start";
  sessionId: string;
  turnId: string;
  text: string;
};

/**
 * 回合收尾闸（Claude Code Stop hook 语义）：模型没有工具调用、准备结束回合时触发。
 * block=true → reason 作为新的 user 消息注入，循环继续（模型接着干活）；
 * 不 block → 回合正常收尾。stopHookActive 对应 CC 的 stop_hook_active：
 * 已是"拦截后续跑"的一次，脚本可自行避让防止无限循环（循环侧也有次数上限兜底）。
 */
export type TurnStopHookEvent = PluginHookScope & {
  hook: "turn_stop";
  sessionId: string;
  turnId: string;
  stopHookActive: boolean;
  /** 模型本回合最后一条回复的正文 */
  text: string;
};
export type TurnStopHookResult = {
  block?: boolean;
  reason?: string;
};

export type TurnEndHookEvent = {
  hook: "turn_end";
  sessionId: string;
  turnId: string;
  status: "completed" | "aborted" | "error" | "interrupted";
  error?: string;
};

export type SessionStartHookEvent = PluginHookScope & {
  hook: "session_start";
  sessionId: string;
  cwd: string;
};

// ---------------------------------------------------------------------------
// v2 扩充事件
// ---------------------------------------------------------------------------

/** 会话结束：切换走 / 进程关停 / 用户删除 / 子 Agent 关闭。 */
export type SessionEndHookEvent = PluginHookScope & {
  hook: "session_end";
  sessionId: string;
  cwd?: string;
  reason: "switch" | "shutdown" | "delete" | "subagent_close";
};

/** 会话元信息变化（当前只有标题）。 */
export type SessionInfoChangedHookEvent = PluginHookScope & {
  hook: "session_info_changed";
  sessionId: string;
  title: string;
};

/** 当前模型变化：用户切换 / 故障转移 / 会话恢复带入。 */
export type ModelSwitchHookEvent = PluginHookScope & {
  hook: "model_switch";
  sessionId: string;
  from: { providerId?: string; model?: string };
  to: { providerId?: string; model?: string };
  /** fallback = 服务商故障自动切换；restore = 切回会话时恢复上次模型 */
  source: "user" | "fallback" | "restore";
};

export type SubagentStartHookEvent = PluginHookScope & {
  hook: "subagent_start";
  /** 父会话 id */
  sessionId: string;
  agentId: string;
  agentType?: string;
  description: string;
  background?: boolean;
  /** 派发时给子 Agent 的任务描述（截断后的） */
  prompt?: string;
};

export type SubagentStopHookEvent = PluginHookScope & {
  hook: "subagent_stop";
  sessionId: string;
  agentId: string;
  agentType?: string;
  description?: string;
  status: "completed" | "failed" | "aborted";
  error?: string;
  durationMs?: number;
};

/** 压缩开始：manual（用户 /compact）/ threshold（占用超阈值）/ overflow（溢出兜底）/ warmup（后台预热） */
export type CompactionStartHookEvent = PluginHookScope & {
  hook: "compaction_start";
  sessionId: string;
  compactionId: string;
  reason: "manual" | "overflow" | "threshold" | "warmup";
  beforeTokens?: number;
  messageCount?: number;
};

export type CompactionEndHookEvent = PluginHookScope & {
  hook: "compaction_end";
  sessionId: string;
  compactionId: string;
  status: "completed" | "failed" | "skipped";
  summary?: string;
  afterTokens?: number;
};

/** 回合被中止：用户点停止 / 强制插话 / 进程关停。 */
export type InterruptHookEvent = PluginHookScope & {
  hook: "interrupt";
  sessionId: string;
  reason: "user_abort" | "steer" | "shutdown" | "subagent_abort";
  source?: "user" | "system";
  turnId?: string;
};

/**
 * 工具「真的开始执行」。
 * 与 tool_call 的区别：tool_call 在决策前（可能被 block / 门禁 / 计划模式拦下），
 * 本事件只在 executeTool 真正被调用时触发 —— 两者数量不等即为被拦下的调用。
 */
export type ToolExecutionStartHookEvent = PluginHookScope & {
  hook: "tool_execution_start";
  sessionId: string;
  callId: string;
  tool: string;
  input: Record<string, unknown>;
  /** 只读批里的并行执行 */
  parallel?: boolean;
  startedAt: number;
};

export type ToolExecutionEndHookEvent = PluginHookScope & {
  hook: "tool_execution_end";
  sessionId: string;
  callId: string;
  tool: string;
  input: Record<string, unknown>;
  /** 送给模型的原始输出（未截断 / 未去重） */
  output: string;
  ok: boolean;
  durationMs: number;
  error?: string;
};

/** 每个模型轮次开始（可能一轮里有多次工具往返）。 */
export type AssistantMessageStartHookEvent = PluginHookScope & {
  hook: "assistant_message_start";
  sessionId: string;
  turnId?: string;
  roundId?: string;
};

/** 一条 assistant 消息落盘后（含工具调用轮里的中间文本）。 */
export type AssistantMessageEndHookEvent = PluginHookScope & {
  hook: "assistant_message_end";
  sessionId: string;
  turnId?: string;
  text: string;
  toolCallCount: number;
};

/**
 * 往上下文注入内容（缓存安全）：返回的每条 notes 作为 context_note 追加到历史尾部，
 * 不进入系统提示、不改请求前缀，因此不会让 prompt cache 整段失效。
 */
export type ContextInjectHookEvent = PluginHookScope & {
  hook: "context_inject";
  sessionId: string;
  turnId: string;
  /** 用户本轮输入，供插件判断该注入什么 */
  text: string;
  phase: "turn_start";
};
export type ContextInjectHookResult = {
  notes?: string[];
};

/**
 * 请求发出前的语义层改写：改的是「将要发给模型的消息与工具」，不是各协议最终 JSON。
 * 注意：改写 messages 前缀会让 prompt cache 整段失效，只有在确实必要时才动。
 */
export type BeforeProviderRequestHookEvent = PluginHookScope & {
  hook: "before_provider_request";
  sessionId: string;
  providerId: string;
  model: string;
  protocol: string;
  messages: ChatMessage[];
  toolNames: string[];
  maxTokens?: number;
  /** 缓存断点已规划的数量：插件改写前缀后此值不再准确 */
  cacheBreakpoints?: number;
};
export type BeforeProviderRequestHookResult = {
  messages?: ChatMessage[];
  /** 只允许替换同名工具的描述 / schema，不允许增删工具（增删请用 registerTool） */
  tools?: unknown[];
  /** 合并进请求体的额外字段（各家协议自行透传） */
  extraBody?: Record<string, unknown>;
};

export type PluginHookEventMap = {
  tool_call: ToolCallHookEvent;
  tool_result: ToolResultHookEvent;
  prompt_submit: PromptSubmitHookEvent;
  permission_request: PermissionRequestHookEvent;
  turn_start: TurnStartHookEvent;
  turn_stop: TurnStopHookEvent;
  turn_end: TurnEndHookEvent;
  session_start: SessionStartHookEvent;
  session_end: SessionEndHookEvent;
  session_info_changed: SessionInfoChangedHookEvent;
  model_switch: ModelSwitchHookEvent;
  subagent_start: SubagentStartHookEvent;
  subagent_stop: SubagentStopHookEvent;
  compaction_start: CompactionStartHookEvent;
  compaction_end: CompactionEndHookEvent;
  interrupt: InterruptHookEvent;
  tool_execution_start: ToolExecutionStartHookEvent;
  tool_execution_end: ToolExecutionEndHookEvent;
  assistant_message_start: AssistantMessageStartHookEvent;
  assistant_message_end: AssistantMessageEndHookEvent;
  context_inject: ContextInjectHookEvent;
  before_provider_request: BeforeProviderRequestHookEvent;
};

export type PluginHookResultMap = {
  tool_call: ToolCallHookResult;
  tool_result: ToolResultHookResult;
  prompt_submit: PromptSubmitHookResult;
  permission_request: PermissionRequestHookResult;
  turn_start: void;
  turn_stop: TurnStopHookResult;
  turn_end: void;
  session_start: void;
  session_end: void;
  session_info_changed: void;
  model_switch: void;
  subagent_start: void;
  subagent_stop: void;
  compaction_start: void;
  compaction_end: void;
  interrupt: void;
  tool_execution_start: void;
  tool_execution_end: void;
  assistant_message_start: void;
  assistant_message_end: void;
  context_inject: ContextInjectHookResult;
  before_provider_request: BeforeProviderRequestHookResult;
};

/** hook 命令执行前的确认请求（每次询问模式）；由 runtime 提供审批回执 */
export type HookCommandApprovalRequest = {
  /** CC 事件名，例如 PreToolUse / Stop */
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
  source?: string;
};

/**
 * 第二个 handler 参数：敏感操作（hook 命令审批）与中止信号。
 * 现有只关心 event 的插件可忽略。
 */
export type PluginHookContext = {
  requestApproval?: (request: HookCommandApprovalRequest) => Promise<boolean>;
  signal?: AbortSignal;
  /** MeowCode 审批模式 / 会话模式，bridge 映射成 CC 的 permission_mode */
  permissionMode?: string;
  chatMode?: string;
};

export type PluginHandler<N extends PluginHookName> = (
  event: PluginHookEventMap[N],
  context?: PluginHookContext,
) => PluginHookResultMap[N] | void | Promise<PluginHookResultMap[N] | void>;

// ---------------------------------------------------------------------------
// 命令 / 存储 / 入口
// ---------------------------------------------------------------------------

/** 插件注册的斜杠命令（代码式；markdown 声明式命令由 commands 模块另行发现） */
export type PluginCommand = {
  name: string;
  description?: string;
  run: (args: string) => string | Promise<string>;
};

/** 命令索引条目（代码式 + markdown 式统一形态；/plugins/commands 与 Composer 用） */
export type PluginCommandInfo = {
  name: string;
  description?: string;
  /** "plugin:<id>" | "project" | "user" */
  source: string;
};

/** 插件命名空间化 KV 存储：~/.meowcode/plugin-data/<pluginId>.json */
export type PluginStorage = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
};

/**
 * 插件入口：与 metis ExtensionFactory 同构。模块默认导出（或模块本身）是工厂函数，
 * 加载器调用一次完成全部注册；抛错则该插件被禁用，不影响其他插件。
 */
export type PluginFactory = (api: PluginAPI) => void | Promise<void>;

export interface PluginAPI {
  /** 注册 LLM 可调用工具；重名/保留名会被拒绝并通过 logger 告警 */
  registerTool(tool: PluginTool): void;
  /** 订阅生命周期 hook */
  on<N extends PluginHookName>(event: N, handler: PluginHandler<N>): void;
  /** 注册斜杠命令；重名被拒 */
  registerCommand(cmd: PluginCommand): void;
  storage: PluginStorage;
  logger: PluginLogger;
  readonly workspace: string;
}

// ---------------------------------------------------------------------------
// 发现 / 加载结果（UI 数据源）
// ---------------------------------------------------------------------------

export type PluginSource = "project" | "user" | "builtin";

export type PluginDescriptor = {
  id: string;
  path: string;
  source: PluginSource;
  enabled: boolean;
  /** 加载失败原因（或被遮蔽/禁用说明），设置页红字展示 */
  error?: string;
  toolNames?: string[];
  commandNames?: string[];
  hookEvents?: string[];
  /** 内置插件显示名（builtin 元数据；其他来源缺省，UI 回落 id） */
  displayName?: string;
  /** 内置插件介绍（builtin 元数据；其他来源缺省，UI 回落市场条目描述） */
  description?: string;
  /** 内置插件图标 dataUrl（builtin 元数据；其他来源缺省，UI 回落市场图标表） */
  iconUrl?: string;
  /**
   * 插件自带的界面面板：`<插件目录>/ui/index.html` 存在时自动登记。
   * 渲染层用 iframe 加载（`GET /plugin-ui/<id>/...`），单文件插件无法携带 UI。
   */
  ui?: PluginUiDescriptor;
};

export type PluginLoadError = { path: string; error: string };

/** 插件面板描述：入口固定为插件目录里的 ui/index.html（相对路径，不含目录前缀）。 */
export type PluginUiDescriptor = {
  panel: {
    /** 面板标题（缺省用插件 id） */
    title: string;
    /** ui/ 目录内的相对入口，如 "index.html" */
    entry: string;
  };
};

export type LoadPluginsResult = {
  descriptors: PluginDescriptor[];
  errors: PluginLoadError[];
};
