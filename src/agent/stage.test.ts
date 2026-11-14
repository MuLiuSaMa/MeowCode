import { describe, expect, it } from "vitest";
import { aggregateStage, deriveStage, stageKey, type StageInput, type StageView } from "./stage.js";

/** 映射表逐行断言：改语义先改这里，UI 才不会悄悄漂。 */

const CASES: Array<[string, StageInput, string, boolean]> = [
  ["审批挂起", { kind: "attention", source: "approval" }, "person/approval", true],
  ["提问挂起", { kind: "attention", source: "ask_user" }, "person/answer", true],

  ["计划空", { kind: "plan", steps: [], streaming: false }, "idle", false],
  [
    "计划有进行中",
    { kind: "plan", steps: [{ status: "completed" }, { status: "in_progress" }], streaming: true },
    "working/running",
    false,
  ],
  [
    "计划全完成",
    { kind: "plan", steps: [{ status: "completed" }, { status: "completed" }], streaming: false },
    "ended/completed",
    false,
  ],
  [
    "计划全取消",
    { kind: "plan", steps: [{ status: "cancelled" }, { status: "cancelled" }], streaming: false },
    "ended/cancelled",
    false,
  ],
  [
    "计划部分完成其余取消",
    { kind: "plan", steps: [{ status: "completed" }, { status: "cancelled" }], streaming: false },
    "ended/cancelled",
    false,
  ],
  [
    "计划有 pending 且仍在跑",
    { kind: "plan", steps: [{ status: "completed" }, { status: "pending" }], streaming: true },
    "working/running",
    false,
  ],
  [
    "计划有 pending 但回合已结束",
    { kind: "plan", steps: [{ status: "completed" }, { status: "pending" }], streaming: false },
    "machine/queued",
    false,
  ],

  ["子 Agent 运行", { kind: "subagent", status: "running" }, "working/running", false],
  ["子 Agent 完成", { kind: "subagent", status: "completed" }, "ended/completed", false],
  ["子 Agent 失败", { kind: "subagent", status: "failed" }, "ended/failed", false],
  ["子 Agent 主动停止", { kind: "subagent", status: "aborted" }, "ended/aborted", false],
  ["子 Agent 进程中断", { kind: "subagent", status: "interrupted" }, "person/review", true],

  ["lane 排队", { kind: "lane", status: "queued" }, "machine/queued", false],
  ["lane 跑着且门禁待判", { kind: "lane", status: "active", gates: { G4: "pending" } }, "working/running", false],
  [
    "lane 门禁失败还能修",
    { kind: "lane", status: "active", gates: { G4: "failed" }, repairCount: 1 },
    "machine/repair",
    false,
  ],
  [
    "lane 门禁失败修满了",
    { kind: "lane", status: "active", gates: { G4: "failed" }, repairCount: 3 },
    "person/review",
    true,
  ],
  [
    "lane 门禁失败且是 pass/fail 拼写",
    { kind: "lane", status: "active", gates: { G4: "fail" }, repairCount: 0 },
    "machine/repair",
    false,
  ],
  [
    "lane 被上游挡着（上游未完成）",
    { kind: "lane", status: "blocked", upstreamDone: false },
    "machine/queued",
    false,
  ],
  ["lane 真被挡住", { kind: "lane", status: "blocked", upstreamDone: true }, "machine/blocked", false],
  ["lane 完成", { kind: "lane", status: "done" }, "ended/completed", false],
];

describe("deriveStage 映射表", () => {
  it.each(CASES)("%s", (_label, input, expectedKey, expectedNeedsHuman) => {
    const view = deriveStage(input);
    expect(stageKey(view.stage)).toBe(expectedKey);
    expect(view.needsHuman).toBe(expectedNeedsHuman);
  });
});

describe("不变量", () => {
  it("needsHuman 恒等于 stage === person", () => {
    for (const [, input] of CASES) {
      const view = deriveStage(input);
      expect(view.needsHuman).toBe(view.stage.stage === "person");
    }
  });

  it("空输入聚合为 idle", () => {
    expect(stageKey(aggregateStage([]).stage)).toBe("idle");
    expect(aggregateStage([]).needsHuman).toBe(false);
  });

  it("person 压过 working 与 machine", () => {
    const views: StageView[] = [
      deriveStage({ kind: "subagent", status: "running" }),
      deriveStage({ kind: "lane", status: "active", gates: { G4: "failed" }, repairCount: 1 }),
      deriveStage({ kind: "attention", source: "approval" }),
    ];
    const merged = aggregateStage(views);
    expect(stageKey(merged.stage)).toBe("person/approval");
    expect(merged.needsHuman).toBe(true);
  });

  it("working 压过 machine（一个失败不能盖住还在跑的任务）", () => {
    const views: StageView[] = [
      deriveStage({ kind: "lane", status: "active", gates: { G4: "failed" }, repairCount: 1 }),
      deriveStage({ kind: "subagent", status: "running" }),
    ];
    expect(stageKey(aggregateStage(views).stage)).toBe("working/running");
  });

  it("machine 内部取最早阻塞者：repair > blocked > queued", () => {
    const views: StageView[] = [
      deriveStage({ kind: "lane", status: "queued" }),
      deriveStage({ kind: "lane", status: "blocked", upstreamDone: true }),
      deriveStage({ kind: "lane", status: "active", gates: { G4: "failed" }, repairCount: 1 }),
    ];
    expect(stageKey(aggregateStage(views).stage)).toBe("machine/repair");
  });

  it("全部终态才返回 ended，且取最坏结果", () => {
    const views: StageView[] = [
      deriveStage({ kind: "subagent", status: "completed" }),
      deriveStage({ kind: "lane", status: "done" }),
      deriveStage({ kind: "subagent", status: "failed" }),
    ];
    const merged = aggregateStage(views);
    expect(stageKey(merged.stage)).toBe("ended/failed");
    expect(merged.needsHuman).toBe(false);
  });

  it("interrupted 恒需人，aborted / cancelled 恒不需人", () => {
    expect(deriveStage({ kind: "subagent", status: "interrupted" }).needsHuman).toBe(true);
    expect(deriveStage({ kind: "subagent", status: "aborted" }).needsHuman).toBe(false);
    expect(
      deriveStage({ kind: "plan", steps: [{ status: "cancelled" }], streaming: false }).needsHuman,
    ).toBe(false);
  });
});
