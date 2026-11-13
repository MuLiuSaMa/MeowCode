import { describe, expect, it } from "vitest";
import {
  CACHE_MIN_INPUT_TOKENS,
  classifyCache,
  diffPrefix,
  prefixChangeSegments,
  resolveMinCacheableTokens,
  type CacheObservation,
  type PrefixSnapshot,
} from "./cache-diagnostics";

const base: CacheObservation = {
  protocol: "openai-chat-completions",
  inputTokens: 10_000,
  prefixChanged: false,
  hadSamePrefixBefore: true,
  idleMs: 1_000,
};

describe("classifyCache", () => {
  it("reports warm when the provider returned cached tokens", () => {
    expect(classifyCache({ ...base, cacheReadTokens: 8_000 })).toEqual({ state: "warm" });
  });

  it("distinguishes not reported from an explicit zero", () => {
    expect(classifyCache({ ...base, cacheReadTokens: undefined })).toEqual({
      state: "unknown",
      reason: "not_reported",
    });
    expect(classifyCache({ ...base, cacheReadTokens: 0 })).toEqual({
      state: "unsupported",
      reason: "stable_prefix_no_cached_tokens",
    });
  });

  it("treats the first request as a normal cache write", () => {
    expect(
      classifyCache({ ...base, cacheReadTokens: 0, hadSamePrefixBefore: false }),
    ).toEqual({ state: "cold", reason: "first_request" });
  });

  it("attributes a changed prefix to our own churn", () => {
    expect(
      classifyCache({ ...base, cacheReadTokens: 0, prefixChanged: true }),
    ).toEqual({ state: "cold", reason: "prefix_changed" });
  });

  it("flags eviction when idle exceeds the declared ttl", () => {
    expect(
      classifyCache({ ...base, cacheReadTokens: 0, cacheTtl: "5m", idleMs: 400_000 }),
    ).toEqual({ state: "evicted", reason: "idle_exceeded_ttl" });
    expect(
      classifyCache({ ...base, cacheReadTokens: 0, cacheTtl: "1h", idleMs: 400_000 }),
    ).toEqual({ state: "unsupported", reason: "stable_prefix_no_cached_tokens" });
  });

  it("reports warm even when the prefix grew, keeping the segment in the reason", () => {
    expect(
      classifyCache({ ...base, cacheReadTokens: 8_000, prefixChanged: true }),
    ).toEqual({ state: "warm" });
    expect(
      classifyCache({
        ...base,
        cacheReadTokens: 8_000,
        prefixChanged: true,
        changedSegments: ["tools"],
      }),
    ).toEqual({ state: "warm", reason: "prefix_changed:tools" });
  });

  it("separates write-without-readback from eviction", () => {
    // 写了 N 却一次没读回：网关丢字段 / 换分片，不是被逐出
    expect(
      classifyCache({ ...base, cacheReadTokens: 0, cacheWriteTokens: 5_000 }),
    ).toEqual({ state: "evicted", reason: "write_no_readback" });
  });

  it("treats a stable-prefix anthropic miss without any write as breakpoints not applied", () => {
    expect(
      classifyCache({ ...base, protocol: "anthropic-messages", cacheReadTokens: 0 }),
    ).toEqual({ state: "unsupported", reason: "no_cache_write" });
  });

  it("honours a per-model cache granularity", () => {
    expect(
      classifyCache(
        { ...base, inputTokens: 3_000, cacheReadTokens: 0 },
        { minCacheableTokens: 4_096 },
      ),
    ).toEqual({ state: "unknown", reason: "below_cache_granularity" });
    // 同一份输入在 1024 档模型上已经该被判定为失效
    expect(
      classifyCache(
        { ...base, inputTokens: 3_000, cacheReadTokens: 0, cacheWriteTokens: 2_000 },
        { minCacheableTokens: 1_024 },
      ),
    ).toEqual({ state: "evicted", reason: "write_no_readback" });
  });

  it("ignores tiny inputs below cache granularity", () => {
    expect(
      classifyCache({ ...base, inputTokens: 500, cacheReadTokens: 0 }),
    ).toEqual({ state: "unknown", reason: "below_cache_granularity" });
  });

  it("names the segment that broke the prefix", () => {
    expect(
      classifyCache({
        ...base,
        cacheReadTokens: 0,
        prefixChanged: true,
        changedSegments: ["tools", "system[1]"],
      }),
    ).toEqual({ state: "cold", reason: "prefix_changed:tools+system[1]" });
  });
});

const snapshot = (tools: string, system: string[]): PrefixSnapshot => ({ tools, system });

describe("resolveMinCacheableTokens", () => {
  it("uses the OpenAI 1024 bucket for every non-anthropic protocol", () => {
    expect(resolveMinCacheableTokens("openai-chat-completions", "deepseek-chat")).toBe(1_024);
    expect(resolveMinCacheableTokens("openai-responses", "gpt-5.6")).toBe(1_024);
  });

  it("tiers anthropic models and falls back conservatively", () => {
    expect(resolveMinCacheableTokens("anthropic-messages", "claude-sonnet-4-5")).toBe(1_024);
    expect(resolveMinCacheableTokens("anthropic-messages", "claude-3-5-haiku")).toBe(2_048);
    expect(resolveMinCacheableTokens("anthropic-messages", "claude-3-opus")).toBe(4_096);
    // 认不出来（兼容网关自定义模型名）就回落到缺省 2048，不猜一个更小的值
    expect(resolveMinCacheableTokens("anthropic-messages", "my-gateway-model")).toBe(
      CACHE_MIN_INPUT_TOKENS,
    );
  });
});

describe("diffPrefix", () => {
  it("treats the first request as having nothing to compare", () => {
    expect(diffPrefix(undefined, snapshot("t1", ["a"]))).toEqual({
      changed: false,
      tools: false,
      system: [],
      countChanged: false,
    });
  });

  it("isolates a tools-only change", () => {
    const diff = diffPrefix(snapshot("t1", ["a", "b"]), snapshot("t2", ["a", "b"]));
    expect(diff).toEqual({ changed: true, tools: true, system: [], countChanged: false });
    expect(prefixChangeSegments(diff)).toEqual(["tools"]);
  });

  it("isolates which system message changed", () => {
    const diff = diffPrefix(snapshot("t1", ["a", "b", "c"]), snapshot("t1", ["a", "B", "c"]));
    expect(prefixChangeSegments(diff)).toEqual(["system[1]"]);
  });

  it("flags a system count change instead of trusting index alignment", () => {
    const diff = diffPrefix(snapshot("t1", ["a", "b"]), snapshot("t1", ["a", "b", "style"]));
    expect(diff.countChanged).toBe(true);
    // 前缀多出的那条不按 system[2] 报，避免与「第 3 条内容改了」混淆
    expect(prefixChangeSegments(diff)).toEqual(["system_count"]);
  });

  it("reports no segments when the prefix is byte-identical", () => {
    const diff = diffPrefix(snapshot("t1", ["a"]), snapshot("t1", ["a"]));
    expect(diff.changed).toBe(false);
    expect(prefixChangeSegments(diff)).toEqual([]);
  });
});
