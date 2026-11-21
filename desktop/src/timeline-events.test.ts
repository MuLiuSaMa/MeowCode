import { describe, expect, it } from "vitest";
import type { MeowEvent, TimelineItem } from "./api";
import { applyTimelineEvent, applyTimelineEvents, finalizeStreamingAssistants } from "./timeline-events";

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

  it("batches deltas with the same result as applying them one by one", () => {
    const events = [
      { type: "thinking_delta", delta: "plan" },
      { type: "thinking_delta", delta: " more" },
      { type: "assistant_delta", delta: "hello", thinkingMs: 1200 },
      { type: "assistant_delta", delta: " world" },
    ] as MeowEvent[];
    const stableKey = (prefix: string) => prefix;
    const sequential = events.reduce(
      (items, event) => applyTimelineEvent(items, event, stableKey),
      [] as TimelineItem[],
    );
    const batched = applyTimelineEvents([], events, stableKey);
    expect(batched).toEqual(sequential);
    expect(batched).toMatchObject([
      {
        kind: "message",
        role: "assistant",
        thinking: "plan more",
        content: "hello world",
        thinkingMs: 1200,
        streaming: true,
      },
    ]);
  });
});
