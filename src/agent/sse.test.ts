import { describe, expect, it } from "vitest";
import { readSseFrames } from "./sse";

describe("readSseFrames", () => {
  it("fails when the provider stops sending data", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // 保持连接打开，但永不发送数据
      },
    });

    await expect(readSseFrames(stream, () => undefined, undefined, 10)).rejects.toThrow(
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
      await expect(readSseFrames(stream, () => undefined, undefined, 30)).rejects.toThrow(
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
    await readSseFrames(stream, (data) => frames.push(data), undefined, 1_000);
    expect(frames).toEqual(['{"a":1}']);
  });
});
