import { describe, expect, it } from "vitest";
import { classifyCache, type CacheObservation } from "./cache-diagnostics";

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

  it("treats a stable-prefix miss on anthropic as eviction", () => {
    expect(
      classifyCache({ ...base, protocol: "anthropic-messages", cacheReadTokens: 0 }),
    ).toEqual({ state: "evicted", reason: "cache_miss" });
  });

  it("ignores tiny inputs below cache granularity", () => {
    expect(
      classifyCache({ ...base, inputTokens: 500, cacheReadTokens: 0 }),
    ).toEqual({ state: "unknown", reason: "below_cache_granularity" });
  });
});
