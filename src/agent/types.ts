export type ToolName =
  | "list_dir"
  | "read_file"
  | "glob"
  | "grep"
  | "write_file"
  | "edit_file"
  | "multi_edit"
  | "run_command"
  | "update_plan"
  | "task"
  | "browser_navigate"
  | "browser_snapshot"
  | "browser_click"
  | "browser_type"
  | "browser_screenshot"
  | "browser_back"
  | "browser_reload";

export type SubagentStatus = "running" | "completed" | "failed" | "aborted" | "interrupted";

/**
 * 子 Agent 角色（metis 式角色注册表的键）：每个角色在 agent-definition.ts
 * 里有一份定义（系统提示词、工具白名单、可关闭的 gate）。general 保持全量
 * 工具不受白名单约束；explore 只读；planner 只读出方案；implementer 读写实现；
 * reviewer / verifier 只读，分别负责 G5 评审与 G6 验证。
 */
export type AgentRole =
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

/** 通用子 Agent / 只读探索子 Agent（历史名，等价于 AgentRole） */
export type SubagentType = AgentRole;

/** 一次模型调用的用量摘要（子 Agent 汇报给父会话/前端展示） */
export type UsageSummary = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

/** 子 Agent 事件由父 runtime 广播时附加的来源信息 */
export type AgentEventMeta = {
  agentId?: string;
  parentSessionId?: string;
  agentDescription?: string;
};

