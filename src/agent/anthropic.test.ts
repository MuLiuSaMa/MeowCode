import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  anthropicTools,
  resetProviderDegradeMemoryForTests,
  streamAnthropicMessages,
  toAnthropicMessages,
} from "./anthropic.js";
import { BREAKPOINT_CAP, isOneShotRequest, resolveCachePlan, withoutCacheWrites } from "./cache-profile.js";
import type { ChatMessage, ToolDefinition } from "./types.js";

// 降级记忆（模块级 Set）跨用例存活：每个用例前归零，避免降级用例污染同 url 的后续用例
beforeEach(() => resetProviderDegradeMemoryForTests());

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

describe("toAnthropicMessages tool images", () => {
  it("sends tool_result content as blocks when images are attached", () => {
    const { messages } = toAnthropicMessages([
      { role: "user", content: "look" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "t1", type: "function", function: { name: "browser_screenshot", arguments: "{}" } },
        ],
      },
      {
        role: "tool",
        content: "Screenshot captured",
        tool_call_id: "t1",
        name: "browser_screenshot",
        images: [{ data: "AAA", mimeType: "image/png" }],
      },
    ]);

    const toolResult = messages[2].content as Array<Record<string, unknown>>;
    const block = toolResult[0] as { type: string; content: Array<Record<string, unknown>> };
    expect(block.type).toBe("tool_result");
    expect(block.content).toEqual([
      { type: "text", text: "Screenshot captured" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AAA" },
      },
    ]);
  });

  it("keeps a plain string when there are no images", () => {
    const { messages } = toAnthropicMessages([
      { role: "user", content: "look" },
      { role: "tool", content: "plain result", tool_call_id: "t1" },
    ]);
    const toolResult = messages[1].content as Array<{ type: string; content: unknown }>;
    expect(toolResult[0].content).toBe("plain result");
  });
});

describe("streamAnthropicMessages cache usage", () => {
  it("reports total input plus cache read/write buckets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          {
            type: "message_start",
            message: {
              usage: {
                input_tokens: 200,
                cache_read_input_tokens: 600,
                cache_creation_input_tokens: 200,
              },
            },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "hi" },
          },
          { type: "message_delta", usage: { output_tokens: 12 } },
        ]),
      ),
    );

    const result = await streamAnthropicMessages({
      url: "https://api.example.com/v1/messages",
      apiKey: "k",
      model: "m",
      system: [],
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      onDelta: () => undefined,
    });
    expect(result.message.content).toBe("hi");
    // 总输入 = 200 普通输入 + 600 缓存读取 + 200 缓存写入
    expect(result.usage).toEqual({
      inputTokens: 1_000,
      outputTokens: 12,
      cacheReadTokens: 600,
      cacheWriteTokens: 200,
    });
  });

  it("rejects a stream that closes without message_stop", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        incompleteSseResponse([
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "partial" },
          },
        ]),
      ),
    );
    await expect(
      streamAnthropicMessages({
        url: "https://api.example.com/v1/messages",
        model: "m",
        system: [],
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        onDelta: () => undefined,
      }),
    ).rejects.toThrow(/ended before completion/);
  });

  it("does not let later zero values overwrite message_start cache usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          {
            type: "message_start",
            message: {
              usage: {
                input_tokens: 100,
                cache_read_input_tokens: 600,
                cache_creation_input_tokens: 0,
              },
            },
          },
          {
            type: "message_delta",
            usage: {
              input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 5,
            },
          },
        ]),
      ),
    );

    const result = await streamAnthropicMessages({
      url: "https://api.example.com/v1/messages",
      model: "m",
      system: [],
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      onDelta: () => undefined,
    });
    expect(result.usage).toEqual({
      inputTokens: 700,
      outputTokens: 5,
      cacheReadTokens: 600,
      cacheWriteTokens: 0,
    });
  });

  it("omits cache buckets when the provider reports no cache fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { type: "message_start", message: { usage: { input_tokens: 100 } } },
          { type: "message_delta", usage: { output_tokens: 3 } },
        ]),
      ),
    );

    const result = await streamAnthropicMessages({
      url: "https://api.example.com/v1/messages",
      model: "m",
      system: [],
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      onDelta: () => undefined,
    });
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 3 });
  });
});

