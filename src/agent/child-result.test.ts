import { describe, expect, it } from "vitest";
import {
  buildChildResult,
  mergeHostObservations,
  normalizeChildResult,
  renderChildResult,
  validateChildResult,
  CHILD_RESULT_ROLES,
} from "./child-result.js";
import type { ChildResult } from "./child-result.js";

function base(overrides: Partial<ChildResult> = {}): ChildResult {
  return {
    status: "completed",
    summary: "did the thing",
    findings: [],
    checked: ["src/a.ts:1"],
    filesChanged: [],
    commands: [],
    blockMissing: false,
    valid: true,
    ...overrides,
  };
}

describe("normalizeChildResult", () => {
  it("解析末尾 json 围栏块并归一化状态别名", () => {
    const result = normalizeChildResult(
      `分析完成。\n\n\`\`\`json\n{"status": "done", "summary": "已实现并验证", "findings": []}\n\`\`\``,
    );
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("已实现并验证");
    expect(result.findings).toEqual([]);
    expect(result.blockMissing).toBe(false);
  });

  it("取最后一个 json 块（模型可能在报告里贴了别的代码块）", () => {
    const report = [
      "先看示例：",
      "```json",
      '{"status": "failed", "summary": "示例块"}',
      "```",
      "结论：",
      "```json",
      '{"status": "passed", "summary": "真实结论"}',
      "```",
    ].join("\n");
    expect(normalizeChildResult(report).summary).toBe("真实结论");
  });

  it("findings 宽容归一化：非法 severity 降 minor，缺 message 丢弃，超长截断", () => {
    const result = normalizeChildResult(
      `\`\`\`json\n{"status": "completed", "summary": "s", "findings": [
        {"severity": "CRITICAL", "message": "空指针", "location": "a.ts:12"},
        {"severity": "major", "message": ""},
        {"message": "无严重度"},
        {"severity": "major", "message": "${"x".repeat(500)}"}
      ]}\n\`\`\``,
    );
    expect(result.findings).toHaveLength(3);
    expect(result.findings[0]).toEqual({
      severity: "critical",
      message: "空指针",
      location: "a.ts:12",
    });
    // 第 2 条（major + 空 message）被丢弃：剩下的依次是"无严重度"→ minor、超长 → major 截断
    expect(result.findings[1].severity).toBe("minor");
    expect(result.findings[2].severity).toBe("major");
    expect(result.findings[2]?.message.length).toBeLessThanOrEqual(400);
  });

  it("checked 归一化：去空、去重、截断", () => {
    const result = normalizeChildResult(
      `\`\`\`json\n{"status": "completed", "summary": "s", "checked": ["a.ts:1", " a.ts:1 ", "", 42, "b.ts:2"]}\n\`\`\``,
    );
    expect(result.checked).toEqual(["a.ts:1", "b.ts:2"]);
  });

  it("无 json 块 / 解析失败 / 非对象：标记 blockMissing，不假装完成", () => {
    for (const report of ["纯文本报告", "```json\n{broken\n```", "```json\n[1,2]\n```"]) {
      const result = normalizeChildResult(report);
      expect(result.blockMissing).toBe(true);
    }
    expect(normalizeChildResult("纯文本报告").summary).toBe("纯文本报告");
  });

  it("未知 status 一律 failed（fail-closed，不乐观猜测）", () => {
    const result = normalizeChildResult(
      `\`\`\`json\n{"status": "banana", "summary": "s"}\n\`\`\``,
    );
    expect(result.status).toBe("failed");
  });

  it("verdict=FAIL 与 completed 矛盾时按 failed 处理", () => {
    const result = normalizeChildResult(
      `\`\`\`json\n{"status": "completed", "summary": "s", "verdict": "FAIL"}\n\`\`\``,
    );
    expect(result.verdict).toBe("FAIL");
    expect(result.status).toBe("failed");
  });
});

