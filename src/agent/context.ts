import { resolveOutputBudget } from "./output-budget.js";
import type { ChatMessage, ProviderConfig, ToolCall, ToolDocument } from "./types.js";

/**
 * 粗略的 token 估算：CJK（中日韩）字符按 1 字 ≈ 1 token，其余按 4 字符 ≈ 1 token。
 * 目的是给上下文窗口做裁剪，不是精确计费；宁可高估（多裁）不可低估（溢出）。
 */
const CJK_CHAR_PATTERN =
  /[\u1100-\u11ff\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK_CHAR_PATTERN)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

/** 单张图片的 token 估算：按主流 1280–1568px 截图口径取 1500，宁可高估。 */
const IMAGE_TOKEN_ESTIMATE = 1_500;
/**
 * 单个文档块的粗估。Anthropic 按页计 1.5–3k token：
 * 有页数时按页数取上限；没有页数时用体积回退，宁可高估也不能让扫描件把窗口估算拉穿。
 */
const DOCUMENT_TOKEN_ESTIMATE = 4_000;
const DOCUMENT_TOKENS_PER_PAGE = 3_000;
/** 无页数回退：每 1MB base64 按 100k token 计（约 25 字符/token，明显高于常规文本）。 */
const DOCUMENT_FALLBACK_TOKENS_PER_BASE64_MB = 100_000;

export function estimateDocumentTokens(document: Pick<ToolDocument, "data" | "pages">): number {
  if (document.pages && document.pages > 0) {
    return Math.max(DOCUMENT_TOKEN_ESTIMATE, Math.ceil(document.pages) * DOCUMENT_TOKENS_PER_PAGE);
  }
  return Math.max(
    DOCUMENT_TOKEN_ESTIMATE,
    Math.ceil(
      (document.data.length / 1_000_000) * DOCUMENT_FALLBACK_TOKENS_PER_BASE64_MB,
    ),
  );
}

/** 当前 user 回合本身已经无法放进模型窗口：压缩旧历史也救不了，必须在发请求前明确拒绝。 */
export class PromptTooLargeError extends Error {
  constructor(
    readonly inputTokens: number,
    readonly outputTokens: number,
    readonly contextWindow: number,
  ) {
    super(
      `当前消息/附件约 ${inputTokens.toLocaleString()} tokens，超过模型窗口 ${contextWindow.toLocaleString()}（已预留输出 ${outputTokens.toLocaleString()}）。请拆分 PDF、减少附件，或改用文件工具分页读取。`,
    );
    this.name = "PromptTooLargeError";
  }
}

export function estimateMessageTokens(message: ChatMessage): number {
  let total = estimateTokens(typeof message.content === "string" ? message.content : "");
  // 服务端原生压缩的加密 item：base64 密文按 4 字符 ≈ 1 token 计，
  // 它是后续每次请求都要回放的固定开销，必须计入上下文占用。
  if (message.role === "native_compaction") {
    try {
      total += estimateTokens(JSON.stringify(message.native.items));
    } catch {
      // 不可序列化时按说明文本计，已经算过了
    }
  }
  const calls = "tool_calls" in message ? message.tool_calls : undefined;
  if (calls?.length) {
    for (const call of calls) {
      total += estimateTokens(call.function.name);
      total += estimateTokens(call.function.arguments);
    }
  }
  // 图片随消息一起回传，按张数计——不按 base64 长度算，否则会高估一个数量级
  const images = "images" in message ? message.images : undefined;
  if (images?.length) total += images.length * IMAGE_TOKEN_ESTIMATE;
  // 文档（PDF）按页数估算；页数不可知时才退回保守体积估算
  const documents = "documents" in message ? message.documents : undefined;
  if (documents?.length) {
    for (const document of documents) total += estimateDocumentTokens(document);
  }
  // thinking 块会随请求回传，必须计入上下文；reasoning 只是本地存档，不计
  const thinking = "anthropic_thinking" in message ? message.anthropic_thinking : undefined;
  if (thinking?.length) {
    for (const block of thinking) {
      total +=
        block.type === "thinking"
          ? estimateTokens(block.thinking) + estimateTokens(block.signature)
          : estimateTokens(block.data);
    }
  }
  return total;
}

