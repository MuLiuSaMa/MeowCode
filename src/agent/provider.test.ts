import { afterEach, describe, expect, it, vi } from "vitest";
import { completionUrl, streamChatCompletion } from "./provider";
import type { ChatMessage } from "./types";

describe("completionUrl", () => {
  it("supports OpenAI-compatible v1 endpoints", () => {
    expect(completionUrl("https://api.openai.com")).toBe("https://api.openai.com/v1/chat/completions");
    expect(completionUrl("https://api.deepseek.com/v1")).toBe("https://api.deepseek.com/v1/chat/completions");
  });

  it("does not add another version for provider-specific versioned bases", () => {
    expect(completionUrl("https://ark.cn-beijing.volces.com/api/coding/v3")).toBe(
      "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions",
    );
  });

  it("keeps suffixed version segments (v1beta / v1alpha)", () => {
    expect(completionUrl("https://generativelanguage.googleapis.com/v1beta/openai")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
    expect(completionUrl("https://generativelanguage.googleapis.com/v1beta")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/chat/completions",
    );
    expect(completionUrl("https://api.example.com/v1alpha")).toBe(
      "https://api.example.com/v1alpha/chat/completions",
    );
  });});

function sseResponse(chunks: object[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function incompleteSseResponse(chunks: object[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const baseOptions = {
  provider: { id: "p", name: "P", baseUrl: "https://api.example.com/v1", model: "m" },
  messages: [{ role: "user" as const, content: "hi" }],
  tools: [],
  onDelta: () => undefined,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chat completions request body", () => {
  it("does not replay archived reasoning or anthropic thinking", async () => {
    let body: { messages?: Array<Record<string, unknown>> } | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        body = JSON.parse(String(init?.body)) as typeof body;
        return sseResponse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
      }),
    );
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "done",
        reasoning: "private thinking",
        anthropic_thinking: [{ type: "thinking", thinking: "x", signature: "s" }],
      },
      { role: "user", content: "again" },
    ];
    await streamChatCompletion({ ...baseOptions, messages });
    const assistant = body?.messages?.find((message) => message.role === "assistant");
    expect(assistant?.content).toBe("done");
    expect(assistant).not.toHaveProperty("reasoning");
    expect(assistant).not.toHaveProperty("anthropic_thinking");
  });
});

describe("prompt cache affinity", () => {
  function captureFetch() {
    const calls: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push({
          headers: init?.headers as Record<string, string>,
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return sseResponse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
      }),
    );
    return calls;
  }

  it("sends the cache key in body and header on the official endpoint", async () => {
    const calls = captureFetch();
    await streamChatCompletion({
      ...baseOptions,
      provider: {
        ...baseOptions.provider,
        baseUrl: "https://api.openai.com/v1",
        promptCacheKey: "sess:main",
      },
    });
    expect(calls[0].body.prompt_cache_key).toBe("sess:main");
    expect(calls[0].headers["x-session-id"]).toBe("sess:main");
  });

  it("keeps the body field off third-party gateways but still sends the header", async () => {
    const calls = captureFetch();
    await streamChatCompletion({
      ...baseOptions,
      provider: { ...baseOptions.provider, promptCacheKey: "sess:main" },
    });
    expect(calls[0].body).not.toHaveProperty("prompt_cache_key");
    expect(calls[0].headers["x-session-id"]).toBe("sess:main");
  });

  it("uses a fresh x-request-id for every retry attempt", async () => {
    const ids: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        ids.push(((init?.headers as Record<string, string> | undefined)?.["x-request-id"]) ?? "");
        if (ids.length === 1) {
          return new Response("busy", { status: 429, headers: { "retry-after": "0" } });
        }
        return sseResponse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
      }),
    );
    await streamChatCompletion(baseOptions);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("streamChatCompletion usage reporting", () => {
  it("reports the tail-block usage once, deduping repeated identical blocks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { choices: [{ delta: { content: "hi" } }] },
          {
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 20,
              prompt_tokens_details: { cached_tokens: 800 },
            },
          },
          {
            choices: [],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 20,
              prompt_tokens_details: { cached_tokens: 800 },
            },
          },
        ]),
      ),
    );

    const samples: Array<{ inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }> = [];
    const result = await streamChatCompletion({
      ...baseOptions,
      onUsage: (usage) => samples.push({ ...usage }),
    });

    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ inputTokens: 1000, outputTokens: 20, cacheReadTokens: 800 });
    // 返回值保持兼容：既有调用方仍拿到最终 usage
    expect(result.usage?.outputTokens).toBe(20);
  });

  it("calls onUsageFinal once with the final usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { choices: [{ delta: { content: "hi" } }] },
          {
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 20,
              prompt_tokens_details: { cached_tokens: 800 },
            },
          },
        ]),
      ),
    );

    const live: Array<{ outputTokens?: number }> = [];
    const finals: Array<{ inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }> = [];
    await streamChatCompletion({
      ...baseOptions,
      onUsage: (usage) => live.push({ ...usage }),
      onUsageFinal: (usage) => finals.push({ ...usage }),
    });

    expect(live.length).toBeGreaterThan(0);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ inputTokens: 1000, outputTokens: 20, cacheReadTokens: 800 });
  });

  it("calls onUsageFinal with the last observed usage when the stream fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        incompleteSseResponse([
          {
            choices: [],
            usage: {
              prompt_tokens: 640,
              completion_tokens: 12,
              prompt_tokens_details: { cached_tokens: 500 },
            },
          },
        ]),
      ),
    );

    const finals: Array<{ inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }> = [];
    await expect(
      streamChatCompletion({
        ...baseOptions,
        onUsageFinal: (usage) => finals.push({ ...usage }),
      }),
    ).rejects.toThrow(/before completion/);

    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ inputTokens: 640, outputTokens: 12, cacheReadTokens: 500 });
  });
});

