/**
 * 前缀缓存命中诊断。
 *
 * OpenAI 兼容网关没有 `cache_control`，TTL 与逐出完全由服务端决定。
 * 本地能做的只有：用「前缀指纹 + 空闲时长 + 服务商报告」判断这次 0 命中
 * 到底是我们自己改了前缀、服务端逐出、还是服务商根本不报告/不支持缓存。
 */
import type { ApiFormat, CacheState } from "./types.js";

export type { CacheState } from "./types.js";

/** 低于这个输入量不做命中判断：低于缓存粒度时 0 命中是正常的。 */
export const CACHE_MIN_INPUT_TOKENS = 2048;

/** 各 TTL 档的毫秒数：诊断与冷 resume 剪枝共用（超过即服务端缓存不可读回）。 */
export const TTL_MS: Record<"5m" | "1h", number> = {
  "5m": 300_000,
  "1h": 3_600_000,
};

export type CacheObservation = {
  protocol: ApiFormat;
  /** 声明的前缀缓存 TTL；非 Anthropic 协议只作诊断期望值 */
  cacheTtl?: "5m" | "1h";
  /** undefined = 服务商未报告，与明确的 0 区分 */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputTokens?: number;
  /** 本请求相对上一次请求，工具 + system 指纹是否变化 */
  prefixChanged: boolean;
  /** 本 provider 之前是否发过相同前缀的请求（缓存已有机会写入） */
  hadSamePrefixBefore: boolean;
  /** 距该 provider 上一次请求的空闲时长 */
  idleMs: number;
};

export function classifyCache(input: CacheObservation): { state: CacheState; reason?: string } {
  if (input.prefixChanged) return { state: "cold", reason: "prefix_changed" };
  if (typeof input.cacheReadTokens === "number" && input.cacheReadTokens > 0) {
    return { state: "warm" };
  }
  if (typeof input.cacheReadTokens !== "number") {
    return { state: "unknown", reason: "not_reported" };
  }
  // 首次请求：0 命中是写入缓存的正常结果，不当作异常。
  if (!input.hadSamePrefixBefore) return { state: "cold", reason: "first_request" };
  if ((input.inputTokens ?? 0) < CACHE_MIN_INPUT_TOKENS) {
    return { state: "unknown", reason: "below_cache_granularity" };
  }
  const ttlMs = input.cacheTtl ? TTL_MS[input.cacheTtl] : undefined;
  if (ttlMs !== undefined && input.idleMs > ttlMs) {
    return { state: "evicted", reason: "idle_exceeded_ttl" };
  }
  // 没有显式断点的协议只能靠服务端自动缓存：稳定前缀仍报告 0，基本可判定为不支持/未生效。
  if (input.protocol !== "anthropic-messages") {
    return { state: "unsupported", reason: "stable_prefix_no_cached_tokens" };
  }
  return { state: "evicted", reason: "cache_miss" };
}