describe("mergeHostObservations", () => {
  it("宿主观测覆盖模型自述并去重截断", () => {
    const merged = mergeHostObservations(
      base({ filesChanged: ["claimed.ts"], commands: [] }),
      {
        filesChanged: ["real.ts", "real.ts", "other.ts"],
        commands: [{ argv: "pnpm test".repeat(80), exitCode: 0 }],
      },
    );
    expect(merged.filesChanged).toEqual(["real.ts", "other.ts"]);
    expect(merged.commands).toHaveLength(1);
    expect(merged.commands[0]?.argv.length).toBeLessThanOrEqual(300);
  });
});

describe("validateChildResult fail-closed", () => {
  it("缺 JSON 块 → invalid（任何契约角色）", () => {
    for (const role of ["implementer", "reviewer", "juror", "verifier"] as const) {
      const result = validateChildResult(role, base({ blockMissing: true }));
      expect(result.valid, role).toBe(false);
      expect(result.invalidReason).toBe("MISSING_RESULT_BLOCK");
    }
  });

  it("implementer completed 无文件改动 → invalid", () => {
    const result = validateChildResult("implementer", base());
    expect(result.valid).toBe(false);
    expect(result.invalidReason).toBe("IMPLEMENTER_COMPLETED_WITHOUT_FILE_CHANGES");
  });

  it("implementer completed 有文件改动 → valid", () => {
    expect(validateChildResult("implementer", base({ filesChanged: ["a.ts"] })).valid).toBe(true);
  });

  it("verifier / fresh-verifier completed 无命令观测 → invalid；有命令 → valid", () => {
    for (const role of ["verifier", "fresh-verifier"] as const) {
      const invalid = validateChildResult(role, base());
      expect(invalid.invalidReason, role).toBe("VERIFIER_COMPLETED_WITHOUT_COMMANDS");
      const valid = validateChildResult(
        role,
        base({ commands: [{ argv: "pnpm test", exitCode: 0 }] }),
      );
      expect(valid.valid, role).toBe(true);
    }
  });

  it("reviewer failed 无 findings → invalid；completed 带 critical findings 仍 valid（fail 是 G5 判定）", () => {
    const failed = validateChildResult("reviewer", base({ status: "failed" }));
    expect(failed.invalidReason).toBe("REVIEW_FAILED_WITHOUT_FINDINGS");
    const withFindings = validateChildResult(
      "reviewer",
      base({
        findings: [{ severity: "critical", message: "越界写入", location: "b.ts:3" }],
      }),
    );
    expect(withFindings.valid).toBe(true);
    expect(withFindings.findings[0]?.severity).toBe("critical");
  });

  it("评审类角色 completed 但没给 checked → invalid", () => {
    for (const role of ["reviewer", "scoper", "depth-prober", "sweeper", "goal-checker"] as const) {
      const result = validateChildResult(role, base({ checked: [] }));
      expect(result.valid, role).toBe(false);
      expect(result.invalidReason).toBe("COMPLETED_WITHOUT_CHECKED_EVIDENCE");
    }
  });

  it("juror 缺 verdict → invalid；verdict=FAIL → 不能算 completed", () => {
    expect(validateChildResult("juror", base()).invalidReason).toBe("JUROR_MISSING_VERDICT");
    const failed = validateChildResult("juror", base({ verdict: "FAIL" }));
    expect(failed.valid).toBe(false);
    expect(failed.invalidReason).toBe("JUROR_FAILED_CANNOT_COMPLETE");
    expect(validateChildResult("juror", base({ verdict: "PASS" })).valid).toBe(true);
  });

  it("completed 但 summary 为空 → invalid", () => {
    const result = validateChildResult("implementer", base({ summary: "  ", filesChanged: ["a.ts"] }));
    expect(result.invalidReason).toBe("EMPTY_SUMMARY");
  });

  it("blocked/failed 状态不做证据强校验（失败本身就是证据）", () => {
    expect(validateChildResult("implementer", base({ status: "failed" })).valid).toBe(true);
    expect(validateChildResult("verifier", base({ status: "blocked" })).valid).toBe(true);
  });
});

