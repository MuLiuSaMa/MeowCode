/**
 * 服务商错误分类。
 *
 * `kind` 是故障转移（provider-fallback）与重试层的共用判据：只有「换个服务商
 * 可能就好了」的错误才允许切链 —— 超时、限流、服务端 5xx。参数错误、鉴权失败、
 * 模型不存在、上下文溢出都不属于这类：换服务商只会把同一个错误再犯一遍。
 */
export type ProviderErrorKind =
  | "timeout"
  | "rate_limit"
  | "server"
  | "auth"
  | "bad_request"
  | "not_found"
  | "unknown";

/** 把 HTTP 状态码归类。未列出的状态一律 unknown（不参与切链）。 */
export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  // 529 = Anthropic 的 overloaded；500/502/503/504 同属服务端临时故障
  if (status === 500 || status === 502 || status === 503 || status === 504 || status === 529) {
    return "server";
  }
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 400 || status === 422) return "bad_request";
  return "unknown";
}

export class ProviderRequestError extends Error {
  /** 由 status 推导的分类，供 failover / UI 判定 */
  readonly kind: ProviderErrorKind;

  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Provider request failed (${status}): ${body || "request failed"}`);
    this.name = "ProviderRequestError";
    this.kind = kindForStatus(status);
  }
}

/** 超时不是用户中止：必须作为真实错误显示，并结束当前回合。 */
export class ProviderTimeoutError extends Error {
  readonly kind: ProviderErrorKind = "timeout";

  constructor(message: string) {
    super(message);
    this.name = "ProviderTimeoutError";
  }
}

/** 任意错误 → 分类（非服务商错误返回 unknown）。 */
export function providerErrorKind(error: unknown): ProviderErrorKind {
  if (!error || typeof error !== "object") return "unknown";
  const kind = (error as { kind?: unknown }).kind;
  if (typeof kind === "string" && isProviderErrorKind(kind)) return kind;
  const name = (error as { name?: unknown }).name;
  if (name === "ProviderTimeoutError") return "timeout";
  return "unknown";
}

const KINDS = new Set<string>([
  "timeout",
  "rate_limit",
  "server",
  "auth",
  "bad_request",
  "not_found",
  "unknown",
]);

export function isProviderErrorKind(value: string): value is ProviderErrorKind {
  return KINDS.has(value);
}
