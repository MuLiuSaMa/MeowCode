import { describe, expect, it, vi } from "vitest";
import { readSseFrames } from "./sse";

describe("readSseFrames", () => {
  it("fails when the provider stops sending data", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // 保持连接打开，但永不发送数据
      },
    });

    await expect(readSseFrames(stream, () => undefined, undefined, 10, 10)).rejects.toThrow(
      "stalled",
    );
  });

  it("fails when only keepalive comments arrive", async () => {
    const encoder = new TextEncoder();
    let interval: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        interval = setInterval(() => {
          controller.enqueue(encoder.encode(": ping\n\n"));
        }, 5);
      },
      cancel() {
        if (interval) clearInterval(interval);
      },
    });

    try {
      await expect(readSseFrames(stream, () => undefined, undefined, 30, 30)).rejects.toThrow(
        "stalled",
      );
    } finally {
      if (interval) clearInterval(interval);
    }
  });

  it("parses frames normally", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"a":1}\n\n'));
        controller.close();
      },
    });
    const frames: string[] = [];
    await readSseFrames(
      stream,
      (data) => {
        frames.push(data);
      },
      undefined,
      1_000,
      1_000,
    );
    expect(frames).toEqual(['{"a":1}']);
  });

  it("uses the first-token budget until the first content frame, then the idle budget", async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => controller.enqueue(encoder.encode('data: {"a":1}\n\n')), 5_000);
        },
      });
      const frames: string[] = [];
      const promise = readSseFrames(
        stream,
        (data) => {
          frames.push(data);
          return true;
        },
        undefined,
        1_000,
        60_000,
      );
      const assertion = expect(promise).rejects.toThrow("stalled for 1s");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(frames).toEqual(['{"a":1}']);
      await vi.advanceTimersByTimeAsync(2_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not end the first-token phase on metadata frames", async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // response.created 只是 bookkeeping，不能把 60s 首帧预算降成 1s
          setTimeout(
            () => controller.enqueue(encoder.encode('data: {"type":"response.created"}\n\n')),
            2_000,
          );
        },
      });
      const promise = readSseFrames(stream, () => false, undefined, 1_000, 60_000, 600_000);
      const assertion = expect(promise).rejects.toThrow("stalled for 60s");
      await vi.advanceTimersByTimeAsync(70_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the first-token budget when no frame ever arrives", async () => {
    vi.useFakeTimers();
    try {
      const stream = new ReadableStream<Uint8Array>({ start() {} });
      const promise = readSseFrames(stream, () => undefined, undefined, 1_000, 60_000);
      const assertion = expect(promise).rejects.toThrow("stalled for 60s");
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a stream that keeps trickling without producing new output", async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      let interval: ReturnType<typeof setInterval> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // 每 50s 一帧，永远不触发 90s 空闲超时，也永远不发终止帧
          interval = setInterval(
            () => controller.enqueue(encoder.encode('data: {"a":1}\n\n')),
            50_000,
          );
        },
        cancel() {
          if (interval) clearInterval(interval);
        },
      });
      const frames: string[] = [];
      const promise = readSseFrames(
        stream,
        (data) => {
          frames.push(data);
        },
        undefined,
        90_000,
        300_000,
        600_000,
      );
      const assertion = expect(promise).rejects.toThrow("no new output for 600s");
      await vi.advanceTimersByTimeAsync(600_000);
      await assertion;
      expect(frames.length).toBeGreaterThanOrEqual(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a slow stream alive as long as it keeps producing output", async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      let interval: ReturnType<typeof setInterval> | undefined;
      let sent = 0;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          interval = setInterval(() => {
            sent += 1;
            if (sent > 24) {
              if (interval) clearInterval(interval);
              controller.close();
              return;
            }
            controller.enqueue(encoder.encode('data: {"delta":"x"}\n\n'));
          }, 50_000);
        },
        cancel() {
          if (interval) clearInterval(interval);
        },
      });
      // 总时长 1200s 远超 600s，但每帧都算新内容，不能被无进展上限截断
      const promise = readSseFrames(
        stream,
        () => true,
        undefined,
        90_000,
        300_000,
        600_000,
      );
      await vi.advanceTimersByTimeAsync(1_250_000);
      await expect(promise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