/** 一组消息的估算 token 总量（上下文占用统计用）。 */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

/** 对话消息的细分占用（token）。各桶互斥，加总恒等于消息总量。 */
export type MessageBreakdown = {
  system: number;
  /** 工具结果，按工具名降序；超出 topN 的合并成 "other tools" */
  toolResults: Array<{ name: string; tokens: number }>;
  userText: number;
  assistantText: number;
  /** 运行时注入的 user 消息（模式提示、@mention 文件上下文、harness 等） */
  injected: number;
  /** 图片与文档（从各角色桶里切出来单列：这是唯一能靠删减直接回收的部分） */
  media: number;
  /** 工具调用参数等其余部分 */
  other: number;
  total: number;
};

/**
 * 把对话消息拆成可归因的几类（看板用，纯估算）。
 *
 * 三桶明细（system / tools / messages）只能说明「多大」，说明不了「谁在吃」；
 * 按工具名与角色拆开，才能判断该收紧哪个工具的输出上限、哪个注入该改成仅本次请求。
 */
export function breakdownMessages(messages: ChatMessage[], topTools = 8): MessageBreakdown {
  const toolTokens = new Map<string, number>();
  let system = 0;
  let userText = 0;
  let assistantText = 0;
  let injected = 0;
  let media = 0;
  let other = 0;

  for (const message of messages) {
    const total = estimateMessageTokens(message);
    const mediaTokens =
      ("images" in message ? (message.images?.length ?? 0) * IMAGE_TOKEN_ESTIMATE : 0) +
      ("documents" in message
        ? (message.documents ?? []).reduce(
            (sum, document) => sum + estimateDocumentTokens(document),
            0,
          )
        : 0);
    media += mediaTokens;
    const rest = Math.max(0, total - mediaTokens);

    if (message.role === "system") {
      system += rest;
      continue;
    }
    if (message.role === "tool") {
      const name = message.name ?? "tool";
      toolTokens.set(name, (toolTokens.get(name) ?? 0) + rest);
      continue;
    }
    if (message.role === "user") {
      if (isInjectedUserMessage(message)) injected += rest;
      else userText += rest;
      continue;
    }
    if (message.role === "assistant") {
      // 工具调用参数是「怎么调」的开销，不是正文：切进 other，避免虚高正文占比
      const callTokens = message.tool_calls?.length
        ? message.tool_calls.reduce(
            (sum, call) =>
              sum + estimateTokens(call.function.name) + estimateTokens(call.function.arguments),
            0,
          )
        : 0;
      assistantText += Math.max(0, rest - callTokens);
      other += Math.min(rest, callTokens);
      continue;
    }
    other += rest;
  }

  const sorted = [...toolTokens.entries()]
    .map(([name, tokens]) => ({ name, tokens }))
    .sort((a, b) => b.tokens - a.tokens);
  const toolResults = sorted.slice(0, topTools);
  const tailTokens = sorted.slice(topTools).reduce((sum, item) => sum + item.tokens, 0);
  if (tailTokens > 0) toolResults.push({ name: "other tools", tokens: tailTokens });

  return {
    system,
    toolResults,
    userText,
    assistantText,
    injected,
    media,
    other,
    total: system + userText + assistantText + injected + media + other +
      toolResults.reduce((sum, item) => sum + item.tokens, 0),
  };
}

/** 工具定义的估算 token（JSON schema 按 4 字符/token 保守折算）。 */
export function estimateToolDefinitionsTokens(tools: unknown): number {
  if (!tools || (Array.isArray(tools) && tools.length === 0)) return 0;
  try {
    return estimateTokens(JSON.stringify(tools));
  } catch {
    return 0;
  }
}

/**
 * 按剩余窗口收紧单次输出预算（逐请求 preflight，参考 ZCode 的 per-step
 * preflight 与 OpenCode 的 output clamp）：input + output + 余量必须落在窗口内。
 * 没声明窗口时保持配置值；measuredInputTokens 只在本轮消息与用量锚点精确
 * 对齐时传入，否则用字符估算（见 output-budget.ts）。
 */
