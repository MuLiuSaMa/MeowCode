import { describe, expect, it } from "vitest";
import type { MeowEvent, TimelineItem } from "./api";
import { applyTimelineEvent, finalizeStreamingAssistants } from "./timeline-events";

let seq = 0;
const key = (prefix: string) => `${prefix}-${(seq += 1)}`;

describe("timeline event projection", () => {
  it("streams deltas into one assistant item and finalizes it before a tool", () => {
    let items: TimelineItem[] = [];
    items = applyTimelineEvent(
      items,
      { type: "thinking_delta", delta: "plan" } as MeowEvent,
      key,
    );
    items = applyTimelineEvent(
      items,
      { type: "assistant_delta", delta: "hello" } as MeowEvent,
      key,
    );
    items = applyTimelineEvent(
      items,
      { type: "message_complete", text: "hello world", reasoning: "plan" } as MeowEvent,
      key,
    );
    expect(items).toMatchObject([
      {
        kind: "message",
        role: "assistant",
        content: "hello world",
        thinking: "plan",
        streaming: false,
      },
    ]);

    items = applyTimelineEvent(
      items,
      {
        type: "tool_started",
        callId: "call-1",
        tool: "read_file",
        input: { path: "a.ts" },
      } as MeowEvent,
      key,
    );
    expect(items.at(-1)).toMatchObject({ kind: "tool", callId: "call-1", tool: "read_file" });
  });

  it("matches tool output and completion by callId", () => {
    let items: TimelineItem[] = [
      { kind: "tool", key: "t1", callId: "call-1", tool: "read_file", input: { path: "a" } },
    ];
    items = applyTimelineEvent(
      items,
      { type: "tool_output", callId: "call-1", output: "contents", truncated: false } as MeowEvent,
      key,
    );
    items = applyTimelineEvent(
      items,
      { type: "tool_finished", callId: "call-1", ok: true } as MeowEvent,
      key,
    );
    expect(items[0]).toMatchObject({ output: "contents", ok: true });
  });

  it("drops an empty streaming assistant when a turn ends", () => {
    const items: TimelineItem[] = [
      { kind: "message", key: "empty", role: "assistant", content: "", streaming: true },
    ];
    finalizeStreamingAssistants(items);
    expect(items).toEqual([]);
  });
});
