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
 *  - anchor：最后一个真实 user 消息（工具循环期间位置固定，尾部失效时可回退）
 *  - tail：对话最后一条非空消息
 */
export type CacheBreakpoint = "tools" | "system0" | "system1" | "anchor" | "tail";

export type CacheProfileId = "anthropic-native" | "qwen" | "anthropic-gateway" | "none";

/** Anthropic 官方上限：超过这个数的断点会被服务端静默忽略，不如自己裁掉并记账。 */
export const BREAKPOINT_CAP = 4;

export type CachePlan = {
  profile: CacheProfileId;
  protocol: ApiFormat;
  /** Anthropic 系实际生效的断点 TTL；5m 不发字段（官方默认），auto 未盖章也回落 5m */
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
  // tools 末位 + instructions（缺失时回退 base）+ 最后一个真实 user + 尾条。
  // 不再给 system[0] 单独打点：它只多缓存几百 token，却占掉一个宝贵的 messages 断点。
  "anthropic-native": ["tools", "system1", "anchor", "tail"],
  // Qwen 不认 tools 断点：只留稳定前缀（system）与尾条
  qwen: ["system0", "tail"],
  // 兼容网关：按官方形态先要满 4 个（one-api / new-api / claude-code-router 这类
  // 基本都是原样转发 Anthropic 请求体，4 断点就是 Anthropic 自己的合法形态）。
  // 真被拒了不在这里猜——由协议层的 400 分级降级记住可用档位，见 gatewayCacheCeiling。
  "anthropic-gateway": ["tools", "system1", "anchor", "tail"],
  none: [],
};

/**
 * 网关降级档：system 首块 + 尾条。
 *
 * 注意不是「把满额列表截断」—— 截断会先丢掉 anchor 与 tail，留下 tools+system1，
 * 那等于只缓存了稳定前缀、把整段对话排除在缓存外，比不降级还差。降级必须换一张
 * 断点表：保住「稳定前缀」和「对话尾部」这两段唯一真正能反复命中的位置。
 */
const GATEWAY_MINIMAL_BREAKPOINTS: CacheBreakpoint[] = ["system0", "tail"];

/**
 * 网关降级记忆（providerId）：被 400 拒过断点之后改走降级档并永久记住。
 *
 * 默认按 4 个断点试探（大多数 one-api / new-api / claude-code-router 都原样转发
 * Anthropic 请求体）；明确因为缓存字段报 400/422 就降到 2 个并记住，之后不再试错。
 * 只有降级档仍被拒才彻底关闭 cache_control —— 目标是「少缓存一点」而不是「不缓存」。
 */
const gatewayMinimalProviders = new Set<string>();

/** 该 provider 是否已降级到 2 断点档。 */
export function gatewayUsesMinimalCache(providerId: string): boolean {
  return gatewayMinimalProviders.has(providerId);
}

/** 记一次降级（4 → 2）。只降不升：同一网关没必要反复试错。 */
export function noteGatewayMinimalCache(providerId: string): void {
  gatewayMinimalProviders.add(providerId);
}

/** 测试用：清空降级记忆（模块级状态不能跨用例泄漏）。 */
export function resetGatewayCacheDegradation(): void {
  gatewayMinimalProviders.clear();
}

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
 * 实测过真的保留 1h 档的端点。
 *
 * 纪律照 hermes：只放**实测**过的路由。未实测不等于「已知可用」—— 1h 的写入溢价是
 * 2×（5m 是 1.25×），发错端点既多付钱又可能被拒。没进这张表的端点，即便用户显式
 * 选了 1h，也只按服务商默认的 5m 处理。
 */
const MEASURED_1H_HOSTS = new Set(["api.anthropic.com"]);

/**
 * 解析这次会话实际要发的 TTL。
 *
 * 只在「能打断点的原生画像 + 实测过的端点」上才谈 1h；Qwen 与未知兼容网关连
 * `cache_control` 都可能不认，一律回落 5m（不发字段）。
 *
 * `auto` 的判据是**谁在驱动这个会话**，不是空闲时长：只有人驱动的会话才有 5–60
 * 分钟的空档去吃冷重写；子代理/批量是连续打点，给它 1h 只是多付写入溢价。
 *
 * 缺省就是 `auto`（hermes 实测：人驱动会话约 63% 的写入来自 5–60min 空档后的冷
 * 重写，1h 能省下大部分；子代理给 1h 反而更贵）。未盖章 pace 的辅助请求按 5m。
 */
function resolveCacheTtl(
  provider: ProviderConfig,
  profile: CacheProfileId,
  host: string,
): "5m" | "1h" {
  const wanted = provider.cacheTtl ?? "auto";
  if (wanted === "5m") return "5m";
  if (profile !== "anthropic-native") return "5m";
  if (!MEASURED_1H_HOSTS.has(host)) return "5m";
  if (wanted === "1h") return "1h";
  // 只有明确盖章为人驱动的会话才升 1h；未盖章（辅助请求、测试、老配置）按最保守档
  return provider.pace === "interactive" ? "1h" : "5m";
}