export function clampOutputTokens(
  provider: ProviderConfig,
  inputTokens: number,
  measuredInputTokens?: number,
): number {
  return resolveOutputBudget({
    configuredMaxTokens: provider.maxTokens,
    contextWindow: provider.contextWindow,
    inputTokens,
    ...(measuredInputTokens !== undefined ? { measuredInputTokens } : {}),
  }).tokens;
}

/**
 * 本轮请求的输入 token 估算：有真实用量锚点时用「锚点 + 之后新增消息的估算」，
 * 只有锚点失效（压缩/裁剪/换模型）才整段字符估算。字符估算在代码与中文混排时
 * 误差可达 ±30%，而 preflight 的输出预算正是从这个数里扣出来的，偏大就会溢出。
 */
export function estimateRequestInputTokens(
  messages: ChatMessage[],
  anchor: ContextUsageAnchor | null,
  toolTokens: number,
): number {
  const systemCount = messages.filter((message) => message.role === "system").length;
  const effectiveCount = messages.length - systemCount;
  if (anchor && anchor.inputTokens > 0 && anchor.messageCount <= effectiveCount) {
    // 锚点里的 inputTokens 已包含 system + 工具定义；只需补算它之后新增的消息
    const trailing = estimateMessagesTokens(
      messages.slice(systemCount + anchor.messageCount),
    );
    return anchor.inputTokens + trailing;
  }
  return estimateMessagesTokens(messages) + toolTokens;
}

/**
 * 上下文用量锚点：最近一次服务商返回的真实输入 token，以及它覆盖到的有效消息条数。
 * 有锚点时只用「锚点 + 之后新增消息的估算」计算占用，不再重算整段历史——
 * 服务商的真实计量永远比字符估算准（参考 metis 的 usageTokens + trailingTokens）。
 */
export type ContextUsageAnchor = {
  /** 服务商报告的输入 token（含缓存读/写） */
  inputTokens: number;
  /** 该次请求覆盖到的有效消息条数（相对 session.effectiveMessages 的下标边界） */
  messageCount: number;
};

export type ContextUsageEstimate = {
  tokens: number;
  source: "usage" | "estimate";
  /** 锚点提供的 token 数；估算路径为 0 */
  usageTokens: number;
  /** 锚点之后新增消息的估算 token */
  trailingTokens: number;
};

/**
 * 计算上下文占用：优先用服务商真实用量做锚点，只估算锚点之后新增的消息。
 * 锚点失效（会话被压缩/摘要、消息数对不上、服务商没报用量）时退回全量估算。
 */
export function estimateContextTokens(
  messages: ChatMessage[],
  anchor?: ContextUsageAnchor | null,
): ContextUsageEstimate {
  const estimated = estimateMessagesTokens(messages);
  if (
    !anchor ||
    !(anchor.inputTokens > 0) ||
    anchor.messageCount < 0 ||
    anchor.messageCount > messages.length
  ) {
    return { tokens: estimated, source: "estimate", usageTokens: 0, trailingTokens: estimated };
  }
  const trailingTokens = estimateMessagesTokens(messages.slice(anchor.messageCount));
  return {
    tokens: anchor.inputTokens + trailingTokens,
    source: "usage",
    usageTokens: anchor.inputTokens,
    trailingTokens,
  };
}

/** 上下文达到软阈值时提示用户手动压缩；真正溢出仍由 runtime 自动压缩。 */
export const COMPACTION_WARNING_RATIO = 0.85;