export type MeowEvent = AgentEventMeta &
  (
  | { type: "server.connected"; version: string }
  | {
      type: "message_start";
      sessionId: string;
      /** 由排队消息启动的回合：对应排队项 id，前端据此把消息放进时间线 */
      queuedId?: string;
    }
  /** 模型思考内容（reasoning/thinking）的流式增量，先于正文 delta */
  | { type: "thinking_delta"; sessionId: string; delta: string }
  | { type: "assistant_delta"; sessionId: string; delta: string }
  | { type: "message_complete"; sessionId: string; text: string; reasoning?: string }
  | { type: "tool_started"; sessionId: string; callId: string; tool: string; input: unknown }
  | { type: "tool_output"; sessionId: string; callId: string; output: string; truncated: boolean }
  | { type: "tool_finished"; sessionId: string; callId: string; ok: boolean }
  | {
      type: "approval_required";
      sessionId: string;
      callId: string;
      tool: string;
      input: unknown;
      diff?: string;
      /** 明显危险的命令特征；仅作提示，模型/用户仍可自行决定 */
      risk?: CommandRisk;
      /** 审批期间文件被改动，预览已重新生成 */
      stale?: boolean;
    }
  | { type: "error"; sessionId: string; message: string }
  /** ask_user 虚拟工具：模型提出澄清问题（可批量多题），回合挂起等用户点选/输入（答案作为工具结果） */
  | {
      type: "ask_user";
      sessionId: string;
      callId: string;
      questions: Array<{ question: string; options: string[] }>;
    }
  | {
      type: "usage";
      sessionId: string;
      /** 本次调用总输入（含缓存读/写） */
      inputTokens?: number;
      outputTokens?: number;
      /** 缓存读取的输入 token；未报告时不带 */
      cacheReadTokens?: number;
      /** 写入缓存的输入 token（Anthropic 类协议）；未报告时不带 */
      cacheWriteTokens?: number;
    }
  | { type: "turn_complete"; sessionId: string }
  /**
   * 供应商故障转移：可重试错误（超时 / 429 / 5xx）触发了 fallback 链切换。
   * from/to 为 provider id，reason 是错误分类，供前端提示"当前服务方"已变更。
   */
  | {
      type: "provider_switched";
      sessionId: string;
      from: string;
      to: string;
      reason: string;
    }
  | {
      type: "plan_updated";
      sessionId: string;
      steps: PlanStep[];
      explanation?: string;
    }
  /** 会话模式切换（plan/goal/default）；前端据此刷新 Composer 徽章 */
  | { type: "session_mode"; sessionId: string; mode: SessionMode }
  /** 主 Agent 档位切换（standard/minimal/complex）；前端据此刷新 Composer 胶囊 */
  | { type: "agent_profile"; sessionId: string; profile: AgentProfileId }
  /** 计划模式下计划文档写入完成；前端弹出「开始执行 / 调整计划」确认面板 */
  | { type: "plan_documented"; sessionId: string; path: string }
  /** 上下文溢出，开始压缩历史（摘要请求可能耗时数秒） */
  | { type: "compaction_started"; sessionId: string }  | { type: "compaction_completed"; sessionId: string; summary: string }
  /** 压缩失败（摘要请求报错/被中止）：清掉前端的压缩状态 */
  | { type: "compaction_failed"; sessionId: string; message: string }
  /**
   * 后台预热压缩（不阻塞回合）：占用过阈值就提前生成摘要，溢出时直接采用。
   * started/completed/failed 三相；前端可显示为轻提示，不要按“压缩中”阻塞输入。
   */
  | {
      type: "compaction_warmup";
      sessionId: string;
      phase: "started" | "completed" | "failed";
      error?: string;
    }
  /** 会话标题已生成 / 已更新（AI 自动生成或用户手动改名） */
  | { type: "session_title"; sessionId: string; title: string }
  /** 文件被 Agent 修改（审阅面板数据源） */
  | { type: "file_changed"; sessionId: string; path: string; operation: "write_file" | "edit_file" }
  /** 模型正在流式生成工具调用参数（只用于进度提示，不落盘） */
  | {
      type: "tool_call_progress";
      sessionId: string;
      /** 已出现的工具调用数量 */
      count: number;
      /** 最近一个工具的名字（可能还没开始输出参数） */
      tool?: string;
      /** 当前所有工具调用的名字（用于判断是否全是 task） */
      names?: string[];
      /** 已生成的参数字符数，仅用于节流/进度判断 */
      chars?: number;
      /** 已经能完整读出的目标文件路径（写/改文件时用于提前显示文件名） */
      path?: string;
    }
  /** 子 Agent 已启动；sessionId 为父会话 */
  | {
      type: "subagent_started";
      sessionId: string;
      parentSessionId: string;
      agentId: string;
      callId: string;
      description: string;
      /** 子 Agent 类型与是否后台运行 */
      agentType?: SubagentType;
      background?: boolean;
      /** 子 Agent 的完整任务提示（前端用于运行中页签的初始内容） */
      prompt: string;
      startedAt: string;
    }
  /** 已完成的子 Agent 被用户继续对话 */
  | {
      type: "subagent_resumed";
      sessionId: string;
      parentSessionId: string;
      agentId: string;
      callId: string;
      description: string;
      agentType?: SubagentType;
      background?: boolean;
      prompt: string;
      startedAt: string;
    }
  /** 子 Agent 已结束；sessionId 为父会话 */
  | {
      type: "subagent_completed";
      sessionId: string;
      parentSessionId: string;
      agentId: string;
      callId: string;
      description: string;
      agentType?: SubagentType;
      background?: boolean;
      status: SubagentStatus;
      error?: string;
      /** 最终报告（后台完成通知与 UI 摘要用，已截断） */
      report?: string;
      endedAt: string;
      durationMs: number;
      usage?: UsageSummary;
    }
  /** 治理 run 已准入（admit 工具成功）；roadmap 快照随后单独发 */
  | {
      type: "workflow_admitted";
      sessionId: string;
      tier: "T0" | "T1" | "T2";
      taskShape: string;
      lanes: Array<{ id: string; objective: string; status: string; dependsOn: string[] }>;
    }
  /** 治理 gate 判定落账（架构图定义的门禁 id，缺省 G4/G5/G6） */
  | {
      type: "workflow_gate";
      sessionId: string;
      laneId: string;
      gate: string;
      verdict: "pass" | "fail";
      /** 关 gate 的 agent（root 表示根侧自证） */
      agentId?: string;
      message: string;
    }
  /** 治理 roadmap 快照：每次状态变化（admit/gate/lane 推进）后全量推送 */
  | {
      type: "workflow_roadmap";
      sessionId: string;
      tier: "T0" | "T1" | "T2";
      completed: boolean;
      lanes: Array<{
        id: string;
        objective: string;
        status: string;
        gates: Record<string, string>;
        repairCount: number;
      }>;
    }
  /** 契约角色的宿主校验结果（implementer/reviewer/verifier 结算时） */
  | {
      type: "child_result";
      sessionId: string;
      agentId: string;
      callId: string;
      role: AgentRole;
      result: {
        status: string;
        valid: boolean;
        invalidReason?: string;
        summary: string;
        filesChangedCount: number;
        commandsCount: number;
        criticalFindings: number;
      };
    }
  );