/**
 * 解析 provider 的缓存画像。
 *
 * 注意：`promptCaching: false` 是压缩摘要复用主前缀的开关（compaction.ts 判定），
 * 与协议层断点无关；这里不读它，避免一个字段承担两种语义。
 */
export function resolveCachePlan(provider: ProviderConfig): CachePlan {
  const protocol = provider.protocol ?? "openai-chat-completions";
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
    // 网关被拒过就换降级断点表：只影响断点位置，不影响 TTL 判定
    const override =
      profile === "anthropic-gateway" && gatewayMinimalProviders.has(provider.id)
        ? GATEWAY_MINIMAL_BREAKPOINTS
        : undefined;
    return finalize(
      profile,
      protocol,
      resolveCacheTtl(provider, profile, host),
      undefined,
      override,
    );
  }

  if (protocol === "openai-responses") {
    // Responses 没有显式断点：缓存命中靠 prompt_cache_key + 服务端自动分片。
    // retention 只在官方端点 + 白名单模型下发（第三方网关不认这个字段）。
    const retention =
      host === "api.openai.com" && supportsLongRetention(model) ? ("24h" as const) : undefined;
    return finalize("none", protocol, "5m", retention);
  }

  // chat completions：OpenAI/DeepSeek 都是自动前缀缓存，没有可打的断点
  return finalize("none", protocol, "5m", undefined);
}

function finalize(
  profile: CacheProfileId,
  protocol: ApiFormat,
  ttl: "5m" | "1h",
  retention?: "24h",
  /** 降级档的断点表（仅网关被拒后使用）；缺省按画像满额 */
  breakpointsOverride?: CacheBreakpoint[],
): CachePlan {
  const wanted = breakpointsOverride ?? PROFILE_BREAKPOINTS[profile];
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
 * chat-completions 的官方端点也接受 `prompt_cache_key`（路由到同一缓存分片，
 * 与 Responses 同语义）；第三方网关不认识这个字段会 400，由协议层的 omit
 * 降级记忆兜住（400 一次即永久跳过）。只放官方主机——发错端点只会白吃 400。
 */
export function supportsChatPromptCacheKey(provider: ProviderConfig): boolean {
  const protocol = provider.protocol ?? "openai-chat-completions";
  if (protocol !== "openai-chat-completions") return false;
  return hostnameOf(provider.baseUrl) === "api.openai.com";
}

/**
 * 血缘亲和：fork / 子 Agent 是否该继承来源会话的缓存键。
 *
 * 只在**内容寻址**的官方 OpenAI 端点上成立——缓存按前缀内容分片，同一份历史
 * 无论挂在哪个会话名下都命中同一桶（opencode affinity.ts、codex 子代理继承父键）。
 * 槽位/会话路由（xAI 等）按 key 分槽，共享键反而让不同角色互相顶掉，保持每会话
 * 独立；第三方网关的分片规则不可证伪，同样不冒险。
 */
export function supportsLineageAffinity(provider: ProviderConfig): boolean {
  const protocol = provider.protocol ?? "openai-chat-completions";
  if (protocol !== "openai-responses" && protocol !== "openai-chat-completions") return false;
  return hostnameOf(provider.baseUrl) === "api.openai.com";
}

/**
 * 是否官方 OpenAI 端点。用于「只在能证伪的端点上开默认行为」这类判断：
 * previous_response_id 增量链、prompt_cache_key 之类字段，第三方兼容端点认不认
 * 无法离线确认，只能在官方端点上默认打开。
 */
export function isOfficialOpenAIEndpoint(provider: ProviderConfig): boolean {
  return hostnameOf(provider.baseUrl) === "api.openai.com";
}

/** 是否官方 Anthropic 端点（context_management 这类新字段只在这里默认下发）。 */
export function isOfficialAnthropicEndpoint(provider: ProviderConfig): boolean {
  return hostnameOf(provider.baseUrl) === "api.anthropic.com";
}

/**
 * 一次性请求判形：这次写入的缓存没有任何后续请求能读回。
 *
 * 判据（对齐 hermes 的 is_one_shot_request）：无工具、无 assistant/tool 轮、user 轮 ≤1。
 * 标题、工具纪要、提交信息都符合这个形状；给它们打断点只买到一次 1.25x（5m）/ 2x（1h）
 * 的写入，永远收不回来。
 *
 * 压缩摘要的「复用主前缀」请求不在此列：它带完整工具目录（tools 非空）且对话里有多轮
 * user —— 判形天然放行，不需要额外开关。
 */
export function isOneShotRequest(
  messages: ReadonlyArray<{ role: string }>,
  tools: ReadonlyArray<unknown>,
): boolean {
  if (tools.length > 0) return false;
  let userCount = 0;
  for (const message of messages) {
    if (message.role === "assistant" || message.role === "tool") return false;
    if (message.role === "user") userCount += 1;
  }
  return userCount <= 1;
}

/** 关掉画像里的全部写入（一次性请求用）：保留 profile 供诊断，但不发任何标记。 */
export function withoutCacheWrites(plan: CachePlan): CachePlan {
  const { retention: _retention, ...rest } = plan;
  return { ...rest, enabled: false, breakpoints: [], dropped: 0 };
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
