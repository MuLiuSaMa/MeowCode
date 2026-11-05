import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthHeaders,
  fetchWithRetry,
  isAbortError,
  isRetryableStatus,
  mergeExtraHeaders,
  parseRetryAfter,
} from "./http";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchWithRetry", () => {
  it("retries 429 and honors Retry-After", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("busy", { status: 429, headers: { "retry-after": "0" } }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry("https://example.test", {}, { baseDelayMs: 1 });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry("https://example.test", {}, { baseDelayMs: 1 });
    expect(response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries network errors", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry("https://example.test", {}, { baseDelayMs: 1 });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns the last retryable response after exhausting attempts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("down", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry(
      "https://example.test",
      {},
      { attempts: 2, baseDelayMs: 1 },
    );
    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops immediately when the signal is already aborted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();

    await expect(
      fetchWithRetry("https://example.test", { signal: controller.signal }, { baseDelayMs: 1 }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails when the provider never returns response headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: unknown, init?: { signal?: AbortSignal }) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      ),
    );

    await expect(
      fetchWithRetry("https://example.test", {}, { timeoutMs: 10 }),
    ).rejects.toThrow("did not respond");
  });
});

describe("retry helpers", () => {
  it("recognizes common abort errors", () => {
    expect(isAbortError(new DOMException("This operation was aborted", "AbortError"))).toBe(true);
    expect(isAbortError(new Error("Aborted"))).toBe(true);
    expect(isAbortError(new Error("provider unavailable"))).toBe(false);
  });

  it("classifies retryable statuses", () => {
    for (const status of [408, 429, 500, 502, 503, 504, 529]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 413, 422]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });

  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("not-a-date")).toBeUndefined();
    const future = new Date(Date.now() + 5_000).toUTCString();
    const parsed = parseRetryAfter(future);
    expect(parsed).toBeGreaterThan(0);
    expect(parsed).toBeLessThanOrEqual(5_000);
  });
});

describe("buildAuthHeaders", () => {
  it("缺省 authStyle 按 fallback：x-api-key（Anthropic 系）/ Bearer（OpenAI 系）", () => {
    expect(buildAuthHeaders("sk-1", undefined, "x-api-key")).toEqual({ "x-api-key": "sk-1" });
    expect(buildAuthHeaders("sk-1", undefined, "bearer")).toEqual({ authorization: "Bearer sk-1" });
  });

  it("各 authStyle 的头形态", () => {
    expect(buildAuthHeaders("k", "bearer", "x-api-key")).toEqual({ authorization: "Bearer k" });
    expect(buildAuthHeaders("k", "api-key", "bearer")).toEqual({ "api-key": "k" });
    expect(buildAuthHeaders("k", "bedrock-api-key", "bearer")).toEqual({
      authorization: "Bedrock-API-Key k",
    });
    expect(buildAuthHeaders("k", "none", "bearer")).toEqual({});
  });

  it("空 apiKey 一律不产头（服务商原生鉴权）", () => {
    expect(buildAuthHeaders(undefined, undefined, "bearer")).toEqual({});
    expect(buildAuthHeaders("", "api-key", "bearer")).toEqual({});
  });
});

describe("mergeExtraHeaders", () => {
  it("空 / 缺省原样返回", () => {
    const base = { "content-type": "application/json" };
    expect(mergeExtraHeaders(base, undefined)).toBe(base);
    expect(mergeExtraHeaders(base, {})).toBe(base);
  });

  it("同名以 extra 为准（用户可覆盖内置头）", () => {
    expect(
      mergeExtraHeaders({ authorization: "Bearer old", "content-type": "application/json" }, {
        authorization: "Bearer new",
        "x-title": "MeowCode",
      }),
    ).toEqual({ authorization: "Bearer new", "content-type": "application/json", "x-title": "MeowCode" });
  });
});