/** 服务商 API 协议。三种都有对应实现（provider.ts 分派）。 */
export type ApiFormat = "anthropic-messages" | "openai-chat-completions" | "openai-responses";

/**
 * 模型输入模态：
 *  - "image"：贴图 / 截图（视频抽帧也走这条通道，不另设 "video"）
 *  - "pdf"：文档块（Anthropic document / Responses input_file）。只有扫描件回退时
 *    才真正下发原文件；文本层能抽出来的一律走本地抽文本（便宜两个数量级）。
 */
export type InputModality = "text" | "image" | "pdf";

export type ProviderConfig = {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  /** 模型显示名；空则回落 model */
  displayName?: string;
  protocol?: ApiFormat;
  /** 服务商目录条目 id，用于取图标 */
  templateId?: string;
  /** 上下文窗口（token 数）；用于按窗口裁剪历史 */
  contextWindow?: number;
  /** 单次最大输出 token 数 */
  maxTokens?: number;
  /** 是否支持前缀缓存；false 时压缩摘要不复用主前缀（默认 true） */
  promptCaching?: boolean;
  inputModalities?: InputModality[];
  apiKey?: string;
  /**
   * 思考强度（reasoning effort）。仅当用户显式选择时才下发 reasoning_effort，
   * 未设置表示沿用服务商默认值。
   */
  reasoningEffort?: string;
  /**
   * 显式思考预算（thinking.budget_tokens）。设置后覆盖按 reasoningEffort 推导的档位；
   * 仍受 maxTokens 钳制（budget 必须严格小于 max_tokens，否则 Anthropic 直接 400）。
   */
  thinkingBudget?: number;
  /**
   * 前缀缓存 TTL。缺省 5m（Anthropic 默认，不发字段）；"1h" 时在断点上带
   * `ttl: "1h"`——只有显式配置才发，避免不支持长 TTL 的网关 400。
   */
  cacheTtl?: "5m" | "1h";
  /**
   * 故障转移链（provider id，按顺序）。留空 = 自动链：当前 provider + 其余
   * enabled provider（设置页顺序），最多 2 跳。显式配置时只走声明的顺序。
   */
  fallbackIds?: string[];
  /**
   * Responses 协议的 reasoning.summary。缺省 "none"（不下发）——思考摘要按输出
   * token 计费，只想要正文时不该为它付钱。
   */
  reasoningSummary?: "none" | "auto" | "concise" | "detailed";
  /** 该模型可选的思考档位；空则用前端的按模型默认表 */
  reasoningLevels?: string[];
  /**
   * Responses 协议的 prompt_cache_key（codex 式缓存亲和）：由 runtime 按
   * sessionId+用途派生注入，会话内稳定。只在 openai-responses 请求体下发，
   * chat completions 不带（部分严格网关会拒绝未知字段）。
   */
  promptCacheKey?: string;
  /**
   * Responses 增量传输（实验开关 incrementalResponses，codex 式 previous_response_id）：
   * runtime 注入链状态。`{}`（无 responseId）= 链首请求：全量发送但 store:true，
   * 服务端留存以便后续续接；带 responseId/fromIndex = 只发新增 input 项。
   * 字段缺省 = 开关关闭，store:false（原行为，本地产品不留存）。
   */
  incremental?: { responseId?: string; fromIndex?: number };
  /** 是否出现在输入框的模型列表里 */
  enabled?: boolean;
  /**
   * 服务端原生压缩开关（默认开启，协议不支持时自动忽略）。
   *  - Anthropic：请求内 context_management 的 compact_20260112 编辑，由服务端
   *    完成摘要并返回可读的 compaction 块，本地不再额外发一次摘要请求；
   *  - OpenAI Responses：POST /responses/compact，返回加密 compaction item，
   *    只在生成它的端点上可重放（换端点/换模型时自动退回本地摘要）。
   * false 时一律走本地摘要路径。
   */
  nativeCompaction?: boolean;
};

