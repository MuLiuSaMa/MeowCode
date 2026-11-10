import { safeParse } from "./context.js";
import { buildAuthHeaders, fetchWithRetry, mergeExtraHeaders, type AuthStyle } from "./http.js";
import { parseJson, readSseFrames } from "./sse.js";
import { ProviderRequestError } from "./provider-error.js";
import { isToolCallComplete, summarizeToolCalls, type ToolCallProgress } from "./tool-progress.js";
import {
  cacheControlFor,
  gatewayUsesMinimalCache,
  hasBreakpoint,
  noteGatewayMinimalCache,
  resetGatewayCacheDegradation,
  resolveCachePlan,
  type CachePlan,
} from "./cache-profile.js";
import { resolveThinkingBudget } from "./thinking-budget.js";
import type {
  AnthropicThinkingBlock,
  ContextEditing,
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

/**
 * 降级记忆（进程生命周期，按 provider id 记）：
 *  - 网关嫌断点太多：400 一次就降到 2 个断点并记住（不是直接全关）；
 *  - 网关连 cache_control 字段都不认：降到 2 个仍 400 才彻底关闭；
 *  - 端点不认 thinking 参数：参数与历史思考块一并跳过；
 *  - 端点认 thinking 但拒绝回放的历史签名块（跨模型签名不可移植）：只剥历史、保留后续思考。
 * 降级是保守方向：记错的代价是少用缓存/思考，重试的代价是每个请求多一趟 400。
 */
const cacheControlUnsupportedProviders = new Set<string>();
const thinkingUnsupportedProviders = new Set<string>();
const historyThinkingRejectedProviders = new Set<string>();
/** 端点在处理前清掉更早的工具结果（不等同于「不认识」，也可能是不支持） */
const contextEditingUnsupportedProviders = new Set<string>();
/** context editing 的 beta 标识：不声明的话服务端不认 context_management 字段。 */
const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";

/**
 * 测试专用：清空降级记忆。模块级 Set 跨用例存活，测试文件里多个用例共用同一个
 * url/ providerId 时，降级用例会把后续用例一起污染（400 记忆是生产语义，测试要归零）。
 */
export function resetProviderDegradeMemoryForTests(): void {
  cacheControlUnsupportedProviders.clear();
  thinkingUnsupportedProviders.clear();
  historyThinkingRejectedProviders.clear();
  contextEditingUnsupportedProviders.clear();
  resetGatewayCacheDegradation();
}

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
  /** 断点锚点：会话快照末尾；追加工具后旧断点位置不变，旧工具段仍可命中 */
  cacheAnchorIndex?: number,
): Array<Record<string, unknown>> {
  const tag = hasBreakpoint(plan, "tools") ? cacheTag(plan) : undefined;
  const anchor =
    tools.length === 0
      ? -1
      : Math.min(
          Math.max(cacheAnchorIndex ?? tools.length - 1, 0),
          tools.length - 1,
        );
  return tools.map((tool, index) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
    // 快照末尾后打缓存断点：稳定工具目录整体可复用。
    // Qwen 等不认 tools 断点的画像在这里拿不到 tag，自然不打。
    ...(index === anchor && tag ? tag : {}),
  }));
}

type CacheControl = NonNullable<ReturnType<typeof cacheControlFor>>;

/** 给消息的最后一个内容块打 cache_control；空消息返回 false。 */
function tagLastContentBlock(
  message: Record<string, unknown> | undefined,
  control: CacheControl,
): boolean {
  if (!message) return false;
  const content = message.content;
  if (typeof content === "string") {
    if (!content) return false;
    message.content = [{ type: "text", text: content, cache_control: control }];
    return true;
  }
  if (Array.isArray(content) && content.length) {
    const tail = content.at(-1) as Record<string, unknown> | undefined;
    if (!tail || typeof tail !== "object") return false;
    tail.cache_control = control;
    return true;
  }
  return false;
}

/** 只含 tool_result 块的 user 消息（并行工具结果合并的载体）。 */
function isToolResultOnly(message: Record<string, unknown> | undefined): boolean {
  if (!message || message.role !== "user" || !Array.isArray(message.content)) return false;
  if (!message.content.length) return false;
  return message.content.every(
    (block) => (block as Record<string, unknown> | undefined)?.type === "tool_result",
  );
}

