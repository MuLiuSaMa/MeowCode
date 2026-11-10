import { isInjectedUserMessage } from "./context.js";
import type { ChatMessage, ProviderConfig } from "./types.js";

/**
 * 请求投影：只改「发给模型的这一份」，不动落盘历史与 UI 时间线。
 *
 * 两个长期被反复计费的点：
 *  - 旧 Anthropic thinking 块：同一 tool-use 回合必须回传，跨轮可以省略；
 *  - 旧用户截图：截图当规格时会一直躺在上下文里，每轮重新计费。
 *
 * 未变化的消沿用原对象引用：增量 Responses 链靠引用相等判断前缀可复用，
 * 这里不能无脑 map 出副本。
 */
export const MAX_USER_IMAGE_MESSAGES_IN_CONTEXT = 3;
export const KEEP_THINKING_USER_TURNS = 1;
/**
 * 文档（PDF）比图片更贵：扫描件一份就是几 MB base64。只保留最近 3 条带文档的
 * user 消息，更早的换成一行说明 —— 与图片同口径。
 */
export const MAX_USER_DOCUMENT_MESSAGES_IN_CONTEXT = 3;

export type ProjectionOptions = {
  keepUserImageMessages?: number;
  keepUserDocumentMessages?: number;
  keepThinkingUserTurns?: number;
};

/** 从末尾数第 keepTurns 个真实 user 消息的下标；没有则 -1。 */
function turnBoundaryIndex(messages: ChatMessage[], keepTurns: number): number {
  let remaining = Math.max(1, Math.floor(keepTurns));
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user" || isInjectedUserMessage(message)) continue;
    remaining -= 1;
    if (remaining === 0) return index;
  }
  return -1;
}

/**
 * 只保留最近 keep 条带图 user 消息的图片；更早的图片换成一行说明。
 * 返回原数组/原对象引用表示没有变化。
 */
export function projectUserImages(
  messages: ChatMessage[],
  keep = MAX_USER_IMAGE_MESSAGES_IN_CONTEXT,
): ChatMessage[] {
  if (keep <= 0) return messages;
  return projectAttachments(messages, keep, "images", (count) =>
    `[${count} image(s) omitted from an earlier message to save context; re-attach if needed]`,
  );
}

/**
 * 文档投影：与图片同口径（保留最近 keep 条带文档的 user 消息）。
 * 扫描件回退的原文件动辄几 MB，躺在上下文里每轮都要重新计费。
 */
export function projectUserDocuments(
  messages: ChatMessage[],
  keep = MAX_USER_DOCUMENT_MESSAGES_IN_CONTEXT,
): ChatMessage[] {
  if (keep <= 0) return messages;
  return projectAttachments(messages, keep, "documents", (count) =>
    `[${count} document(s) omitted from an earlier message to save context; read the file again if needed]`,
  );
}

/** 图片/文档共用的「只保留最近 N 条带附件的 user 消息」投影。 */
function projectAttachments(
  messages: ChatMessage[],
  keep: number,
  field: "images" | "documents",
  noteFor: (count: number) => string,
): ChatMessage[] {
  const keepIndexes = new Set<number>();
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user" || !message[field]?.length) continue;
    if (seen < keep) {
      keepIndexes.add(index);
      seen += 1;
    }
  }
  if (keepIndexes.size === 0) return messages;

  let changed = false;
  const projected = messages.map((message, index) => {
    if (message.role !== "user" || !message[field]?.length || keepIndexes.has(index)) {
      return message;
    }
    changed = true;
    const count = message[field]!.length;
    const note = noteFor(count);
    return {
      ...message,
      [field]: undefined,
      content: message.content.trim() ? `${message.content}\n${note}` : note,
    } as ChatMessage;
  });
  return changed ? projected : messages;
}

/**
 * Anthropic 只保留最近 keepTurns 个 user 回合内的 thinking；
 * 更早的 assistant thinking 块省略（官方允许跨轮省略，同一 tool-use 回合必须保留）。
 */
