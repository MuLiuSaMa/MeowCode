import type { ChatMessage, TimelineItem } from "./api";

type KeyFactory = (prefix: string) => string;

type ParsedCall = {
  id: string;
  name: string;
  input: unknown;
};

function parseArguments(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // 存档里的参数解析失败时保留原文，详情里仍可查看
    return raw;
  }
}

function readToolCall(raw: unknown): ParsedCall | null {
  if (!raw || typeof raw !== "object") return null;
  const fn = (raw as { function?: unknown }).function;
  if (!fn || typeof fn !== "object") return null;
  const name = (fn as { name?: unknown }).name;
  if (typeof name !== "string" || !name) return null;
  const args = (fn as { arguments?: unknown }).arguments;
  const id = (raw as { id?: unknown }).id;
  return {
    id: typeof id === "string" ? id : "",
    name,
    input: typeof args === "string" ? parseArguments(args) : (args ?? {}),
  };
}

export type HistoryCompaction = {
  /** 压缩摘要之前有多少条消息（消息数组下标） */
  messageIndex: number;
  summary?: string;
  status?: "completed" | "interrupted" | "failed";
};

/**
 * 会话存档 → 时间线。存档里的工具调用只有 assistant.tool_calls（没有输出），
 * 重建为 replayed 工具行；content 为空的纯工具轮不再产生空白气泡。
 * 传入压缩记录时，把每条压缩分隔线插回它发生的原始位置。
 */
export function timelineFromHistory(
  messages: ChatMessage[],
  nextKey: KeyFactory,
  compaction?: HistoryCompaction | HistoryCompaction[] | null,
): TimelineItem[] {
  const items: TimelineItem[] = [];
  const toolOutputs = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "tool" && message.tool_call_id) {
      toolOutputs.set(message.tool_call_id, message.content ?? "");
    }
  }

  const compactions = Array.isArray(compaction) ? compaction : compaction ? [compaction] : [];
  const inserted = new Set<number>();
  const insertCompactions = (index: number) => {
    if (inserted.has(index)) return;
    inserted.add(index);
    for (const point of compactions) {
      if (point.messageIndex !== index) continue;
      items.push({
        kind: "compaction",
        key: nextKey("compaction"),
        summary: point.summary ?? null,
        ...(point.status === "interrupted" ? { interrupted: true } : {}),
        ...(point.status === "failed" ? { failed: true } : {}),
      });
    }
  };

  for (let index = 0; index < messages.length; index += 1) {
    insertCompactions(index);
    const message = messages[index];
    if (message.role === "system" || message.role === "tool") continue;

    if (message.role === "user") {
      // 附图两路来源：当轮内存里的 base64（dataUrl）与历史落盘引用（assetUrl）
      const images = [
        ...(message.images ?? []).map((image) => ({
          mimeType: image.mimeType,
          dataUrl: `data:${image.mimeType};base64,${image.data}`,
        })),
        ...(message.imageRefs ?? [])
          .map((ref) => ({
            mimeType: ref.mimeType,
            src: window.meow.assetUrl?.(ref.file) ?? null,
          }))
          .filter((image): image is { mimeType: string; src: string } => Boolean(image.src)),
      ];
      items.push({
        kind: "message",
        key: nextKey("user"),
        role: "user",
        content: typeof message.content === "string" ? message.content : "",
        ...(images.length ? { images } : {}),
      });
      continue;
    }

    const content = typeof message.content === "string" ? message.content : "";
    const reasoning = typeof message.reasoning === "string" && message.reasoning ? message.reasoning : undefined;
    if (content || reasoning) {
      items.push({
        kind: "message",
        key: nextKey("assistant"),
        role: "assistant",
        content,
        ...(reasoning ? { thinking: reasoning } : {}),
      });
    }

    for (const raw of message.tool_calls ?? []) {
      const call = readToolCall(raw);
      if (!call) continue;
      const output = call.id ? toolOutputs.get(call.id) : undefined;
      items.push({
        kind: "tool",
        key: nextKey("tool"),
        callId: call.id,
        tool: call.name,
        input: call.input,
        replayed: true,
        ...(output !== undefined ? { output, truncated: false } : {}),
      });
    }
  }

  // 压缩发生在最后一条消息之后（正常情况）时补在末尾
  insertCompactions(messages.length);
  return items;
}

/** 开始压缩：清掉残留的运行中标记，在时间线末尾插入分隔线。 */
export function markCompactionStarted(items: TimelineItem[], key: string): TimelineItem[] {
  const next = items.filter((item) => !(item.kind === "compaction" && item.running));
  next.push({ kind: "compaction", key, running: true });
  return next;
}

/** 压缩完成：把运行中的分隔线改成完成态；没有运行中标记时补一条。 */
export function markCompactionCompleted(
  items: TimelineItem[],
  key: string,
  summary: string,
): TimelineItem[] {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "compaction" && item.running) {
      const next = [...items];
      next[index] = { ...item, running: false, summary };
      return next;
    }
  }
  return [...items, { kind: "compaction", key, summary }];
}

/** 压缩失败或中止：移除运行中的分隔线，已完成的历史标记保留。 */
export function clearRunningCompaction(items: TimelineItem[]): TimelineItem[] {
  return items.filter((item) => !(item.kind === "compaction" && item.running));
}
