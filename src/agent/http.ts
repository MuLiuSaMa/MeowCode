import { randomUUID } from "node:crypto";
import { ProviderTimeoutError } from "./provider-error.js";
import { applyProxy } from "./proxy.js";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const DEFAULT_RESPONSE_TIMEOUT_MS = 300_000;

/** 网关（如 magpie）按 User-Agent 认 agent，用量统计要能认成 MeowCode。 */
export const MEOWCODE_USER_AGENT = "MeowCode/1.4.0 (+https://github.com/MuLiuSaMa/MeowCode)";

/**
 * 鉴权头风格。缺省（undefined）按协议传统：Anthropic 系用 x-api-key，
 * OpenAI 系用 Authorization: Bearer。少数服务商不认这两样：
 *  - "api-key"：Azure OpenAI（`api-key` 头）
 *  - "bedrock-api-key"：Amazon Bedrock 的 API key（`Authorization: Bedrock-API-Key <key>`）
 *  - "none"：本地推理框架（vLLM/Ollama）或鉴权完全由 extraHeaders 提供的场景
 */
export type AuthStyle = "bearer" | "api-key" | "bedrock-api-key" | "none";

/**
 * 按 authStyle 生成鉴权头。authStyle 缺省时用 fallback 决定默认形态。
 * apiKey 为空返回 {}（服务商原生鉴权，如 DSH 的约定）。
 */
export function buildAuthHeaders(
  apiKey: string | undefined,
  authStyle: AuthStyle | undefined,
  fallback: "x-api-key" | "bearer",
): Record<string, string> {
  if (!apiKey) return {};
  switch (authStyle) {
    case "none":
      return {};
    case "api-key":
      return { "api-key": apiKey };
    case "bedrock-api-key":
      return { authorization: `Bedrock-API-Key ${apiKey}` };
    case "bearer":
      return { authorization: `Bearer ${apiKey}` };
    default:
      return fallback === "x-api-key" ? { "x-api-key": apiKey } : { authorization: `Bearer ${apiKey}` };
  }
}

/** extraHeaders 覆盖在基础头之后（同名以用户配置为准）。 */
export function mergeExtraHeaders(
  base: Record<string, string>,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  if (!extra || Object.keys(extra).length === 0) return base;
  return { ...base, ...extra };
}

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/** 解析 Retry-After（秒数或 HTTP 日期），返回毫秒。 */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

/** 用户主动中止（fetch/SSE/重试等待都可能抛不同文案的 AbortError）。 */
export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
  if (name === "AbortError" || code === "ABORT_ERR") return true;
  return typeof message === "string" && /^(?:this operation was )?aborted$/i.test(message.trim());
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 服务商请求的共享重试层：只用于拿到响应头之前的失败，
 * 流式响应一旦开始就不再重试，避免重复消费。
 */
export async function fetchWithRetry(
  input: string | URL,
  init: RequestInit = {},
  options: {
    attempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    /** 等待响应头的超时；超时直接失败，不进入重试等待 */
    timeoutMs?: number;
  } = {},
): Promise<Response> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelayMs = options.baseDelayMs ?? 600;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
  const userSignal = init.signal ?? undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (userSignal?.aborted) throw abortError();
    let response: Response | undefined;
    const timeoutController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, timeoutMs);
    const signal = userSignal
      ? AbortSignal.any([userSignal, timeoutController.signal])
      : timeoutController.signal;
    try {
      // 每次 HTTP 尝试一个独立请求 id：代理/网关的日志与错误回执能对上具体那一次，
      // 重试也不会共用同一个 id（用户显式配置的同名头优先）。
      const headers = { ...(init.headers as Record<string, string> | undefined) };
      if (!Object.keys(headers).some((key) => key.toLowerCase() === "x-request-id")) {
        headers["x-request-id"] = randomUUID();
      }
      if (!Object.keys(headers).some((key) => key.toLowerCase() === "user-agent")) {
        headers["user-agent"] = MEOWCODE_USER_AGENT;
      }
      // 代理按当前设置决定（直连时原样返回 init，无额外开销）
      response = await fetch(input, applyProxy({ ...init, headers, signal }, String(input)));
    } catch (error) {
      if (userSignal?.aborted) throw abortError();
      if (timedOut) {
        throw new ProviderTimeoutError(
          `Provider did not respond within ${Math.round(timeoutMs / 1000)}s.`,
        );
      }
      if (isAbortError(error)) throw error;
      lastError = error;
    } finally {
      clearTimeout(timer);
    }

    if (!response) {
      if (attempt === attempts) {
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
      }
      await sleep(baseDelayMs * 2 ** (attempt - 1), signal);
      continue;
    }

    if (!isRetryableStatus(response.status) || attempt === attempts) return response;
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    const delay = Math.min(retryAfter ?? baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
    await response.body?.cancel().catch(() => undefined);
    await sleep(delay, signal);
  }

  throw lastError instanceof Error ? lastError : new Error("Request failed after retries");
}
