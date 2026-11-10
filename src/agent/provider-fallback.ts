/**
 * 供应商故障转移（fallback chain）。
 *
 * 目标很窄：主服务商**临时性**故障（超时 / 429 / 5xx）时，把这一跳换到链上的
 * 下一个已启用 provider，让回合继续，而不是让用户手动改配置重发。
 *
 * 刻意不切的四类错误（切了只会把同一个错误再犯一遍，还多花一次请求）：
 *  - 用户中止（abort）：不是错误；
 *  - 401/403：密钥/权限问题，换服务商等于绕过用户的配置意图；
 *  - 400/422：请求体本身有问题（含 max_tokens 超限、字段不被支持）；
 *  - 404：模型不存在；
 *  - 上下文溢出：走既有的压缩降级链，不是换服务商能解决的。
 */
import { isAbortError } from "./http.js";
import { isContextOverflow } from "./compaction.js";
import { providerErrorKind, type ProviderErrorKind } from "./provider-error.js";
import type { ProviderConfig } from "./types.js";

/** 默认最多跳 2 次（共 3 次请求：主 + 2 跳）。 */
export const MAX_FALLBACK_HOPS = 2;

/**
 * 故障转移的墙钟预算：从本回合首个请求算起，超过这个时长不再尝试新 provider。
 * 每次尝试本身已有超时与退避，但「3 次尝试 × 多跳」叠起来可以耗掉好几分钟；
 * 用户宁可看到一个明确的失败，也不要一个永远不动的界面。
 */
export const FAILOVER_WALL_CLOCK_MS = 45_000;

/**
 * 只有这几类值得切链：
 *  - timeout：`fetchWithRetry` 已经重试过同样的端点，仍然不通；
 *  - rate_limit：429 等下去不如换一家；
 *  - server：500/502/503/504/529，服务端临时故障。
 */
const FAILOVER_KINDS = new Set<ProviderErrorKind>(["timeout", "rate_limit", "server"]);

/**
 * 判断一个错误是否值得切到下一个服务商。
 * 顺序很重要：先排除中止（用户意图），再排除溢出（有专门的降级链），最后才看分类。
 */
export function isFailoverEligible(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (isContextOverflow(error)) return false;
  return FAILOVER_KINDS.has(providerErrorKind(error));
}

/** 切链的错误原因（事件/日志展示用），不可切时返回 undefined。 */
export function failoverReason(error: unknown): ProviderErrorKind | undefined {
  return isFailoverEligible(error) ? providerErrorKind(error) : undefined;
}

/**
 * 生成候选链（**不含**当前 provider，按尝试顺序）。
 *
 * - provider.fallbackIds 有值时按声明顺序（只认 enabled 且存在的 id）；
 * - 否则自动链：设置页顺序里的其余 enabled provider；
 * - 结果去重，并按 maxHops 截断。
 */
export function planFallbacks(
  providers: ProviderConfig[],
  activeId: string,
  maxHops = MAX_FALLBACK_HOPS,
  explicitIds?: string[],
): ProviderConfig[] {
  const enabled = providers.filter((provider) => provider.enabled !== false);
  const byId = new Map(enabled.map((provider) => [provider.id, provider]));
  const ordered: ProviderConfig[] = [];

  if (explicitIds?.length) {
    for (const id of explicitIds) {
      const provider = byId.get(id);
      if (provider && provider.id !== activeId) ordered.push(provider);
    }
  } else {
    for (const provider of enabled) {
      if (provider.id !== activeId) ordered.push(provider);
    }
  }

  const seen = new Set<string>([activeId]);
  const chain: ProviderConfig[] = [];
  for (const provider of ordered) {
    if (seen.has(provider.id)) continue;
    seen.add(provider.id);
    chain.push(provider);
    if (chain.length >= Math.max(0, maxHops)) break;
  }
  return chain;
}
