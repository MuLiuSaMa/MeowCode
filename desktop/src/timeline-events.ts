import type { MeowEvent, TimelineItem, TimelineTool } from "./api";

type KeyFactory = (prefix: string) => string;

/**
 * 收尾所有流式助手条目：运行时的 message_complete 只在本轮最终回复时发送，
 * 带工具调用的中间轮次没有它 —— 若不在工具开始 / 回合结束时收尾，
 * 这些条目会一直渲染光标（caret），「思考中…」标签也不会恢复成「思考过程」。
 * 既无正文也无思考的中间条目没有展示价值，直接丢弃。
 */
export function finalizeStreamingAssistants(items: TimelineItem[]): void {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind !== "message" || item.role !== "assistant" || !item.streaming) continue;
    if (!item.content && !item.thinking) {
      items.splice(index, 1);
      continue;
    }
    items[index] = { ...item, streaming: false };
  }
}

/** 原地应用一条事件；调用方负责复制数组。 */
function applyTimelineEventInPlace(
  items: TimelineItem[],
  event: MeowEvent,
  nextKey: KeyFactory,
): void {
  switch (event.type) {
    case "thinking_delta": {
      const last = items.at(-1);
      if (last?.kind === "message" && last.role === "assistant" && last.streaming) {
        items[items.length - 1] = {
          ...last,
          thinking: (last.thinking ?? "") + (event.delta ?? ""),
        };
      } else {
        items.push({
          kind: "message",
          key: nextKey("thinking"),
          role: "assistant",
          content: "",
          thinking: event.delta ?? "",
          streaming: true,
        });
      }
      break;
    }
    case "assistant_delta": {
      const last = items.at(-1);
      const thinkingMs = event.thinkingMs;
      if (last?.kind === "message" && last.role === "assistant" && last.streaming) {
        items[items.length - 1] = {
          ...last,
          content: last.content + (event.delta ?? ""),
          ...(thinkingMs !== undefined ? { thinkingMs } : {}),
        };
      } else {
        items.push({
          kind: "message",
          key: nextKey("assistant"),
          role: "assistant",
          content: event.delta ?? "",
          ...(thinkingMs !== undefined ? { thinkingMs } : {}),
          streaming: true,
        });
      }
      break;
    }
    case "thinking_complete": {
      // 只有工具调用的轮次没有正文增量：思考时长在消息落盘时补一个事件
      const last = items.at(-1);
      if (last?.kind === "message" && last.role === "assistant") {
        items[items.length - 1] = { ...last, thinkingMs: event.thinkingMs };
      }
      break;
    }
    case "message_complete": {
      const last = items.at(-1);
      if (last?.kind === "message" && last.role === "assistant" && last.streaming) {
        items[items.length - 1] = {
          ...last,
          content: event.text ?? last.content,
          thinking: event.reasoning ?? last.thinking,
          ...(event.thinkingMs !== undefined ? { thinkingMs: event.thinkingMs } : {}),
          streaming: false,
        };
      } else {
        items.push({
          kind: "message",
          key: nextKey("assistant"),
          role: "assistant",
          content: event.text ?? "",
          thinking: event.reasoning,
          ...(event.thinkingMs !== undefined ? { thinkingMs: event.thinkingMs } : {}),
        });
      }
      break;
    }
    case "tool_started": {
      finalizeStreamingAssistants(items);
      items.push({
        kind: "tool",
        key: nextKey("tool"),
        callId: event.callId ?? "",
        tool: event.tool ?? "",
        input: event.input,
      });
      break;
    }
    case "tool_output": {
      const index = items.findIndex(
        (item) => item.kind === "tool" && item.callId === event.callId,
      );
      if (index >= 0) {
        const item = items[index] as TimelineTool;
        const images = (event.images ?? [])
          .filter((image) => image && typeof image.data === "string" && image.data)
          .map((image) => {
            const mimeType = image.mimeType || "image/png";
            return { mimeType, dataUrl: `data:${mimeType};base64,${image.data}` };
          });
        items[index] = {
          ...item,
          output: event.output ?? "",
          truncated: event.truncated,
          ...(event.spilled ? { spilled: event.spilled } : {}),
          ...(images.length ? { images } : {}),
        };
      }
      break;
    }
    case "tool_finished": {
      const index = items.findIndex(
        (item) => item.kind === "tool" && item.callId === event.callId,
      );
      if (index >= 0) {
        const item = items[index] as TimelineTool;
        items[index] = { ...item, ok: event.ok };
      }
      break;
    }
    case "turn_complete": {
      finalizeStreamingAssistants(items);
      break;
    }
    default:
      break;
  }
}

/** 主对话与子 Agent 共用的流式时间线更新；调用方负责复制数组。 */
export function applyTimelineEvent(
  items: TimelineItem[],
  event: MeowEvent,
  nextKey: KeyFactory,
): TimelineItem[] {
  const next = [...items];
  applyTimelineEventInPlace(next, event, nextKey);
  return next;
}

/** 批量版本：只拷贝一次数组，按顺序应用多条事件（流式合帧用）。 */
export function applyTimelineEvents(
  items: TimelineItem[],
  events: readonly MeowEvent[],
  nextKey: KeyFactory,
): TimelineItem[] {
  if (!events.length) return items;
  const next = [...items];
  for (const event of events) applyTimelineEventInPlace(next, event, nextKey);
  return next;
}
