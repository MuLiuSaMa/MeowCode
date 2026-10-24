import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBatcher } from "./event-batcher.cjs";

describe("createEventBatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("batches consecutive delta events into one frame within the interval", () => {
    const sent = [];
    const batcher = createEventBatcher((payload) => sent.push(payload));
    batcher.push({ type: "assistant_delta", seq: 1, text: "a" });
    batcher.push({ type: "assistant_delta", seq: 2, text: "b" });
    batcher.push({ type: "thinking_delta", seq: 3, text: "t" });
    expect(sent).toEqual([]);

    vi.advanceTimersByTime(16);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      batch: [
        { type: "assistant_delta", seq: 1, text: "a" },
        { type: "assistant_delta", seq: 2, text: "b" },
        { type: "thinking_delta", seq: 3, text: "t" },
      ],
    });
  });

  it("sends a single queued event as the original payload, not wrapped", () => {
    const sent = [];
    const batcher = createEventBatcher((payload) => sent.push(payload));
    batcher.push({ type: "assistant_delta", seq: 1, text: "a" });
    vi.advanceTimersByTime(16);
    expect(sent).toEqual([{ type: "assistant_delta", seq: 1, text: "a" }]);
  });

  it("flushes queued deltas before a terminal event and sends it immediately", () => {
    const sent = [];
    const batcher = createEventBatcher((payload) => sent.push(payload));
    batcher.push({ type: "assistant_delta", seq: 1, text: "a" });
    batcher.push({ type: "assistant_delta", seq: 2, text: "b" });
    batcher.push({ type: "turn_end", seq: 3 });
    // 终态事件不被合帧延迟：队列先冲掉（保序），随后立即单发
    expect(sent).toEqual([
      {
        batch: [
          { type: "assistant_delta", seq: 1, text: "a" },
          { type: "assistant_delta", seq: 2, text: "b" },
        ],
      },
      { type: "turn_end", seq: 3 },
    ]);
    // 定时器已随 flush 取消，不会再补发
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(2);
  });

  it("sends unknown event types immediately without batching", () => {
    const sent = [];
    const batcher = createEventBatcher((payload) => sent.push(payload));
    batcher.push({ type: "some_future_event", seq: 9 });
    expect(sent).toEqual([{ type: "some_future_event", seq: 9 }]);
  });

  it("flushes remaining deltas when the stream tears down", () => {
    const sent = [];
    const batcher = createEventBatcher((payload) => sent.push(payload));
    batcher.push({ type: "tool_output", seq: 4, output: "partial" });
    batcher.stop();
    // stop 丢弃未发送批次：窗口销毁后不再向死窗口投递
    expect(sent).toEqual([]);

    const other = createEventBatcher((payload) => sent.push(payload));
    other.push({ type: "tool_output", seq: 5, output: "tail" });
    other.flush();
    expect(sent).toEqual([{ type: "tool_output", seq: 5, output: "tail" }]);
  });

  it("keeps batches ordered when terminal events interleave with deltas", () => {
    const sent = [];
    const batcher = createEventBatcher((payload) => sent.push(payload));
    batcher.push({ type: "assistant_delta", seq: 1 });
    batcher.push({ type: "tool_started", seq: 2 });
    batcher.push({ type: "tool_output", seq: 3 });
    batcher.push({ type: "assistant_delta", seq: 4 });
    vi.advanceTimersByTime(16);
    const seqs = sent.flatMap((frame) => (frame.batch ? frame.batch.map((e) => e.seq) : [frame.seq]));
    expect(seqs).toEqual([1, 2, 3, 4]);
  });
});