export function projectAnthropicThinking(
  messages: ChatMessage[],
  keepTurns = KEEP_THINKING_USER_TURNS,
): ChatMessage[] {
  const boundary = turnBoundaryIndex(messages, keepTurns);
  if (boundary < 0) return messages;

  let changed = false;
  const projected = messages.map((message, index) => {
    if (index >= boundary || message.role !== "assistant" || !message.anthropic_thinking?.length) {
      return message;
    }
    changed = true;
    return { ...message, anthropic_thinking: undefined };
  });
  return changed ? projected : messages;
}

/**
 * 滞回触发/目标线（字节）：图片/文档 payload 以 base64 字符长度近似（偏大 ~1.37×，
 * 常数吸收）。对齐 opencode 的「trigger/target 双线」语义但按截图密度取 8/4 MiB——
 * 编码会话的截图比设计稿小一个量级，25/15 MiB 要攒太多张才触发一次。
 */
export const ATTACHMENT_HYSTERESIS_TRIGGER_BYTES = 8 * 1024 * 1024;
export const ATTACHMENT_HYSTERESIS_TARGET_BYTES = 4 * 1024 * 1024;

/**
 * 投影结果记忆化：增量链（previous_response_id）用引用相等判断前缀可续接，
 * 每轮新建对象会让链断掉。键必须含投影参数——同一条消息在不同阈值/切点下结果不同。
 */
const attachmentMemo = new WeakMap<ChatMessage, Map<string, ChatMessage>>();
const stripThinkingMemo = new WeakMap<ChatMessage, Map<number, ChatMessage>>();

/**
 * 滞回式附件投影（主路径用；opencode 的图片淘汰同款）：
 *  - 附件总量 ≤ 触发线 → 不裁；
 *  - 越过触发线 → 从最旧端裁到目标线，只保留最新的那截。
 *
 * 前向扫描（旧→新累计）：切点由「累计到触发线为止的最旧边界」唯一决定，
 * 新增附件只会让 kept 增长，不会推动切点——切点只在触发线-目标线的余量被
 * 吃满时才前移一次，代价是一次性后缀重写，换来之后每轮少发一截旧附件。
 * （旧实现从最新往回取 ≤target 的后缀，历史一旦越线，每来一张新图切点就前移一位，
 * 等于每张截图都重写一次前缀；这个 bug 已由 test 覆盖。）
 * 逐请求重算但字节单调，重启后同一历史算出同一切点（确定性），不落盘标记。
 */
export function projectAttachmentsHysteresis(
  messages: ChatMessage[],
  field: "images" | "documents",
  trigger = ATTACHMENT_HYSTERESIS_TRIGGER_BYTES,
  target = ATTACHMENT_HYSTERESIS_TARGET_BYTES,
): ChatMessage[] {
  if (trigger <= 0 || target <= 0 || target >= trigger) return messages;
  // 旧→新的带附件消息（下标 + payload 字节）
  const carrier: Array<{ index: number; bytes: number }> = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "user" || !message[field]?.length) continue;
    const bytes = message[field]!.reduce((sum, item) => sum + (item.data?.length ?? 0), 0);
    if (bytes > 0) carrier.push({ index, bytes });
  }
  const total = carrier.reduce((sum, item) => sum + item.bytes, 0);
  if (total <= trigger) return messages;

  // 前向扫描：只有累计越过触发线才从最旧端裁到目标线，cut 只增不减。
  // cut < carrier.length - 1 保证永远保留最新一条附件（即使它单独超目标线）。
  let cut = 0;
  let kept = 0;
  for (const item of carrier) {
    kept += item.bytes;
    if (kept <= trigger) continue;
    while (kept > target && cut < carrier.length - 1) {
      kept -= carrier[cut].bytes;
      cut += 1;
    }
  }
  if (cut === 0) return messages;
  const dropIndexes = new Set(carrier.slice(0, cut).map((item) => item.index));
  const note =
    field === "images"
      ? (count: number) =>
          `[${count} image(s) omitted from an earlier message to save context; re-attach if needed]`
      : (count: number) =>
          `[${count} document(s) omitted from an earlier message; read the file again if needed]`;

  let changed = false;
  const memoKey = `${field}:${trigger}:${target}`;
  const projected = messages.map((message, index) => {
    if (message.role !== "user" || !dropIndexes.has(index)) return message;
    changed = true;
    const cached = attachmentMemo.get(message)?.get(memoKey);
    if (cached) return cached;
    const count = message[field]!.length;
    const text = note(count);
    const next = {
      ...message,
      [field]: undefined,
      content: message.content.trim() ? `${message.content}\n${text}` : text,
    } as ChatMessage;
    const perMessage = attachmentMemo.get(message);
    if (perMessage) perMessage.set(memoKey, next);
    else attachmentMemo.set(message, new Map([[memoKey, next]]));
    return next;
  });
  return changed ? projected : messages;
}

