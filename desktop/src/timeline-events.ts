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

/** 主对话与子 Agent 共用的流式时间线更新；调用方负责复制数组。 */
export function applyTimelineEvent(
  items: TimelineItem[],
  event: MeowEvent,
  nextKey: KeyFactory,
): TimelineItem[] {
  const next = [...items];
  switch (event.type) {
    case "thinking_delta": {
      const last = next.at(-1);
      if (last?.kind === "message" && last.role === "assistant" && last.streaming) {
        next[next.length - 1] = {
          ...last,
          thinking: (last.thinking ?? "") + (event.delta ?? ""),
        };
      } else {
        next.push({
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
      const last = next.at(-1);
      if (last?.kind === "message" && last.role === "assistant" && last.streaming) {
        next[next.length - 1] = { ...last, content: last.content + (event.delta ?? "") };
      } else {
        next.push({
          kind: "message",
          key: nextKey("assistant"),
          role: "assistant",
          content: event.delta ?? "",
          streaming: true,
        });
      }
      break;
    }
    case "message_complete": {
      const last = next.at(-1);
      if (last?.kind === "message" && last.role === "assistant" && last.streaming) {
        next[next.length - 1] = {
          ...last,
          content: event.text ?? last.content,
          thinking: event.reasoning ?? last.thinking,
          streaming: false,
        };
      } else {
        next.push({
          kind: "message",
          key: nextKey("assistant"),
          role: "assistant",
          content: event.text ?? "",
          thinking: event.reasoning,
        });
      }
      break;
    }
    case "tool_started": {
      finalizeStreamingAssistants(next);
      next.push({
        kind: "tool",
        key: nextKey("tool"),
        callId: event.callId ?? "",
        tool: event.tool ?? "",
        input: event.input,
      });
      break;
    }
    case "tool_output": {
      const index = next.findIndex(
        (item) => item.kind === "tool" && item.callId === event.callId,
      );
      if (index >= 0) {
        const item = next[index] as TimelineTool;
        next[index] = { ...item, output: event.output ?? "", truncated: event.truncated };
      }
      break;
    }
    case "tool_finished": {
      const index = next.findIndex(
        (item) => item.kind === "tool" && item.callId === event.callId,
      );
      if (index >= 0) {
        const item = next[index] as TimelineTool;
        next[index] = { ...item, ok: event.ok };
      }
      break;
    }
    case "turn_complete": {
      finalizeStreamingAssistants(next);
      break;
    }
    default:
      break;
  }
  return next;
}
