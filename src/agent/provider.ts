import type {
  ApiFormat,
  ChatMessage,
  ContextEditing,
  ProviderConfig,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from "./types.js";
import { anthropicTools, streamAnthropicMessages, toAnthropicMessages } from "./anthropic.js";
import { estimateMessagesTokens } from "./context.js";
import {
  isOneShotRequest,
  resolveCachePlan,
  supportsChatPromptCacheKey,
  withoutCacheWrites,
} from "./cache-profile.js";
import { buildAuthHeaders, fetchWithRetry, mergeExtraHeaders } from "./http.js";
import { readSseFrames } from "./sse.js";
import { responsesTools, streamResponses, toResponsesInput } from "./responses.js";
import { ProviderRequestError } from "./provider-error.js";
import { isToolCallComplete, summarizeToolCalls, type ToolCallProgress } from "./tool-progress.js";

/** 明确拒绝 parallel_tool_calls 字段的 provider id：之后请求不再携带，避免每趟 400。 */
const parallelToolCallsUnsupportedProviders = new Set<string>();
/** 明确拒绝 prompt_cache_key 字段的 provider id（第三方网关）：之后请求不再携带。 */
const promptCacheKeyUnsupportedProviders = new Set<string>();

export type StreamCompletionResult = {
  message: Extract<ChatMessage, { role: "assistant" }>;
  usage?: TokenUsage;
  /** 服务商声明的结束原因；length 表示达到输出上限，内容被截断 */
  finishReason?: string;
  /** Responses 增量链：仅当本次响应被 store:true 留存时返回（codex 式 previous_response_id） */
  responseId?: string;
};

/** 流中实时用量回调：Anthropic 在 message_start 就给出输入/缓存；OpenAI 仅在尾块。 */
export type UsageListener = (usage: TokenUsage) => void;

/** 部分网关每块都带 usage：值没变就不重复上报，避免前端白刷新。 */
function sameUsage(previous: TokenUsage | undefined, next: TokenUsage): boolean {
  return (
    previous !== undefined &&
    previous.inputTokens === next.inputTokens &&
    previous.outputTokens === next.outputTokens &&
    previous.cacheReadTokens === next.cacheReadTokens &&
    previous.cacheWriteTokens === next.cacheWriteTokens
  );
}

type ProviderChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      /** 思考内容：DeepSeek / GLM / Kimi 等 openai 兼容形态的思考流 */
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: "stop" | "tool_calls" | "length" | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** OpenAI / GLM 等：输入明细里的缓存命中数 */
    prompt_tokens_details?: { cached_tokens?: number };
    /** DeepSeek 兼容：顶层缓存命中数（prompt_tokens 已包含它） */
    prompt_cache_hit_tokens?: number;
    /** 部分兼容网关只给顶层 cached_tokens */
    cached_tokens?: number;
  };
  error?: { message?: string };
};

/**
 * 按协议拼出补全端点。
 *
 * 三种协议的后缀不同，且服务商给的 baseUrl 可能是带 `/v1` 的也可能不带，
 * 所以「已带目标后缀 / 已带 /vN / 都不带」三种情况都要处理。
 */
export function completionUrl(baseUrl: string, protocol: ApiFormat = "openai-chat-completions"): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const suffix =
    protocol === "anthropic-messages"
      ? "/messages"
      : protocol === "openai-responses"
        ? "/responses"
        : "/chat/completions";

  if (trimmed.endsWith(suffix)) return trimmed;
  // 已带 /vN（含 v1beta / v1alpha 这类带后缀的）或 OpenAI 兼容层标记 /openai 时
  // 只补后缀，否则补 /v1 + 后缀。Gemini 的兼容端点是 /v1beta/openai/chat/completions
  // （没有独立的 /v1 段），老正则 \/v\d+$ 匹配不上 v1beta 会拼出 /v1beta/v1/...。
  return /\/v\d+[a-z]*$|\/openai$/i.test(trimmed)
    ? `${trimmed}${suffix}`
    : `${trimmed}/v1${suffix}`;
}

/**
 * OpenAI chat 协议的 tool 消息带截图时需要 content 数组（text + image_url data URL）；
 * 用户附图同理，用 text + image_url 的数组形式。
 * 不带图片的消息保持原样，避免严格网关拒绝数组 content。
 * 图片只存在于当轮内存消息里，不落会话盘。
 *
 * 文档（PDF）在 chat completions 里没有可移植的承载方式（`file` 块兼容性极差），
 * 这里一律不下发，改在正文里补一行说明：模型能读到"有附件但未随请求发送"，
 * 而不是凭空少一段上下文。
 */
function toChatCompletionMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const documentNote = (documents: NonNullable<Extract<ChatMessage, { role: "user" }>["documents"]>) =>
    `[${documents.length} document(s) not sent: this endpoint does not accept file blocks (${documents
      .map((document) => document.name || document.mimeType)
      .join(", ")}). The extracted text is in the message above.]`;

  return messages.map((message) => {
    // 原生压缩的加密 item 只对 Responses 有效：chat completions 降级为一段说明，
    // 让模型知道更早的历史已被服务端压掉（否则它会以为会话从这里才开始）。
    if (message.role === "native_compaction") {
      return {
        role: "user",
        content: `[Earlier conversation history was compacted by the provider. Treat the following as context, not as a new request.]\n${message.content}`,
      };
    }
    if (message.role === "user" && (message.images?.length || message.documents?.length)) {
      const text = [message.content, message.documents?.length ? documentNote(message.documents) : ""]
        .filter(Boolean)
        .join("\n");
      return {
        role: "user",
        content: [
          ...(text ? [{ type: "text", text }] : []),
          ...message.images?.map((image) => ({
            type: "image_url",
            image_url: { url: `data:${image.mimeType};base64,${image.data}` },
          })) ?? [],
        ],
      };
    }
    if (message.role !== "tool" || (!message.images?.length && !message.documents?.length)) {
      // imageRefs / documentRefs 只是回放层的落盘引用；reasoning / anthropic_thinking
      // 也只用于存档展示（见 types.ts 的字段说明），chat completions 不回传。
      const {
        imageRefs: _imageRefs,
        documentRefs: _documentRefs,
        reasoning: _reasoning,
        thinkingMs: _thinkingMs,
        anthropic_thinking: _thinking,
        ...rest
      } = message as ChatMessage & {
        imageRefs?: unknown;
        documentRefs?: unknown;
        reasoning?: unknown;
        thinkingMs?: unknown;
        anthropic_thinking?: unknown;
      };
      return rest as unknown as Record<string, unknown>;
    }
    const text = [
      message.content,
      message.documents?.length ? documentNote(message.documents) : "",
    ]
      .filter(Boolean)
      .join("\n");
    const images = message.images ?? [];
    if (!images.length) {
      // 只有文档、没有图片：退回普通字符串 content，不让网关看到数组
      return {
        role: "tool",
        tool_call_id: message.tool_call_id,
        ...(message.name ? { name: message.name } : {}),
        content: text,
      };
    }
    return {
      role: "tool",
      tool_call_id: message.tool_call_id,
      ...(message.name ? { name: message.name } : {}),
      content: [
        { type: "text", text },
        ...images.map((image) => ({
          type: "image_url",
          image_url: { url: `data:${image.mimeType};base64,${image.data}` },
        })),
      ],
    };
  });
}

