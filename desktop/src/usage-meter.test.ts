import { describe, expect, it } from "vitest";
import {
  applySample,
  EMPTY_SAMPLE,
  hitRate,
  isCacheBust,
  mergeSample,
  retractSample,
  totalsFromServer,
  type UsageSample,
} from "./usage-meter";

const sample = (patch: Partial<UsageSample>): UsageSample => ({ ...EMPTY_SAMPLE, ...patch });

describe("usage-meter", () => {
  it("同一轮多次上报按替换计，不双计（实时输入 + 输出增长 + 最终真值）", () => {
    let totals = { ...EMPTY_SAMPLE };
    let previous: UsageSample | undefined;

    // 流开始：Anthropic 的 message_start 先给输入与缓存
    let next = mergeSample(previous, {
      inputTokens: 12000,
      cacheReadTokens: 9000,
      cacheWriteTokens: 1000,
    });
    totals = applySample(totals, previous, next);
    expect(totals.input).toBe(12000);
    expect(totals.cacheRead).toBe(9000);
    expect(totals.output).toBe(0);
    previous = next;

    // 输出增长
    next = mergeSample(previous, { inputTokens: 12000, outputTokens: 120 });
    totals = applySample(totals, previous, next);
    expect(totals.input).toBe(12000); // 没有翻倍
    expect(totals.output).toBe(120);

    // 最终真值覆盖同一轮
    previous = next;
    next = mergeSample(previous, { outputTokens: 340 });
    totals = applySample(totals, previous, next);
    expect(totals.output).toBe(340);
    expect(totals.input).toBe(12000);
    expect(totals.cacheRead).toBe(9000);
  });

  it("多轮之间是累加：不同 roundId 各自替换", () => {
    const roundA = sample({ input: 1000, output: 50, cacheRead: 800, cacheInput: 1000, cacheReported: true });
    const roundB = sample({ input: 1200, output: 80, cacheRead: 600, cacheInput: 1200, cacheReported: true });
    let totals = applySample({ ...EMPTY_SAMPLE }, undefined, roundA);
    totals = applySample(totals, undefined, roundB);
    expect(totals.input).toBe(2200);
    expect(totals.output).toBe(130);
    expect(hitRate(totals)).toBeCloseTo(1400 / 2200);
  });

  it("撤回一轮后总量回减，不会留下负数", () => {
    const round = sample({ input: 1000, output: 50, cacheRead: 800, cacheInput: 1000, cacheReported: true });
    const totals = applySample({ ...EMPTY_SAMPLE }, undefined, round);
    const retracted = retractSample(totals, round);
    expect(retracted.input).toBe(0);
    expect(retracted.output).toBe(0);
    expect(retracted.cacheRead).toBe(0);
    // 撤回不存在的样本是空操作
    expect(retractSample(retracted, undefined)).toEqual(retracted);
  });

  it("命中率只统计报告过缓存的轮次，没有分母时为 null", () => {
    expect(hitRate({ ...EMPTY_SAMPLE })).toBeNull();
    const noCache = applySample({ ...EMPTY_SAMPLE }, undefined, sample({ input: 500, output: 10 }));
    expect(hitRate(noCache)).toBeNull();
    const withCache = applySample(
      noCache,
      undefined,
      sample({ input: 1000, output: 10, cacheRead: 900, cacheInput: 1000, cacheReported: true }),
    );
    // 只算报告缓存那一轮的输入（1000），未报告缓存的 500 不进分母
    expect(hitRate(withCache)).toBeCloseTo(0.9);
  });

  it("事件缺字段时不把已有值清零", () => {
    const first = mergeSample(undefined, { inputTokens: 800, cacheReadTokens: 600 });
    const second = mergeSample(first, { outputTokens: 40 });
    expect(second.input).toBe(800);
    expect(second.cacheRead).toBe(600);
    expect(second.output).toBe(40);
    expect(second.cacheInput).toBe(800);
  });

  it("服务端汇总作为基座可直接派生", () => {
    const totals = totalsFromServer({
      inputTokens: 5000,
      outputTokens: 300,
      cacheReadTokens: 4000,
      cacheWriteTokens: 200,
      cacheInputTokens: 5000,
      cacheReported: true,
    });
    expect(totals.input).toBe(5000);
    expect(hitRate(totals)).toBeCloseTo(0.8);
    expect(totalsFromServer(null)).toEqual(EMPTY_SAMPLE);
  });
});

describe("isCacheBust", () => {
  it("同模型相邻两轮命中读数显著跌落 = 疑似失配", () => {
    expect(isCacheBust({ read: 50_000 }, { read: 40_000 })).toBe(true);
  });

  it("1024 桶内漂移不报警（OpenAI 豁免），读数为 0 的轮不参与", () => {
    expect(isCacheBust({ read: 50_000 }, { read: 49_000 })).toBe(false);
    expect(isCacheBust({ read: 50_000 }, { read: 0 })).toBe(false);
    expect(isCacheBust(null, { read: 40_000 })).toBe(false);
    expect(isCacheBust({ read: 50_000 }, undefined)).toBe(false);
  });
});
