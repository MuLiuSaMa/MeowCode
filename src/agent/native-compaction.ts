import { toAnthropicMessages } from "./anthropic.js";
import { compactionSummaryMaxTokens } from "./compaction.js";
import { estimateMessagesTokens, estimateToolDefinitionsTokens } from "./context.js";
import { fetchWithRetry } from "./http.js";
import { completionUrl } from "./provider.js";
import { responsesTools, toResponsesInput } from "./responses.js";
import type {
  ChatMessage,
  NativeCompactionPayload,
  ProviderConfig,
  TokenUsage,
  ToolDefinition,
} from "./types.js";

/**
 * 服务端原生压缩。
 *
 * 本地摘要的代价是「压缩这一下要再发一遍全量输入」，而两家服务商都提供了
 * 由服务端完成压缩的通道：
 *
 *  - Anthropic `context_management.edits[].type = "compact_20260112"`：
 *    在请求里声明「输入超过 N token 就压缩」，服务端把更早的对话折成一段
 *    摘要并以 compaction 内容块返回（可读文本），本地直接当摘要用。
 *    `pause_after_compaction` 让服务端压完就停，不再继续生成正文。
 *  - OpenAI Responses `POST /responses/compact`：返回
 *    `{ object: "response.compaction", output: [compaction item, ...] }`，
 *    其中 compaction item 的 `encrypted_content` 是服务端加密的历史，
 *    只能在生成它的端点上原样回放——本地不存明文历史、也不再发摘要提示。
 *
 * 两条路径都不改变「本地 JSONL 保留完整历史」的语义：原生压缩点只是一个
 * 重放投影，换端点/换模型时可以直接退回本地摘要（见 runtime）。
 */

/** 服务端拒绝或无法完成原生压缩：调用方应退回本地摘要，而不是把回合判死。 */
export class NativeCompactionUnavailable extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "NativeCompactionUnavailable";
    this.status = status;
  }
}

export type NativeCompactionMode = "anthropic-inband" | "openai-endpoint";

/** Anthropic 的压缩触发值下限（服务端约束，低于它请求会被拒绝）。 */
export const ANTHROPIC_MIN_COMPACT_TRIGGER = 50_000;

/** 原生 Anthropic 与兼容网关的字段集不同：只有官方端点认 context_management。 */
function isNativeAnthropicEndpoint(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === "api.anthropic.com";
  } catch {
    return false;
  }
}

/**
 * 判断当前 provider 是否值得尝试原生压缩。
 * 返回 null 表示不支持（调用方直接走本地摘要，不产生任何额外请求）。
 */
export function nativeCompactionMode(provider: ProviderConfig): NativeCompactionMode | null {
  if (provider.nativeCompaction === false) return null;
  const protocol = provider.protocol ?? "openai-chat-completions";
  if (protocol === "anthropic-messages") {
    // 官方端点默认启用；兼容网关字段集不同，需要用户显式打开 nativeCompaction
    // （有的代理确实转发了 context_management，不能一刀切禁用）
    if (provider.nativeCompaction === true) return "anthropic-inband";
    return isNativeAnthropicEndpoint(provider.baseUrl) ? "anthropic-inband" : null;
  }
  if (protocol === "openai-responses") return "openai-endpoint";
  return null;
}

export type NativeCompactionResult = {
  /** 可读摘要：Anthropic 来自 compaction 块；OpenAI 通常为空（加密 item 无明文） */
  summary: string;
  /** 需要在后续请求里原样回放的加密 item（OpenAI）；Anthropic 不产生 */
  native?: NativeCompactionPayload;
  usage?: TokenUsage;
};

/**
 * 请求一次服务端压缩。失败一律抛 NativeCompactionUnavailable，
 * 由调用方决定是否退回本地摘要（网络/鉴权错误会原样抛出，不误判为"不支持"）。
 */
export async function requestNativeCompaction(options: {
  provider: ProviderConfig;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
}): Promise<NativeCompactionResult> {
  const mode = nativeCompactionMode(options.provider);
  if (!mode) throw new NativeCompactionUnavailable("Provider does not support server-side compaction.");
  return mode === "anthropic-inband"
    ? requestAnthropicCompaction(options)
    : requestResponsesCompaction(options);
}

type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

function anthropicUsage(usage: AnthropicUsage | undefined): TokenUsage | undefined {
  if (!usage) return undefined;
  const cached = usage.cache_read_input_tokens ?? 0;
  const created = usage.cache_creation_input_tokens ?? 0;
  const hasInput = usage.input_tokens !== undefined || cached > 0 || created > 0;
  return {
    ...(hasInput ? { inputTokens: (usage.input_tokens ?? 0) + cached + created } : {}),
    ...(usage.output_tokens !== undefined ? { outputTokens: usage.output_tokens } : {}),
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(created > 0 ? { cacheWriteTokens: created } : {}),
  };
}

/**
 * Anthropic 路径：一次非流式请求，服务端压完即停。
 *
 * 触发值取「窗口一半」与「当前估算 90%」的较小者，并夹到服务端下限 50000：
 * 只有触发值 ≤ 当前输入，服务端才会真的压缩；估算低于下限时无从压缩，
 * 直接判定不可用（调用方退回本地摘要）。
 */