/**
 * 压缩软触发的绝对预留项，两段都取自开源同类的现成口径，不自创数值：
 *  - 输出预留 = min(maxTokens, 21_000)：ZCode `getAutoCompactOutputReserveTokens`
 *    （provider 窗口是输入+输出共享的，自动压缩只能让出输入侧）
 *  - 余量 = max(15% 窗口, 窗口 ≥ 32_000 时的 16_000)：OpenCode 的 `RESERVE_SHARE` /
 *    `RESERVE_MIN`，注释写明这份额「留给压缩前最后一次回复和摘要本身」，
 *    15% 的余量是为了「一步跨过阈值时整段对话仍能原样发出并复用缓存」
 *    （实测单步 p99 增长约 22k token）。
 *
 * 两段**取大者而不是相加**：OpenCode 的 16_000 已经把输出算在内，
 * 再叠一次输出预留会把 32k 窗口的阈值压到 26%，属于过早压缩。
 *
 * 阈值 = min(window × ratio, window − 预留)；预留吃满窗口时退回纯比值。
 * 95% 的总量硬闸不走这个函数 —— Codex 的全窗守卫从不随口径移动，照此保留。
 */
export const COMPACTION_OUTPUT_RESERVE_CAP = 21_000;
export const COMPACTION_RESERVE_SHARE = 0.15;
export const COMPACTION_RESERVE_MIN_TOKENS = 16_000;

/** 软触发阈值（token）；窗口未知时返回 0，调用方按「不触发」处理。 */
export function compactionTriggerTokens(
  contextWindow: number | null | undefined,
  maxOutputTokens?: number,
  ratio = COMPACTION_WARNING_RATIO,
): number {
  if (!contextWindow || contextWindow <= 0) return 0;
  const ratioThreshold = Math.floor(contextWindow * ratio);
  const outputReserve = Math.min(maxOutputTokens ?? 8_192, COMPACTION_OUTPUT_RESERVE_CAP);
  const headroom = Math.max(
    Math.floor(contextWindow * COMPACTION_RESERVE_SHARE),
    contextWindow >= 2 * COMPACTION_RESERVE_MIN_TOKENS ? COMPACTION_RESERVE_MIN_TOKENS : 0,
  );
  const room = contextWindow - Math.max(outputReserve, headroom);
  return room > 0 ? Math.min(ratioThreshold, room) : ratioThreshold;
}

export function shouldRecommendCompaction(
  usedTokens: number,
  contextWindow: number | null | undefined,
  maxOutputTokens?: number,
): boolean {
  if (!contextWindow || contextWindow <= 0) return false;
  const trigger = compactionTriggerTokens(contextWindow, maxOutputTokens, COMPACTION_WARNING_RATIO);
  return trigger > 0 && usedTokens >= trigger;
}

/** 判断一条 assistant 消息是否带工具调用。 */
function isToolCallMessage(message: ChatMessage): boolean {
  return message.role === "assistant" && Boolean(message.tool_calls?.length);
}

/**
 * 修复落盘历史里的工具调用配对（中止回合、老会话缺工具结果）：
 *  - assistant.tool_calls 中没有对应 tool 结果的调用会被移除；
 *  - 找不到对应调用的孤儿 tool 消息会被丢弃；
 *  - 移除后既无正文也无思考的空 assistant 消息会被丢弃。
 * 返回新数组，不修改入参。
 */
export function repairToolPairs(messages: ChatMessage[]): ChatMessage[] {
  const resultIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool" && message.tool_call_id) resultIds.add(message.tool_call_id);
  }

  const keptCallIds = new Set<string>();
  const emittedResults = new Set<string>();
  const repaired: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      // 同一个 callId 只保留第一条结果，避免旧版裁剪产生的重复 tool 消息
      if (keptCallIds.has(message.tool_call_id) && !emittedResults.has(message.tool_call_id)) {
        repaired.push(message);
        emittedResults.add(message.tool_call_id);
      }
      continue;
    }
    if (message.role !== "assistant" || !message.tool_calls?.length) {
      repaired.push(message);
      continue;
    }

    const calls = message.tool_calls.filter((call) => resultIds.has(call.id));
    for (const call of calls) keptCallIds.add(call.id);
    const hasContent = Boolean(message.content?.trim());
    const hasReasoning = Boolean(message.reasoning?.trim());
    if (!calls.length) {
      if (!hasContent && !hasReasoning) continue;
      const { tool_calls: _calls, ...rest } = message;
      // 去掉 tool_calls 后 content 不能保持 null（没有工具调用的空 assistant 在部分网关会被拒绝）
      repaired.push({ ...rest, content: rest.content ?? "" });
      continue;
    }
    // 引用稳定：配对完整时原样保留对象。增量传输（previous_response_id）靠
    // 「消息对象引用未变 ⇒ 内容未变」验证前缀可复用；这里每次重建对象会让
    // 增量链永远失效，每轮都退化成全量重发。
    if (calls.length === message.tool_calls.length) {
      repaired.push(message);
      continue;
    }
    repaired.push({ ...message, tool_calls: calls });
  }
  return repaired;
}

