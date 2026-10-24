import { ProviderTimeoutError } from "./provider-error.js";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const DEFAULT_RESPONSE_TIMEOUT_MS = 45_000;

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
      response = await fetch(input, { ...init, signal });
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
