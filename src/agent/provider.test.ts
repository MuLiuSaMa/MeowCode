import { afterEach, describe, expect, it, vi } from "vitest";
import { completionUrl, streamChatCompletion } from "./provider";

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
});

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
    expect(result.usage).toEqual({ inputTokens: 111, outputTokens: 22 });
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
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 1 });
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
    expect(Array.isArray(toolMessage?.content)).toBe(true);
    expect((toolMessage?.content as unknown[])[0]).toEqual({
      type: "text",
      text: "Screenshot captured",
    });
    expect((toolMessage?.content as unknown[])[1]).toEqual({
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
      outputTokens: 5,
      cacheReadTokens: 600,
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
