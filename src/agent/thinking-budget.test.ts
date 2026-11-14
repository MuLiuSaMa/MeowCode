import { describe, expect, it } from "vitest";
import {
  MAX_THINKING_BUDGET,
  MIN_THINKING_BUDGET,
  boostEffort,
  complexityBoostSteps,
  resolveThinkingBudget,
  resolveThinkingPolicy,
} from "./thinking-budget.js";

describe("resolveThinkingBudget", () => {
  it("maps effort levels to the plan's budget table", () => {
    expect(resolveThinkingBudget({ effort: "minimal", maxTokens: 32_000 })).toBe(1024);
    expect(resolveThinkingBudget({ effort: "low", maxTokens: 32_000 })).toBe(1024);
    expect(resolveThinkingBudget({ effort: "medium", maxTokens: 32_000 })).toBe(2048);
    expect(resolveThinkingBudget({ effort: "high", maxTokens: 32_000 })).toBe(4096);
    expect(resolveThinkingBudget({ effort: "xhigh", maxTokens: 32_000 })).toBe(8192);
    expect(resolveThinkingBudget({ effort: "max", maxTokens: 32_000 })).toBe(16_384);
  });

  it("falls back to medium for an unknown level instead of max", () => {
    expect(resolveThinkingBudget({ effort: "ultra", maxTokens: 32_000 })).toBe(2048);
  });

  it("returns undefined when neither effort nor explicit budget is set", () => {
    expect(resolveThinkingBudget({})).toBeUndefined();
    expect(resolveThinkingBudget({ maxTokens: 32_000 })).toBeUndefined();
    // 0/负数不算显式预算
    expect(resolveThinkingBudget({ explicit: 0 })).toBeUndefined();
    expect(resolveThinkingBudget({ explicit: Number.NaN })).toBeUndefined();
  });

  it("lets an explicit budget override the effort level", () => {
    expect(resolveThinkingBudget({ effort: "high", explicit: 8000, maxTokens: 32_000 })).toBe(8000);
  });

  it("clamps the budget so max_tokens always has room for output", () => {
    // 2048 - 1024(输出预留) = 1024：high 的 4096 被压到 1024
    expect(resolveThinkingBudget({ effort: "high", maxTokens: 2048 })).toBe(MIN_THINKING_BUDGET);
    expect(resolveThinkingBudget({ effort: "max", maxTokens: 4096 })).toBe(3072);
  });

  it("does not send thinking when max_tokens cannot hold a legal budget", () => {
    expect(resolveThinkingBudget({ effort: "high", maxTokens: 1500 })).toBeUndefined();
    expect(resolveThinkingBudget({ effort: "high", maxTokens: 1024 })).toBeUndefined();
    expect(resolveThinkingBudget({ explicit: 4096, maxTokens: 1500 })).toBeUndefined();
  });

  it("assumes 8192 max_tokens when the caller does not know the limit", () => {
    expect(resolveThinkingBudget({ effort: "max" })).toBe(7168);
  });

  it("never exceeds the hard ceiling", () => {
    expect(resolveThinkingBudget({ explicit: 999_999, maxTokens: 1_000_000 })).toBe(MAX_THINKING_BUDGET);
  });
});

describe("boostEffort", () => {
  const levels = ["minimal", "low", "medium", "high"];

  it("moves one level up in the declared order", () => {
    expect(boostEffort("low", levels)).toBe("medium");
    expect(boostEffort("medium", levels)).toBe("high");
  });

  it("stops at the top level", () => {
    expect(boostEffort("high", levels)).toBe("high");
  });

  it("keeps the effort when levels are unknown", () => {
    expect(boostEffort("low", undefined)).toBe("low");
    expect(boostEffort("low", [])).toBe("low");
    // 不在声明列表里的档位不猜顺序
    expect(boostEffort("custom", levels)).toBe("custom");
  });
});

describe("resolveThinkingPolicy", () => {
  it("boosts the effort in plan mode", () => {
    expect(
      resolveThinkingPolicy({
        effort: "low",
        reasoningLevels: ["low", "medium", "high"],
        maxTokens: 32_000,
        boost: true,
      }),
    ).toEqual({ effort: "medium", budget: 2048 });
  });

  it("does not touch an explicit budget", () => {
    expect(
      resolveThinkingPolicy({
        effort: "low",
        explicit: 8000,
        reasoningLevels: ["low", "medium", "high"],
        maxTokens: 32_000,
        boost: true,
      }),
    ).toEqual({ effort: "low", budget: 8000 });
  });

  it("reports no budget when the window is too small", () => {
    expect(resolveThinkingPolicy({ effort: "high", maxTokens: 1500 })).toEqual({ effort: "high" });
  });
});

describe("complexityBoostSteps（#9 复杂度调档）", () => {
  it("各项事实各算一档，封顶两档", () => {
    expect(complexityBoostSteps(undefined)).toBe(0);
    expect(complexityBoostSteps({})).toBe(0);
    // 门禁 4 条以上 / 子 Agent 2 个以上 / T2 / 连续失败 2 次，各一档
    expect(complexityBoostSteps({ gates: 4 })).toBe(1);
    expect(complexityBoostSteps({ gates: 3 })).toBe(0);
    expect(complexityBoostSteps({ subagents: 2 })).toBe(1);
    expect(complexityBoostSteps({ tier: "T2" })).toBe(1);
    expect(complexityBoostSteps({ recentFailures: 2 })).toBe(1);
    expect(complexityBoostSteps({ recentFailures: 1 })).toBe(0);
    // 四项全中也只升两档：再往上就是 max，成本翻倍收益递减
    expect(
      complexityBoostSteps({ gates: 9, subagents: 5, tier: "T2", recentFailures: 4 }),
    ).toBe(2);
  });

  it("resolveThinkingPolicy：复杂度与模式取较大步数，显式预算仍然优先", () => {
    const levels = ["low", "medium", "high", "xhigh"];
    // 模式升 1 档 + 复杂度 2 档 → 取 2
    const boosted = resolveThinkingPolicy({
      effort: "low",
      boost: true,
      complexity: { gates: 4, tier: "T2" },
      reasoningLevels: levels,
    });
    expect(boosted.effort).toBe("high");
    // 显式预算是精确意图：不参与升档
    const pinned = resolveThinkingPolicy({
      effort: "low",
      explicit: 2048,
      complexity: { gates: 9, tier: "T2" },
      reasoningLevels: levels,
    });
    expect(pinned.effort).toBe("low");
    expect(pinned.budget).toBe(2048);
  });
});
