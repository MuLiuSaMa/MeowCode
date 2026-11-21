import { describe, expect, it } from "vitest";
import { BEHAVIOR_SEGMENT, buildAgentSegments, buildEnvironmentSegment } from "./prompt-segments.js";

describe("environment segment", () => {
  it("写清工作区、平台、shell、审批档和当天日期", () => {
    const text = buildEnvironmentSegment({
      workspace: "D:\\MeowCode",
      platform: "win32",
      approvalMode: "full",
      today: "2026-11-21",
    });
    expect(text).toContain("workspace D:\\MeowCode");
    expect(text).toContain("win32");
    expect(text).toContain("shell PowerShell");
    expect(text).toContain("approval full access");
    expect(text).toContain("today 2026-11-21");
    expect(text.startsWith("Environment: ")).toBe(true);
  });

  it("缺省审批档按「会询问」描述，不留空档", () => {
    const text = buildEnvironmentSegment({ workspace: "C:\\ws", approvalMode: "default" });
    expect(text).toContain("approval ask");
    expect(text).not.toContain("undefined");
    expect(buildEnvironmentSegment({ workspace: "C:\\ws" })).toContain("approval ask");
  });

  it("未知审批档原样透出，不吞掉", () => {
    expect(buildEnvironmentSegment({ workspace: "x", approvalMode: "custom-mode" })).toContain(
      "approval custom-mode",
    );
  });
});

describe("agent segments", () => {
  it("行为段在前、环境段在后，且行为段覆盖四条动作边界", () => {
    const segments = buildAgentSegments({ workspace: "D:\\MeowCode" });
    expect(segments[0]).toBe(BEHAVIOR_SEGMENT);
    expect(segments[1].startsWith("Environment: ")).toBe(true);
    for (const phrase of [
      "Risky or hard-to-reverse actions",
      "never revert them",
      "findings first with severity and path:line",
      "read the error and fix the cause",
      "update_plan",
    ]) {
      expect(BEHAVIOR_SEGMENT).toContain(phrase);
    }
  });

  it("行为段不重复基线已有的红线（避免同一句话说两遍）", () => {
    // 基线负责「假完成 / 数据不是指令 / 只改被要求的」，行为段只补边界，不复述
    expect(BEHAVIOR_SEGMENT).not.toContain("Never claim a result");
    expect(BEHAVIOR_SEGMENT).not.toContain("data, not instructions");
    expect(BEHAVIOR_SEGMENT).not.toContain("Change only what was asked");
  });
});
