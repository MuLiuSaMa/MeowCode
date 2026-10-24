import { afterEach, describe, expect, it, vi } from "vitest";
import { toResponsesInput, streamResponses } from "./responses";

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamResponses", () => {
  it("maps incomplete max_output_tokens to a length finish reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { type: "response.output_text.delta", delta: "partial" },
          {
            type: "response.incomplete",
            response: {
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
              usage: { input_tokens: 3, output_tokens: 2 },
            },
          },
        ]),
      ),
    );

    const result = await streamResponses({
      url: "https://example.test/v1/responses",
      model: "m",
      instructions: "",
      input: [],
      tools: [],
      onDelta: () => undefined,
    });

    expect(result.message.content).toBe("partial");
    expect(result.finishReason).toBe("length");
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
  });

  it("rejects response.failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { type: "response.failed", response: { error: { message: "upstream exploded" } } },
        ]),
      ),
    );
    await expect(
      streamResponses({
        url: "https://example.test/v1/responses",
        model: "m",
        instructions: "",
        input: [],
        tools: [],
        onDelta: () => undefined,
      }),
    ).rejects.toThrow(/upstream exploded/);
  });

  it("rejects a stream that closes without a terminal event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        incompleteSseResponse([{ type: "response.output_text.delta", delta: "partial" }]),
      ),
    );
    await expect(
      streamResponses({
        url: "https://example.test/v1/responses",
        model: "m",
        instructions: "",
        input: [],
        tools: [],
        onDelta: () => undefined,
      }),
    ).rejects.toThrow(/ended before completion/);
  });
});

describe("Responses request privacy", () => {
  it("disables server-side storage", async () => {
    const fetchMock = vi.fn(async () => sseResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    await streamResponses({
      url: "https://api.openai.com/v1/responses",
      model: "gpt-5.4",
      instructions: "",
      input: [],
      tools: [],
      onDelta: () => undefined,
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body)).store).toBe(false);
  });
});

describe("toResponsesInput user images", () => {
  it("maps user-attached images to input_image parts", () => {
    const input = toResponsesInput([
      { role: "user", content: "看看这张", images: [{ data: "AAA", mimeType: "image/png" }] },
    ]);

    expect(input[0]).toEqual({
      role: "user",
      content: [
        { type: "input_text", text: "看看这张" },
        { type: "input_image", image_url: "data:image/png;base64,AAA" },
      ],
    });
  });
});

describe("prompt_cache_key affinity", () => {
  it("forwards prompt_cache_key in the request body when provided", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        { type: "response.output_text.delta", delta: "ok" },
        { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    await streamResponses({
      url: "https://example.test/v1/responses",
      model: "m",
      promptCacheKey: "session-123:main",
      instructions: "",
      input: [],
      tools: [],
      onDelta: () => undefined,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.prompt_cache_key).toBe("session-123:main");
    expect(body.store).toBe(false);
  });

  it("omits prompt_cache_key when not provided", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        { type: "response.output_text.delta", delta: "ok" },
        { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    await streamResponses({
      url: "https://example.test/v1/responses",
      model: "m",
      instructions: "",
      input: [],
      tools: [],
      onDelta: () => undefined,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).not.toHaveProperty("prompt_cache_key");
  });
});

describe("toResponsesInput attachments", () => {
  it("sends user documents as input_file blocks", () => {
    const input = toResponsesInput([
      {
        role: "user",
        content: "read this",
        documents: [{ data: "PDFDATA", mimeType: "application/pdf", name: "r.pdf" }],
      },
    ]);
    const content = (input[0] as { content: Array<Record<string, unknown>> }).content;
    expect(content[0]).toEqual({ type: "input_text", text: "read this" });
    expect(content[1]).toEqual({
      type: "input_file",
      filename: "r.pdf",
      file_data: "data:application/pdf;base64,PDFDATA",
    });
  });

  it("splits tool images into a following user message instead of dropping them", () => {
    const input = toResponsesInput([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "t1", type: "function", function: { name: "browser_screenshot", arguments: "{}" } }],
      },
      {
        role: "tool",
        content: "screenshot",
        tool_call_id: "t1",
        name: "browser_screenshot",
        images: [{ data: "AAA", mimeType: "image/png" }],
      },
    ]);
    const output = input.find((item) => item.type === "function_call_output") as {
      output: string;
    };
    expect(output.output).toBe("screenshot");
    const followUp = input.find((item) => item.role === "user") as {
      content: Array<Record<string, unknown>>;
    };
    expect(followUp.content[1]).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,AAA",
    });
  });

  it("splits tool documents the same way", () => {
    const input = toResponsesInput([
      {
        role: "tool",
        content: "scanned",
        tool_call_id: "t1",
        name: "read_file",
        documents: [{ data: "PDFDATA", mimeType: "application/pdf", name: "scan.pdf" }],
      },
    ]);
    expect(input[0]).toMatchObject({ type: "function_call_output", output: "scanned" });
    expect(input[1]).toMatchObject({ role: "user" });
    expect((input[1] as { content: Array<Record<string, unknown>> }).content[1]).toEqual({
      type: "input_file",
      filename: "scan.pdf",
      file_data: "data:application/pdf;base64,PDFDATA",
    });
  });

  it("leaves plain tool outputs as a single item", () => {
    const input = toResponsesInput([
      { role: "tool", content: "plain", tool_call_id: "t1", name: "read_file" },
    ]);
    expect(input).toHaveLength(1);
  });
});

describe("streamResponses reasoning + cache headers", () => {
  async function capture(options: {
    reasoningEffort?: string;
    reasoningSummary?: "none" | "auto" | "concise" | "detailed";
    cacheRetention?: "24h";
    promptCacheKey?: string;
  }) {
    const fetchMock = vi.fn(async () =>
      sseResponse([{ type: "response.completed", response: { status: "completed" } }]),
    );
    vi.stubGlobal("fetch", fetchMock);
    await streamResponses({
      url: "https://api.openai.com/v1/responses",
      model: "gpt-5.1",
      instructions: "",
      input: [],
      tools: [],
      onDelta: () => undefined,
      ...options,
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    return {
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      headers: init.headers as Record<string, string>,
    };
  }

  it("does not request a reasoning summary by default", async () => {
    const { body } = await capture({ reasoningEffort: "medium" });
    expect(body.reasoning).toEqual({ effort: "medium" });
  });

  it("sends the summary only when explicitly configured", async () => {
    const { body } = await capture({ reasoningEffort: "high", reasoningSummary: "concise" });
    expect(body.reasoning).toEqual({ effort: "high", summary: "concise" });
  });

  it("adds prompt_cache_retention only when the plan allows it", async () => {
    const withRetention = await capture({ cacheRetention: "24h" });
    expect(withRetention.body.prompt_cache_retention).toBe("24h");
    const without = await capture({});
    expect(without.body).not.toHaveProperty("prompt_cache_retention");
  });

  it("mirrors prompt_cache_key into the x-session-id header", async () => {
    const { headers } = await capture({ promptCacheKey: "sess:main" });
    expect(headers["x-session-id"]).toBe("sess:main");
    const none = await capture({});
    expect(none.headers["x-session-id"]).toBeUndefined();
  });
});
