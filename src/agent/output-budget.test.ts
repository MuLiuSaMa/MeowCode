import { describe, expect, it } from "vitest";
import {
  CONTEXT_SAFETY_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  MIN_OUTPUT_TOKENS,
  resolveOutputBudget,
} from "./output-budget";

describe("resolveOutputBudget", () => {
  it("窗口未知时保持配置值", () => {
    const budget = resolveOutputBudget({ inputTokens: 120_000, configuredMaxTokens: 32_000 });
    expect(budget.tokens).toBe(32_000);
    expect(budget.clamped).toBe(false);
    expect(budget.available).toBe(Number.POSITIVE_INFINITY);
    expect(budget.source).toBe("configured");
  });

  it("未配置输出上限时用保守默认值", () => {
    const budget = resolveOutputBudget({ inputTokens: 100 });
    expect(budget.tokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it("输入占满窗口时按剩余空间收紧", () => {
    const budget = resolveOutputBudget({
      inputTokens: 195_000,
      contextWindow: 200_000,
      configuredMaxTokens: 32_000,
    });
    expect(budget.tokens).toBe(200_000 - 195_000 - CONTEXT_SAFETY_TOKENS);
    expect(budget.clamped).toBe(true);
    expect(budget.source).toBe("estimate");
  });

  it("剩余空间为负时保底 MIN_OUTPUT_TOKENS，不返回 0 或负数", () => {
    const budget = resolveOutputBudget({
      inputTokens: 260_000,
      contextWindow: 200_000,
      configuredMaxTokens: 8_192,
    });
    expect(budget.tokens).toBe(MIN_OUTPUT_TOKENS);
    expect(budget.clamped).toBe(true);
  });

  it("输入宽松时不抬高配置值", () => {
    const budget = resolveOutputBudget({
      inputTokens: 1_000,
      contextWindow: 200_000,
      configuredMaxTokens: 4_096,
    });
    expect(budget.tokens).toBe(4_096);
    expect(budget.clamped).toBe(false);
  });

  it("真实用量优先于字符估算", () => {
    const budget = resolveOutputBudget({
      inputTokens: 1_000,
      measuredInputTokens: 190_000,
      contextWindow: 200_000,
      configuredMaxTokens: 32_000,
    });
    expect(budget.source).toBe("measured");
    expect(budget.inputTokens).toBe(190_000);
    expect(budget.tokens).toBe(200_000 - 190_000 - CONTEXT_SAFETY_TOKENS);
  });

  it("忽略非法的真实用量与窗口值", () => {
    const budget = resolveOutputBudget({
      inputTokens: 50_000,
      measuredInputTokens: 0,
      contextWindow: 0,
      configuredMaxTokens: 8_192,
    });
    expect(budget.source).toBe("configured");
    expect(budget.tokens).toBe(8_192);
  });

  it("配置值低于保底时抬到保底", () => {
    const budget = resolveOutputBudget({ inputTokens: 0, configuredMaxTokens: 16 });
    expect(budget.tokens).toBe(MIN_OUTPUT_TOKENS);
  });
});
