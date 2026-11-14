import { describe, expect, it } from "vitest";
import {
  PLAN_NUDGE_STEP,
  planMutationWeight,
  planNudge,
  turnEndPlanBlock,
} from "./plan-freshness.js";

/**
 * 一个真实会话暴露的三个口径问题（见模块头注释）：
 * 改动量按调用计、收尾闸被 update_plan 清零、空清单无人管。
 */

describe("planMutationWeight", () => {
  it("multi_edit 按涉及的文件数计，不按 edits 条数", () => {
    const oneFile = {
      edits: [
        { path: "a.ts", oldString: "x", newString: "y" },
        { path: "a.ts", oldString: "m", newString: "n" },
      ],
    };
    const threeFiles = {
      edits: [
        { path: "a.ts", oldString: "x", newString: "y" },
        { path: "b.ts", oldString: "x", newString: "y" },
        { path: "c.ts", oldString: "x", newString: "y" },
      ],
    };
    // 同一文件改两处 = 一处改动
    expect(planMutationWeight("multi_edit", oneFile)).toBe(1);
    // 三个文件 = 三处改动（旧口径只记 1，这就是问题所在）
    expect(planMutationWeight("multi_edit", threeFiles)).toBe(3);
  });

  it("multi_edit 参数非法时记 1，不丢计数", () => {
    expect(planMutationWeight("multi_edit", { edits: [] })).toBe(1);
    expect(planMutationWeight("multi_edit", undefined)).toBe(1);
  });

  it("apply_patch 按 patch 里的文件头计", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      "-x",
      "+y",
      "*** Add File: src/b.ts",
      "+new",
      "*** Delete File: src/c.ts",
      "*** End Patch",
    ].join("\n");
    expect(planMutationWeight("apply_patch", { patch })).toBe(3);
    expect(planMutationWeight("apply_patch", { patch: "garbage" })).toBe(1);
  });

  it("其余写类工具各记 1；只读工具记 0", () => {
    expect(planMutationWeight("write_file", { path: "a", content: "" })).toBe(1);
    expect(planMutationWeight("edit_file", {})).toBe(1);
    expect(planMutationWeight("delete_file", {})).toBe(1);
    expect(planMutationWeight("move_file", {})).toBe(1);
    // 读取与搜索不改变工作区，不该被当成「改动」
    for (const tool of ["read_file", "grep", "glob", "read_many", "run_command"]) {
      expect(planMutationWeight(tool, {}), tool).toBe(0);
    }
  });
});

describe("planNudge", () => {
  const base = {
    mutations: 0,
    nudgedAt: 0,
    hasPlan: false,
    hasOpenSteps: false,
    noPlanNudged: false,
  };

  it("没有清单时，第一次改动就推建清单（且整回合只推一次）", () => {
    expect(planNudge({ ...base, mutations: 0 })?.kind).toBeUndefined();
    expect(planNudge({ ...base, mutations: 1 })).toEqual({ kind: "create", nextNudgedAt: 0 });
    // 推过一次后不再推
    expect(planNudge({ ...base, mutations: 3, noPlanNudged: true })).toBeNull();
  });

  it("有清单且有未完成步骤：按改动单位累计到阈值再推", () => {
    const state = { ...base, hasPlan: true, hasOpenSteps: true };
    expect(planNudge({ ...state, mutations: PLAN_NUDGE_STEP - 1 })).toBeNull();
    expect(planNudge({ ...state, mutations: PLAN_NUDGE_STEP })).toEqual({
      kind: "update",
      nextNudgedAt: PLAN_NUDGE_STEP,
    });
    // 提醒过之后再涨不到阈值，不重复推
    const nudged = { ...state, nudgedAt: PLAN_NUDGE_STEP };
    expect(planNudge({ ...nudged, mutations: PLAN_NUDGE_STEP + 1 })).toBeNull();
    expect(planNudge({ ...nudged, mutations: PLAN_NUDGE_STEP * 2 })).toEqual({
      kind: "update",
      nextNudgedAt: PLAN_NUDGE_STEP * 2,
    });
  });

  it("清单全部完成就不再提醒", () => {
    expect(
      planNudge({ ...base, hasPlan: true, hasOpenSteps: false, mutations: 10 }),
    ).toBeNull();
  });
});

describe("turnEndPlanBlock", () => {
  it("有未完成步骤 + 本回合改过文件 → 拦一次（与 update_plan 是否清过计数无关）", () => {
    expect(turnEndPlanBlock({ hasOpenSteps: true, turnHadMutations: true })).toBe(true);
  });

  it("只读回合不拦，清单全部完成也不拦", () => {
    expect(turnEndPlanBlock({ hasOpenSteps: true, turnHadMutations: false })).toBe(false);
    expect(turnEndPlanBlock({ hasOpenSteps: false, turnHadMutations: true })).toBe(false);
  });
});