describe("Anthropic prompt caching", () => {
  it("marks the longest stable system block, the last tool, and the last message as cacheable", () => {
    const { system, messages } = toAnthropicMessages([
      { role: "system", content: "stable contract" },
      { role: "system", content: "Current task plan:\n1. [pending] A" },
      { role: "user", content: "hi" },
    ]);
    // base 由 system[1] 的缓存块顺带覆盖，不再单独占一个断点
    expect(system).toEqual([
      { type: "text", text: "stable contract" },
      { type: "text", text: "Current task plan:\n1. [pending] A", cache_control: { type: "ephemeral" } },
    ]);
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
    });

    const tools = anthropicTools([
      {
        type: "function",
        function: { name: "read_file", description: "read", parameters: { type: "object" } },
      },
      {
        type: "function",
        function: { name: "grep", description: "grep", parameters: { type: "object" } },
      },
    ]);
    expect(tools[0]).not.toHaveProperty("cache_control");
    expect(tools[1]).toMatchObject({ name: "grep", cache_control: { type: "ephemeral" } });
  });

  it("marks the second system block (AGENTS.md); base is covered by it and mode stays uncached", () => {
    const { system } = toAnthropicMessages([
      { role: "system", content: "base prompt" },
      { role: "system", content: "project instructions" },
      { role: "system", content: "plan snapshot" },
      { role: "user", content: "hi" },
    ]);
    expect(system).toHaveLength(3);
    // AGENTS.md 是最长稳定段，必须命中断点；它之前的 base 在同一缓存块内
    expect(system[0]).not.toHaveProperty("cache_control");
    expect(system[1]).toHaveProperty("cache_control");
    // 末条 mode 消息短且切换频繁，全价发送
    expect(system[2]).not.toHaveProperty("cache_control");
  });

  it("leaves a single system block with exactly one cache breakpoint", () => {
    const { system } = toAnthropicMessages([
      { role: "system", content: "only base" },
      { role: "user", content: "hi" },
    ]);
    expect(system).toEqual([
      { type: "text", text: "only base", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("degrades to two breakpoints first when a gateway rejects the field", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        if (bodies.length === 1) {
          return new Response("unknown field: cache_control", { status: 400 });
        }
        return sseResponse([
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "ok" },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          },
        ]);
      }),
    );

    const result = await streamAnthropicMessages({
      url: "https://gateway.example/v1/messages",
      model: "m",
      system: [
        { type: "text", text: "stable", cache_control: { type: "ephemeral" } },
        { type: "text", text: "volatile", cache_control: { type: "ephemeral" } },
      ],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
        },
      ],
      tools: [
        {
          name: "read_file",
          description: "read",
          input_schema: { type: "object" },
          cache_control: { type: "ephemeral" },
        },
      ],
      onDelta: () => undefined,
    });

    expect(result.message.content).toBe("ok");
    expect(bodies).toHaveLength(2);
    // 第一次是满额断点，第二次降到「system 首块 + 尾条」：不是一刀切全关
    expect((bodies[0].system as Array<Record<string, unknown>>)[0]).toHaveProperty("cache_control");
    expect((bodies[1].system as Array<Record<string, unknown>>)[0]).toHaveProperty("cache_control");
    expect((bodies[1].system as Array<Record<string, unknown>>)[1]).not.toHaveProperty("cache_control");
    expect((bodies[1].tools as Array<Record<string, unknown>>)[0]).not.toHaveProperty("cache_control");
    const retryMessage = (bodies[1].messages as Array<{ content: Array<Record<string, unknown>> }>)[0];
    expect(retryMessage.content[0]).toHaveProperty("cache_control");
  });

  it("turns cache_control off entirely only when the 2-breakpoint form is rejected too", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    // 只拒前两次（满额 + 降级档），之后的请求一律放行：第二次 call 用来验证「已记住全关」
    let rejections = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        if (rejections < 2) {
          rejections += 1;
          return new Response("unknown field: cache_control", { status: 400 });
        }
        return sseResponse([
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "ok" },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          },
        ]);
      }),
    );

    const call = () =>
      streamAnthropicMessages({
        url: "https://strict.example/v1/messages",
        model: "m",
        system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral" } }],
        messages: [
          { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
        ],
        tools: [],
        onDelta: () => undefined,
      });

    await call();
    expect(bodies).toHaveLength(3);
    expect((bodies[2].system as Array<Record<string, unknown>>)[0]).not.toHaveProperty("cache_control");
    const lastMessage = (bodies[2].messages as Array<{ content: Array<Record<string, unknown>> }>)[0];
    expect(lastMessage.content[0]).not.toHaveProperty("cache_control");

    // 全关会被记住：下一次请求直接以「不发字段」起步，不再试错
    bodies.length = 0;
    await call();
    expect(bodies).toHaveLength(1);
    expect((bodies[0].system as Array<Record<string, unknown>>)[0]).not.toHaveProperty("cache_control");
  });
});