/** 最后一条**非空**消息打尾断点：空 tool 结果不会再让这一跳静默失去缓存写入。 */
function markLastMessageCacheable(
  out: Array<Record<string, unknown>>,
  plan: CachePlan,
  skipWrite = false,
): void {
  if (!hasBreakpoint(plan, "tail")) return;
  const control = cacheControlFor(plan);
  if (!control) return;
  // skipWrite：本次请求末尾挂着一段合成指令（压缩提示），那条消息不会被任何后续请求
  // 读回。写入点前移一条，否则整段历史按 1.25x（5m）/ 2x（1h）重写，指令部分纯亏。
  const start = skipWrite ? out.length - 2 : out.length - 1;
  for (let index = start; index >= 0; index -= 1) {
    if (tagLastContentBlock(out[index], control)) return;
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

/**
 * 降级档的请求体：只留 system 首块与最后一条非空消息的断点。
 *
 * 网关报 400 时不能直接判定「完全不支持缓存」——更常见的是嫌 4 个断点太贪。
 * 这个形态（system + 尾条）是所有 Anthropic 兼容实现都认的最小集合，
 * 降到它还能保住「稳定前缀」这一段，比一刀切关闭多救回一大截命中率。
 * TTL 固定 5m：能走到这里的都是网关画像，而 1h 只在实测过的官方端点上才发。
 */
function buildMinimalCacheBodies(
  system: AnthropicSystemBlock[],
  messages: Array<Record<string, unknown>>,
  tools: Array<Record<string, unknown>>,
): {
  system: Array<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
} {
  const control: CacheControl = { type: "ephemeral" };
  const minimalSystem = system.map((block, index) => {
    const clean = stripCacheControl(block) as Record<string, unknown>;
    return index === 0 ? { ...clean, cache_control: control } : clean;
  });
  const minimalMessages = messages.map((message) => stripCacheControl(message));
  for (let index = minimalMessages.length - 1; index >= 0; index -= 1) {
    if (tagLastContentBlock(minimalMessages[index], control)) break;
  }
  return {
    system: minimalSystem,
    messages: minimalMessages,
    tools: tools.map((tool) => stripCacheControl(tool)),
  };
}

/** 把内部消息列表转成 Anthropic 的 messages（system 单独提出去）。 */
export function toAnthropicMessages(
  messages: ChatMessage[],
  plan: CachePlan = NATIVE_PLAN,
  options: { skipTailCacheWrite?: boolean } = {},
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
  // 稳定段断点优先给 system[1]（AGENTS.md 等 instructions，最长稳定段）；
  // 没有 instructions 时回退 system[0]。mode 提示排在 system 末尾、切换频繁且体积小，
  // 刻意留在断点之外。断点总数由 cache-profile 统一裁剪：
  // 官方 4 个 / Qwen 2 个 / 未知网关 0 个。
  const systemTag = cacheTag(plan);
  if (systemTag) {
    if (hasBreakpoint(plan, "system0") && system.length) Object.assign(system[0], systemTag);
    if (hasBreakpoint(plan, "system1")) {
      const target = system.length > 1 ? system[1] : system[0];
      if (target) Object.assign(target, systemTag);
    }
  }
  const rest = messages.filter((message) => message.role !== "system");

  const out: Array<Record<string, unknown>> = [];
  // 最后一个真实 user 消息在序列化结果里的位置。tool 结果也会变成 role=user，
  // 所以必须按原始 role 记录，否则 anchor 会退化成 tail。
  let anchorIndex = -1;
  /** 上一条真实 user 的位置：末条是合成指令时（压缩复用前缀）anchor 要回退到它。 */
  let previousAnchorIndex = -1;
  for (const message of rest) {
    // 原生压缩点（目前只由 OpenAI Responses 产出）：Anthropic 无法重放加密 item，
    // 降级为一条 user 说明，保证模型知道更早历史已被压缩。
    if (message.role === "native_compaction") {
      out.push({
        role: "user",
        // 固定用内容块数组：断点来回移动时不能改变消息的序列化形状
        content: [
          {
            type: "text",
            text: `[Earlier conversation history was compacted by the provider. Treat the following as context, not as a new request.]\n${message.content}`,
          },
        ],
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
        previousAnchorIndex = anchorIndex;
        anchorIndex = out.length - 1;
        continue;
      }
      // 始终用内容块数组承载文本：cache_control 的加/移不能改变消息形状，
      // 否则断点从这条消息移走的下一跳，整段前缀会因 JSON 结构变化而失效。
      out.push({
        role: "user",
        content: message.content ? [{ type: "text", text: message.content }] : "",
      });
      if (message.content) {
        previousAnchorIndex = anchorIndex;
        anchorIndex = out.length - 1;
      }
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
      // 只合并到「纯 tool_result」消息：真实 user 文本已经是内容块数组，不能被误并。
      const previous = out.at(-1);
      if (isToolResultOnly(previous)) {
        (previous!.content as Array<Record<string, unknown>>).push(block);
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
  // anchor 固定在最后一个真实 user 消息：工具循环期间它会一直留在原位，
  // 尾块因任何原因失效时仍有一段可回退的缓存前缀。
  // 末条是合成指令时（压缩复用前缀），它本身不会被后续请求读回：
  // anchor 回退到上一条真实 user，跟 tail 一起让出这一跳的写入成本。
  const syntheticTail = options.skipTailCacheWrite === true;
  const effectiveAnchor =
    syntheticTail && anchorIndex === out.length - 1 ? previousAnchorIndex : anchorIndex;
  if (hasBreakpoint(plan, "anchor") && effectiveAnchor >= 0) {
    const control = cacheControlFor(plan);
    if (control) tagLastContentBlock(out[effectiveAnchor], control);
  }
  markLastMessageCacheable(out, plan, syntheticTail);
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
  /** 降级记忆的键；缺省用 url。来自 provider.id，跨会话稳定 */
  providerId?: string;
  apiKey?: string;
  /** 鉴权头风格；缺省用 Anthropic 原生 x-api-key */
  authStyle?: AuthStyle;
  /** 额外请求头（同名覆盖内置） */
  extraHeaders?: Record<string, string>;
  /** 额外请求体字段（展开合并进顶层） */
  extraBody?: Record<string, unknown>;
  model: string;
  maxTokens?: number;
  reasoningEffort?: string;
  /** 显式思考预算（provider.thinkingBudget），覆盖按档位推导的值 */
  thinkingBudget?: number;
  /** 会话亲和键：以 x-session-id 头发出，防止代理把两个会话的缓存串到一个分片 */
  promptCacheKey?: string;
  /** 服务端 context editing：处理前清掉更早的工具结果（不按输入计费，且不改本地历史） */
  contextEditing?: ContextEditing;
  system: AnthropicSystemBlock[];
  messages: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
  /** 传工具定义但禁止实际调用（压缩摘要复用主前缀时需要） */
  toolChoice?: "none";
  signal?: AbortSignal;
  /** 网络层尝试次数；缺省沿用 fetchWithRetry 默认（3）。辅助请求传 1 = 失败不重试。 */
  fetchAttempts?: number;
  onDelta: (delta: string) => void;
  onThinking?: (delta: string) => void;
  /** 流中实时用量：message_start 就带输入/缓存，不必等流结束 */
  onUsage?: (usage: TokenUsage) => void;
  onToolCall?: (progress: ToolCallProgress) => void;
  /** 流式中某个工具调用参数完整闭合时立即回调（实验：流中提前执行只读工具） */
  onToolCallComplete?: (call: ToolCall) => void;
}): Promise<{
  message: Extract<ChatMessage, { role: "assistant" }>;
  usage?: TokenUsage;
  finishReason?: string;
}> {
  const headers = mergeExtraHeaders(
    {
      "content-type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
      // 空 apiKey = 用服务商原生鉴权（DSH 的约定），此时不带鉴权头；
      // authStyle 显式设置时按风格产出（Azure / Bedrock 网关代理 anthropic 协议时用）
      ...buildAuthHeaders(options.apiKey, options.authStyle, "x-api-key"),
      // 会话亲和：原生端点靠 cache_control，兼容网关/代理还需要一个稳定键来粘住分片。
      // 部分网关只认 header，body 没有等价字段，所以这里必须发。
      ...(options.promptCacheKey ? { "x-session-id": options.promptCacheKey } : {}),
      // context editing 需要声明 beta，否则字段被忽略（或被拒）
      ...(options.contextEditing &&
      !contextEditingUnsupportedProviders.has(options.providerId ?? options.url)
        ? { "anthropic-beta": CONTEXT_MANAGEMENT_BETA }
        : {}),
    },
    options.extraHeaders,
  );

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
  // 降级记忆先查：曾 400 过的 provider 直接按降级态起步，不再每轮试错
  const providerKey = options.providerId ?? options.url;
  const historyThinkingStripped = historyThinkingRejectedProviders.has(providerKey);
  let useThinking =
    (native ? thinkingBudget !== undefined : deepseek && Boolean(options.reasoningEffort)) &&
    !thinkingUnsupportedProviders.has(providerKey);
  /**
   * 缓存写入档位：
   *  - full：画像给的全部断点（网关默认 4 个）
   *  - minimal：被拒过就只留 system 首块 + 尾条（2 个，兼容面最广）
   *  - off：连字段都不发（端点整体不认识 cache_control）
   */
  let contextEditingOn =
    Boolean(options.contextEditing) && !contextEditingUnsupportedProviders.has(providerKey);
  let cacheLevel: "full" | "minimal" | "off" = cacheControlUnsupportedProviders.has(providerKey)
    ? "off"
    : gatewayUsesMinimalCache(providerKey)
      ? "minimal"
      : "full";
  // 懒构建：只有真降级时才深拷贝整段历史（大 history 上的 stripCacheControl 不便宜）
  let minimalCache: ReturnType<typeof buildMinimalCacheBodies> | null = null;
  const minimal = () =>
    (minimalCache ??= buildMinimalCacheBodies(options.system, options.messages, options.tools));
  const buildBody = (level: "full" | "minimal" | "off", withThinking: boolean) => ({
    model: options.model,
    max_tokens: options.maxTokens ?? 8192,
    system: options.system.length
      ? level === "minimal"
        ? minimal().system
        : options.system.map((block) =>
            level === "full" ? block : { type: block.type, text: block.text },
          )
      : undefined,
    messages: stripThinkingBlocks(
      level === "minimal"
        ? minimal().messages
        : level === "full"
          ? options.messages
          : stripCacheControl(options.messages),
      // 历史思考块被该端点拒绝过（跨模型签名）：剥历史但保留 thinking 参数，新回合照常思考
      withThinking && !historyThinkingStripped,
    ),
    tools: options.tools.length
      ? level === "minimal"
        ? minimal().tools
        : options.tools.map((tool) =>
            level === "full"
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
    // 服务端 context editing：只声明「超过多少就清、保留最近几次工具调用」，
    // 清哪些由服务端决定。被清掉的部分不进输入计费，本地历史一个字节都不动。
    ...(contextEditingOn && options.contextEditing
      ? {
          context_management: {
            edits: [
              {
                type: "clear_tool_uses_20250919",
                trigger: { type: "input_tokens", value: options.contextEditing.triggerTokens },
                keep: { type: "tool_uses", value: options.contextEditing.keepToolUses },
                ...(options.contextEditing.clearAtLeastTokens
                  ? {
                      clear_at_least: {
                        type: "input_tokens",
                        value: options.contextEditing.clearAtLeastTokens,
                      },
                    }
                  : {}),
              },
            ],
          },
        }
      : {}),
    // 用户自定义字段最后展开：同名覆盖内置，用于网关特有的开关
    ...options.extraBody,
  });
  const send = (level: "full" | "minimal" | "off", withThinking: boolean) =>
    fetchWithRetry(
      options.url,
      {
        method: "POST",
        headers,
        signal: options.signal,
        body: JSON.stringify(buildBody(level, withThinking)),
      },
      { attempts: options.fetchAttempts },
    );

  let response = await send(cacheLevel, useThinking);
  let failureText = "";
  if (!response.ok) {
    failureText = await response.text().catch(() => "");
    // 部分 Anthropic 兼容网关不接受多个（或不认识）cache_control。
    // 分级降级：4 个断点 → 2 个（system 首块 + 尾条）→ 完全关闭；每级重新判断
    // 失败是否仍指向缓存字段。一上来就全关是以前的做法，等于「网关只是嫌断点多」
    // 也要把缓存赔光。循环最多两圈（full → minimal → off）。
    while (
      cacheLevel !== "off" &&
      (response.status === 400 || response.status === 422) &&
      /cache_control|prompt.?cach|unknown.*cache|invalid.*cache/i.test(failureText)
    ) {
      cacheLevel = cacheLevel === "full" ? "minimal" : "off";
      if (cacheLevel === "off") cacheControlUnsupportedProviders.add(providerKey);
      else noteGatewayMinimalCache(providerKey);
      response = await send(cacheLevel, useThinking);
      failureText = response.ok ? "" : await response.text().catch(() => "");
    }
    // 端点不支持 context editing：去掉该字段重试一次并记住（只影响省 token 的手段，
    // 不影响对话本身，所以不当作失败上报）。
    if (
      !response.ok &&
      contextEditingOn &&
      (response.status === 400 || response.status === 422) &&
      /context[-_]management|clear_tool_uses|context editing/i.test(failureText)
    ) {
      contextEditingOn = false;
      contextEditingUnsupportedProviders.add(providerKey);
      response = await send(cacheLevel, useThinking);
      failureText = response.ok ? "" : await response.text().catch(() => "");
    }
    // 模型或网关不支持扩展思考：去掉 thinking 与历史 thinking 块再试一次。
    // 签名类报错（跨模型签名不可移植）只剥历史、下次保留参数；其余视为端点整体不支持并记住。
    if (
      !response.ok &&
      useThinking &&
      (response.status === 400 || response.status === 422) &&
      /thinking|budget_tokens/i.test(failureText)
    ) {
      if (/signature|redacted_thinking|thinking.*block|block.*thinking/i.test(failureText)) {
        historyThinkingRejectedProviders.add(providerKey);
      } else {
        thinkingUnsupportedProviders.add(providerKey);
        useThinking = false;
      }
      response = await send(cacheLevel, false);
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

  /** 对外统一的用量形状：Anthropic 的 input_tokens 不含缓存部分，总输入 = 普通输入 + 缓存读取 + 缓存写入。 */
  const buildUsage = (): TokenUsage | undefined => {
    const hasUsage =
      inputTokens !== undefined ||
      cachedInputTokens !== undefined ||
      cacheCreationInputTokens !== undefined;
    if (!hasUsage) return undefined;
    return {
      inputTokens: (inputTokens ?? 0) + (cachedInputTokens ?? 0) + (cacheCreationInputTokens ?? 0),
      outputTokens,
      ...(cachedInputTokens !== undefined ? { cacheReadTokens: cachedInputTokens } : {}),
      ...(cacheCreationInputTokens !== undefined
        ? { cacheWriteTokens: cacheCreationInputTokens }
        : {}),
    };
  };

  let reportedUsage: TokenUsage | undefined;
  let lastUsageAt = 0;
  /** 输入/缓存一到就发；纯输出增长按 32 token + 250ms 节流，别让每个 chunk 都冒一条事件。 */
  const emitUsage = (force = false) => {
    const next = buildUsage();
    if (!next) return;
    const now = Date.now();
    const metadataChanged =
      reportedUsage === undefined ||
      reportedUsage.inputTokens !== next.inputTokens ||
      reportedUsage.cacheReadTokens !== next.cacheReadTokens ||
      reportedUsage.cacheWriteTokens !== next.cacheWriteTokens;
    const outputGrew = (next.outputTokens ?? 0) - (reportedUsage?.outputTokens ?? 0);
    if (!force && !metadataChanged && !(outputGrew >= 32 && now - lastUsageAt >= 250)) return;
    if (force && !metadataChanged && outputGrew <= 0) return;
    reportedUsage = next;
    lastUsageAt = now;
    options.onUsage?.(next);
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
      emitUsage();

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
  // 流结束前强冲一次，保证实时样本与最终返回值同值
  emitUsage(true);
  const usageSample = buildUsage();
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
    usage: usageSample ?? { outputTokens },
    ...(finishReason ? { finishReason } : {}),
  };
}
