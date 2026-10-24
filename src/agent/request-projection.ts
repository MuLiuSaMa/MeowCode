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