describe("server-side context editing", () => {
  it("declares clear_tool_uses when asked", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const headers: Array<Record<string, string>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: string; headers?: Record<string, string> }) => {
        bodies.push(JSON.parse(String(init?.body)));
        headers.push(init?.headers ?? {});
        return sseResponse([
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        ]);
      }),
    );

    await streamAnthropicMessages({
      url: "https://api.anthropic.com/v1/messages",
      providerId: "native-ce",
      model: "claude-sonnet-4-5",
      system: [{ type: "text", text: "stable" }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      contextEditing: { triggerTokens: 120_000, keepToolUses: 3, clearAtLeastTokens: 20_000 },
      onDelta: () => undefined,
    });

    // 不声明 beta 服务端不认这个字段
    expect(headers[0]["anthropic-beta"]).toBe("context-management-2025-06-27");
    expect(bodies[0].context_management).toEqual({
      edits: [
        {
          type: "clear_tool_uses_20250919",
          trigger: { type: "input_tokens", value: 120_000 },
          keep: { type: "tool_uses", value: 3 },
          clear_at_least: { type: "input_tokens", value: 20_000 },
        },
      ],
    });
  });

  it("drops the field and remembers when the endpoint does not support it", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let rejections = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        bodies.push(JSON.parse(String(init?.body)));
        if (rejections < 1) {
          rejections += 1;
          return new Response("context_management is not supported", { status: 400 });
        }
        return sseResponse([
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        ]);
      }),
    );

    const call = () =>
      streamAnthropicMessages({
        url: "https://api.anthropic.com/v1/messages",
        providerId: "native-ce-degrade",
        model: "claude-sonnet-4-5",
        system: [{ type: "text", text: "stable" }],
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [],
        contextEditing: { triggerTokens: 120_000, keepToolUses: 3 },
        onDelta: () => undefined,
      });

    await call();
    expect(bodies[0]).toHaveProperty("context_management");
    expect(bodies[1]).not.toHaveProperty("context_management");

    // 记住降级：下一次请求不再带上该字段，也不会再吃一趟 400
    bodies.length = 0;
    await call();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("context_management");
  });
});

describe("finish reasons", () => {
  it("maps max_tokens to length", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { type: "message_start", message: { usage: { input_tokens: 2 } } },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "partial" },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "max_tokens" },
            usage: { output_tokens: 4 },
          },
        ]),
      ),
    );

    const result = await streamAnthropicMessages({
      url: "https://example.test/v1/messages",
      model: "m",
      system: [],
      messages: [],
      tools: [],
      onDelta: () => undefined,
    });

    expect(result.message.content).toBe("partial");
    expect(result.finishReason).toBe("length");
  });
});