export type Settings = {
  workspace?: string;
  providerId?: string;
  providers?: Array<Omit<ProviderConfig, "apiKey"> & { apiKeyEncrypted?: string }>;
};

/** Anthropic 原生扩展思考块：开启 thinking 后，带工具调用的回合必须把这些块原样回传。 */
export type AnthropicThinkingBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

/**
 * 服务端原生压缩产出的不透明载体（目前只有 OpenAI Responses 的
 * /responses/compact 会返回）：加密 item 只能在生成它的 provider/端点/模型上
 * 原样回放，因此必须连同来源一起落盘；来源不匹配时整段丢弃、退回本地摘要。
 */
export type NativeCompactionPayload = {
  providerId: string;
  /** 去掉尾部斜杠的 baseUrl，用于判断端点是否同一处 */
  endpoint: string;
  model: string;
  protocol: ApiFormat;
  /** provider 返回的原始 item（含 encrypted_content），逐字回传 */
  items: Array<Record<string, unknown>>;
};

export type ChatMessage =
  | { role: "system"; content: string }
  | {
      role: "user";
      content: string;
      /**
       * 用户附带的图片（粘贴 / 拖拽 / 选择文件）。
       * 与工具截图一样只在内存里，不写会话 JSONL——base64 会让记录膨胀几个数量级。
       * 落盘副本见 imageRefs（仅回放层附加）。
       */
      images?: ToolImage[];
      /**
       * 文档块（目前只有 PDF，且仅扫描件回退时携带）。同样不落 JSONL，
       * 落盘副本见 documentRefs。
       */
      documents?: ToolDocument[];
    }
  | {
      role: "assistant";
      content: string | null;
      /** 模型思考过程（reasoning_content / thinking），仅存档展示，不回传给服务商 */
      reasoning?: string;
      /** Anthropic 原生 thinking 块（含签名）；只在开启 thinking 的请求里回灌 */
      anthropic_thinking?: AnthropicThinkingBlock[];
      tool_calls?: ToolCall[];
    }
  | {
      role: "tool";
      content: string;
      tool_call_id: string;
      name?: string;
      /** 工具结果附带的图片（如浏览器截图），仅回传当轮请求，不落会话盘 */
      images?: ToolImage[];
      /**
       * 工具结果附带的文档（read_file 读到扫描版 PDF）：只对 Anthropic / Responses
       * 有效，chat completions 不支持 file 块——序列化前由 runtime 拆成紧随的
       * user 消息，见 toResponsesInput / toAnthropicMessages。
       */
      documents?: ToolDocument[];
    }
  | {
      /**
       * 服务端原生压缩载体：content 是给人看/降级用的说明，native.items 是
       * 加密 item。只有 Responses 协议会把它原样放进 input；其他协议降级为
       * 一条 user 说明消息。
       */
      role: "native_compaction";
      content: string;
      native: NativeCompactionPayload;
    };