async function requestAnthropicCompaction(options: {
  provider: ProviderConfig;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
}): Promise<NativeCompactionResult> {
  const { provider } = options;
  const estimated =
    estimateMessagesTokens(options.messages) + estimateToolDefinitionsTokens(options.tools);
  const window = provider.contextWindow && provider.contextWindow > 0 ? provider.contextWindow : 200_000;
  if (estimated < ANTHROPIC_MIN_COMPACT_TRIGGER) {
    throw new NativeCompactionUnavailable(
      `Input (~${estimated} tokens) is below the server-side compaction floor (${ANTHROPIC_MIN_COMPACT_TRIGGER}).`,
    );
  }
  const trigger = Math.max(
    ANTHROPIC_MIN_COMPACT_TRIGGER,
    Math.min(Math.floor(window * 0.5), Math.floor(estimated * 0.9)),
  );
  const { system, messages } = toAnthropicMessages(options.messages);
  const body = {
    model: provider.model,
    max_tokens: compactionSummaryMaxTokens(provider),
    ...(system.length ? { system } : {}),
    messages,
    ...(options.tools.length ? { tools: options.tools.map(anthropicTool) } : {}),
    ...(options.tools.length ? { tool_choice: { type: "none" } } : {}),
    context_management: {
      edits: [
        {
          type: "compact_20260112",
          trigger: { type: "input_tokens", value: trigger },
          pause_after_compaction: true,
        },
      ],
    },
    stream: false,
  };

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (provider.apiKey) headers["x-api-key"] = provider.apiKey;
  const response = await fetchWithRetry(completionUrl(provider.baseUrl, "anthropic-messages"), {
    method: "POST",
    headers,
    signal: options.signal,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new NativeCompactionUnavailable(
      `Server-side compaction rejected (${response.status}): ${text || response.statusText}`,
      response.status,
    );
  }
  const parsed = (await response.json().catch(() => null)) as {
    content?: Array<{ type?: string; text?: string; content?: string }>;
    usage?: AnthropicUsage;
  } | null;
  const summary = (parsed?.content ?? [])
    .filter((block) => block.type === "compaction")
    .map((block) => block.content ?? block.text ?? "")
    .join("\n")
    .trim();
  if (!summary) {
    throw new NativeCompactionUnavailable(
      "Provider returned no compaction block; the conversation may be below the trigger.",
    );
  }
  return { summary, usage: anthropicUsage(parsed?.usage) };
}

/** Anthropic 工具 schema（与 anthropic.ts 同形，避免把 cache_control 带进压缩请求）。 */
function anthropicTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  };
}

type ResponsesUsage = {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
};

/**
 * OpenAI Responses 路径：POST /responses/compact。
 * 返回的 compaction item 是加密历史，必须连同来源一起存档、后续逐字回放。
 */
async function requestResponsesCompaction(options: {
  provider: ProviderConfig;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
}): Promise<NativeCompactionResult> {
  const { provider } = options;
  const instructions = options.messages
    .flatMap((message) => (message.role === "system" && message.content ? [message.content] : []))
    .join("\n\n");
  const url = completionUrl(provider.baseUrl, "openai-responses").replace(
    /\/responses$/,
    "/responses/compact",
  );
  const body = {
    model: provider.model,
    input: toResponsesInput(options.messages),
    ...(instructions ? { instructions } : {}),
    ...(options.tools.length ? { tools: responsesTools(options.tools) } : {}),
    ...(provider.promptCacheKey ? { prompt_cache_key: provider.promptCacheKey } : {}),
  };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  const response = await fetchWithRetry(url, {
    method: "POST",
    headers,
    signal: options.signal,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new NativeCompactionUnavailable(
      `Compaction endpoint rejected (${response.status}): ${text || response.statusText}`,
      response.status,
    );
  }
  const parsed = (await response.json().catch(() => null)) as {
    output?: Array<Record<string, unknown>>;
    usage?: ResponsesUsage;
  } | null;
  const output = parsed?.output ?? [];
  // 整个 output 就是服务端给出的「替换窗口」：加密 compaction item + 它决定保留的
  // 用户/助手消息项，必须按原顺序整体回放，只挑 compaction item 会丢掉保留段。
  if (!output.some((item) => item?.type === "compaction")) {
    throw new NativeCompactionUnavailable("Compaction endpoint returned no compaction item.");
  }
  return {
    summary: textFromResponsesOutput(output),
    native: {
      providerId: provider.id,
      endpoint: provider.baseUrl.replace(/\/+$/, ""),
      model: provider.model,
      protocol: "openai-responses",
      items: output,
    },
    ...(parsed?.usage
      ? {
          usage: {
            ...(parsed.usage.input_tokens !== undefined
              ? { inputTokens: parsed.usage.input_tokens }
              : {}),
            ...(parsed.usage.output_tokens !== undefined
              ? { outputTokens: parsed.usage.output_tokens }
              : {}),
            ...(parsed.usage.input_tokens_details?.cached_tokens !== undefined
              ? { cacheReadTokens: parsed.usage.input_tokens_details.cached_tokens }
              : {}),
          },
        }
      : {}),
  };
}

/** 压缩结果里偶尔会带可读的消息项；没有明文时返回空串（加密 item 不可读）。 */
function textFromResponsesOutput(output: Array<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const item of output) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const block of item.content as Array<Record<string, unknown>>) {
      if (typeof block?.text === "string" && block.text.trim()) parts.push(block.text.trim());
    }
  }
  return parts.join("\n").trim();
}

/**
 * 原生压缩点是否还能在当前 provider 上回放：端点、模型、协议任一变化都不行
 * （加密 item 与生成它的端点绑定）。不能回放时必须退回本地摘要。
 */
export function canReplayNativeCompaction(
  native: NativeCompactionPayload,
  provider: ProviderConfig,
): boolean {
  return (
    native.protocol === (provider.protocol ?? "openai-chat-completions") &&
    native.model === provider.model &&
    native.endpoint === provider.baseUrl.replace(/\/+$/, "")
  );
}
