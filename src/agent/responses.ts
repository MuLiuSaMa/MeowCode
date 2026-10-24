import { fetchWithRetry } from "./http.js";
import { parseJson, readSseFrames } from "./sse.js";
import { ProviderRequestError } from "./provider-error.js";
import { isToolCallComplete, summarizeToolCalls, type ToolCallProgress } from "./tool-progress.js";
import type { ChatMessage, TokenUsage, ToolCall, ToolDefinition } from "./types.js";

/**
 * OpenAI Responses 协议。
 *
 * 与 Chat Completions 的差异：
 *  - 端点是 `/responses`（不是 `/chat/completions`）
 *  - `instructions` 取代 system message，`input` 是扁平的消息/输出项数组
 *  - 推理强度走 `reasoning: { effort }`
 *  - 流式事件是 `response.output_text.delta` / `response.output_item.added` /
 *    `response.function_call_arguments.delta` / `response.completed`
 */

export function responsesTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));
}

/** 把内部消息列表摊平成 Responses 的 input 数组。 */
export function toResponsesInput(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") continue; // 走 instructions
    // 服务端原生压缩：加密 item 必须逐字回放到生成它的端点。
    // 端点/模型变了就不能再用（provider 会拒绝），此处只按 payload 原样发出，
    // 是否可用由 runtime 在落盘前判定（来源不匹配会改走本地摘要）。
    if (message.role === "native_compaction") {
      for (const item of message.native.items) out.push(item);
      continue;
    }
    if (message.role === "user") {
      // 用户附图/文档：Responses 的 input 用 input_text / input_image / input_file 块数组
      if (message.images?.length || message.documents?.length) {
        out.push({
          role: "user",
          content: [
            ...(message.content ? [{ type: "input_text", text: message.content }] : []),
            ...message.images?.map((image) => ({
              type: "input_image",
              image_url: `data:${image.mimeType};base64,${image.data}`,
            })) ?? [],
            ...(message.documents ?? []).map((document) => ({
              type: "input_file",
              filename: document.name || "document.pdf",
              file_data: `data:${document.mimeType};base64,${document.data}`,
            })),
          ],
        });
        continue;
      }
      out.push({ role: "user", content: message.content ?? "" });
      continue;
    }
    if (message.role === "assistant") {
      if (message.content) out.push({ role: "assistant", content: message.content });
      for (const call of message.tool_calls ?? []) {
        out.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
      continue;
    }
    if (message.role === "tool") {
      // function_call_output 只收字符串：工具附带的图片/文档必须拆成紧随的 user 消息，
      // 否则会被静默丢弃（browser_screenshot 在 responses 协议下丢图的老问题）。
      out.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: message.content,
      });
      if (message.images?.length || message.documents?.length) {
        out.push({
          role: "user",
          content: [
            {
              type: "input_text",
              text: `[Tool result attachments from ${message.name ?? "tool"}]`,
            },
            ...message.images?.map((image) => ({
              type: "input_image",
              image_url: `data:${image.mimeType};base64,${image.data}`,
            })) ?? [],
            ...(message.documents ?? []).map((document) => ({
              type: "input_file",
              filename: document.name || "document.pdf",
              file_data: `data:${document.mimeType};base64,${document.data}`,
            })),
          ],
        });
      }
    }
  }
  return out;
}

type ResponsesChunk = {
  type?: string;
  delta?: string;
  item?: {
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  response?: {
    /** 服务端留存的响应 id（store:true 时返回）；增量链用它续接 */
    id?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      /** 输入明细：缓存命中的 token 数（input_tokens 已包含它） */
      input_tokens_details?: { cached_tokens?: number };
    };
    status?: string;
    incomplete_details?: { reason?: string };
    error?: { message?: string };
  };
  error?: { message?: string };
};