describe("streamChatCompletion tool progress", () => {
  it("reports accumulating tool-call names and argument length", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call-1", function: { name: "task", arguments: '{"des' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: 'cription":"x"}' } }],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ]),
      ),
    );
    const progress: Array<{ count: number; tool?: string; names?: string[]; chars: number }> = [];
    const result = await streamChatCompletion({
      ...baseOptions,
      onToolCall: (item) => progress.push(item),
    });
    expect(progress[0]).toMatchObject({ count: 1, tool: "task", names: ["task"] });
    expect(progress.at(-1)).toMatchObject({ count: 1, tool: "task", chars: 19 });
    expect(result.message.tool_calls?.[0].function.name).toBe("task");
  });

  it("fires onToolCallComplete exactly once when arguments close midstream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call-1", function: { name: "read_file", arguments: '{"pa' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ]),
      ),
    );
    const completed: Array<{ id: string; function: { name: string; arguments: string } }> = [];
    const result = await streamChatCompletion({
      ...baseOptions,
      onToolCallComplete: (call) => completed.push(call as never),
    });
    // 参数闭合即刻触发一次；流结束后的最终结果仍是完整参数
    expect(completed).toHaveLength(1);
    expect(completed[0]).toEqual({
      id: "call-1",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"a.txt"}' },
    });
    expect(result.message.tool_calls?.[0].function.arguments).toBe('{"path":"a.txt"}');
  });

  it("does not fire onToolCallComplete while arguments are still incomplete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call-2", function: { name: "read_file", arguments: '{"pa' } },
                  ],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: "length" }] },
        ]),
      ),
    );
    const completed: unknown[] = [];
    await streamChatCompletion({
      ...baseOptions,
      onToolCallComplete: (call) => completed.push(call),
    });
    expect(completed).toHaveLength(0);
  });
});