/** 主路径组合：图片 + 文档滞回投影。thinking 不进主路径——它的边界每轮移动，逐轮投影等于每轮自爆缓存。 */
export function projectForMainPath(messages: ChatMessage[]): ChatMessage[] {
  let projected = projectAttachmentsHysteresis(messages, "images");
  projected = projectAttachmentsHysteresis(projected, "documents");
  return projected;
}

/**
 * 压缩保留段里「thinking 从第几条开始继续携带」的切点。
 *
 * 逐轮投影 thinking 会让边界每轮前移、从改动点起缓存全失效，所以主路径不动它。
 * 但压缩边界不一样：整段前缀本来就要整体重写，此刻把旧回合的 thinking 一次性剥掉
 * 是零额外代价的，而留在上下文里会永久占窗口、把下一次压缩触发点整体前移
 * （对照 cc-haha：旧 thinking 不进重放）。
 *
 * 切点取「保留段里最后一个真实 user 消息」：它之前的 assistant 属于更早的回合，
 * 跨轮不再需要回传 thinking；它之后的可能是当前回合的工具循环，Anthropic 要求
 * 同一 tool-use 回合内必须原样带着，不能剥。
 *
 * 返回值在保留段固定不变，因此后续每轮算出的切点一致 —— 不会变成逐轮投影。
 */
export function retainedThinkingBoundary(retained: ChatMessage[]): number {
  const boundary = turnBoundaryIndex(retained, 1);
  return boundary > 0 ? boundary : 0;
}

/**
 * 剥掉 `keepFrom` 之前的 thinking。没有变化的消息原样返回同一引用 ——
 * 增量传输（previous_response_id）靠引用相等判断前缀可复用。
 *
 * 剥掉的块整键移除（而不是置 undefined）：序列化时字段存在与否影响字节，
 * 也影响「到底剥没剥」的断言（provider.test.ts 同口径）。
 */
export function stripThinkingBefore(
  messages: ChatMessage[],
  keepFrom: number,
): ChatMessage[] {
  if (keepFrom <= 0) return messages;
  let changed = false;
  const next = messages.map((message, index) => {
    if (index >= keepFrom || message.role !== "assistant" || !message.anthropic_thinking?.length) {
      return message;
    }
    changed = true;
    const cached = stripThinkingMemo.get(message)?.get(keepFrom);
    if (cached) return cached;
    const { anthropic_thinking: _strippedThinking, ...rest } = message;
    const stripped = rest as ChatMessage;
    const perMessage = stripThinkingMemo.get(message);
    if (perMessage) perMessage.set(keepFrom, stripped);
    else stripThinkingMemo.set(message, new Map([[keepFrom, stripped]]));
    return stripped;
  });
  return changed ? next : messages;
}

/** 按 provider 协议组合投影；非 Anthropic 协议不碰 thinking。 */
export function projectForRequest(
  messages: ChatMessage[],
  provider?: ProviderConfig | null,
  options: ProjectionOptions = {},
): ChatMessage[] {
  let projected = projectUserImages(messages, options.keepUserImageMessages);
  projected = projectUserDocuments(projected, options.keepUserDocumentMessages);
  const protocol = provider?.protocol ?? "openai-chat-completions";
  if (protocol === "anthropic-messages") {
    projected = projectAnthropicThinking(projected, options.keepThinkingUserTurns);
  }
  return projected;
}