/** 会话消息上的落盘图片引用：仅 /session/messages 回放层附加（见 SessionStore.messagesForClient），
 *  模型请求组装必须剥掉（provider.ts 的 toChatCompletionMessages 已处理）。 */
export type ChatMessageWithRefs = ChatMessage & {
  imageRefs?: ImageRef[];
  documentRefs?: DocumentRef[];
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
      /**
       * 内置工具一律 false（内置 schema 深校验用）；放宽为可选 boolean，
       * 兼容插件 / MCP 工具转换（MCP 的 inputSchema 保留原值，插件可不填）。
       */
      additionalProperties?: boolean;
    };
  };
};

/** 一次模型调用的用量统计 */
export type TokenUsage = {
  /** 总输入（含缓存读取/写入）：OpenAI/Responses 为 prompt_tokens/input_tokens，
      Anthropic 为 input + cache_read + cache_creation */
  inputTokens?: number;
  outputTokens?: number;
  /** 缓存读取；undefined 表示服务商未报告（与 0 区分） */
  cacheReadTokens?: number;
  /** 写入缓存的输入 token（Anthropic cache_creation_input_tokens） */
  cacheWriteTokens?: number;
};

/** 工具结果附带的图片（base64，不含 data: 前缀） */
export type ToolImage = {
  data: string;
  mimeType: string;
};

/**
 * 文档块（base64，不含 data: 前缀）。目前只有 PDF：三协议里只有 Anthropic 的
 * `document` 块与 Responses 的 `input_file` 能承载，chat completions 直接不给。
 */
export type ToolDocument = {
  data: string;
  mimeType: string;
  /** 展示名（通常是文件名），Anthropic / Responses 都会带上 */
  name: string;
};

/**
 * 工具审批模式（粒度由粗到细）：
 *  - "read-only"：只读，写/改/命令一律拒绝
 *  - "ask"：每次写文件、改文件、跑命令都弹审批（旧版 "default" 的语义）
 *  - "auto"：**可写根（工作区）内的写/改自动批准**，越界路径与命令仍然弹审批（codex 式）
 *  - "full"：全部工具自动放行，并允许工作区外的绝对路径
 */
export type ApprovalMode = "read-only" | "ask" | "auto" | "full";

/** 旧客户端/旧会话仍可能传 "default"，语义等于 "ask"。 */
export type ApprovalModeInput = ApprovalMode | "default";

export function normalizeApprovalMode(value: unknown): ApprovalMode {
  if (value === "default") return "ask";
  if (value === "read-only" || value === "ask" || value === "auto" || value === "full") {
    return value;
  }
  return "auto";
}

export function isApprovalMode(value: unknown): value is ApprovalModeInput {
  return (
    value === "default" ||
    value === "read-only" ||
    value === "ask" ||
    value === "auto" ||
    value === "full"
  );
}

/**
 * 会话模式（与审批模式互不干扰）：
 *  - "default"：现状，无额外指令与门控
 *  - "plan"：计划模式——只读调研 + 只允许写 plans/ 下的计划文档，写完等用户在界面确认
 *  - "goal"：目标模式——只注入"围绕目标连续推进"的指令，不改任何权限
 */
export type SessionMode = "default" | "plan" | "goal";

export function normalizeSessionMode(value: unknown): SessionMode {
  return value === "plan" || value === "goal" ? value : "default";
}

export function isSessionMode(value: unknown): value is SessionMode {
  return value === "default" || value === "plan" || value === "goal";
}

/**
 * 主 Agent 档位（会话级，与审批/会话模式互不干扰）：
 *  - "standard"：现状完整能力（全量工具 + 全部子 Agent 角色）
 *  - "minimal"：极简——只有 read_file / run_command，子 Agent 仅 general / explore
 *  - "complex"：复杂——全量工具 + 编排提示词，允许更多并发子 Agent
 * 档位定义（提示词/工具白名单/角色白名单/并发上限）在 agent-profiles.ts。
 */
