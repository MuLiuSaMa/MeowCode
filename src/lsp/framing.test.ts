import { describe, expect, it } from "vitest";
import { FrameParser, encodeFrame } from "./framing";

function collect(): { parser: FrameParser; messages: unknown[]; errors: Error[] } {
  const messages: unknown[] = [];
  const errors: Error[] = [];
  const parser = new FrameParser(
    (message) => messages.push(message),
    (error) => errors.push(error),
  );
  return { parser, messages, errors };
}

describe("LSP framing", () => {
  it("round-trips one message", () => {
    const { parser, messages } = collect();
    parser.feed(encodeFrame({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
    expect(messages).toEqual([{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
  });

  it("handles split chunks and multiple frames in one chunk", () => {
    const { parser, messages } = collect();
    const first = encodeFrame({ a: 1 });
    const second = encodeFrame({ b: 2 });
    const combined = Buffer.concat([first, second]);
    parser.feed(combined.subarray(0, 5));
    parser.feed(combined.subarray(5, first.length + 2));
    parser.feed(combined.subarray(first.length + 2));
    expect(messages).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("reports malformed headers without killing the parser", () => {
    const { parser, messages, errors } = collect();
    parser.feed(Buffer.from("X-Nope: 1\r\n\r\n"));
    parser.feed(encodeFrame({ ok: true }));
    expect(errors.length).toBe(1);
    expect(messages).toEqual([{ ok: true }]);
  });

  it("accepts LF-only separators", () => {
    const { parser, messages } = collect();
    const body = JSON.stringify({ ok: true });
    parser.feed(Buffer.from(`Content-Length: ${body.length}\n\n${body}`));
    expect(messages).toEqual([{ ok: true }]);
  });
});