describe("streamChatCompletion usage", () => {
  it("requests include_usage and captures real usage", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sseResponse([
          { choices: [{ delta: { role: "assistant" } }] },
          { choices: [{ delta: { content: "hi" } }] },
          {
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 111, completion_tokens: 22 },
          },
        ]);
      }),
    );

    const result = await streamChatCompletion(baseOptions);
    expect(bodies[0].stream_options).toEqual({ include_usage: true });
    expect(result.message.content).toBe("hi");
    expect(result.usage).toEqual({
      inputTokens: 111,
      uncachedInputTokens: 111,
      outputTokens: 22,
    });
  });

  it("retries without stream_options when the gateway rejects it", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        if (body.stream_options) {
          return new Response("stream_options is not supported", { status: 400 });
        }
        return sseResponse([
          {
            choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 7, completion_tokens: 1 },
          },
        ]);
      }),
    );

    const result = await streamChatCompletion(baseOptions);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].stream_options).toBeUndefined();
    expect(result.usage).toEqual({
      inputTokens: 7,
      uncachedInputTokens: 7,
      outputTokens: 1,
    });
  });

  it("does not retry for unrelated request errors", async () => {
    const fetchMock = vi.fn(async () => new Response("invalid api key", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(streamChatCompletion(baseOptions)).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a stream that closes without [DONE] or finish_reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => incompleteSseResponse([{ choices: [{ delta: { content: "partial" } }] }])),
    );
    await expect(streamChatCompletion(baseOptions)).rejects.toThrow(/ended before completion/);
  });

  it("accepts a stream that closes after finish_reason without [DONE]", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        incompleteSseResponse([
          { choices: [{ delta: { content: "full" }, finish_reason: "stop" }] },
        ]),
      ),
    );
    const result = await streamChatCompletion(baseOptions);
    expect(result.message.content).toBe("full");
  });
});

describe("streamChatCompletion tool images", () => {
  it("maps attached tool images to image_url content parts", async () => {
    const bodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sseResponse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
      }),
    );

    await streamChatCompletion({
      ...baseOptions,
      messages: [
        { role: "user", content: "look at the page" },
        {
          role: "tool",
          content: "Screenshot captured",
          tool_call_id: "t1",
          name: "browser_screenshot",
          images: [{ data: "AAA", mimeType: "image/png" }],
        },
      ],
    });

    const toolMessage = bodies[0].messages.find((message) => message.role === "tool");
    const toolContent = toolMessage?.content as unknown[] | undefined;
    expect(Array.isArray(toolContent)).toBe(true);
    expect(toolContent?.[0]).toEqual({
      type: "text",
      text: "Screenshot captured",
    });
    expect(toolContent?.[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAA" },
    });
  });

  it("keeps a plain string for tool messages without images", async () => {
    const bodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sseResponse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
      }),
    );

    await streamChatCompletion({
      ...baseOptions,
      messages: [
        { role: "user", content: "hi" },
        { role: "tool", content: "plain", tool_call_id: "t1" },
      ],
    });

    const toolMessage = bodies[0].messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toBe("plain");
  });
});

describe("streamChatCompletion cache usage buckets", () => {
  it("reads cached tokens from OpenAI prompt token details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          {
            choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 1_000,
              completion_tokens: 12,
              prompt_tokens_details: { cached_tokens: 618 },
            },
          },
        ]),
      ),
    );

    const result = await streamChatCompletion(baseOptions);
    expect(result.usage).toEqual({
      inputTokens: 1_000,
      // prompt_tokens 已含命中部分，减掉才是真正没走缓存的输入
      uncachedInputTokens: 382,
      outputTokens: 12,
      cacheReadTokens: 618,
    });
  });

  it("supports DeepSeek prompt_cache_hit_tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          {
            choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 800, completion_tokens: 5, prompt_cache_hit_tokens: 600 },
          },
        ]),
      ),
    );

    const result = await streamChatCompletion(baseOptions);
    expect(result.usage).toEqual({
      inputTokens: 800,
      uncachedInputTokens: 200,
      outputTokens: 5,
      cacheReadTokens: 600,
    });
  });

  it("derives cache read when the gateway reports only prompt_cache_miss_tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          {
            choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 800, completion_tokens: 5, prompt_cache_miss_tokens: 200 },
          },
        ]),
      ),
    );

    const result = await streamChatCompletion(baseOptions);
    expect(result.usage).toEqual({
      inputTokens: 800,
      uncachedInputTokens: 200,
      outputTokens: 5,
      cacheReadTokens: 600,
    });
  });

  it("accepts Anthropic-style cache fields passed through by a gateway", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          {
            choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 1_000,
              completion_tokens: 5,
              cache_read_input_tokens: 600,
              cache_creation_input_tokens: 100,
            },
          },
        ]),
      ),
    );

    const result = await streamChatCompletion(baseOptions);
    expect(result.usage).toEqual({
      inputTokens: 1_000,
      uncachedInputTokens: 300,
      outputTokens: 5,
      cacheReadTokens: 600,
      cacheWriteTokens: 100,
    });
  });

  it("reads cached tokens for the responses protocol", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { type: "response.output_text.delta", delta: "ok" },
          {
            type: "response.completed",
            response: {
              usage: {
                input_tokens: 1_000,
                output_tokens: 5,
                input_tokens_details: { cached_tokens: 250 },
              },
            },
          },
        ]),
      ),
    );

    const result = await streamChatCompletion({
      ...baseOptions,
      provider: { ...baseOptions.provider, protocol: "openai-responses" as const },
    });
    expect(result.usage).toEqual({
      inputTokens: 1_000,
      uncachedInputTokens: 750,
      outputTokens: 5,
      cacheReadTokens: 250,
    });
  });
});