async function streamChatCompletions(options: {
  provider: ProviderConfig;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
  /** 网络层尝试次数；缺省沿用 fetchWithRetry 默认（3）。辅助请求传 1 = 失败不重试。 */
  fetchAttempts?: number;
  onDelta: (delta: string) => void;
  onThinking?: (delta: string) => void;
  /** 流中实时用量（同一轮可能多次：输入/缓存先到，输出随后增长） */
  onUsage?: UsageListener;
  onToolCall?: (progress: ToolCallProgress) => void;
  /** 流式中某个工具调用参数完整闭合时立即回调（实验：流中提前执行只读工具） */
  onToolCallComplete?: (call: ToolCall) => void;
  /** 传工具定义但禁止实际调用（压缩摘要复用主前缀时需要） */
  toolChoice?: "none";
}): Promise<StreamCompletionResult> {
  const url = completionUrl(options.provider.baseUrl, "openai-chat-completions");
  const buildBody = (includeUsage: boolean, includeParallel: boolean, includeCacheKey: boolean) => ({
    model: options.provider.model,
    messages: toChatCompletionMessages(options.messages),
    tools: options.tools,
    stream: true,
    // 并行工具调用恒开（对齐 Codex client.rs）：批处理密度直接决定总输入 token。
    // 严格网关不认识会报 400，下面降级去掉重试。
    ...(includeParallel ? { parallel_tool_calls: true } : {}),
    // 会话亲和键：body 字段只发官方主机（第三方网关不认识会 400，下面降级去掉重试）；
    // 网关走 x-session-id 头即可（头不会触发 400），防止代理按会话串缓存分片。
    ...(includeCacheKey &&
    supportsChatPromptCacheKey(options.provider) &&
    options.provider.promptCacheKey
      ? { prompt_cache_key: options.provider.promptCacheKey }
      : {}),
    // 请求服务商回传真实用量（OpenAI 标准字段）。上下文占用圆圈依赖它；
    // 严格网关不认识该字段会报 400，下面会降级去掉重试一次。
    ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
    ...(options.provider.maxTokens ? { max_tokens: options.provider.maxTokens } : {}),
    // 仅在用户显式设置了思考强度时才下发，避免不支持的网关因未知字段报 400
    ...(options.provider.reasoningEffort ? { reasoning_effort: options.provider.reasoningEffort } : {}),
    ...(options.toolChoice === "none" && options.tools.length
      ? { tool_choice: "none" }
      : {}),
    // 用户自定义字段最后展开：同名覆盖内置，用于服务商特有的开关
    // （Qwen/dashscope 的 enable_thinking、vLLM 的 chat_template_kwargs 等）
    ...options.provider.extraBody,
  });
  const doFetch = (includeUsage: boolean, includeParallel: boolean, includeCacheKey: boolean) => {
    const headers = mergeExtraHeaders(
      {
        "content-type": "application/json",
        ...buildAuthHeaders(options.provider.apiKey, options.provider.authStyle, "bearer"),
        // 与 Responses 同源：代理/网关按会话粘住缓存分片（部分代理只认头不认 body）
        ...(options.provider.promptCacheKey
          ? { "x-session-id": options.provider.promptCacheKey }
          : {}),
      },
      options.provider.extraHeaders,
    );
    return fetchWithRetry(
      url,
      {
        method: "POST",
        headers,
        signal: options.signal,
        body: JSON.stringify(buildBody(includeUsage, includeParallel, includeCacheKey)),
      },
      { attempts: options.fetchAttempts },
    );
  };

  // 400 降级记忆：网关拒绝过 parallel_tool_calls / prompt_cache_key 就不再发
  // （每个请求多一趟 400 很贵）
  const omit = {
    usage: false,
    parallel: parallelToolCallsUnsupportedProviders.has(options.provider.id),
    cacheKey: promptCacheKeyUnsupportedProviders.has(options.provider.id),
  };
  let response = await doFetch(!omit.usage, !omit.parallel, !omit.cacheKey);
  for (let fallbacks = 0; !response.ok && response.status === 400 && fallbacks < 2; fallbacks += 1) {
    const text = await response.text().catch(() => "");
    if (!omit.usage && /stream_options/i.test(text)) {
      // 网关不认识 stream_options：去掉再试一次
      omit.usage = true;
    } else if (!omit.cacheKey && /prompt_cache_key/i.test(text)) {
      omit.cacheKey = true;
      promptCacheKeyUnsupportedProviders.add(options.provider.id);
    } else if (!omit.parallel && /parallel_tool_calls/i.test(text)) {
      omit.parallel = true;
      parallelToolCallsUnsupportedProviders.add(options.provider.id);
    } else {
      throw new ProviderRequestError(response.status, text || response.statusText);
    }
    response = await doFetch(!omit.usage, !omit.parallel, !omit.cacheKey);
  }
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new ProviderRequestError(response.status, text || response.statusText);
  }

  const content: string[] = [];
  const reasoning: string[] = [];
  const toolCalls = new Map<number, ToolCall>();
  const completedCalls = new Set<number>();
  let usage: StreamCompletionResult["usage"];
  let reportedUsage: TokenUsage | undefined;
  let finishReason: string | undefined;
  let sawDone = false;

  await readSseFrames(
    response.body,
    (data) => {
      if (data === "[DONE]") {
        sawDone = true;
        return;
      }
      let parsed: ProviderChunk;
      try {
        parsed = JSON.parse(data) as ProviderChunk;
      } catch {
        return;
      }
      if (parsed.error?.message) throw new Error(parsed.error.message);
      if (parsed.usage) {
        // 缓存命中：OpenAI 走 prompt_tokens_details.cached_tokens，DeepSeek 用顶层 prompt_cache_hit_tokens
        const cachedTokens =
          parsed.usage.prompt_tokens_details?.cached_tokens ??
          parsed.usage.prompt_cache_hit_tokens ??
          parsed.usage.cached_tokens;
        usage = {
          inputTokens: parsed.usage.prompt_tokens,
          outputTokens: parsed.usage.completion_tokens,
          ...(cachedTokens !== undefined ? { cacheReadTokens: cachedTokens } : {}),
        };
        if (!sameUsage(reportedUsage, usage)) {
          reportedUsage = usage;
          options.onUsage?.(usage);
        }
      }
      const choice = parsed.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      const delta = choice?.delta;
      // 思考内容增量（reasoning_content 是 DeepSeek/GLM 的事实标准，reasoning 是部分网关的变体）
      const thinkingDelta = delta?.reasoning_content ?? delta?.reasoning;
      if (thinkingDelta) {
        reasoning.push(thinkingDelta);
        options.onThinking?.(thinkingDelta);
      }
      if (delta?.content) {
        content.push(delta.content);
        options.onDelta(delta.content);
      }
      for (const partial of delta?.tool_calls ?? []) {
        const index = partial.index ?? 0;
        const current: ToolCall = toolCalls.get(index) ?? {
          id: "",
          type: "function" as const,
          function: { name: "", arguments: "" },
        };
        if (partial.id) current.id = partial.id;
        if (partial.function?.name) current.function.name = partial.function.name;
        if (partial.function?.arguments) current.function.arguments += partial.function.arguments;
        toolCalls.set(index, current);
        options.onToolCall?.(summarizeToolCalls(toolCalls.values()));
        // 参数闭合即刻回调（每个 call 只触发一次）；调用方拿快照自行决定是否提前执行
        if (
          options.onToolCallComplete &&
          !completedCalls.has(index) &&
          isToolCallComplete(current)
        ) {
          completedCalls.add(index);
          options.onToolCallComplete({ ...current, function: { ...current.function } });
        }
      }
    },
    options.signal,
  );

  if (!sawDone && !finishReason) {
    throw new Error("Model stream ended before completion; the response may be incomplete.");
  }

  const calls = [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value);
  const text = content.join("");
  const reasoningText = reasoning.join("");
  return {
    message: calls.length
      ? {
          role: "assistant",
          content: text || null,
          ...(reasoningText ? { reasoning: reasoningText } : {}),
          tool_calls: calls,
        }
      : { role: "assistant", content: text, ...(reasoningText ? { reasoning: reasoningText } : {}) },
    usage,
    ...(finishReason ? { finishReason } : {}),
  };
}

