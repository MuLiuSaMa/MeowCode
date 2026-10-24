import { safeParse } from "./context.js";
import { fetchWithRetry } from "./http.js";
import { parseJson, readSseFrames } from "./sse.js";
import { ProviderRequestError } from "./provider-error.js";
import { isToolCallComplete, summarizeToolCalls, type ToolCallProgress } from "./tool-progress.js";
import {
  cacheControlFor,
  hasBreakpoint,
  resolveCachePlan,
  type CachePlan,
} from "./cache-profile.js";
import { resolveThinkingBudget } from "./thinking-budget.js";
import type {
  AnthropicThinkingBlock,
  ChatMessage,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from "./types.js";

/**
 * Anthropic Messages 协议。
 *
 * 与 OpenAI Chat Completions 的差异：
 *  - `system` 是请求体顶层字段，不是 messages 里的一条
 *  - 工具 schema 是 `{name, description, input_schema}`
 *  - 流式事件是 `content_block_start` / `content_block_delta` / `message_delta`
 *  - 工具调用走 `tool_use` 内容块，参数是 `input_json_delta` 的累加
 */

export const ANTHROPIC_VERSION = "2023-06-01";

/** 原生 Anthropic 与 Anthropic 兼容网关（GLM/Kimi/MiniMax 等）的字段集不同。 */
function isNativeAnthropicEndpoint(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === "api.anthropic.com";
  } catch {
    return false;
  }
}

/** DeepSeek 的 Anthropic 端点按 ZCode 的映射：thinking + output_config.effort，不认顶层 reasoning_effort。 */
function isDeepSeekEndpoint(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().endsWith("deepseek.com");
  } catch {
    return false;
  }
}

/** effort 档位 → thinking.budget_tokens 的映射已收敛到 thinking-budget.ts。 */

/**
 * 未传入画像时的默认值：Anthropic 官方口径（4 断点）。
 * 保留这个默认是为了让 toAnthropicMessages / anthropicTools 的调用方
 * （测试、压缩摘要复用前缀等）不必每次都手工构造 plan。
 */
const NATIVE_PLAN: CachePlan = resolveCachePlan({
  id: "",
  name: "",
  baseUrl: "https://api.anthropic.com",
  model: "claude",
  protocol: "anthropic-messages",
});

/** 断点的 cache_control 值（含 TTL）；NONE 画像返回 undefined。 */
function cacheTag(plan: CachePlan): Record<string, unknown> | undefined {
  const control = cacheControlFor(plan);
  return control ? { cache_control: control } : undefined;
}

/** 未启用 thinking 时，历史里的 thinking 块不能回传：Anthropic 只允许它们出现在启用思考的请求里。 */
function stripThinkingBlocks(
  messages: Array<Record<string, unknown>>,
  keep: boolean,
): Array<Record<string, unknown>> {
  if (keep) return messages;
  return messages.map((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
    const blocks = (message.content as Array<Record<string, unknown>>).filter(
      (block) => block.type !== "thinking" && block.type !== "redacted_thinking",
    );
    return { ...message, content: blocks.length ? blocks : "" };
  });
}

export type AnthropicSystemBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; ttl?: "1h" };
};

export function anthropicTools(
  tools: ToolDefinition[],
  plan: CachePlan = NATIVE_PLAN,
): Array<Record<string, unknown>> {
  const tag = hasBreakpoint(plan, "tools") ? cacheTag(plan) : undefined;
  return tools.map((tool, index) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
    // 最后一个工具后打缓存断点：稳定工具目录整体可复用。
    // Qwen 等不认 tools 断点的画像在这里拿不到 tag，自然不打。
    ...(index === tools.length - 1 && tag ? tag : {}),
  }));
}

/** 把对话历史的最后一条消息打上缓存断点：下次请求可复用整段前缀。 */
function markLastMessageCacheable(out: Array<Record<string, unknown>>, plan: CachePlan): void {
  if (!hasBreakpoint(plan, "tail")) return;
  const control = cacheControlFor(plan);
  if (!control) return;
  const last = out.at(-1);
  if (!last) return;
  const content = last.content;
  if (typeof content === "string") {
    if (!content) return;
    last.content = [{ type: "text", text: content, cache_control: control }];
    return;
  }
  if (Array.isArray(content) && content.length) {
    const tail = content.at(-1) as Record<string, unknown> | undefined;
    if (tail && typeof tail === "object") tail.cache_control = control;
  }
}