describe("finish reasons", () => {
  it("captures length from chat completions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { choices: [{ delta: { content: "partial" }, finish_reason: "length" }] },
        ]),
      ),
    );

    const result = await streamChatCompletion(baseOptions);
    expect(result.message.content).toBe("partial");
    expect(result.finishReason).toBe("length");
  });
});

describe("transient provider failures", () => {
  it("retries a 429 before consuming the stream", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("busy", { status: 429, headers: { "retry-after": "0" } }),
      )
      .mockResolvedValueOnce(
        sseResponse([
          { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamChatCompletion(baseOptions);
    expect(result.message.content).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("streamChatCompletion user images", () => {
  it("maps user-attached images to image_url content parts", async () => {
    const bodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sseResponse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
      }),
    );

    await streamChatCompletion({
      ...baseOptions,
      messages: [
        { role: "user", content: "这是什么", images: [{ data: "AAA", mimeType: "image/png" }] },
      ],
    });

    expect(bodies[0].messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "这是什么" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
      ],
    });
  });

  it("omits the empty text part for image-only messages", async () => {
    const bodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sseResponse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
      }),
    );

    await streamChatCompletion({
      ...baseOptions,
      messages: [{ role: "user", content: "", images: [{ data: "AAA", mimeType: "image/png" }] }],
    });

    expect(bodies[0].messages[0]).toEqual({
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }],
    });
  });
});

describe("streamChatCompletion auth/extra fields", () => {
  it("authStyle=api-key + extraHeaders + extraBody 进入 chat completions 请求", async () => {
    const calls: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push({
          headers: init.headers as Record<string, string>,
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
        });
        return sseResponse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
      }),
    );
    await streamChatCompletion({
      ...baseOptions,
      provider: {
        ...baseOptions.provider,
        apiKey: "azure-key",
        authStyle: "api-key",
        extraHeaders: { "x-title": "MeowCode" },
        extraBody: { enable_thinking: false },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].headers["api-key"]).toBe("azure-key");
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0].headers["x-title"]).toBe("MeowCode");
    expect(calls[0].body.enable_thinking).toBe(false);
  });

  it("anthropic-messages 协议同样消费 authStyle/extraHeaders/extraBody", async () => {
    const calls: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push({
          headers: init.headers as Record<string, string>,
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
        });
        return new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(
                encoder.encode(
                  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
                ),
              );
              controller.enqueue(encoder.encode('data: {"type":"message_stop"}\n\n'));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    await streamChatCompletion({
      ...baseOptions,
      provider: {
        ...baseOptions.provider,
        protocol: "anthropic-messages",
        baseUrl: "https://gateway.example.com",
        apiKey: "k",
        authStyle: "bedrock-api-key",
        extraHeaders: { "x-tenant": "t1" },
        extraBody: { metadata: { user: "u1" } },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.authorization).toBe("Bedrock-API-Key k");
    expect(calls[0].headers["x-api-key"]).toBeUndefined();
    expect(calls[0].headers["x-tenant"]).toBe("t1");
    expect(calls[0].body.metadata).toEqual({ user: "u1" });
  });
});
