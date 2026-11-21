import { describe, expect, it } from "vitest";
import { splitMarkdownBlocks, splitStreamingMarkdown } from "./streaming-markdown";

describe("splitStreamingMarkdown", () => {
  it("keeps plain prose in the tail when there is no safe boundary", () => {
    expect(splitStreamingMarkdown("hello *wor")).toEqual({
      stable: "",
      tail: "hello *wor",
    });
    expect(splitStreamingMarkdown("")).toEqual({ stable: "", tail: "" });
  });

  it("splits after a blank line followed by a safe top-level block", () => {
    const parts = splitStreamingMarkdown("first paragraph\n\n# heading");
    expect(parts.stable).toBe("first paragraph\n\n");
    expect(parts.tail).toBe("# heading");
  });

  it("does not split before a list or blockquote", () => {
    expect(splitStreamingMarkdown("intro\n\n- item")).toEqual({
      stable: "",
      tail: "intro\n\n- item",
    });
    expect(splitStreamingMarkdown("intro\n\n> quote")).toEqual({
      stable: "",
      tail: "intro\n\n> quote",
    });
  });

  it("treats a closed fence as a stable boundary", () => {
    const text = "before\n\n```ts\nconst a = 1;\n```\nafter";
    const parts = splitStreamingMarkdown(text);
    expect(parts.stable).toBe("before\n\n```ts\nconst a = 1;\n```\n");
    expect(parts.tail).toBe("after");
    expect(parts.openFence).toBeUndefined();
  });

  it("exposes an unclosed fence as plain text and keeps the prefix stable", () => {
    const text = "before\n\n```ts\nconst a = 1;\ncons";
    const parts = splitStreamingMarkdown(text);
    expect(parts.stable).toBe("before\n\n");
    expect(parts.tail).toBe("");
    expect(parts.openFence).toEqual({ lang: "ts", body: "const a = 1;\ncons" });
  });

  it("ignores blank lines inside a fence", () => {
    const text = "```md\nfirst\n\nsecond";
    const parts = splitStreamingMarkdown(text);
    expect(parts.stable).toBe("");
    expect(parts.openFence).toEqual({ lang: "md", body: "first\n\nsecond" });
  });

  it("closes tilde fences and longer fences correctly", () => {
    const closed = splitStreamingMarkdown("~~~js\ncode\n~~~\nrest");
    expect(closed.stable).toBe("~~~js\ncode\n~~~\n");
    expect(closed.tail).toBe("rest");

    const longer = splitStreamingMarkdown("````\ncode\n````\nrest");
    expect(longer.stable).toBe("````\ncode\n````\n");
  });

  it("handles Windows newlines", () => {
    const parts = splitStreamingMarkdown("a\r\n\r\nb");
    expect(parts.stable).toBe("a\r\n\r\n");
    expect(parts.tail).toBe("b");
  });
});

describe("splitMarkdownBlocks", () => {
  it("splits prose on blank lines and keeps the separator in the earlier block", () => {
    expect(splitMarkdownBlocks("a\n\nb\n\nc")).toEqual(["a\n\n", "b\n\n", "c"]);
  });

  it("keeps blank lines inside a fence within the same block", () => {
    expect(splitMarkdownBlocks("```md\nfirst\n\nsecond\n```\n\nafter")).toEqual([
      "```md\nfirst\n\nsecond\n```\n",
      "after",
    ]);
  });

  it("keeps a loose list in one block instead of splitting it into two lists", () => {
    // 关键回归：按空行硬切会把松散列表拆成两个 <ul>、把引用拆成两个 <blockquote>，
    // 间距和语义都会变。边界规则必须与 splitStreamingMarkdown 一致。
    expect(splitMarkdownBlocks("- one\n\n- two\n\ntail")).toEqual(["- one\n\n- two\n\n", "tail"]);
    expect(splitMarkdownBlocks("> a\n\n> b\n\ntail")).toEqual(["> a\n\n> b\n\n", "tail"]);
  });

  it("ignores leading blank lines", () => {
    // 块尾的连续空行会并入前一块，渲染时等价
    expect(splitMarkdownBlocks("\n\n\npara\n\n\n\nnext")).toEqual(["para\n\n\n\n", "next"]);
    expect(splitMarkdownBlocks("")).toEqual([]);
    expect(splitMarkdownBlocks("\n\n")).toEqual([]);
  });

  it("falls back to a single block when link or footnote definitions exist", () => {
    // 定义可以被前面的引用使用，拆开渲染会让引用失效
    expect(splitMarkdownBlocks("see [x]\n\n[x]: https://example.com\n\nmore")).toHaveLength(1);
    expect(splitMarkdownBlocks("text[^1]\n\n[^1]: note\n\nmore")).toHaveLength(1);
  });

  it("does not treat a task list checkbox as a link definition", () => {
    // 若 `- [ ]` 被误判成 link reference definition，整篇会退化成 1 块
    expect(splitMarkdownBlocks("todo\n\npara\n\n- [ ] a")).toHaveLength(2);
  });
});