function isCompactionSummaryMessage(message: ChatMessage): boolean {
  return (
    message.role === "user" &&
    typeof message.content === "string" &&
    message.content.startsWith("Earlier conversation summary:")
  );
}

/**
 * 压缩载体：本地摘要或服务端原生压缩点。两者都是「更早历史」的替代，
 * 裁剪时必须无条件保留 —— 丢了等于整段失忆。
 */
export function isCompactionCarrier(message: ChatMessage): boolean {
  return message.role === "native_compaction" || isCompactionSummaryMessage(message);
}

/** 运行时注入的 user 消息不算“用户回合”，裁剪时不能拿它当最后请求。 */
export function isInjectedUserMessage(message: ChatMessage): boolean {
  if (message.role !== "user" || typeof message.content !== "string") return false;
  return (
    isCompactionSummaryMessage(message) ||
    message.content.startsWith("Runtime context:") ||
    message.content.startsWith("The user referenced these workspace files with @mentions.")
  );
}

/**
 * 把消息切成不可拆的单元：
 *  - 普通消息各自成组；
 *  - assistant(tool_calls) 与紧随其后的 tool 结果永远成组；
 *  - 没有前置 assistant 的孤儿 tool 直接丢弃（repairToolPairs 也会清）。
 * 导出给压缩保留段（session-store）复用：切段必须落在单元边界，避免拆散工具配对。
 */
export function buildMessageUnits(messages: ChatMessage[]): ChatMessage[][] {
  const units: ChatMessage[][] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "tool") continue;
    if (!isToolCallMessage(message)) {
      units.push([message]);
      continue;
    }
    const unit: ChatMessage[] = [message];
    let cursor = index + 1;
    while (cursor < messages.length && messages[cursor].role === "tool") {
      unit.push(messages[cursor]);
      cursor += 1;
    }
    units.push(unit);
    index = cursor - 1;
  }
  return units;
}

/** 这几类结果记录的是"改过什么"，收缩掉模型会重复改同一处，必须保留。 */
const KEEP_TOOL_NAMES = new Set(["edit_file", "multi_edit", "write_file"]);

/**
 * 轻量压缩档位（参考 opencode 的 SHRINK_STEPS 思路：溢出先做便宜的裁剪，
 * 不行再动模型摘要）：最近 2 个单元逐字保留，更早的工具输出按字符上限抽头尾。
 */
export const SHRINK_KEEP_RECENT_UNITS = 2;
export const SHRINK_MAX_CHARS = 1_200;

export type ToolOutputRef = {
  callId: string;
  tool: string;
  content: string;
};

type ShrinkOptions = {
  /** 从末尾起逐字保留的不可拆单元数 */
  keepRecentUnits?: number;
  /** 单条工具输出保留的字符上限 */
  maxChars?: number;
  /** callId → 落盘产物相对路径：命中时摘录附 locator，全文可用 read_file 找回 */
  spilled?: ReadonlyMap<string, string>;
};

/** 判断一条 tool 结果是否属于「可以被轻量压缩」的旧输出（改文件的记录必须留着）。 */
function isShrinkableToolMessage(
  message: ChatMessage,
  minChars: number,
): message is Extract<ChatMessage, { role: "tool" }> {
  if (message.role !== "tool") return false;
  if (message.name && KEEP_TOOL_NAMES.has(message.name)) return false;
  return message.content.length > minChars || Boolean(message.images?.length);
}

