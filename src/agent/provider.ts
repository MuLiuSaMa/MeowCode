import type {
  ApiFormat,
  ChatMessage,
  ProviderConfig,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from "./types.js";
import { anthropicTools, streamAnthropicMessages, toAnthropicMessages } from "./anthropic.js";
import { resolveCachePlan } from "./cache-profile.js";
import { fetchWithRetry } from "./http.js";
import { readSseFrames } from "./sse.js";
import { responsesTools, streamResponses, toResponsesInput } from "./responses.js";
import { ProviderRequestError } from "./provider-error.js";
import { isToolCallComplete, summarizeToolCalls, type ToolCallProgress } from "./tool-progress.js";

export type StreamCompletionResult = {
  message: Extract<ChatMessage, { role: "assistant" }>;
  usage?: TokenUsage;
  /** 服务商声明的结束原因；length 表示达到输出上限，内容被截断 */
  finishReason?: string;
  /** Responses 增量链：仅当本次响应被 store:true 留存时返回（codex 式 previous_response_id） */
  responseId?: string;
};

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
  // 已带 /vN 就只补后缀，否则补 /v1 + 后缀
  return /\/v\d+$/.test(trimmed) ? `${trimmed}${suffix}` : `${trimmed}/v1${suffix}`;
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
      // imageRefs / documentRefs 只是回放层的落盘引用，不发给模型
      const { imageRefs: _imageRefs, documentRefs: _documentRefs, ...rest } = message as ChatMessage & {
        imageRefs?: unknown;
        documentRefs?: unknown;
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
  onDelta: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onToolCall?: (progress: ToolCallProgress) => void;
  /** 流式中某个工具调用参数完整闭合时立即回调（实验：流中提前执行只读工具） */
  onToolCallComplete?: (call: ToolCall) => void;
  /** 传工具定义但禁止实际调用（压缩摘要复用主前缀时需要） */
  toolChoice?: "none";
}): Promise<StreamCompletionResult> {
  const url = completionUrl(options.provider.baseUrl, "openai-chat-completions");
  const buildBody = (includeUsage: boolean) => ({
    model: options.provider.model,
    messages: toChatCompletionMessages(options.messages),
    tools: options.tools,
    stream: true,
    // 请求服务商回传真实用量（OpenAI 标准字段）。上下文占用圆圈依赖它；
    // 严格网关不认识该字段会报 400，下面会降级去掉重试一次。
    ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
    ...(options.provider.maxTokens ? { max_tokens: options.provider.maxTokens } : {}),
    // 仅在用户显式设置了思考强度时才下发，避免不支持的网关因未知字段报 400
    ...(options.provider.reasoningEffort ? { reasoning_effort: options.provider.reasoningEffort } : {}),
    ...(options.toolChoice === "none" && options.tools.length
      ? { tool_choice: "none" }
      : {}),
  });
  const doFetch = (includeUsage: boolean) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.provider.apiKey) headers.authorization = `Bearer ${options.provider.apiKey}`;
    return fetchWithRetry(url, {
      method: "POST",
      headers,
      signal: options.signal,
      body: JSON.stringify(buildBody(includeUsage)),
    });
  };

  let response = await doFetch(true);
  if (!response.ok && response.status === 400) {
    const text = await response.text().catch(() => "");
    if (/stream_options/i.test(text)) {
      // 网关不认识 stream_options：去掉再试一次
      response = await doFetch(false);
    } else {
      throw new ProviderRequestError(response.status, text || response.statusText);
    }
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
          parsed.usage.prompt_tokens_details?.cached_tokens ?? parsed.usage.prompt_cache_hit_tokens;
        usage = {
          inputTokens: parsed.usage.prompt_tokens,
          outputTokens: parsed.usage.completion_tokens,
          ...(cachedTokens !== undefined ? { cacheReadTokens: cachedTokens } : {}),
        };
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
  _purpose: "title" | "compaction" | "digest" | "commit" = "compaction",
): ProviderConfig {
  return { ...provider, maxTokens, reasoningEffort: undefined, thinkingBudget: undefined };
}

export async function streamChatCompletion(options: {
  provider: ProviderConfig;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
  onDelta: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onToolCall?: (progress: ToolCallProgress) => void;
  /** 流式中某个工具调用参数完整闭合时立即回调（实验：流中提前执行只读工具） */
  onToolCallComplete?: (call: ToolCall) => void;
  /** 传工具定义但禁止实际调用（压缩摘要复用主前缀时需要） */
  toolChoice?: "none";
}): Promise<StreamCompletionResult> {
  const protocol = options.provider.protocol ?? "openai-chat-completions";
  // 缓存画像在这里解析一次：断点位置、TTL、retention 全部由 cache-profile 决定，
  // 协议层只消费裁剪好的计划（保证任何路径都不会超过 Anthropic 的 4 断点上限）。
  const cachePlan = resolveCachePlan(options.provider);

  if (protocol === "anthropic-messages") {
    const { system, messages } = toAnthropicMessages(options.messages, cachePlan);
    return streamAnthropicMessages({
      url: completionUrl(options.provider.baseUrl, protocol),
      apiKey: options.provider.apiKey,
      model: options.provider.model,
      maxTokens: options.provider.maxTokens,
      reasoningEffort: options.provider.reasoningEffort,
      thinkingBudget: options.provider.thinkingBudget,
      system,
      messages,
      tools: anthropicTools(options.tools, cachePlan),
      toolChoice: options.toolChoice,
      signal: options.signal,
      onDelta: options.onDelta,
      onThinking: options.onThinking,
      onToolCall: options.onToolCall,
      onToolCallComplete: options.onToolCallComplete,
    });
  }

  if (protocol === "openai-responses") {
    const system = options.messages
      .flatMap((message) => (message.role === "system" && message.content ? [message.content] : []))
      .join("\n\n");
    const input = toResponsesInput(options.messages);
    return streamResponses({
      url: completionUrl(options.provider.baseUrl, protocol),
      apiKey: options.provider.apiKey,
      model: options.provider.model,
      maxTokens: options.provider.maxTokens,
      reasoningEffort: options.provider.reasoningEffort,
      reasoningSummary: options.provider.reasoningSummary,
      promptCacheKey: options.provider.promptCacheKey,
      cacheRetention: cachePlan.retention,
      incremental: options.provider.incremental,
      instructions: system,
      input,
      tools: responsesTools(options.tools),
      toolChoice: options.toolChoice,
      signal: options.signal,
      onDelta: options.onDelta,
      onThinking: options.onThinking,
      onToolCall: options.onToolCall,
      onToolCallComplete: options.onToolCallComplete,
    });
  }

  return streamChatCompletions(options);
}