describe("Anthropic request fields by endpoint", () => {
  async function capturedBody(url: string): Promise<Record<string, unknown>> {
    const fetchMock = vi.fn(async () => sseResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    await streamAnthropicMessages({
      url,
      apiKey: "k",
      model: "claude-sonnet-5",
      maxTokens: 2048,
      reasoningEffort: "high",
      system: [],
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      onDelta: () => undefined,
    });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    return JSON.parse(String(init.body)) as Record<string, unknown>;
  }

  it("does not send reasoning_effort to the native Anthropic API", async () => {
    const body = await capturedBody("https://api.anthropic.com/v1/messages");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("keeps reasoning_effort for Anthropic-compatible gateways", async () => {
    const body = await capturedBody("https://open.bigmodel.cn/api/anthropic/v1/messages");
    expect(body.reasoning_effort).toBe("high");
  });

  it("maps DeepSeek's Anthropic endpoint to thinking + output_config.effort", async () => {
    const body = await capturedBody("https://api.deepseek.com/anthropic/v1/messages");
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.output_config).toEqual({ effort: "high" });
  });
});

describe("toAnthropicMessages tool result grouping", () => {
  it("puts every tool_result of a parallel batch in the single next user message", () => {
    const { messages } = toAnthropicMessages([
      { role: "user", content: "do two things" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "a", type: "function", function: { name: "read_file", arguments: "{}" } },
          { id: "b", type: "function", function: { name: "list_dir", arguments: "{}" } },
        ],
      },
      { role: "tool", content: "A", tool_call_id: "a", name: "read_file" },
      { role: "tool", content: "B", tool_call_id: "b", name: "list_dir" },
    ]);

    expect(messages).toHaveLength(3);
    const reply = messages[2] as { role: string; content: Array<Record<string, unknown>> };
    expect(reply.role).toBe("user");
    expect(reply.content.every((block) => block.type === "tool_result")).toBe(true);
    expect(reply.content.map((block) => block.tool_use_id)).toEqual(["a", "b"]);
  });

  it("keeps a real user message out of the tool_result group", () => {
    const { messages } = toAnthropicMessages([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "a", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "tool", content: "A", tool_call_id: "a", name: "read_file" },
      { role: "user", content: "next question" },
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[1].content).toEqual([
      { type: "tool_result", tool_use_id: "a", content: "A" },
    ]);
    expect(messages[2]).toMatchObject({ role: "user" });
    expect((messages[2].content as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "text",
      text: "next question",
    });
  });
});