/** 递归剥离 cache_control：部分网关整体拒绝该字段，降级重试时连同消息一起清理。 */
function stripCacheControl<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => stripCacheControl(item)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === "cache_control") continue;
      out[key] = stripCacheControl(item);
    }
    return out as T;
  }
  return value;
}

/** 把内部消息列表转成 Anthropic 的 messages（system 单独提出去）。 */
export function toAnthropicMessages(
  messages: ChatMessage[],
  plan: CachePlan = NATIVE_PLAN,
): {
  system: AnthropicSystemBlock[];
  messages: Array<Record<string, unknown>>;
} {
  const system: AnthropicSystemBlock[] = messages
    .filter(
      (message): message is Extract<ChatMessage, { role: "system" }> =>
        message.role === "system" && Boolean(message.content),
    )
    .map((message) => ({ type: "text", text: message.content }));
  // 断点打在 system[0]（基础指令）和 system[1]（AGENTS.md，最长稳定段）：
  // systemMessages() 的排列是 [base, instructions?, mode?] —— 旧逻辑把断点给末条
  // mode 消息（几百 token），AGENTS.md（可达 4k+ token）整段全价，是缓存的最大漏点。
  // mode 切换频率高、体积小，让它留在断点之外全价发送更划算。
  // 断点总数由 cache-profile 统一裁剪：官方 4 个 / Qwen 2 个 / 未知网关 0 个。
  const systemTag = cacheTag(plan);
  if (systemTag) {
    if (hasBreakpoint(plan, "system0") && system.length) Object.assign(system[0], systemTag);
    if (hasBreakpoint(plan, "system1") && system.length > 1) Object.assign(system[1], systemTag);
  }
  const rest = messages.filter((message) => message.role !== "system");

  const out: Array<Record<string, unknown>> = [];
  for (const message of rest) {
    // 原生压缩点（目前只由 OpenAI Responses 产出）：Anthropic 无法重放加密 item，
    // 降级为一条 user 说明，保证模型知道更早历史已被压缩。
    if (message.role === "native_compaction") {
      out.push({
        role: "user",
        content: `[Earlier conversation history was compacted by the provider. Treat the following as context, not as a new request.]\n${message.content}`,
      });
      continue;
    }
    if (message.role === "user") {
      // 用户附图/文档：Anthropic 用 content 块数组承载 text + image + document
      if (message.images?.length || message.documents?.length) {
        out.push({
          role: "user",
          content: [
            ...(message.content ? [{ type: "text", text: message.content }] : []),
            ...message.images?.map((image) => ({
              type: "image",
              source: { type: "base64", media_type: image.mimeType, data: image.data },
            })) ?? [],
            ...(message.documents ?? []).map((document) => ({
              type: "document",
              source: {
                type: "base64",
                media_type: document.mimeType,
                data: document.data,
              },
              ...(document.name ? { title: document.name } : {}),
            })),
          ],
        });
        continue;
      }
      out.push({ role: "user", content: message.content ?? "" });
      continue;
    }
    if (message.role === "assistant") {
      const blocks: Array<Record<string, unknown>> = [];
      // thinking 块必须排在 text / tool_use 之前，且保持原样（含签名）
      for (const block of message.anthropic_thinking ?? []) {
        if (block.type === "thinking") {
          if (block.thinking && block.signature) {
            blocks.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
          }
        } else if (block.data) {
          blocks.push({ type: "redacted_thinking", data: block.data });
        }
      }
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of message.tool_calls ?? []) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input: safeParse(call.function.arguments),
        });
      }
      out.push({ role: "assistant", content: blocks.length ? blocks : "" });
      continue;
    }
    if (message.role === "tool") {
      // 截图等图片随工具结果回传：Anthropic 用 tool_result 的内容块数组承载
      const content = message.images?.length
        ? [
            { type: "text", text: message.content },
            ...message.images.map((image) => ({
              type: "image",
              source: { type: "base64", media_type: image.mimeType, data: image.data },
            })),
          ]
        : message.content;
      const block = { type: "tool_result", tool_use_id: message.tool_call_id, content };
      // 并行批次的所有 tool_result 必须放在紧随 tool_use 的同一条 user 消息里，
      // 否则 Anthropic 报 "tool_use ids were found without tool_result blocks immediately after"。
      const previous = out.at(-1);
      if (previous?.role === "user" && Array.isArray(previous.content)) {
        (previous.content as Array<Record<string, unknown>>).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      // 工具带来的 PDF（扫描件回退）：tool_result 里只放文本，文档块追加在同一条
      // user 消息的末尾，既保持 tool_result 紧邻 tool_use，又不丢文档。
      if (message.documents?.length) {
        const host = out.at(-1) as { content: Array<Record<string, unknown>> };
        for (const document of message.documents) {
          host.content.push({
            type: "document",
            source: { type: "base64", media_type: document.mimeType, data: document.data },
            ...(document.name ? { title: document.name } : {}),
          });
        }
      }
    }
  }
  markLastMessageCacheable(out, plan);
  return { system, messages: out };
}

