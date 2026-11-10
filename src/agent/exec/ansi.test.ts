import { describe, expect, it } from "vitest";
import { createAnsiStripper, hasAnsi, stripAnsi } from "./ansi";

const strip = (parts: string[]): string => {
  const stripper = createAnsiStripper();
  const out = parts.map((part) => stripper.push(Buffer.from(part, "utf8")));
  out.push(stripper.flush());
  return Buffer.concat(out).toString("utf8");
};

describe("ansi stripper", () => {
  it("removes SGR colour codes", () => {
    expect(strip(["\u001b[31merror\u001b[0m: boom"])).toBe("error: boom");
  });

  it("removes cursor / erase sequences (CSI)", () => {
    expect(strip(["\u001b[2K\u001b[1Gdone"])).toBe("done");
  });

  it("keeps a sequence split across chunks from eating the next bytes", () => {
    // 真正的坑：ESC 和 '[' 分两次读到，逐块处理会把 '[' 当正文留下、把内容吃掉
    expect(strip(["\u001b", "[32mok"])).toBe("ok");
    // CSI 的参数跨块
    expect(strip(["\u001b[3", "8;5;196mred\u001b[0m"])).toBe("red");
  });

  it("removes OSC titles terminated by BEL or ST", () => {
    expect(strip(["\u001b]0;window title\u0007text"])).toBe("text");
    expect(strip(["\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\"])).toBe("link");
  });

  it("removes DCS payloads", () => {
    expect(strip(["\u001bP1$r\u001b\\after"])).toBe("after");
  });

  it("removes single-character escapes", () => {
    expect(strip(["\u001bcreset"])).toBe("reset");
  });

  it("passes multi-byte UTF-8 through untouched", () => {
    expect(strip(["中文\u001b[0m输出"])).toBe("中文输出");
  });

  it("drops a dangling sequence at flush instead of leaking control bytes", () => {
    expect(strip(["tail\u001b[38;5"])).toBe("tail");
  });

  it("leaves ordinary text identical", () => {
    const text = "line 1\nline 2\n\tindented\r\n";
    expect(strip([text])).toBe(text);
  });

  it("reports whether a value contains escapes", () => {
    expect(hasAnsi("\u001b[0m")).toBe(true);
    expect(hasAnsi("plain")).toBe(false);
  });

  it("stripAnsi handles a whole string in one call", () => {
    expect(stripAnsi("\u001b[1;33mwarn\u001b[0m")).toBe("warn");
  });
});