/**
 * 按服务商声明的协议分派。三种协议都由各自模块实现请求体与流式解析。
 */
/**
 * 辅助请求（标题 / 工具纪要 / 压缩摘要）不应继承主对话的推理强度：
 * 这些任务要的是短文本压缩，不是深度思考，thinking 会白烧几千 token。
 * 显式 thinkingBudget 同样要剥掉 —— 否则用户填的 8192 会在每个标题请求上重付一次。
 *
 * purpose 只用于诊断/日志；真正的行为差异由调用方选的 maxTokens 决定。
 */
export function utilityProvider(
  provider: ProviderConfig,
  maxTokens: number,
  _purpose:
    | "title"
    | "compaction"
    | "digest"
    | "commit"
    | "polish"
    | "memory"
    | "learning"
    | "suggestion"
    | "mail" = "compaction",
): ProviderConfig {
  return { ...provider, maxTokens, reasoningEffort: undefined, thinkingBudget: undefined };
}

export async function streamChatCompletion(options: {
  provider: ProviderConfig;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  /** Anthropic tools 断点锚点（会话目录快照末尾）；其他协议忽略 */
  toolCacheAnchor?: number;
  signal?: AbortSignal;
  /** 网络层尝试次数；缺省沿用 fetchWithRetry 默认（3）。辅助请求传 1 = 失败不重试。 */
  fetchAttempts?: number;
  onDelta: (delta: string) => void;
  onThinking?: (delta: string) => void;
  /** 流中实时用量（同一轮可能多次：输入/缓存先到，输出随后增长） */
  onUsage?: UsageListener;
  /**
   * 每请求最终用量：成功时取返回结果，失败时取流中最后观察到的快照。
   * 后台一次性请求用它落账，避免把流中的多个累计快照当成多次调用。
   */
  onUsageFinal?: UsageListener;
  onToolCall?: (progress: ToolCallProgress) => void;
  /** 流式中某个工具调用参数完整闭合时立即回调（实验：流中提前执行只读工具） */
  onToolCallComplete?: (call: ToolCall) => void;
  /** 传工具定义但禁止实际调用（压缩摘要复用主前缀时需要） */
  toolChoice?: "none";
  /**
   * 缓存写入意图：
   *  - auto（默认）：一次性请求（无工具、无 assistant/tool 轮、user 轮 ≤1）不打标记，
   *    因为它的写入永远读不回来。
   *  - prefix-reuse：本次请求复用了主对话前缀（压缩摘要）。不做一次性判形，
   *    且把写入断点前移到合成指令之前 —— 指令本身不会被后续请求读回。
   */
  cacheMode?: "auto" | "prefix-reuse";
  /**
   * 服务端 context editing（Anthropic clear_tool_uses）：只对支持它的端点传。
   * 传了也不会白亏 —— 端点报错时协议层会去掉字段重试并记住。
   */
  contextEditing?: ContextEditing;
}): Promise<StreamCompletionResult> {
  const protocol = options.provider.protocol ?? "openai-chat-completions";
  const oneShot =
    options.cacheMode !== "prefix-reuse" && isOneShotRequest(options.messages, options.tools);
  // 一次性请求（标题 / 记忆 / 学习 / 工具纪要）永远不会被读回：丢掉亲和键，
  // 别让它写一份没人读的缓存、还把主会话的条目挤出分片。
  // 1024 是 OpenAI 的缓存粒度下限，低于它的请求本来也不写，保持原样。
  const provider =
    oneShot && estimateMessagesTokens(options.messages) >= 1_024
      ? { ...options.provider, promptCacheKey: undefined }
      : options.provider;
  // 缓存画像在这里解析一次：断点位置、TTL、retention 全部由 cache-profile 决定，
  // 协议层只消费裁剪好的计划（保证任何路径都不会超过 Anthropic 的 4 断点上限）。
  const cachePlan = oneShot
    ? withoutCacheWrites(resolveCachePlan(provider))
    : resolveCachePlan(provider);

  let latestUsage: TokenUsage | undefined;
  const onUsage =
    options.onUsage || options.onUsageFinal
      ? (usage: TokenUsage) => {
          latestUsage = usage;
          options.onUsage?.(usage);
        }
      : undefined;
  // 一次性请求只认最终值；失败时保留流中已观察到的部分用量（输入/缓存可能已计费）。
  const run = async <T extends StreamCompletionResult>(request: () => Promise<T>): Promise<T> => {
    try {
      const result = await request();
      const finalUsage = result.usage ?? latestUsage;
      if (finalUsage) options.onUsageFinal?.(finalUsage);
      return result;
    } catch (error) {
      if (latestUsage) options.onUsageFinal?.(latestUsage);
      throw error;
    }
  };

  if (protocol === "anthropic-messages") {
    const { system, messages } = toAnthropicMessages(options.messages, cachePlan, {
      skipTailCacheWrite: options.cacheMode === "prefix-reuse",
    });
    return run(() =>
      streamAnthropicMessages({
        url: completionUrl(provider.baseUrl, protocol),
        providerId: provider.id,
        apiKey: provider.apiKey,
        authStyle: provider.authStyle,
        extraHeaders: provider.extraHeaders,
        extraBody: provider.extraBody,
        model: provider.model,
        maxTokens: provider.maxTokens,
        reasoningEffort: provider.reasoningEffort,
        thinkingBudget: provider.thinkingBudget,
        promptCacheKey: provider.promptCacheKey,
        ...(options.contextEditing ? { contextEditing: options.contextEditing } : {}),
        system,
        messages,
        tools: anthropicTools(options.tools, cachePlan, options.toolCacheAnchor),
        toolChoice: options.toolChoice,
        signal: options.signal,
        fetchAttempts: options.fetchAttempts,
        onDelta: options.onDelta,
        onThinking: options.onThinking,
        onUsage,
        onToolCall: options.onToolCall,
        onToolCallComplete: options.onToolCallComplete,
      }),
    );
  }

  if (protocol === "openai-responses") {
    const system = options.messages
      .flatMap((message) => (message.role === "system" && message.content ? [message.content] : []))
      .join("\n\n");
    const input = toResponsesInput(options.messages);
    return run(() =>
      streamResponses({
        url: completionUrl(provider.baseUrl, protocol),
        apiKey: provider.apiKey,
        authStyle: provider.authStyle,
        extraHeaders: provider.extraHeaders,
        extraBody: provider.extraBody,
        model: provider.model,
        maxTokens: provider.maxTokens,
        reasoningEffort: provider.reasoningEffort,
        reasoningSummary: provider.reasoningSummary,
        promptCacheKey: provider.promptCacheKey,
        cacheRetention: cachePlan.retention,
        incremental: provider.incremental,
        instructions: system,
        input,
        tools: responsesTools(options.tools),
        toolChoice: options.toolChoice,
        signal: options.signal,
        fetchAttempts: options.fetchAttempts,
        onDelta: options.onDelta,
        onThinking: options.onThinking,
        onUsage,
        onToolCall: options.onToolCall,
        onToolCallComplete: options.onToolCallComplete,
      }),
    );
  }

  return run(() => streamChatCompletions({ ...options, provider, onUsage }));
}
