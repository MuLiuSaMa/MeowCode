/**
 * 前缀缓存命中诊断。
 *
 * OpenAI 兼容网关没有 `cache_control`，TTL 与逐出完全由服务端决定。
 * 本地能做的只有：用「前缀指纹 + 空闲时长 + 服务商报告」判断这次 0 命中
 * 到底是我们自己改了前缀、服务端逐出、还是服务商根本不报告/不支持缓存。
 */
import type { ApiFormat, CacheState } from "./types.js";

export type { CacheState } from "./types.js";

/**
 * 缺省最小可缓存输入量：低于缓存粒度时 0 命中是正常的。
 *
 * 官方按模型分档（Anthropic 512 / 1024 / 2048 / 4096，OpenAI 系 1024 桶），
 * 用单一常量会在两头误判：模型实际 512 时把真实失效记成 unknown（漏报），
 * 实际 4096 时把「本就不该缓存」记成 evicted（虚警，污染分母）。
 * 这里只作未识别模型的保守回落，正常路径走 resolveMinCacheableTokens。
 */
export const CACHE_MIN_INPUT_TOKENS = 2048;

/**
 * 按协议 + 模型挑最小可缓存长度。
 *
 * 纪律同 MEASURED_1H_HOSTS：只在能说出依据时偏离缺省，认不出来的模型一律
 * 回落 2048 —— 猜一个更小的值会把「本来就不写缓存」误报成失效。
 */
export function resolveMinCacheableTokens(protocol: ApiFormat, model: string): number {
  // OpenAI 系（含兼容网关）官方是 1024 token 起步的自动前缀缓存
  if (protocol !== "anthropic-messages") return 1024;
  const name = model.toLowerCase();
  if (/claude-(opus|sonnet|haiku)-4|claude-4/.test(name)) return 1024;
  if (/claude-3-7|claude-3-5/.test(name)) return 2048;
  if (/claude-3-(opus|sonnet)/.test(name)) return 4096;
  return CACHE_MIN_INPUT_TOKENS;
}

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
  /**
   * 变化落在哪几段（`tools` / `system[1]` / `system_count`）。
   * 缺省表示只知道「变了」不知道「谁变了」—— 老调用点与低粒度诊断仍可用。
   */
  changedSegments?: readonly string[];
  /** 本 provider 之前是否发过相同前缀的请求（缓存已有机会写入） */
  hadSamePrefixBefore: boolean;
  /** 距该 provider 上一次请求的空闲时长 */
  idleMs: number;
};

export function classifyCache(
  input: CacheObservation,
  options?: { minCacheableTokens?: number },
): { state: CacheState; reason?: string } {
  const read = input.cacheReadTokens;
  const write = input.cacheWriteTokens ?? 0;
  const segmentSuffix = input.changedSegments?.length
    ? `:${input.changedSegments.join("+")}`
    : "";

  // 命中优先。前缀变了不等于没命中 —— 老前缀（tools + system）通常还在服务端，
  // 只有新增的那一小段是冷写。先判 prefixChanged 会把一次 90% 命中的请求记成
  // cold，既吞掉真实命中，又把「写了没读回」这类真问题淹没在噪音里。
  if (typeof read === "number" && read > 0) {
    return input.prefixChanged && segmentSuffix
      ? { state: "warm", reason: `prefix_changed${segmentSuffix}` }
      : { state: "warm" };
  }
  if (typeof read !== "number") {
    return { state: "unknown", reason: "not_reported" };
  }
  // 以下都是 0 命中：这时才需要归因「谁把缓存弄没了」
  if (input.prefixChanged) {
    return { state: "cold", reason: `prefix_changed${segmentSuffix}` };
  }
  // 首次请求：0 命中是写入缓存的正常结果，不当作异常。
  if (!input.hadSamePrefixBefore) return { state: "cold", reason: "first_request" };
  const minCacheable = options?.minCacheableTokens ?? CACHE_MIN_INPUT_TOKENS;
  if ((input.inputTokens ?? 0) < minCacheable) {
    return { state: "unknown", reason: "below_cache_granularity" };
  }
  const ttlMs = input.cacheTtl ? TTL_MS[input.cacheTtl] : undefined;
  if (ttlMs !== undefined && input.idleMs > ttlMs) {
    return { state: "evicted", reason: "idle_exceeded_ttl" };
  }
  // 写了却一次也没读回：前缀字节对、TTL 没过期，说明写进去的条目读不到 ——
  // 典型是网关丢了 cache_control、路由到了不同分片、或请求参数漂移。
  // 这与「被服务端逐出」是两种完全不同的故障，分开报。
  if (write > 0) return { state: "evicted", reason: "write_no_readback" };
  // 没有显式断点的协议只能靠服务端自动缓存：稳定前缀仍报告 0，基本可判定为不支持/未生效。
  if (input.protocol !== "anthropic-messages") {
    return { state: "unsupported", reason: "stable_prefix_no_cached_tokens" };
  }
  // Anthropic 协议下连写都没发生：断点压根没生效（网关剥字段、或整段短于最小可缓存长度）。
  return { state: "unsupported", reason: "no_cache_write" };
}

/**
 * 前缀分段快照：工具块一个指纹 + 每条 system 消息一个指纹（下标顺序即 system[i]）。
 */
export type PrefixSnapshot = {
  tools: string;
  system: readonly string[];
};

export type PrefixDiff = {
  changed: boolean;
  tools: boolean;
  /** 内容变化的 system 下标（只在两次条数一致时逐条比对） */
  system: readonly number[];
  /** system 条数变了：下标对齐不可信，只能整体归因 */
  countChanged: boolean;
};

/**
 * 比较两次请求的前缀分段指纹。
 *
 * 把 tools 与 system 拼成一个 sha1 只能回答「变了」，回答不了「谁变了」——
 * 一次 MCP 工具上线、一次 AGENTS.md 重载、一次语色切换在诊断上长得一模一样，
 * 掉缓存后无从归因。分段比较把三者拆开（对照 cc-haha 的
 * promptCacheBreakDetection：system / 每个工具 / betas 各自哈希）。
 */
export function diffPrefix(
  previous: PrefixSnapshot | undefined,
  next: PrefixSnapshot,
): PrefixDiff {
  if (!previous) return { changed: false, tools: false, system: [], countChanged: false };
  const tools = previous.tools !== next.tools;
  const countChanged = previous.system.length !== next.system.length;
  const system: number[] = [];
  const shared = Math.min(previous.system.length, next.system.length);
  for (let index = 0; index < shared; index += 1) {
    if (previous.system[index] !== next.system[index]) system.push(index);
  }
  return { changed: tools || countChanged || system.length > 0, tools, system, countChanged };
}

/**
 * 差异 → 可读段名。段名进 `cacheReason`，UI 的 rebuilds 计数按 reason 分桶，
 * 于是「到底是谁在炸前缀」可以直接按段统计出来。
 */
export function prefixChangeSegments(diff: PrefixDiff): string[] {
  const segments: string[] = [];
  if (diff.tools) segments.push("tools");
  if (diff.countChanged) segments.push("system_count");
  for (const index of diff.system) segments.push(`system[${index}]`);
  return segments;
}
