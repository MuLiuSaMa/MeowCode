/**
 * 前缀缓存的「画像」（cache profile）。
 *
 * 同一个 `cache_control` 字段，在不同服务商眼里的含义并不一样：
 *  - Anthropic 官方：最多 4 个断点，tools / system / messages 都能打，还支持 1h TTL；
 *  - 阿里云百炼（Qwen）：只认 system 与消息尾部，给 tools 打断点反而会报错或无效；
 *  - 各种 Anthropic 兼容网关：多数只稳定支持 system + 尾条两处；
 *  - OpenAI 系：没有 cache_control，缓存靠 `prompt_cache_key` + 端点侧 retention。
 *
 * 所以协议层不再自己决定「哪里打断点」，只消费这里裁剪好的计划：
 * 出口统一按 BREAKPOINT_CAP 裁剪并计数，任何一条路径都不可能发出超过 4 个断点。
 */
import type { ApiFormat, ProviderConfig } from "./types.js";

/**
 * 断点位置（语义名，协议层自己映射到具体字段）：
 *  - tools：工具目录最后一个工具
 *  - system0 / system1：system 消息第 1 / 第 2 条（基础指令 / AGENTS.md）
 *  - tail：对话最后一条消息
 */
export type CacheBreakpoint = "tools" | "system0" | "system1" | "tail";

export type CacheProfileId = "anthropic-native" | "qwen" | "anthropic-gateway" | "none";

/** Anthropic 官方上限：超过这个数的断点会被服务端静默忽略，不如自己裁掉并记账。 */
export const BREAKPOINT_CAP = 4;

export type CachePlan = {
  profile: CacheProfileId;
  protocol: ApiFormat;
  /** Anthropic 系：断点 TTL；缺省 5m（不发字段） */
  ttl: "5m" | "1h";
  /** 是否应该打 cache_control（false = 完全不打） */
  enabled: boolean;
  /** 裁剪后的断点列表，长度恒 <= BREAKPOINT_CAP */
  breakpoints: CacheBreakpoint[];
  /** 被 cap 裁掉的断点数量（诊断日志用；正常画像不会超） */
  dropped: number;
  /** OpenAI Responses：prompt_cache_retention（仅官方端点 + 白名单模型） */
  retention?: "24h";
};

/** 各画像的断点序：越靠前越重要，超限时从尾部丢弃。 */
const PROFILE_BREAKPOINTS: Record<CacheProfileId, CacheBreakpoint[]> = {
  // tools 末位 + system[0] + system[1] + 尾条，恰好用满 4 个
  "anthropic-native": ["tools", "system0", "system1", "tail"],
  // Qwen 不认 tools 断点：只留稳定前缀（system）与尾条
  qwen: ["system0", "tail"],
  // 其余兼容网关：保守只打 system[0] 与尾条
  "anthropic-gateway": ["system0", "tail"],
  none: [],
};

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** OpenAI 官方端点里支持 24h 保留的模型（保守白名单，宁可不发）。 */
function supportsLongRetention(model: string): boolean {
  return /^(gpt-5|gpt-4\.1|o[34])/.test(model.toLowerCase());
}

/**
 * 解析 provider 的缓存画像。
 *
 * 注意：`promptCaching: false` 是压缩摘要复用主前缀的开关（compaction.ts 判定），
 * 与协议层断点无关；这里不读它，避免一个字段承担两种语义。
 */
export function resolveCachePlan(provider: ProviderConfig): CachePlan {
  const protocol = provider.protocol ?? "openai-chat-completions";
  const ttl = provider.cacheTtl === "1h" ? "1h" : "5m";
  const host = hostnameOf(provider.baseUrl);
  const model = (provider.model ?? "").toLowerCase();

  if (protocol === "anthropic-messages") {
    let profile: CacheProfileId = "none";
    if (!host) {
      profile = "none";
    } else if (host === "api.anthropic.com" || model.includes("claude")) {
      profile = "anthropic-native";
    } else if (/dashscope|aliyuncs|qwen/.test(host) || /qwen|qwq/.test(model)) {
      profile = "qwen";
    } else {
      profile = "anthropic-gateway";
    }
    return finalize(profile, protocol, ttl, undefined);
  }

  if (protocol === "openai-responses") {
    // Responses 没有显式断点：缓存命中靠 prompt_cache_key + 服务端自动分片。
    // retention 只在官方端点 + 白名单模型下发（第三方网关不认这个字段）。
    const retention =
      host === "api.openai.com" && supportsLongRetention(model) ? ("24h" as const) : undefined;
    return finalize("none", protocol, ttl, retention);
  }

  // chat completions：OpenAI/DeepSeek 都是自动前缀缓存，没有可打的断点
  return finalize("none", protocol, ttl, undefined);
}

function finalize(
  profile: CacheProfileId,
  protocol: ApiFormat,
  ttl: "5m" | "1h",
  retention: "24h" | undefined,
): CachePlan {
  const wanted = PROFILE_BREAKPOINTS[profile];
  const breakpoints = wanted.slice(0, BREAKPOINT_CAP);
  return {
    profile,
    protocol,
    ttl,
    enabled: breakpoints.length > 0,
    breakpoints,
    dropped: Math.max(0, wanted.length - breakpoints.length),
    ...(retention ? { retention } : {}),
  };
}

/** 计划里是否有某个断点（协议层每次打点前问一次，避免硬编码位置）。 */
export function hasBreakpoint(plan: CachePlan, breakpoint: CacheBreakpoint): boolean {
  return plan.enabled && plan.breakpoints.includes(breakpoint);
}

/**
 * Anthropic 的 cache_control 值：5m 省略 ttl（官方默认），1h 才显式带。
 * 显式带 1h 是风险点（部分网关不认），所以只在 provider.cacheTtl === "1h" 时出现。
 */
export function cacheControlFor(plan: CachePlan): { type: "ephemeral"; ttl?: "1h" } | undefined {
  if (!plan.enabled) return undefined;
  return plan.ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

/**
 * 会话亲和键：Responses 的 prompt_cache_key 与 x-session-id 同源，
 * 保证「同一会话的请求路由到同一缓存分片」，也防止代理把两个会话的缓存串起来。
 * 长度按 OpenAI 的 64 字符上限裁剪。
 */
export function sessionAffinityKey(sessionId: string, purpose = "main"): string {
  return `${sessionId}:${purpose}`.slice(0, 64);
}
