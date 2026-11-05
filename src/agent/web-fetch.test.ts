import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWebPage } from "./web-fetch.js";
import type { ProviderConfig } from "./types.js";

function response(body: string | null, init: ResponseInit = {}): Response {
  return new Response(body, init);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local web fetch", () => {
  it("converts HTML to Markdown and drops scripts/styles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response(
          "<html><head><style>.x{display:none}</style></head><body><h1>Hello</h1><p>World</p><script>alert(1)</script></body></html>",
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
        ),
      ),
    );

    const result = await fetchWebPage(null, "https://example.com/page");

    expect(result.status).toBe(200);
    expect(result.output).toContain("untrusted data");
    expect(result.output).toContain("# Hello");
    expect(result.output).toContain("World");
    expect(result.output).not.toContain("alert(1)");
    expect(result.output).not.toContain("display:none");
  });

  it("passes plain text through", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response("plain body", { status: 200, headers: { "content-type": "text/plain" } }),
      ),
    );
    const result = await fetchWebPage(null, "https://example.com/a.txt");
    expect(result.output).toContain("plain body");
  });

  it("rejects unsupported content types", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response("pdf", { status: 200, headers: { "content-type": "application/pdf" } }),
      ),
    );
    await expect(fetchWebPage(null, "https://example.com/a.pdf")).rejects.toThrow(
      /Unsupported content type/i,
    );
  });

  it("follows same-origin redirects", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(null, { status: 302, headers: { location: "/next" } }),
      )
      .mockResolvedValueOnce(
        response("<h1>Next</h1>", { status: 200, headers: { "content-type": "text/html" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchWebPage(null, "https://example.com/start");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("https://example.com/next");
    expect(result.output).toContain("# Next");
  });

  it("refuses cross-origin redirects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response(null, { status: 302, headers: { location: "https://evil.example/x" } }),
      ),
    );
    await expect(fetchWebPage(null, "https://example.com/start")).rejects.toThrow(
      /Cross-origin redirect/i,
    );
  });

  it("blocks private and loopback hosts", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWebPage(null, "http://127.0.0.1/admin")).rejects.toThrow(/Private\/loopback/i);
    await expect(fetchWebPage(null, "http://localhost:3000/")).rejects.toThrow(/Private\/loopback/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects bad schemes and embedded credentials", async () => {
    await expect(fetchWebPage(null, "file:///etc/passwd")).rejects.toThrow(/Unsupported URL scheme/i);
    await expect(fetchWebPage(null, "https://user:pass@example.com/")).rejects.toThrow(
      /Credentials in URLs/i,
    );
  });

  it("rejects responses declared larger than the byte cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response("x", {
          status: 200,
          headers: { "content-type": "text/plain", "content-length": "6000000" },
        }),
      ),
    );
    await expect(fetchWebPage(null, "https://example.com/big")).rejects.toThrow(/maximum of 5000000/);
  });

  it("times out a stalled body after 10s", async () => {
    vi.useFakeTimers();
    try {
      const body = new ReadableStream<Uint8Array>({ start() {} });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(body, { status: 200, headers: { "content-type": "text/html" } }),
        ),
      );
      const pending = fetchWebPage(null, "https://example.com/slow");
      const assertion = expect(pending).rejects.toThrow(/timed out after 10s/i);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a server that never sends headers", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener("abort", () =>
                reject(new DOMException("Aborted", "AbortError")),
              );
            }),
        ),
      );
      const pending = fetchWebPage(null, "https://example.com/hang");
      const assertion = expect(pending).rejects.toThrow(/timed out after 10s/i);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("truncates bodies above the character cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response("a".repeat(100_001), { status: 200, headers: { "content-type": "text/plain" } }),
      ),
    );
    const result = await fetchWebPage(null, "https://example.com/long");
    expect(result.truncated).toBe(true);
    expect(result.output).toContain("Content truncated");
  });
});

describe("DeepSeek Fetch API", () => {
  const deepseek: ProviderConfig = {
    id: "d",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    protocol: "anthropic-messages",
    model: "m",
    apiKey: "key",
  };

  it("uses the provider key and returns Markdown", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response(JSON.stringify({ content: "# Page" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchWebPage(deepseek, "https://example.com/page");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/v1/tools/fetch");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer key");
    expect(JSON.parse(String(init.body))).toEqual({ url: "https://example.com/page" });
    expect(result.output).toContain("# Page");
  });
});
