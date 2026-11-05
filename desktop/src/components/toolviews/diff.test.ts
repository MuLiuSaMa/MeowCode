import { describe, expect, it } from "vitest";
import { diffLines } from "./diff";

describe("diffLines", () => {
  it("标出单行替换并保留上下文行号", () => {
    const result = diffLines("a\nb\nc", "a\nB\nc");
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.rows).toEqual([
      { kind: "ctx", text: "a", oldNo: 1, newNo: 1 },
      { kind: "del", text: "b", oldNo: 2 },
      { kind: "add", text: "B", newNo: 2 },
      { kind: "ctx", text: "c", oldNo: 3, newNo: 3 },
    ]);
  });

  it("只在中间插入一行", () => {
    const result = diffLines("a\nc", "a\nb\nc");
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.rows.map((row) => row.kind)).toEqual(["ctx", "add", "ctx"]);
    expect(result.rows[1].newNo).toBe(2);
    expect(result.rows[2]).toMatchObject({ oldNo: 2, newNo: 3 });
  });

  it("只在中间删除一行", () => {
    const result = diffLines("a\nb\nc", "a\nc");
    expect(result.added).toBe(0);
    expect(result.removed).toBe(1);
    expect(result.rows.map((row) => row.kind)).toEqual(["ctx", "del", "ctx"]);
    expect(result.rows[1].oldNo).toBe(2);
  });

  it("空内容 → 新增文件", () => {
    const result = diffLines("", "x\ny");
    expect(result.added).toBe(2);
    expect(result.removed).toBe(0);
    expect(result.rows).toEqual([
      { kind: "add", text: "x", newNo: 1 },
      { kind: "add", text: "y", newNo: 2 },
    ]);
  });

  it("内容 → 空（删除/清空）", () => {
    const result = diffLines("x\ny", "");
    expect(result.added).toBe(0);
    expect(result.removed).toBe(2);
    expect(result.rows.map((row) => row.kind)).toEqual(["del", "del"]);
  });

  it("统一 CRLF，不把换行符算进 diff", () => {
    const result = diffLines("a\r\nb", "a\r\nB");
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.rows[1]).toMatchObject({ kind: "del", text: "b" });
  });

  it("超长 diff 只保留展示上限但统计完整", () => {
    const before = Array.from({ length: 400 }, (_, index) => `old-${index}`).join("\n");
    const after = Array.from({ length: 400 }, (_, index) => `new-${index}`).join("\n");
    const result = diffLines(before, after);
    expect(result.added).toBe(400);
    expect(result.removed).toBe(400);
    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(600);
  });
});
