import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSearchBackend, formatWebSearchResult } from "./web-search.js";
import type { ProviderConfig } from "./types.js";

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "p",
    name: "P",
    baseUrl: "https://api.anthropic.com/v1",
    model: "m",
    apiKey: "key",
    protocol: "anthropic-messages",
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web search backend selection", () => {
  it("prefers the DeepSeek direct API when the host and key match", () => {
    const backend = createWebSearchBackend(
      provider({ baseUrl: "https://api.deepseek.com/anthropic" }),
    );
    expect(backend?.id).toBe("deepseek-search-api");
  });

  it("uses Anthropic native search for Anthropic and Z.ai/BigModel", () => {
    expect(createWebSearchBackend(provider())?.id).toBe("anthropic-native");
    expect(
      createWebSearchBackend(provider({ baseUrl: "https://api.z.ai/api/anthropic" }))?.id,
    ).toBe("anthropic-native");
    expect(
      createWebSearchBackend(provider({ baseUrl: "https://open.bigmodel.cn/api/anthropic" }))?.id,
    ).toBe("anthropic-native");
  });

  it("uses OpenAI native search only for the Responses protocol", () => {
    expect(
      createWebSearchBackend(
        provider({ baseUrl: "https://api.openai.com/v1", protocol: "openai-responses" }),
      )?.id,
    ).toBe("openai-native");
    expect(
      createWebSearchBackend(
        provider({ baseUrl: "https://api.openai.com/v1", protocol: "openai-chat-completions" }),
      ),
    ).toBeNull();
  });

  it("hides search for providers without their own search API", () => {
    expect(
      createWebSearchBackend(
        provider({ baseUrl: "https://api.groq.com/openai/v1", protocol: "openai-chat-completions" }),
      ),
    ).toBeNull();
    expect(
      createWebSearchBackend(provider({ baseUrl: "https://gateway.example.com/anthropic" })),
    ).toBeNull();
    expect(
      createWebSearchBackend(provider({ baseUrl: "https://api.deepseek.com/anthropic", apiKey: undefined })),
    ).toBeNull();
  });
});

describe("DeepSeek Search API", () => {
  it("maps the request and sources", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        results: [
          {
            url: "https://example.com/a",
            title: "A",
            snippet: "short",
            summary: "long summary",
            date: "2026-01-01",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const backend = createWebSearchBackend(
      provider({ baseUrl: "https://api.deepseek.com/anthropic" }),
    );
    const result = await backend!.search("q", {
      maxResults: 3,
      originalQuestion: "  what\n is it  ",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/v1/tools/search");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      query: "q",
      count: 3,
      need_content: false,
      ori_question: "what is it",
    });
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer key");
    expect(result.sources).toEqual([
      {
        url: "https://example.com/a",
        title: "A",
        snippet: "short",
        summary: "long summary",
        publishedAt: "2026-01-01",
      },
    ]);
  });
});

describe("Anthropic native search", () => {
  it("sends the native tool and joins citations as snippets", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        content: [
          {
            type: "text",
            text: "summary",
            citations: [{ url: "https://example.com/a", cited_text: "cited text" }],
          },
          {
            type: "web_search_tool_result",
            content: [
              { type: "web_search_result", url: "https://example.com/a", title: "A", page_age: "2 days" },
              { type: "web_search_result", url: "https://example.com/b", title: "B" },
              { type: "web_search_result", url: "https://example.com/a", title: "dup" },
            ],
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 4,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const backend = createWebSearchBackend(provider());
    const result = await backend!.search("q", {});

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const body = JSON.parse(String(init.body));
    expect(body.stream).toBe(false);
    expect(body.tools).toEqual([
      { type: "web_search_20250305", name: "web_search", max_uses: 5 },
    ]);
    expect(body.tool_choice).toBeUndefined();
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("key");
    expect(result.sources).toEqual([
      {
        url: "https://example.com/a",
        title: "A",
        snippet: "cited text",
        publishedAt: "2 days",
      },
      { url: "https://example.com/b", title: "B" },
    ]);
    expect(result.usage).toEqual({
      inputTokens: 17,
      outputTokens: 20,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    });
  });

  it("uses the dynamic-filtering tool type on Z.ai", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        content: [
          {
            type: "web_search_tool_result",
            content: [{ type: "web_search_result", url: "https://example.com/a", title: "A" }],
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const backend = createWebSearchBackend(
      provider({ baseUrl: "https://api.z.ai/api/anthropic" }),
    );
    await backend!.search("q", {});

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).tools[0].type).toBe("web_search_20260209");
  });

  it("fails loudly when the provider returns no search blocks", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ content: [{ type: "text", text: "no" }] })));
    const backend = createWebSearchBackend(provider());
    await expect(backend!.search("q", {})).rejects.toThrow(/no web search results/i);
  });

  it("surfaces provider HTTP errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ error: { message: "bad request" } }, 400)),
    );
    const backend = createWebSearchBackend(provider());
    await expect(backend!.search("q", {})).rejects.toThrow(/HTTP 400.*bad request/i);
  });
});

describe("OpenAI native search", () => {
  it("requests sources and maps citations plus action sources", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        output: [
          {
            type: "web_search_call",
            action: { type: "search", query: "q", sources: [{ type: "url", url: "https://example.com/b" }] },
          },
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "MeowCode is great.",
                annotations: [
                  {
                    type: "url_citation",
                    start_index: 0,
                    end_index: 8,
                    url: "https://example.com/a",
                    title: "A",
                  },
                ],
              },
            ],
          },
        ],
        usage: { input_tokens: 5, output_tokens: 6, input_tokens_details: { cached_tokens: 2 } },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const backend = createWebSearchBackend(
      provider({ baseUrl: "https://api.openai.com/v1", protocol: "openai-responses" }),
    );
    const result = await backend!.search("q", {});

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(String(init.body));
    expect(body.tools).toEqual([{ type: "web_search" }]);
    expect(body.include).toEqual(["web_search_call.action.sources"]);
    expect(body.store).toBe(false);
    expect(result.sources).toEqual([
      { url: "https://example.com/b" },
      { url: "https://example.com/a", title: "A", snippet: "MeowCode" },
    ]);
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 6, cacheReadTokens: 2 });
  });
});

describe("formatWebSearchResult", () => {
  it("adds the untrusted-content notice and cite reminder", () => {
    const output = formatWebSearchResult("q", {
      sources: [
        {
          url: "https://example.com/a",
          title: "A",
          summary: "long   summary",
          publishedAt: "2026-01-01",
        },
      ],
    });
    expect(output).toContain("untrusted data");
    expect(output).toContain("- [A](https://example.com/a) — long summary (2026-01-01)");
    expect(output).toContain("markdown links");
  });
});