export type AgentProfileId = "standard" | "minimal" | "complex";

/** 一个用户回合的最终状态；interrupted 表示进程在回合中途退出。 */
export type TurnStatus = "completed" | "aborted" | "error" | "interrupted";

/** 模型调用的来源：主对话 / 自动标题 / 上下文压缩。 */
export type UsageSource = "chat" | "title" | "compaction";

export type SessionSettings = {
  approvalMode?: ApprovalMode;
  mode?: SessionMode;
  /** 主 Agent 档位（standard/minimal/complex）；缺省 = standard */
  agentProfile?: AgentProfileId;
  /**
   * 会话当前使用的架构图 id（custom-* 自定义架构）；缺省 = 跟随档位。
   * 自定义架构只换图，提示词/工具仍按 agentProfile 走。
   */
  harnessArchitecture?: string;
  providerId?: string;
  model?: string;
  reasoningEffort?: string;
};

export type CompactionPoint = {
  messageIndex: number;
  summary?: string;
  status: "completed" | "interrupted" | "failed";
};

export type CommandRisk = {
  level: "high";
  reasons: string[];
};

/** 正在等待用户确认的工具调用；随 /session 回放，切回会话时恢复审批弹窗。 */
export type PendingApproval = {
  callId: string;
  /** 归属会话：子 Agent 的审批统一记在父会话上 */
  sessionId: string;
  /** 子 Agent 审批时指向发起它的父会话 */
  parentSessionId?: string;
  agentId?: string;
  agentDescription?: string;
  tool: string;
  input: unknown;
  diff?: string;
  risk?: CommandRisk;
  /** 审批期间目标文件被外部改动，diff 已重新生成：这是第二次（也是最后一次）确认 */
  stale?: boolean;
};

export type ToolResult = {
  output: string;
  ok: boolean;
  images?: ToolImage[];
  /** 文档块（扫描版 PDF 回退），与 images 同样只在当轮内存里 */
  documents?: ToolDocument[];
  /** 内容被省略（已落盘或明确提示），UI 用它显示截断标记。 */
  truncated?: boolean;
};

export type PlanStepStatus = "pending" | "in_progress" | "completed" | "cancelled";

export type PlanStep = {
  title: string;
  status: PlanStepStatus;
};

/**
 * 落盘图片的引用：JSONL 消息条目不再内联 base64（会让会话文件膨胀几个数量级），
 * 图片写到 sessions/assets/<sessionId>/ 下，条目里只留相对引用。
 * file 形如 "<sessionId>/<entryId>-<n>.png"，相对 assets 根目录。
 */
export type ImageRef = {
  file: string;
  mimeType: string;
};

/**
 * 落盘文档的引用：与 ImageRef 同构，file 形如 "<sessionId>/<entryId>-<n>.pdf"。
 * 前端回放拿到引用后经 /session/asset 取原文件。
 */
export type DocumentRef = {
  file: string;
  mimeType: string;
  /** 展示名（原文件名） */
  name?: string;
};

export type SessionHeader = {
  type: "session";
  version: 1 | 2;
  id: string;
  cwd: string;
  createdAt: string;
  /** 分支来源会话；仅 v2 新建/分支写入 */
  parentSessionId?: string;
  rootSessionId?: string;
  /** 子 Agent 子会话标记；普通会话/分支不带 */
  agentKind?: "subagent";
  /** 子 Agent 类型；旧子会话缺省视为 general */
  agentType?: SubagentType;
  /** 派发该子 Agent 的父会话 task 工具 callId */
  parentCallId?: string;
  /** 任务描述（页签标题） */
  description?: string;
};