describe("Anthropic extended thinking", () => {
  const nativeUrl = "https://api.anthropic.com/v1/messages";

  function thinkingStream(): Response {
    return sseResponse([
      { type: "message_start", message: { usage: { input_tokens: 5 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "step one" },
      },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc" } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "read_file" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ]);
  }

  const baseOptions = (url: string) => ({
    url,
    model: "claude-sonnet-5",
    maxTokens: 8192,
    system: [],
    messages: [{ role: "user", content: "hi" }] as Array<Record<string, unknown>>,
    tools: [] as Array<Record<string, unknown>>,
    onDelta: () => undefined,
  });

  it("captures the thinking block with its signature", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => thinkingStream()));
    const result = await streamAnthropicMessages({ ...baseOptions(nativeUrl), reasoningEffort: "high" });

    expect(result.message.anthropic_thinking).toEqual([
      { type: "thinking", thinking: "step one", signature: "sig-abc" },
    ]);
    expect(result.message.reasoning).toBe("step one");
    expect(result.message.tool_calls?.[0]?.id).toBe("t1");
  });

  it("reports usage at message_start, before any thinking delta", async () => {
    const order: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          {
            type: "message_start",
            message: {
              usage: {
                input_tokens: 120,
                cache_read_input_tokens: 900,
                cache_creation_input_tokens: 30,
              },
            },
          },
          { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 40 } },
          { type: "message_stop" },
        ]),
      ),
    );

    const samples: Array<{ inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }> = [];
    const result = await streamAnthropicMessages({
      ...baseOptions(nativeUrl),
      onThinking: () => order.push("thinking"),
      onUsage: (usage) => {
        order.push(`usage:${usage.outputTokens ?? 0}`);
        samples.push({ ...usage });
      },
    });

    // 第一件事就是输入/缓存到达（思考还没开始），输出此时还是 0
    expect(order[0]).toBe("usage:0");
    expect(samples[0]).toMatchObject({
      inputTokens: 1050,
      cacheReadTokens: 900,
      cacheWriteTokens: 30,
    });
    // 结束前强冲一次：最后一次回调与返回值同值
    expect(samples.at(-1)?.outputTokens).toBe(40);
    expect(result.usage?.outputTokens).toBe(40);
  });

  it("replays thinking blocks before text and tool_use", () => {
    const { messages } = toAnthropicMessages([
      { role: "user", content: "x" },
      {
        role: "assistant",
        content: "answer",
        reasoning: "step one",
        anthropic_thinking: [{ type: "thinking", thinking: "step one", signature: "sig-abc" }],
        tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "tool", content: "ok", tool_call_id: "t1" },
    ]);

    const blocks = messages[1].content as Array<Record<string, unknown>>;
    expect(blocks.map((block) => block.type)).toEqual(["thinking", "text", "tool_use"]);
    expect(blocks[0]).toEqual({ type: "thinking", thinking: "step one", signature: "sig-abc" });
  });

  it("enables thinking for a native endpoint when effort is set", async () => {
    const fetchMock = vi.fn(async () => sseResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    await streamAnthropicMessages({ ...baseOptions(nativeUrl), reasoningEffort: "high" });

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("skips thinking when max_tokens leaves no valid budget", async () => {
    const fetchMock = vi.fn(async () => sseResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    await streamAnthropicMessages({
      ...baseOptions(nativeUrl),
      maxTokens: 1500,
      reasoningEffort: "high",
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("drops historical thinking blocks when thinking is not enabled", async () => {
    const fetchMock = vi.fn(async () => sseResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const options = baseOptions(nativeUrl);
    options.messages = [
      { role: "user", content: "x" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "old", signature: "sig-old" },
          { type: "text", text: "answer" },
        ],
      },
    ];
    await streamAnthropicMessages(options);

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    const assistant = body.messages[1].content as Array<Record<string, unknown>>;
    expect(assistant.some((block) => block.type === "thinking")).toBe(false);
  });

  it("retries without thinking when the model does not support it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "thinking is not supported for this model" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(sseResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await streamAnthropicMessages({ ...baseOptions(nativeUrl), reasoningEffort: "high" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    const second = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(first).toHaveProperty("thinking");
    expect(second).not.toHaveProperty("thinking");
  });
});

describe("toAnthropicMessages user images", () => {
  it("sends user-attached images as image blocks", () => {
    const { messages } = toAnthropicMessages([
      { role: "user", content: "看看这张", images: [{ data: "AAA", mimeType: "image/jpeg" }] },
    ]);

    const content = messages[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: "看看这张" });
    expect(content[1]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "AAA" },
    });
  });

  it("uses a stable content-block array for plain user text", () => {
    const { messages } = toAnthropicMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok" },
    ]);
    // 固定为数组：断点加/移时序列化形状不能变，否则前缀缓存在下一跳失效
    const content = messages[0].content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toMatchObject({ type: "text", text: "hi" });
  });
});

/** 数一次请求体里出现了多少个 cache_control（断点总数必须 <= 4）。 */
function countCacheControl(body: unknown): number {
  let count = 0;
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === "cache_control") count += 1;
      else walk(item);
    }
  };
  walk(body);
  return count;
}

