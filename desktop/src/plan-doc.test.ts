import { describe, expect, it } from "vitest";
import { samePlanDocPath } from "./plan-doc";

describe("samePlanDocPath", () => {
  it("Windows 反斜杠与斜杠视为同一份文档", () => {
    expect(samePlanDocPath("plans\\2026-11-14-demo.md", "plans/2026-11-14-demo.md")).toBe(true);
  });

  it("忽略开头的 ./", () => {
    expect(samePlanDocPath("./plans/demo.md", "plans/demo.md")).toBe(true);
  });

  it("不同文档不相等", () => {
    expect(samePlanDocPath("plans/a.md", "plans/b.md")).toBe(false);
  });

  it("空值不相等", () => {
    expect(samePlanDocPath(null, "plans/a.md")).toBe(false);
    expect(samePlanDocPath("plans/a.md", undefined)).toBe(false);
    expect(samePlanDocPath("", "")).toBe(false);
  });
});