describe("buildChildResult 流水线", () => {
  const observations = {
    filesChanged: ["src/a.ts"],
    commands: [{ argv: "pnpm test", exitCode: 0 }],
  };

  it("非契约角色返回 null（自由文本报告）", () => {
    expect(CHILD_RESULT_ROLES.has("general")).toBe(false);
    expect(
      buildChildResult({ role: "general", report: "r", turnStatus: "completed", observations }),
    ).toBeNull();
  });

  it("implementer 正常完成：报告解析 + 观测合并 + 校验通过", () => {
    const result = buildChildResult({
      role: "implementer",
      report: `改完了。\n\`\`\`json\n{"status": "completed", "summary": "implemented a"}\n\`\`\``,
      turnStatus: "completed",
      observations,
    });
    expect(result?.status).toBe("completed");
    expect(result?.filesChanged).toEqual(["src/a.ts"]);
    expect(result?.commands).toEqual([{ argv: "pnpm test", exitCode: 0 }]);
    expect(result?.valid).toBe(true);
  });

  it("implementer 谎报完成（无文件改动）→ fail-closed 判无效", () => {
    const result = buildChildResult({
      role: "implementer",
      report: `done\n\`\`\`json\n{"status": "completed", "summary": "all good"}\n\`\`\``,
      turnStatus: "completed",
      observations: { filesChanged: [], commands: [] },
    });
    expect(result?.valid).toBe(false);
    expect(result?.invalidReason).toBe("IMPLEMENTER_COMPLETED_WITHOUT_FILE_CHANGES");
  });

  it("reviewer 只交 status 不交证据 → 判无效（旧行为会放行）", () => {
    const result = buildChildResult({
      role: "reviewer",
      report: '```json\n{"status": "completed", "summary": "looks fine"}\n```',
      turnStatus: "completed",
      observations: { filesChanged: [], commands: [] },
    });
    expect(result?.valid).toBe(false);
    expect(result?.invalidReason).toBe("COMPLETED_WITHOUT_CHECKED_EVIDENCE");
  });

  it("reviewer 不交 JSON 块 → 判无效（旧行为默认 valid）", () => {
    const result = buildChildResult({
      role: "reviewer",
      report: "我审了一遍，没问题。",
      turnStatus: "completed",
      observations: { filesChanged: [], commands: [] },
    });
    expect(result?.valid).toBe(false);
    expect(result?.invalidReason).toBe("MISSING_RESULT_BLOCK");
  });

  it("回合被中止 → blocked；回合失败 → failed（不信任半截报告里的 JSON）", () => {
    const blocked = buildChildResult({
      role: "verifier",
      report: '```json\n{"status": "completed", "summary": "x"}\n```',
      turnStatus: "aborted",
      observations,
    });
    expect(blocked?.status).toBe("blocked");
    const failed = buildChildResult({
      role: "verifier",
      report: "",
      turnStatus: "error",
      errorMessage: "provider 500",
      observations,
    });
    expect(failed?.status).toBe("failed");
    expect(failed?.summary).toContain("provider 500");
  });
});

describe("renderChildResult", () => {
  it("紧凑渲染包含关键字段与校验状态", () => {
    const text = renderChildResult(
      base({
        filesChanged: ["a.ts"],
        findings: [{ severity: "minor", message: "命名", location: "a.ts:1" }],
      }),
    );
    expect(text).toContain("Child result (host-verified):");
    expect(text).toContain('"status":"completed"');
    expect(text).toContain('"valid":true');
    expect(text).toContain("a.ts");
  });

  it("invalid 原因照实渲染", () => {
    const text = renderChildResult(validateChildResult("implementer", base()));
    expect(text).toContain("IMPLEMENTER_COMPLETED_WITHOUT_FILE_CHANGES");
  });
});