export type SessionEntry =
  | SessionHeader
  | {
      type: "message";
      id: string;
      parentId: string | null;
      timestamp: string;
      message: ChatMessage;
      /** 图片已落盘到 assets/ 时的引用；恢复时按引用读回，旧条目无此字段 */
      imageRefs?: ImageRef[];
      /** 文档（PDF）已落盘时的引用；旧条目无此字段 */
      documentRefs?: DocumentRef[];
    }
  | {
      type: "turn_start";
      id: string;
      parentId: string | null;
      timestamp: string;
      turnId: string;
      /** 由排队消息启动时对应排队项 id */
      queueId?: string;
      /** 直接发送的原始文本；用于崩溃落在 user 消息写入前的恢复 */
      text?: string;
      providerId?: string;
      model?: string;
      approvalMode?: ApprovalMode;
    }
  | {
      type: "turn_end";
      id: string;
      parentId: string | null;
      timestamp: string;
      turnId: string;
      status: TurnStatus;
      error?: string;
    }
  | {
      type: "tool_call_started";
      id: string;
      parentId: string | null;
      timestamp: string;
      turnId: string;
      callId: string;
      tool: string;
      input: unknown;
    }
  | {
      type: "approval_requested";
      id: string;
      parentId: string | null;
      timestamp: string;
      turnId: string;
      callId: string;
      tool: string;
      input: unknown;
      diff?: string;
      risk?: CommandRisk;
    }
  | {
      type: "queued_prompt";
      id: string;
      parentId: string | null;
      timestamp: string;
      queueId: string;
      text: string;
    }
  | {
      type: "queued_prompt_removed";
      id: string;
      parentId: string | null;
      timestamp: string;
      queueId: string;
      reason: "user" | "aborted" | "steered" | "discarded";
    }
  | {
      type: "session_settings";
      id: string;
      parentId: string | null;
      timestamp: string;
      approvalMode?: ApprovalMode;
      mode?: SessionMode;
      agentProfile?: AgentProfileId;
      harnessArchitecture?: string;
      providerId?: string;
      model?: string;
      reasoningEffort?: string;
    }
  | {
      type: "compaction_started";
      id: string;
      parentId: string | null;
      timestamp: string;
      compactionId: string;
      turnId?: string;
      reason: "manual" | "overflow";
      /** 压缩开始时已有多少条对话消息 */
      messageIndex: number;
    }
  | {
      type: "compaction_end";
      id: string;
      parentId: string | null;
      timestamp: string;
      compactionId: string;
      status: "completed" | "failed" | "interrupted";
      error?: string;
    }
  | {
      type: "recovery";
      id: string;
      parentId: string | null;
      timestamp: string;
      actions: string[];
    }
  | {
      type: "approval";
      id: string;
      parentId: string | null;
      timestamp: string;
      callId: string;
      tool: string;
      input: unknown;
      approved: boolean;
      /** 恢复时补写的拒绝记录、可写根内自动批准、计划模式下写计划文档的自动批准 */
      reason?: "restored_denied" | "writable_root" | "plan_mode" | "stale" | "stale_rechecked";
      turnId?: string;
    }
  | {
      type: "title";
      id: string;
      parentId: string | null;
      timestamp: string;
      title: string;
    }
  | {
      type: "plan";
      id: string;
      parentId: string | null;
      timestamp: string;
      steps: PlanStep[];
      explanation?: string;
    }
  | {
      /** 单次模型调用的用量；会话累计由 SessionStore.usageTotals 计算 */
      type: "usage";
      id: string;
      parentId: string | null;
      timestamp: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      /** 未标记的旧记录视为主对话 */
      source?: UsageSource;
      turnId?: string;
      providerId?: string;
      model?: string;
    }
  | {
      /** 一个已完成回合的耗时指标；最后一条用于切换会话后恢复右侧信息 */
      type: "metrics";
      id: string;
      parentId: string | null;
      timestamp: string;
      tokensPerSecond?: number;
      responseMs?: number;
      firstTokenMs?: number;
      turnId?: string;
      status?: TurnStatus;
    }
  | {
      type: "compaction_summary";
      id: string;
      parentId: string | null;
      timestamp: string;
      summary: string;
      /**
       * 压缩点之前仍参与后续请求的真实消息条数（按不可拆单元边界计数）。
       * 摘要只覆盖更早的历史；近期对话逐字保留，避免模型丢失刚读过的文件与最新报错。
       * 旧会话数据缺省视为 0（与旧行为一致：只保留摘要之后的消息）。
       */
      keepRecentMessages?: number;
    }
  | {
      /**
       * 服务端原生压缩点：与 compaction_summary 同位（同样把更早历史挡在重放之外），
       * 但重放时携带 provider 的加密 item 而不是本地摘要文本。
       * summary 只用于 UI/事件与降级说明。
       */
      type: "native_compaction";
      id: string;
      parentId: string | null;
      timestamp: string;
      summary: string;
      native: NativeCompactionPayload;
    }
  | {
      /** 追加式运行时上下文（计划快照 / @文件引用等）；按位置参与后续请求，不显示在聊天时间线 */
      type: "context_note";
      id: string;
      parentId: string | null;
      timestamp: string;
      source: "plan" | "file" | "subagent" | "workflow";
      content: string;
    }
  | {
      /**
       * 旧工具输出的模型纪要（轻量压缩档位）：重放时用纪要替换对应 tool 结果，
       * 会话完整历史仍留在 JSONL 里，UI 时间线也照常显示原文。
       */
      type: "tool_digest";
      id: string;
      parentId: string | null;
      timestamp: string;
      digests: Array<{ callId: string; digest: string }>;
    }
  | {
      /** Agent 对文件的改动记录（审阅面板）：path 为工作区相对路径，diff 为统一 diff 文本 */
      type: "file_change";
      id: string;
      parentId: string | null;
      timestamp: string;
      path: string;
      operation: "write_file" | "edit_file";
      diff: string;
    }
  | {
      /** 父会话里的子 Agent 索引；同一 agentId 以最后一条为准 */
      type: "subagent";
      id: string;
      parentId: string | null;
      timestamp: string;
      agentId: string;
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
    }
  | {
      /** 治理 run 准入（admit 工具成功）；审计用，不参与消息重放 */
      type: "admission";
      id: string;
      parentId: string | null;
      timestamp: string;
      tier: "T0" | "T1" | "T2";
      taskShape: string;
      lanes: Array<{
        id: string;
        objective: string;
        ownedPaths: string[];
        verificationCommands: string[];
        dependsOn: string[];
      }>;
    }
  | {
      /** 治理 gate 判定（G4/G5/G6 pass/fail）；审计用，不参与消息重放 */
      type: "gate_report";
      id: string;
      parentId: string | null;
      timestamp: string;
      laneId: string;
      gate: string;
      verdict: "pass" | "fail";
      /** 关 gate 的子 Agent（或 "root" 表示根侧自证） */
      agentId?: string;
      message: string;
    }
  | {
      /** 契约角色的宿主校验结果；审计用，不参与消息重放 */
      type: "child_result";
      id: string;
      parentId: string | null;
      timestamp: string;
      agentId: string;
      callId: string;
      role: AgentRole;
      payload: {
        status: string;
        valid: boolean;
        invalidReason?: string;
        summary: string;
        filesChanged: string[];
        commands: Array<{ argv: string; exitCode: number }>;
        findingsCount: number;
      };
    };

/** /session 返回的子 Agent 摘要；running 在无 live runtime 时投影为 interrupted */
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

export type PlanEntry = Extract<SessionEntry, { type: "plan" }>;
export type CompactionSummaryEntry = Extract<SessionEntry, { type: "compaction_summary" }>;
export type NativeCompactionEntry = Extract<SessionEntry, { type: "native_compaction" }>;
export type FileChangeEntry = Extract<SessionEntry, { type: "file_change" }>;
export type UsageEntry = Extract<SessionEntry, { type: "usage" }>;
export type MetricsEntry = Extract<SessionEntry, { type: "metrics" }>;



