import { describe, expect, it } from "vitest";
import {
  buildOutcomeRecord,
  computeImplicitScore,
  createTurnTrace,
  deriveRecoveryPairs,
  detectSignals,
  extractErrorSignature,
  hashSessionTurn,
  isControlGroupHoldout,
  isUserCorrection,
  recordToolCall,
  repeatedFailures,
  skillNameFromPath,
} from "./signals";

describe("correction detection", () => {
  it("recognises Chinese and English corrections", () => {
    expect(isUserCorrection("不对，我要的是另一个文件")).toBe(true);
    expect(isUserCorrection("我是说先跑测试")).toBe(true);
    expect(isUserCorrection("That's not what I asked for")).toBe(true);
    expect(isUserCorrection("i meant the other module")).toBe(true);
  });

  it("does not fire on ordinary requests", () => {
    expect(isUserCorrection("帮我把这个函数重构成 async")).toBe(false);
    expect(isUserCorrection("add a test for the parser")).toBe(false);
    expect(isUserCorrection("不是这个意思吗？顺便加个日志")).toBe(true); // 含「不是这个意思」按纠正处理
  });
});

describe("zero-token gate", () => {
  it("returns nothing for an ordinary successful turn", () => {
    const trace = createTurnTrace();
    trace.userTexts.push("给 parser 加一个空行处理");
    recordToolCall(trace, { name: "read_file", args: { path: "src/parser.ts" }, ok: true });
    recordToolCall(trace, {
      name: "run_command",
      args: { command: "pnpm test" },
      ok: true,
    });
    expect(detectSignals(trace)).toEqual([]);
  });

  it("fires on a user correction", () => {
    const trace = createTurnTrace();
    trace.userTexts.push("不对，你改错文件了");
    const signals = detectSignals(trace);
    expect(signals.map((signal) => signal.type)).toContain("correction");
  });

  it("fires on an explicit save request", () => {
    const trace = createTurnTrace();
    trace.userTexts.push("记住：以后发版都走 pnpm release");
    const signals = detectSignals(trace);
    expect(signals.map((signal) => signal.type)).toContain("explicit_save");
  });

  it("fires on a repeated failing command", () => {
    const trace = createTurnTrace();
    recordToolCall(trace, { name: "run_command", args: { command: "pnpm build" }, ok: false });
    recordToolCall(trace, { name: "run_command", args: { command: "pnpm build" }, ok: false });
    const signals = detectSignals(trace);
    expect(signals.map((signal) => signal.type)).toContain("command_failure");
    expect(repeatedFailures(trace.commandFingerprints)).toEqual([
      { command: "pnpm build", count: 2 },
    ]);
  });

  it("fires on a heavy turn", () => {
    const trace = createTurnTrace();
    for (let index = 0; index < 8; index += 1) {
      recordToolCall(trace, { name: "grep", args: { pattern: "x" }, ok: true });
    }
    expect(detectSignals(trace).map((signal) => signal.type)).toContain("heavy_turn");
  });

  it("fires when the model actually read a learned skill", () => {
    const trace = createTurnTrace();
    recordToolCall(trace, {
      name: "read_file",
      args: { path: "D:/proj/.meowcode/learning/skills/release/SKILL.md" },
      ok: true,
    });
    const signals = detectSignals(trace);
    expect(signals.map((signal) => signal.type)).toContain("skill_recall");
    expect(trace.skillReads).toEqual(["release"]);
  });
});

describe("recovery pairs", () => {
  it("pairs a failed command with the later successful one", () => {
    const pairs = deriveRecoveryPairs([
      { command: "pnpm build", exitCode: 1 },
      { command: "pnpm install", exitCode: 0 },
      { command: "pnpm build", exitCode: 0 },
    ]);
    // 一条失败只配一次恢复：install 已经把它救回来了，后面的 build 不再重复配对
    expect(pairs).toEqual([{ failed: "pnpm build", recovered: "pnpm install" }]);
  });

  it("keeps failures that no later success rescued", () => {
    const pairs = deriveRecoveryPairs([
      { command: "pnpm build", exitCode: 1 },
      { command: "git status", exitCode: 0 },
    ]);
    expect(pairs).toEqual([]);
  });

  it("ignores successes with no prior failure", () => {
    expect(deriveRecoveryPairs([{ command: "pnpm test", exitCode: 0 }])).toEqual([]);
  });
});

describe("error signatures", () => {
  it("extracts the stable part of a tool error", () => {
    expect(extractErrorSignature("Error: Cannot find module 'chalk'")).toContain("Cannot find module");
    expect(extractErrorSignature("src/a.ts(3,5): error TS2345: bad arg")).toBe("TS2345");
    expect(extractErrorSignature("ENOENT: no such file or directory")).toBe("ENOENT");
    expect(extractErrorSignature("all good")).toBeNull();
  });
});

describe("implicit score", () => {
  it("ranks outcomes in the expected order", () => {
    expect(computeImplicitScore({ status: "completed", toolErrors: 0, userCorrected: false })).toBe(1);
    expect(computeImplicitScore({ status: "completed", toolErrors: 2, userCorrected: false })).toBe(0.5);
    expect(computeImplicitScore({ status: "error", toolErrors: 0, userCorrected: false })).toBe(-0.5);
    expect(computeImplicitScore({ status: "aborted", toolErrors: 0, userCorrected: false })).toBe(-1);
    // 纠正覆盖一切正分
    expect(computeImplicitScore({ status: "completed", toolErrors: 0, userCorrected: true })).toBe(-1);
  });
});

describe("control group holdout", () => {
  it("is deterministic for the same session and turn", () => {
    expect(hashSessionTurn("s1", 3)).toBe(hashSessionTurn("s1", 3));
    expect(isControlGroupHoldout("s1", 3)).toBe(isControlGroupHoldout("s1", 3));
  });

  it("holds out roughly 15% of turns", () => {
    let holdout = 0;
    const total = 4_000;
    for (let turn = 0; turn < total; turn += 1) {
      if (isControlGroupHoldout("session-x", turn)) holdout += 1;
    }
    const ratio = holdout / total;
    expect(ratio).toBeGreaterThan(0.12);
    expect(ratio).toBeLessThan(0.18);
  });
});

describe("outcome record", () => {
  it("carries the trace and derives the implicit score", () => {
    const trace = createTurnTrace();
    trace.userTexts.push("把 build 修好");
    recordToolCall(trace, { name: "run_command", args: { command: "pnpm build" }, ok: false });
    recordToolCall(trace, { name: "run_command", args: { command: "pnpm build" }, ok: true });

    const record = buildOutcomeRecord({
      sessionId: "s1",
      turnIndex: 2,
      status: "completed",
      trace,
      recalledIds: ["project:skill:release"],
      userCorrected: false,
      holdout: false,
    });
    expect(record.toolCalls).toBe(2);
    expect(record.toolErrors).toBe(1);
    expect(record.recoveryPairs).toHaveLength(1);
    expect(record.implicitScore).toBe(0.5);
    expect(record.recalledIds).toEqual(["project:skill:release"]);
  });
});

describe("skill path detection", () => {
  it("extracts the skill name from both separator styles", () => {
    expect(skillNameFromPath("D:/p/.meowcode/learning/skills/release/SKILL.md")).toBe("release");
    expect(skillNameFromPath("D:\\p\\.meowcode\\learning\\skills\\release\\SKILL.md")).toBe("release");
    expect(skillNameFromPath("D:/p/.meowcode/skills/handwritten/SKILL.md")).toBeNull();
  });
});
