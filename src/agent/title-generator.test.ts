import { describe, expect, it } from "vitest";
import { cleanGeneratedTitle, normalizeTitleInput } from "./title-generator.js";

describe("cleanGeneratedTitle", () => {
  it("keeps a short JSON title as-is", () => {
    expect(cleanGeneratedTitle('{"title":"修复登录页样式"}')).toBe("修复登录页样式");
  });

  it("parses fenced JSON and strips thinking blocks", () => {
    expect(cleanGeneratedTitle('```json\n{"title":"计划页签"}\n```')).toBe("计划页签");
    expect(cleanGeneratedTitle('<think>内部推理</think>{"title":"自动展开面板"}')).toBe(
      "自动展开面板",
    );
  });

  it("truncates an oversized CJK title by display width", () => {
    const title = "把前端整体重写成黑白灰的 Agent 风格并修复所有显示问题和光标残留";
    // 宽度上限 36（CJK 记 2、拉丁记 1）：截到「风格」后补省略号
    expect(cleanGeneratedTitle(JSON.stringify({ title }))).toBe(
      "把前端整体重写成黑白灰的 Agent 风格…",
    );
  });

  it("does not cut a Latin title in the middle of a word", () => {
    const title = "Refactor the authentication middleware for desktop";
    expect(cleanGeneratedTitle(JSON.stringify({ title }))).toBe("Refactor the authentication…");
  });

  it("rejects a long plain-text reply instead of storing it as a title", () => {
    const reply =
      "I'll start by exploring your project structure to understand what we're working with.<tool_call>list_dir</tool_call>";
    expect(cleanGeneratedTitle(reply)).toBeNull();
  });

  it("accepts a short plain-text title fallback", () => {
    expect(cleanGeneratedTitle("修复光标残留")).toBe("修复光标残留");
    // 裸文本的句末标点会被清掉
    expect(cleanGeneratedTitle("修复光标残留。")).toBe("修复光标残留");
  });

  it("rejects empty or decoration-only output", () => {
    expect(cleanGeneratedTitle("")).toBeNull();
    expect(cleanGeneratedTitle("???")).toBeNull();
    expect(cleanGeneratedTitle('{"title":""}')).toBeNull();
  });
});

describe("normalizeTitleInput", () => {
  it("collapses whitespace and caps the input length", () => {
    expect(normalizeTitleInput("  hello\n\nworld  ")).toBe("hello world");
    expect(normalizeTitleInput("x".repeat(2_000)).length).toBe(1_200);
  });
});
