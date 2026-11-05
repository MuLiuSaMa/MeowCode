import { describe, expect, it } from "vitest";
import { splitHighlight } from "./search-highlight";

describe("splitHighlight", () => {
  it("returns the whole text as one plain segment without ranges", () => {
    expect(splitHighlight("hello world", [])).toEqual([{ text: "hello world", hit: false }]);
  });

  it("returns empty for empty text", () => {
    expect(splitHighlight("", [{ start: 0, end: 1 }])).toEqual([]);
  });

  it("splits prefix / hit / suffix", () => {
    expect(splitHighlight("abcdef", [{ start: 2, end: 4 }])).toEqual([
      { text: "ab", hit: false },
      { text: "cd", hit: true },
      { text: "ef", hit: false },
    ]);
  });

  it("highlights a match covering the whole text", () => {
    expect(splitHighlight("abc", [{ start: 0, end: 3 }])).toEqual([{ text: "abc", hit: true }]);
  });

  it("clamps out-of-bounds and drops invalid ranges", () => {
    expect(splitHighlight("abc", [{ start: -5, end: 2 }])).toEqual([
      { text: "ab", hit: true },
      { text: "c", hit: false },
    ]);
    expect(splitHighlight("abc", [{ start: 2, end: 99 }])).toEqual([
      { text: "ab", hit: false },
      { text: "c", hit: true },
    ]);
    expect(splitHighlight("abc", [{ start: 2, end: 2 }])).toEqual([{ text: "abc", hit: false }]);
  });

  it("merges overlapping and adjacent ranges", () => {
    expect(splitHighlight("abcdef", [
      { start: 0, end: 3 },
      { start: 2, end: 5 },
    ])).toEqual([{ text: "abcde", hit: true }, { text: "f", hit: false }]);

    expect(splitHighlight("abcdef", [
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ])).toEqual([{ text: "abcd", hit: true }, { text: "ef", hit: false }]);
  });

  it("sorts unsorted ranges before splitting", () => {
    expect(splitHighlight("abcdef", [
      { start: 4, end: 6 },
      { start: 0, end: 2 },
    ])).toEqual([
      { text: "ab", hit: true },
      { text: "cd", hit: false },
      { text: "ef", hit: true },
    ]);
  });

  it("keeps surrogate-pair text intact by slicing on code-unit offsets from the server", () => {
    const text = "前置😀后置";
    // 😀 占 2 个 code unit；服务端偏移按 JS 字符串下标计算
    expect(splitHighlight(text, [{ start: 2, end: 4 }])).toEqual([
      { text: "前置", hit: false },
      { text: "😀", hit: true },
      { text: "后置", hit: false },
    ]);
  });
});