/** 收集可轻量压缩的旧工具输出（供 LLM 摘要档位复用同一选中口径）。 */
export function collectOldToolOutputs(
  messages: ChatMessage[],
  options: { keepRecentUnits?: number; minChars?: number } = {},
): ToolOutputRef[] {
  const keepUnits = options.keepRecentUnits ?? SHRINK_KEEP_RECENT_UNITS;
  const minChars = options.minChars ?? SHRINK_MAX_CHARS;
  const units = buildMessageUnits(messages);
  const cutoff = Math.max(0, units.length - keepUnits);
  const refs: ToolOutputRef[] = [];
  for (let index = 0; index < cutoff; index += 1) {
    for (const message of units[index]) {
      if (!isShrinkableToolMessage(message, minChars)) continue;
      refs.push({
        callId: message.tool_call_id,
        tool: message.name ?? "tool",
        content: message.content,
      });
    }
  }
  return refs;
}

/**
 * 抽头尾保留信息量：头部通常是命令/文件开头，尾部通常是报错与结果。
 * 总长（含省略标注）严格不超过 maxChars：反复收缩会收敛，不会每次都“再剪一刀”。
 */
function excerptOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.max(0, Math.floor(maxChars * 0.55));
  const tail = Math.max(0, Math.floor(maxChars * 0.35));
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n... [${omitted} chars trimmed] ...\n${text.slice(text.length - tail)}`;
}

/**
 * 第一层轻量压缩（无模型调用）：把旧的工具输出换成头尾摘录，保留结构、时间线与
 * 「读过哪个文件 / 跑过什么命令」的事实，丢掉重复日志与大段文件正文。
 * 返回 changed=false 表示没有可压缩的输出（调用方应直接升级到下一档）。
 */
export function shrinkToolOutputs(
  messages: ChatMessage[],
  options: ShrinkOptions = {},
): { messages: ChatMessage[]; changed: boolean } {
  const keepUnits = options.keepRecentUnits ?? SHRINK_KEEP_RECENT_UNITS;
  const maxChars = options.maxChars ?? SHRINK_MAX_CHARS;
  const units = buildMessageUnits(messages);
  const cutoff = Math.max(0, units.length - keepUnits);
  let changed = false;
  const next = units.map((unit, index) => {
    if (index >= cutoff) return unit;
    return unit.map((message) => {
      if (!isShrinkableToolMessage(message, maxChars)) return message;
      changed = true;
      const spillPath = options.spilled?.get(message.tool_call_id);
      const dropped = [
        spillPath ? `full text saved to ${spillPath}; read it with read_file` : "",
        message.images?.length ? `${message.images.length} image(s) dropped` : "",
        message.documents?.length ? `${message.documents.length} document(s) dropped` : "",
      ].filter(Boolean);
      const note = dropped.length ? ` [${dropped.join("; ")}]` : "";
      return {
        ...message,
        // 标注算进预算内，保证多次收缩会收敛到 maxChars 以内
        content: excerptOutput(message.content, Math.max(64, maxChars - note.length)) + note,
        images: undefined,
        documents: undefined,
      };
    });
  });
  if (!changed) return { messages, changed: false };
  const flat = next.flat();
  // 孤儿 tool 消息会被 buildMessageUnits 丢掉；数量对不上就放弃，绝不改坏消息序列
  if (flat.length !== messages.length) return { messages, changed: false };
  return { messages: flat, changed: true };
}

/**
 * 按上下文窗口裁剪历史。
 *
 * 规则（保证请求合法、且最近的对话优先保留）：
 *  - 预算内不改写任何消息：已发送过的历史一旦变动，前缀缓存就整段失效
 *  - 超预算时做轻量压缩：旧工具输出抽头尾，尽量不丢整轮对话
 *  - **永远保留** 开头全部 system 消息（稳定提示 + 易变计划/摘要）
 *  - 以「普通消息」或「assistant(tool_calls)+tool 结果」为不可拆单元，从最新往回保留
 *  - 最后一条真实 user 消息之后的回合整体保留；压缩摘要前缀也保留
 *  - 返回前再次修复 tool 配对并去重，保证请求一定合法
 *
 * @param contextWindow 服务商声明的上下文窗口（token 数）
 * @param maxTokens     单次最大输出（从预算里扣掉）
 * @param reservedTokens 工具定义等消息之外的固定开销（从预算里扣掉）
 */
export function trimMessages(
  messages: ChatMessage[],
  contextWindow: number,
  maxTokens?: number,
  reservedTokens = 0,
): ChatMessage[] {
  if (!contextWindow || contextWindow <= 0) return messages;
  if (messages.length <= 1) return messages;

  // 预算 = 上下文窗口 - 预留输出 - 工具定义等固定开销 - 少量余量
  const budget = Math.max(
    1024,
    contextWindow - (maxTokens ?? 0) - Math.max(0, reservedTokens) - 1024,
  );
  // 预算内保持原样：任何中段改写都会让上一次请求已经缓存的前缀失效。
  let current = messages;
  let total = estimateMessagesTokens(current);
  // 超预算时才做轻量压缩：旧工具输出抽头尾，保住时间线与「读过什么」，
  // 尽量不靠整单元丢弃（丢单元会连用户/助手的正文一起消失）。
  //
  // 先收缩、再按需丢弃（而不是「反正要丢就跳过收缩」）：两种做法都会让前缀
  // 从改动点起失效、缓存代价一样，而收缩把总量压小之后能多留下几个单元 ——
  // 信息量严格更好。真正该避免的是「在预算边缘反复小改」，那由压缩阈值管，
  // 不是这里。
  if (total > budget) {
    const shrunk = shrinkToolOutputs(current);
    if (shrunk.changed) {
      current = shrunk.messages;
      total = estimateMessagesTokens(current);
    }
  }
  // 即使在预算内也归一化一次，清掉旧版本可能留下的孤儿/重复 tool 消息
  if (total <= budget) return repairToolPairs(current);

  let systemCount = 0;
  while (systemCount < current.length && current[systemCount].role === "system") systemCount += 1;
  const systems = current.slice(0, systemCount);
  const rest = current.slice(systemCount);
  const units = buildMessageUnits(rest);
  const costs = units.map((unit) => estimateMessagesTokens(unit));

  // 压缩摘要是“前面所有历史”的替代，丢了等于整段失忆；原生压缩点同理
  let summaryIndex = -1;
  for (let index = 0; index < units.length; index += 1) {
    if (units[index].some(isCompactionCarrier)) summaryIndex = index;
  }
  // 最后一个真实用户回合：从它到末尾的所有单元强制保留
  let lastUserIndex = -1;
  for (let index = units.length - 1; index >= 0; index -= 1) {
    if (units[index].some((message) => message.role === "user" && !isInjectedUserMessage(message))) {
      lastUserIndex = index;
      break;
    }
  }

  const keep = new Set<number>();
  if (lastUserIndex >= 0) {
    for (let index = lastUserIndex; index < units.length; index += 1) keep.add(index);
  }
  if (summaryIndex >= 0) keep.add(summaryIndex);

  let used = estimateMessagesTokens(systems);
  for (const index of keep) used += costs[index];

  // 从最后一条真实 user 之前继续向前补，直到超出预算
  const scanStart = lastUserIndex >= 0 ? lastUserIndex - 1 : units.length - 1;
  for (let index = scanStart; index >= 0; index -= 1) {
    if (keep.has(index)) continue;
    if (used + costs[index] > budget) break;
    keep.add(index);
    used += costs[index];
  }

  const kept = units.filter((_, index) => keep.has(index)).flat();
  return repairToolPairs([...systems, ...kept]);
}

/** 把 OpenAI 风格的 tool_calls 转成 Anthropic 的 tool_use 内容块。 */
export function toAnthropicToolUse(calls: ToolCall[]): Array<Record<string, unknown>> {
  return calls.map((call) => ({
    type: "tool_use",
    id: call.id,
    name: call.function.name,
    input: safeParse(call.function.arguments),
  }));
}

export function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