export async function streamResponses(options: {
  url: string;
  apiKey?: string;
  model: string;
  maxTokens?: number;
  reasoningEffort?: string;
  /** 思考摘要档位；缺省 "none" = 不下发（摘要按输出 token 计费） */
  reasoningSummary?: "none" | "auto" | "concise" | "detailed";
  /** OpenAI Responses 的 prompt_cache_key：会话派生的稳定值，提升前缀缓存命中率 */
  promptCacheKey?: string;
  /** 官方端点 + 白名单模型才给 24h 保留；缺省不下发 */
  cacheRetention?: "24h";
  /**
   * 增量传输（实验 incrementalResponses）：带 responseId 时只发 input.slice(fromIndex)
   * 并携带 previous_response_id + store:true；失败（网关不认识字段 / 链失效）自动
   * 回落全量重发一次。responseId 缺省但字段存在 = 链首请求：全量 + store:true。
   * 字段缺省 = 关闭，store:false。
   */
  incremental?: { responseId?: string; fromIndex?: number };
  instructions: string;
  input: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
  /** 传工具定义但禁止实际调用（压缩摘要复用主前缀时需要） */
  toolChoice?: "none";
  signal?: AbortSignal;
  onDelta: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onToolCall?: (progress: ToolCallProgress) => void;
  /** 流式中某个工具调用参数完整闭合时立即回调（实验：流中提前执行只读工具） */
  onToolCallComplete?: (call: ToolCall) => void;
}): Promise<{
  message: Extract<ChatMessage, { role: "assistant" }>;
  usage?: TokenUsage;
  finishReason?: string;
  /** 仅当本次请求被服务端 store:true 留存时返回；后续请求可用它续接增量链 */
  responseId?: string;
}> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
  // 会话亲和：与 prompt_cache_key 同源，让中间代理/网关按会话粘住缓存分片，
  // 避免两个会话的前缀互相顶掉（部分代理只认 header 不认 body）。
  if (options.promptCacheKey) headers["x-session-id"] = options.promptCacheKey;

  const inc = options.incremental;
  const incrementalActive = Boolean(inc);
  const chainUsable = Boolean(
    inc?.responseId &&
      typeof inc.fromIndex === "number" &&
      inc.fromIndex >= 0 &&
      inc.fromIndex <= options.input.length,
  );
  // 回落开关：链首失败后置 false，重发全量（仍然 store:true，重新成为链首）
  let sendIncremental = chainUsable;

  const buildBody = () => ({
    model: options.model,
    instructions: options.instructions || undefined,
    // 增量链上只发新增项（历史由服务端按 previous_response_id 续接）
    input: sendIncremental ? options.input.slice(inc!.fromIndex) : options.input,
    tools: options.tools.length ? options.tools : undefined,
    ...(options.toolChoice === "none" && options.tools.length
      ? { tool_choice: "none" }
      : {}),
    stream: true,
    // 增量模式必须 store:true（previous_response_id 依赖服务端留存）；
    // 关闭时维持原行为：Responses 默认 store=true，本地产品显式关闭。
    store: incrementalActive ? true : false,
    ...(sendIncremental ? { previous_response_id: inc!.responseId } : {}),
    // 缓存亲和：同一会话的请求路由到同一缓存分片（codex prompt_cache_key 同款思路）
    ...(options.promptCacheKey ? { prompt_cache_key: options.promptCacheKey } : {}),
    // 24h 保留只在官方端点 + 白名单模型下发（第三方网关不认这个字段）。
    ...(options.cacheRetention ? { prompt_cache_retention: options.cacheRetention } : {}),
    ...(options.maxTokens ? { max_output_tokens: options.maxTokens } : {}),
    // 思考摘要默认不下发：summary 会额外产出 token，只要正文时不该为它付费。
    ...(options.reasoningEffort
      ? {
          reasoning: {
            effort: options.reasoningEffort,
            ...(options.reasoningSummary && options.reasoningSummary !== "none"
              ? { summary: options.reasoningSummary }
              : {}),
          },
        }
      : {}),
  });

  const doFetch = () =>
    fetchWithRetry(options.url, {
      method: "POST",
      headers,
      signal: options.signal,
      body: JSON.stringify(buildBody()),
    });

  let response = await doFetch();
  if (!response.ok && incrementalActive && (response.status === 400 || response.status === 404)) {
    // 链失效（response id 过期/未找到）或网关拒绝增量字段：全量重发一次。
    // 仍保持 store:true —— 重发的响应重新成为可续接的链首。
    sendIncremental = false;
    response = await doFetch();
  }

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new ProviderRequestError(response.status, text || response.statusText);
  }

  const content: string[] = [];
  const reasoning: string[] = [];
  const toolCalls = new Map<string, ToolCall>();
  const completedCalls = new Set<string>();
  let usage: TokenUsage | undefined;
  let finishReason: string | undefined;
  let sawTerminal = false;
  // 只有 store:true 的成功请求才回传 responseId —— 调用方据此决定增量链是否延续
  let storedResponseId: string | undefined;

  await readSseFrames(
    response.body,
    (data) => {
      if (data === "[DONE]") {
        sawTerminal = true;
        return;
      }
      const chunk = parseJson<ResponsesChunk>(data);
      if (!chunk) return;
      if (chunk.error?.message) throw new Error(chunk.error.message);
      if (chunk.type === "response.failed") {
        throw new Error(chunk.response?.error?.message ?? "Model response failed.");
      }
      if (chunk.type === "response.completed" || chunk.type === "response.incomplete") {
        sawTerminal = true;
      }

      // 思考摘要增量（reasoning summary；非所有服务商都开启）
      if (chunk.type === "response.reasoning_summary_text.delta" && chunk.delta) {
        reasoning.push(chunk.delta);
        options.onThinking?.(chunk.delta);
        return;
      }
      if (chunk.type === "response.output_text.delta" && chunk.delta) {
        content.push(chunk.delta);
        options.onDelta(chunk.delta);
        return;
      }
      if (chunk.type === "response.output_item.added" && chunk.item?.type === "function_call") {
        const callId = chunk.item.call_id ?? "";
        toolCalls.set(callId, {
          id: callId,
          type: "function",
          function: { name: chunk.item.name ?? "", arguments: "" },
        });
        options.onToolCall?.(summarizeToolCalls(toolCalls.values()));
        return;
      }
      if (chunk.type === "response.function_call_arguments.delta" && chunk.delta) {
        const current = [...toolCalls.values()].at(-1);
        if (current) {
          current.function.arguments += chunk.delta;
          options.onToolCall?.(summarizeToolCalls(toolCalls.values()));
          // 参数闭合即刻回调（每个 call 只触发一次）
          if (
            options.onToolCallComplete &&
            !completedCalls.has(current.id) &&
            isToolCallComplete(current)
          ) {
            completedCalls.add(current.id);
            options.onToolCallComplete({ ...current, function: { ...current.function } });
          }
        }
        return;
      }
      if (
        (chunk.type === "response.completed" || chunk.type === "response.incomplete") &&
        chunk.response?.usage
      ) {
        const reported = chunk.response.usage;
        // input_tokens 已包含缓存命中部分，原样作为总输入
        const cachedTokens = reported.input_tokens_details?.cached_tokens;
        usage = {
          inputTokens: reported.input_tokens,
          outputTokens: reported.output_tokens,
          ...(cachedTokens !== undefined ? { cacheReadTokens: cachedTokens } : {}),
        };
      }
      if (incrementalActive && chunk.response?.id) {
        storedResponseId = chunk.response.id;
      }
      if (
        chunk.type === "response.incomplete" ||
        (chunk.response?.status === "incomplete" && chunk.type !== "response.completed")
      ) {
        finishReason =
          chunk.response?.incomplete_details?.reason === "max_output_tokens" ? "length" : "stop";
      }
    },
    options.signal,
  );

  if (!sawTerminal) {
    throw new Error("Model stream ended before completion; the response may be incomplete.");
  }

  const calls = [...toolCalls.values()];
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
    ...(incrementalActive && storedResponseId ? { responseId: storedResponseId } : {}),
  };
}