describe("cache profile breakpoints", () => {
  const baseMessages = (): ChatMessage[] => [
    { role: "system", content: "base prompt" },
    { role: "system", content: "AGENTS.md body" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    { role: "user", content: "again" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call-1", type: "function", function: { name: "a", arguments: "{}" } },
      ],
    },
    { role: "tool", content: "ok", tool_call_id: "call-1" },
  ];
  const tools: ToolDefinition[] = [
    { type: "function", function: { name: "a", description: "a", parameters: { type: "object", properties: {} } } },
    { type: "function", function: { name: "b", description: "b", parameters: { type: "object", properties: {} } } },
  ];

  function build(provider: Partial<Parameters<typeof resolveCachePlan>[0]> & { baseUrl: string; model: string }) {
    const plan = resolveCachePlan({
      id: "p",
      name: "p",
      protocol: "anthropic-messages",
      ...provider,
    });
    const { system, messages } = toAnthropicMessages(baseMessages(), plan);
    return { plan, body: { system, messages, tools: anthropicTools(tools, plan) } };
  }

  it("uses exactly 4 breakpoints on the native Anthropic endpoint", () => {
    const { body } = build({ baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5" });
    expect(countCacheControl(body)).toBe(BREAKPOINT_CAP);
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[0]).not.toHaveProperty("cache_control");
    expect(tools[1]).toHaveProperty("cache_control");
  });

  it("never tags tools on a Qwen endpoint", () => {
    const { plan, body } = build({
      baseUrl: "https://dashscope.aliyuncs.com/api/v2/apps/claude-code-proxy",
      model: "qwen3-max",
    });
    expect(plan.profile).toBe("qwen");
    expect(countCacheControl(body)).toBe(2);
    expect((body.tools as Array<Record<string, unknown>>)[1]).not.toHaveProperty("cache_control");
  });

  it("sends no breakpoints at all for an unparseable endpoint", () => {
    const { plan, body } = build({ baseUrl: "not a url", model: "glm-4.6" });
    expect(plan.enabled).toBe(false);
    expect(countCacheControl(body)).toBe(0);
  });

  it("carries the 1h ttl on every breakpoint when configured", () => {
    const { body } = build({
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-5",
      cacheTtl: "1h",
    });
    const tags: unknown[] = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (!value || typeof value !== "object") return;
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (key === "cache_control") tags.push(item);
        else walk(item);
      }
    };
    walk(body);
    expect(tags).toHaveLength(BREAKPOINT_CAP);
    for (const tag of tags) expect(tag).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("tags the snapshot anchor instead of the array tail", () => {
    const plan = resolveCachePlan({
      id: "p",
      name: "p",
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-5",
    });
    // 追加工具后：断点留在快照末尾（index 0），新追加的 index 1 不打点
    const appended = anthropicTools(tools, plan, 0);
    expect(appended[0]).toHaveProperty("cache_control");
    expect(appended[1]).not.toHaveProperty("cache_control");
    // 越界锚点钳制到数组末尾
    const clamped = anthropicTools(tools, plan, 99);
    expect(clamped[1]).toHaveProperty("cache_control");
    expect(anthropicTools([], plan, 0)).toEqual([]);
  });

  it("moves the tail write breakpoint before a trailing synthetic instruction", () => {
    const plan = resolveCachePlan({
      id: "p",
      name: "p",
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-5",
    });
    const messages: ChatMessage[] = [
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "on it" },
      { role: "user", content: "COMPACTION INSTRUCTION" },
    ];
    const normal = toAnthropicMessages(messages, plan);
    const skip = toAnthropicMessages(messages, plan, { skipTailCacheWrite: true });

    // 正常路径：tail 断点落在最后一条（合成指令）上
    const normalTail = normal.messages.at(-1)?.content as Array<Record<string, unknown>>;
    expect(normalTail[0]).toHaveProperty("cache_control");

    // 复用前缀路径：写入点前移到指令之前的真实消息，指令不再被计费
    const skipTail = skip.messages.at(-1)?.content as Array<Record<string, unknown>>;
    expect(skipTail[0]).not.toHaveProperty("cache_control");
    expect(countCacheControl(skip.messages)).toBeGreaterThan(0);
    // 原 anchor 位置（上一条真实 user）继续承载断点：复用前缀的意义就在这
    expect((skip.messages[0].content as Array<Record<string, unknown>>)[0]).toHaveProperty(
      "cache_control",
    );
  });
});