type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  /** 缓存读取（命中）的输入 token */
  cache_read_input_tokens?: number;
  /** 写入缓存的输入 token */
  cache_creation_input_tokens?: number;
};

type AnthropicChunk = {
  type?: string;
  message?: { usage?: AnthropicUsage };
  index?: number;
  content_block?: { type?: string; id?: string; name?: string; thinking?: string; signature?: string; data?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  usage?: AnthropicUsage;
  error?: { message?: string };
};

export async function streamAnthropicMessages(options: {  url: string;
  apiKey?: string;
  model: string;
  maxTokens?: number;
  reasoningEffort?: string;
  /** 显式思考预算（provider.thinkingBudget），覆盖按档位推导的值 */
  thinkingBudget?: number;
  system: AnthropicSystemBlock[];
  messages: Array<Record<string, unknown>>;
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
}> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
  };
  // 空 apiKey = 用服务商原生鉴权（DSH 的约定），此时不带鉴权头
  if (options.apiKey) headers["x-api-key"] = options.apiKey;

  const native = isNativeAnthropicEndpoint(options.url);
  const deepseek = isDeepSeekEndpoint(options.url);
  // 原生 Anthropic：档位/显式预算 → budget_tokens（由 thinking-budget 统一钳制）。
  // 非原生端点仍走 reasoning_effort / output_config：它们多半不认 thinking 字段，
  // 显式预算在那里只作为"用户想多思考"的意图，由 effort 表达。
  const nativeBudget = resolveThinkingBudget({
    effort: options.reasoningEffort,
    explicit: options.thinkingBudget,
    maxTokens: options.maxTokens,
  });
  const thinkingBudget = native ? nativeBudget : undefined;
  let useThinking = native
    ? thinkingBudget !== undefined
    : deepseek && Boolean(options.reasoningEffort);
  let useCacheControl = true;

  const buildBody = (withCache: boolean, withThinking: boolean) => ({
    model: options.model,
    max_tokens: options.maxTokens ?? 8192,
    system: options.system.length
      ? options.system.map((block) =>
          withCache ? block : { type: block.type, text: block.text },
        )
      : undefined,
    messages: stripThinkingBlocks(
      withCache ? options.messages : stripCacheControl(options.messages),
      withThinking,
    ),
    tools: options.tools.length
      ? options.tools.map((tool) =>
          withCache
            ? tool
            : Object.fromEntries(Object.entries(tool).filter(([key]) => key !== "cache_control")),
        )
      : undefined,
    ...(options.toolChoice === "none" && options.tools.length
      ? { tool_choice: { type: "none" } }
      : {}),
    stream: true,
    // 原生 Anthropic 用 thinking.budget_tokens；DeepSeek 用 thinking + output_config.effort；
    // 其他兼容网关只认 reasoning_effort。三者互斥。
    ...(deepseek
      ? withThinking && options.reasoningEffort
        ? { thinking: { type: "enabled" }, output_config: { effort: options.reasoningEffort } }
        : {}
      : !native && options.reasoningEffort
        ? { reasoning_effort: options.reasoningEffort }
        : {}),
    ...(withThinking && thinkingBudget !== undefined
      ? { thinking: { type: "enabled", budget_tokens: thinkingBudget } }
      : {}),
  });
  const send = (withCache: boolean, withThinking: boolean) =>
    fetchWithRetry(options.url, {
      method: "POST",
      headers,
      signal: options.signal,
      body: JSON.stringify(buildBody(withCache, withThinking)),
    });

  let response = await send(useCacheControl, useThinking);
  let failureText = "";
  if (!response.ok) {
    failureText = await response.text().catch(() => "");
    // 部分 Anthropic 兼容网关不认识 cache_control：仅在明确是缓存字段问题时降级重试一次。
    if (
      (response.status === 400 || response.status === 422) &&
      /cache_control|prompt.?cach|unknown.*cache|invalid.*cache/i.test(failureText)
    ) {
      useCacheControl = false;
      response = await send(useCacheControl, useThinking);
      failureText = response.ok ? "" : await response.text().catch(() => "");
    }
    // 模型或网关不支持扩展思考：去掉 thinking 与历史 thinking 块再试一次。
    if (
      !response.ok &&
      useThinking &&
      (response.status === 400 || response.status === 422) &&
      /thinking|budget_tokens/i.test(failureText)
    ) {
      useThinking = false;
      response = await send(useCacheControl, false);
      failureText = response.ok ? "" : await response.text().catch(() => "");
    }
    if (!response.ok) {
      throw new ProviderRequestError(response.status, failureText || response.statusText);
    }
  }

  if (!response.body) {
    throw new ProviderRequestError(response.status, "Response body is missing.");
  }

  const content: string[] = [];
  const reasoning: string[] = [];
  const toolCalls = new Map<number, ToolCall>();
  const completedBlocks = new Set<number>();
  // thinking 块按 content block index 累积；带签名的整块才能在下一次请求里回灌
  const thinkingBlocks = new Map<
    number,
    { type: "thinking"; text: string[]; signature: string } | { type: "redacted_thinking"; data: string }
  >();
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cachedInputTokens: number | undefined;
  let cacheCreationInputTokens: number | undefined;
  let finishReason: string | undefined;
  let sawTerminal = false;

  /** message_start / message_delta 都可能携带用量；缓存与输入字段用 max 合并，避免后来的 0 覆盖真实值 */
  const applyUsage = (usage: AnthropicUsage | undefined) => {
    if (!usage) return;
    if (usage.input_tokens !== undefined) {
      inputTokens = Math.max(inputTokens ?? 0, usage.input_tokens);
    }
    if (usage.output_tokens !== undefined) outputTokens = usage.output_tokens;
    if (usage.cache_read_input_tokens !== undefined) {
      cachedInputTokens = Math.max(cachedInputTokens ?? 0, usage.cache_read_input_tokens);
    }
    if (usage.cache_creation_input_tokens !== undefined) {
      cacheCreationInputTokens = Math.max(
        cacheCreationInputTokens ?? 0,
        usage.cache_creation_input_tokens,
      );
    }
  };

  await readSseFrames(
    response.body,
    (data) => {
      if (data === "[DONE]") {
        sawTerminal = true;
        return;
      }
      const chunk = parseJson<AnthropicChunk>(data);
      if (!chunk) return;
      if (chunk.error?.message) throw new Error(chunk.error.message);
      if (chunk.type === "message_stop") sawTerminal = true;

      applyUsage(chunk.message?.usage);
      applyUsage(chunk.usage);

      if (chunk.type === "message_delta" && chunk.delta?.stop_reason) {
        finishReason =
          chunk.delta.stop_reason === "max_tokens"
            ? "length"
            : chunk.delta.stop_reason === "tool_use"
              ? "tool_calls"
              : "stop";
      }

      if (chunk.type === "content_block_start") {
        const index = chunk.index ?? 0;
        if (chunk.content_block?.type === "thinking") {
          thinkingBlocks.set(index, {
            type: "thinking",
            text: [chunk.content_block.thinking ?? ""],
            signature: "",
          });
          return;
        }
        if (chunk.content_block?.type === "redacted_thinking") {
          thinkingBlocks.set(index, {
            type: "redacted_thinking",
            data: chunk.content_block.data ?? "",
          });
          return;
        }
        // 工具调用开始：记下 index → 一条 ToolCall
        if (chunk.content_block?.type === "tool_use") {
          toolCalls.set(index, {
            id: chunk.content_block.id ?? "",
            type: "function",
            function: { name: chunk.content_block.name ?? "", arguments: "" },
          });
          options.onToolCall?.(summarizeToolCalls(toolCalls.values()));
        }
        return;
      }
      if (chunk.type === "content_block_delta") {
        // 签名增量：与 thinking 文本一起构成可回灌的完整块
        if (chunk.delta?.type === "signature_delta" && chunk.delta.signature) {
          const block = thinkingBlocks.get(chunk.index ?? 0);
          if (block?.type === "thinking") block.signature += chunk.delta.signature;
          return;
        }
        // 思考内容：thinking 块的增量（GLM / Claude / Kimi 等走 anthropic 协议时的思考流）
        if (chunk.delta?.type === "thinking_delta" && chunk.delta.thinking) {
          reasoning.push(chunk.delta.thinking);
          const block = thinkingBlocks.get(chunk.index ?? 0);
          if (block?.type === "thinking") block.text.push(chunk.delta.thinking);
          options.onThinking?.(chunk.delta.thinking);
          return;
        }
        if (chunk.delta?.type === "text_delta" && chunk.delta.text) {
          content.push(chunk.delta.text);
          options.onDelta(chunk.delta.text);
        }
        // input_json_delta：工具参数按增量累加
        if (chunk.delta?.type === "input_json_delta" && chunk.delta.partial_json) {
          const index = chunk.index ?? 0;
          const current = toolCalls.get(index);
          if (current) {
            current.function.arguments += chunk.delta.partial_json;
            options.onToolCall?.(summarizeToolCalls(toolCalls.values()));
            // 只对 tool_use 块触发；参数闭合即刻回调（每个块只触发一次）
            if (
              options.onToolCallComplete &&
              !completedBlocks.has(index) &&
              isToolCallComplete(current)
            ) {
              completedBlocks.add(index);
              options.onToolCallComplete({ ...current, function: { ...current.function } });
            }
          }
        }
      }
    },
    options.signal,
  );

  if (!sawTerminal && !finishReason) {
    throw new Error("Model stream ended before completion; the response may be incomplete.");
  }

  const calls = [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value);
  const text = content.join("");
  const reasoningText = reasoning.join("");
  // 只有文本与签名都完整的块才能回灌；缺签名的思考块宁可丢弃
  const thinking = [...thinkingBlocks.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([, block]): AnthropicThinkingBlock[] => {
      if (block.type === "redacted_thinking") {
        return block.data ? [{ type: "redacted_thinking", data: block.data }] : [];
      }
      const thinkingText = block.text.join("");
      return thinkingText && block.signature
        ? [{ type: "thinking", thinking: thinkingText, signature: block.signature }]
        : [];
    });
  // Anthropic 的 input_tokens 不含缓存部分：对外统一成总输入 = 普通输入 + 缓存读取 + 缓存写入
  const hasUsage =
    inputTokens !== undefined || cachedInputTokens !== undefined || cacheCreationInputTokens !== undefined;
  const totalInputTokens = hasUsage
    ? (inputTokens ?? 0) + (cachedInputTokens ?? 0) + (cacheCreationInputTokens ?? 0)
    : undefined;
  return {
    message: calls.length
      ? {
          role: "assistant",
          content: text || null,
          ...(reasoningText ? { reasoning: reasoningText } : {}),
          ...(thinking.length ? { anthropic_thinking: thinking } : {}),
          tool_calls: calls,
        }
      : {
          role: "assistant",
          content: text,
          ...(reasoningText ? { reasoning: reasoningText } : {}),
          ...(thinking.length ? { anthropic_thinking: thinking } : {}),
        },
    usage: {
      ...(totalInputTokens !== undefined ? { inputTokens: totalInputTokens } : {}),
      outputTokens,
      ...(cachedInputTokens !== undefined ? { cacheReadTokens: cachedInputTokens } : {}),
      ...(cacheCreationInputTokens !== undefined
        ? { cacheWriteTokens: cacheCreationInputTokens }
        : {}),
    },
    ...(finishReason ? { finishReason } : {}),
  };
}
