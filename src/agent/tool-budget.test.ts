import { describe, expect, it } from "vitest";
import { estimateTokens } from "./context";
import { sliceHeadToTokens, truncateToTokens } from "./tool-budget";

describe("truncateToTokens", () => {
  it("under budget keeps the original text", () => {
    const text = "const value = 1;";
    expect(truncateToTokens(text, 100)).toEqual({
      text,
      truncated: false,
      omittedTokens: 0,
    });
  });

  it("keeps head and tail of over-budget text", () => {
    const text = `START-${"x".repeat(2_000)}-END`;
    const result = truncateToTokens(text, 100);
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith("START-")).toBe(true);
    expect(result.text.endsWith("-END")).toBe(true);
    expect(result.text).toContain("truncated");
    expect(result.omittedTokens).toBeGreaterThan(0);
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(110);
  });

  it("中文按字计预算，不会像字符口径那样放大四倍", () => {
    const text = "中".repeat(1_000);
    const result = truncateToTokens(text, 100);
    expect(result.truncated).toBe(true);
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(110);
    // 头尾各留一部分，不能只剩开头
    expect(result.text.indexOf("中")).toBeGreaterThanOrEqual(0);
    expect(result.text.lastIndexOf("中")).toBeGreaterThan(result.text.indexOf("中"));
  });

  it("headRatio=0 只留尾部，headRatio=1 只留头部", () => {
    const text = `HEAD${"x".repeat(1_000)}TAIL`;
    const tail = truncateToTokens(text, 50, { headRatio: 0 }).text;
    expect(tail.endsWith("TAIL")).toBe(true);
    expect(tail.startsWith("HEAD")).toBe(false);
    const head = truncateToTokens(text, 50, { headRatio: 1 }).text;
    expect(head.startsWith("HEAD")).toBe(true);
    expect(head.endsWith("TAIL")).toBe(false);
  });

  it("sliceHeadToTokens 不追加省略标记", () => {
    const text = "中".repeat(50);
    const head = sliceHeadToTokens(text, 10);
    expect(head).toBe("中".repeat(10));
  });
});