describe("one-shot request detection", () => {
  const tool = (name: string): ToolDefinition => ({
    type: "function",
    function: { name, description: name, parameters: { type: "object", properties: {} } },
  });

  it("treats title/digest shapes as one-shot and drops every breakpoint", () => {
    const plan = resolveCachePlan({
      id: "p",
      name: "p",
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-5",
    });
    const titleMessages: ChatMessage[] = [
      { role: "system", content: "give me a title" },
      { role: "user", content: "fix the parser" },
    ];
    const digestMessages: ChatMessage[] = [
      { role: "system", content: "compress these tool outputs" },
      { role: "user", content: "#1 read_file\nlots of text" },
    ];
    expect(isOneShotRequest(titleMessages, [])).toBe(true);
    expect(isOneShotRequest(digestMessages, [])).toBe(true);
    expect(withoutCacheWrites(plan).enabled).toBe(false);
    const { system, messages } = toAnthropicMessages(titleMessages, withoutCacheWrites(plan));
    expect(countCacheControl({ system, messages })).toBe(0);
  });

  it("does not treat prefix-reuse summaries as one-shot", () => {
    const conversation: ChatMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
    ];
    // 带工具目录 → 不是一次性
    expect(isOneShotRequest(conversation, [tool("a")])).toBe(false);
    // 无工具但多轮 user → 也不是
    expect(isOneShotRequest(conversation, [])).toBe(false);
    // 有 assistant/tool 轮 → 不是
    expect(
      isOneShotRequest([{ role: "user", content: "q" }, { role: "assistant", content: "a" }], []),
    ).toBe(false);
  });
});

describe("documents serialization", () => {
  const plan = resolveCachePlan({
    id: "p",
    name: "p",
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
  });

  it("turns user documents into document blocks", () => {
    const { messages } = toAnthropicMessages(
      [
        {
          role: "user",
          content: "read this",
          documents: [{ data: "PDFDATA", mimeType: "application/pdf", name: "r.pdf" }],
        },
      ],
      plan,
    );
    const content = messages[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: "read this" });
    // 尾条断点会落在最后一个内容块上（native 画像的 tail 断点），这里只校验文档块本体
    expect(content[1]).toMatchObject({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "PDFDATA" },
      title: "r.pdf",
    });
  });

  it("keeps tool_result blocks first and appends tool documents after them", () => {
    const { messages } = toAnthropicMessages(
      [
        { role: "user", content: "look" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: "{}" } }],
        },
        {
          role: "tool",
          content: "scanned pdf",
          tool_call_id: "t1",
          name: "read_file",
          documents: [{ data: "PDFDATA", mimeType: "application/pdf", name: "scan.pdf" }],
        },
      ],
      plan,
    );
    const content = messages[2].content as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1" });
    expect(content[1]).toMatchObject({ type: "document", title: "scan.pdf" });
  });
});

describe("thinking budget wiring", () => {
  async function capturedBody(options: {
    maxTokens: number;
    reasoningEffort?: string;
    thinkingBudget?: number;
  }) {
    const fetchMock = vi.fn(async () => sseResponse([{ type: "message_stop" }]));
    vi.stubGlobal("fetch", fetchMock);
    await streamAnthropicMessages({
      url: "https://api.anthropic.com/v1/messages",
      model: "claude-sonnet-4-5",
      system: [],
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      onDelta: () => undefined,
      ...options,
    });
    return JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
  }

  it("clamps the budget so it never eats the whole output window", async () => {
    const body = await capturedBody({ maxTokens: 2048, reasoningEffort: "high" });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });

  it("sends no thinking when max_tokens is too small", async () => {
    const body = await capturedBody({ maxTokens: 1500, reasoningEffort: "high" });
    expect(body).not.toHaveProperty("thinking");
  });

  it("lets an explicit budget win over the effort level", async () => {
    const body = await capturedBody({ maxTokens: 32_000, reasoningEffort: "low", thinkingBudget: 8000 });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
  });
});

describe("streamAnthropicMessages attribution headers", () => {
  async function captureHeaders(promptCacheKey?: string) {
    const fetchMock = vi.fn(async () => sseResponse([{ type: "message_stop" }]));
    vi.stubGlobal("fetch", fetchMock);
    await streamAnthropicMessages({
      url: "https://api.anthropic.com/v1/messages",
      model: "claude-sonnet-4-5",
      promptCacheKey,
      system: [],
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      onDelta: () => undefined,
    });
    return (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
  }

  it("mirrors the cache key into x-session-id and stamps a request id", async () => {
    const headers = await captureHeaders("sess:main");
    expect(headers["x-session-id"]).toBe("sess:main");
    expect(headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("omits x-session-id when no cache key is set", async () => {
    const headers = await captureHeaders(undefined);
    expect(headers["x-session-id"]).toBeUndefined();
  });
});
