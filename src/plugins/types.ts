import type { ToolResult } from "../agent/types.js";

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
  | "turn_start"
  | "turn_end"
  | "session_start";

export type ToolCallHookEvent = {
  hook: "tool_call";
  sessionId: string;
  callId: string;
  tool: string;
  input: Record<string, unknown>;
};
/** block=true → 工具不执行，reason 作为工具结果返回给模型；input → 替换实际执行参数（链式传递） */
export type ToolCallHookResult = {
  block?: boolean;
  reason?: string;
  input?: Record<string, unknown>;
};

export type ToolResultHookEvent = {
  hook: "tool_result";
  sessionId: string;
  callId: string;
  tool: string;
  output: string;
  ok: boolean;
  truncated?: boolean;
};
/** output/ok 可被改写（链式传递，后注册的 handler 看到前者改过的值） */
export type ToolResultHookResult = {
  output?: string;
  ok?: boolean;
};

export type PromptSubmitHookEvent = {
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

export type TurnStartHookEvent = {
  hook: "turn_start";
  sessionId: string;
  turnId: string;
  text: string;
};

export type TurnEndHookEvent = {
  hook: "turn_end";
  sessionId: string;
  turnId: string;
  status: "completed" | "aborted" | "error" | "interrupted";
  error?: string;
};

export type SessionStartHookEvent = {
  hook: "session_start";
  sessionId: string;
  cwd: string;
};

export type PluginHookEventMap = {
  tool_call: ToolCallHookEvent;
  tool_result: ToolResultHookEvent;
  prompt_submit: PromptSubmitHookEvent;
  turn_start: TurnStartHookEvent;
  turn_end: TurnEndHookEvent;
  session_start: SessionStartHookEvent;
};

export type PluginHookResultMap = {
  tool_call: ToolCallHookResult;
  tool_result: ToolResultHookResult;
  prompt_submit: PromptSubmitHookResult;
  turn_start: void;
  turn_end: void;
  session_start: void;
};

export type PluginHandler<N extends PluginHookName> = (
  event: PluginHookEventMap[N],
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

export type PluginSource = "project" | "user";

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
};

export type PluginLoadError = { path: string; error: string };

export type LoadPluginsResult = {
  descriptors: PluginDescriptor[];
  errors: PluginLoadError[];
};
