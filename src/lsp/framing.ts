/**
 * LSP / tsserver 共用的 Content-Length 分帧。
 * 只在 stdio 上跑，不做网络相关的兼容；对 \n\n 分隔也容忍。
 */
const MAX_HEADER_BYTES = 8 * 1024;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export function encodeFrame(message: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, "ascii"),
    json,
  ]);
}

export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(
    private readonly onMessage: (message: unknown) => void,
    private readonly onError?: (error: Error) => void,
  ) {}

  feed(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const crlf = this.buffer.indexOf("\r\n\r\n");
      const lf = this.buffer.indexOf("\n\n");
      let headerEnd: number;
      let separatorLength: number;
      if (crlf >= 0 && (lf < 0 || crlf <= lf)) {
        headerEnd = crlf;
        separatorLength = 4;
      } else if (lf >= 0) {
        headerEnd = lf;
        separatorLength = 2;
      } else {
        if (this.buffer.length > MAX_HEADER_BYTES) {
          this.onError?.(new Error("LSP message header is too large."));
          this.buffer = Buffer.alloc(0);
        }
        return;
      }
      if (headerEnd > MAX_HEADER_BYTES) {
        this.onError?.(new Error("LSP message header is too large."));
        this.buffer = Buffer.alloc(0);
        return;
      }
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /(?:^|\r?\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.onError?.(new Error("LSP message is missing Content-Length."));
        this.buffer = this.buffer.subarray(headerEnd + separatorLength);
        continue;
      }
      const length = Number(match[1]);
      if (!Number.isInteger(length) || length < 0 || length > MAX_FRAME_BYTES) {
        this.onError?.(new Error(`Invalid LSP Content-Length: ${match[1]}`));
        this.buffer = Buffer.alloc(0);
        return;
      }
      const bodyStart = headerEnd + separatorLength;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch (error) {
        this.onError?.(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      this.onMessage(parsed);
    }
  }
}
