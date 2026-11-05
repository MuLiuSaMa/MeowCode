import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANTHROPIC_MIN_COMPACT_TRIGGER,
  NativeCompactionUnavailable,
  canReplayNativeCompaction,
  nativeCompactionMode,
  requestNativeCompaction,
} from "./native-compaction";
import type { ChatMessage, NativeCompactionPayload, ProviderConfig } from "./types";

type Captured = { url: string; body: Record<string, unknown> };

let server: Server | null = null;

/** 起一个临时 HTTP 服务：把请求体交回测试，按 handler 返回预设响应。 */
async function startServer(
  handler: (request: Captured, response: import("node:http").ServerResponse) => void,
): Promise<{ baseUrl: string; captured: Captured[] }> {
  const captured: Captured[] = [];
  server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const entry = { url: request.url ?? "", body };
      captured.push(entry);
      handler(entry, response);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server!.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, captured };
}

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

const anthropicProvider = (baseUrl: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: "anthropic",
  name: "Anthropic",
  baseUrl,
  model: "claude-sonnet-4-5",
  protocol: "anthropic-messages",
  contextWindow: 200_000,
  maxTokens: 8_192,
  ...overrides,
});

const responsesProvider = (baseUrl: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: "openai",
  name: "OpenAI",
  baseUrl,
  model: "gpt-5.1",
  protocol: "openai-responses",
  contextWindow: 200_000,
  maxTokens: 16_384,
  ...overrides,
});

/** 造一段足够长的历史，越过 Anthropic 的 50000 触发下限。 */
const longHistory = (): ChatMessage[] => [
  { role: "system", content: "You are MeowCode." },
  { role: "user", content: "refactor the parser carefully. ".repeat(12_000) },
  { role: "assistant", content: "working on it" },
  { role: "user", content: "continue" },
];

describe("nativeCompactionMode", () => {
  it("只在官方 Anthropic 端点启用请求内压缩", () => {
    expect(
      nativeCompactionMode(anthropicProvider("https://api.anthropic.com/v1")),
    ).toBe("anthropic-inband");
    expect(nativeCompactionMode(anthropicProvider("https://open.bigmodel.cn/api/anthropic"))).toBeNull();
  });

  it("Responses 协议走 /responses/compact 端点", () => {
    expect(nativeCompactionMode(responsesProvider("https://api.openai.com/v1"))).toBe(
      "openai-endpoint",
    );
  });

  it("chat completions 与显式关闭时返回 null", () => {
    expect(
      nativeCompactionMode({
        id: "p",
        name: "P",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-chat",
      }),
    ).toBeNull();
    expect(
      nativeCompactionMode(responsesProvider("https://api.openai.com/v1", { nativeCompaction: false })),
    ).toBeNull();
  });
});

describe("requestNativeCompaction — Anthropic", () => {
  it("下发 compact_20260112 编辑并解析 compaction 块", async () => {
    const { baseUrl, captured } = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          content: [
            { type: "text", text: "ignored" },
            { type: "compaction", content: "  Goal: refactor parser\nNext: run tests  " },
          ],
          usage: {
            input_tokens: 60_000,
            output_tokens: 200,
            cache_read_input_tokens: 40_000,
            cache_creation_input_tokens: 0,
          },
        }),
      );
    });

    const result = await requestNativeCompaction({
      provider: anthropicProvider(baseUrl, { nativeCompaction: true }),
      messages: longHistory(),
      tools: [],
    });

    expect(result.summary).toBe("Goal: refactor parser\nNext: run tests");
    expect(result.native).toBeUndefined();
    expect(result.usage).toEqual({
      inputTokens: 100_000,
      outputTokens: 200,
      cacheReadTokens: 40_000,
    });

    expect(captured).toHaveLength(1);
    const edit = (
      captured[0].body.context_management as {
        edits: Array<{ type: string; trigger: { type: string; value: number }; pause_after_compaction: boolean }>;
      }
    ).edits[0];
    expect(edit.type).toBe("compact_20260112");
    expect(edit.trigger.type).toBe("input_tokens");
    expect(edit.trigger.value).toBeGreaterThanOrEqual(ANTHROPIC_MIN_COMPACT_TRIGGER);
    expect(edit.pause_after_compaction).toBe(true);
    expect(captured[0].body.stream).toBe(false);
    expect(captured[0].body.tool_choice).toBeUndefined();
    // 一次性请求：压缩点生成后没有请求能在这个前缀上读回缓存，任何标记都是白付写入
    expect(JSON.stringify(captured[0].body)).not.toContain("cache_control");
  });

  it("输入低于服务端下限时不发请求，直接判定不可用", async () => {
    const { baseUrl, captured } = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ content: [] }));
    });
    await expect(
      requestNativeCompaction({
        provider: anthropicProvider(baseUrl),
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      }),
    ).rejects.toBeInstanceOf(NativeCompactionUnavailable);
    expect(captured).toHaveLength(0);
  });

  it("没有 compaction 块时抛不可用，交给调用方退回本地摘要", async () => {
    const { baseUrl } = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ content: [{ type: "text", text: "no compaction" }] }));
    });
    await expect(
      requestNativeCompaction({
        provider: anthropicProvider(baseUrl),
        messages: longHistory(),
        tools: [],
      }),
    ).rejects.toBeInstanceOf(NativeCompactionUnavailable);
  });

  it("服务端拒绝时带上状态码，便于运行时区分「不支持」与「网络故障」", async () => {
    const { baseUrl } = await startServer((_request, response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "context_management is not supported" } }));
    });
    await expect(
      requestNativeCompaction({
        provider: anthropicProvider(baseUrl, { nativeCompaction: true }),
        messages: longHistory(),
        tools: [],
      }),
    ).rejects.toMatchObject({ name: "NativeCompactionUnavailable", status: 400 });
  });
});

describe("requestNativeCompaction — OpenAI Responses", () => {
  it("POST /responses/compact，返回加密 item 与来源信息", async () => {
    const { baseUrl, captured } = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          object: "response.compaction",
          output: [
            { type: "compaction", id: "cmp_1", encrypted_content: "gAAAA-encrypted" },
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "keep the parser refactor on track" }],
            },
          ],
          usage: { input_tokens: 80_000, output_tokens: 500, input_tokens_details: { cached_tokens: 70_000 } },
        }),
      );
    });

    const result = await requestNativeCompaction({
      provider: responsesProvider(baseUrl),
      messages: longHistory(),
      tools: [],
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("/v1/responses/compact");
    expect(captured[0].body.stream).toBeUndefined();
    expect(captured[0].body.store).toBeUndefined();
    expect(Array.isArray(captured[0].body.input)).toBe(true);

    expect(result.summary).toBe("keep the parser refactor on track");
    // 整个 replacement window 原样回放：加密 item + 服务端保留的消息项
    expect(result.native?.items).toEqual([
      { type: "compaction", id: "cmp_1", encrypted_content: "gAAAA-encrypted" },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "keep the parser refactor on track" }],
      },
    ]);
    expect(result.native?.endpoint).toBe(baseUrl);
    expect(result.native?.model).toBe("gpt-5.1");
    expect(result.native?.protocol).toBe("openai-responses");
    expect(result.usage).toEqual({
      inputTokens: 80_000,
      outputTokens: 500,
      cacheReadTokens: 70_000,
    });
  });

  it("没有 compaction item 时抛不可用", async () => {
    const { baseUrl } = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "response.compaction", output: [] }));
    });
    await expect(
      requestNativeCompaction({
        provider: responsesProvider(baseUrl),
        messages: longHistory(),
        tools: [],
      }),
    ).rejects.toBeInstanceOf(NativeCompactionUnavailable);
  });

  it("端点不存在（404）时抛不可用，触发本地摘要回退", async () => {
    const { baseUrl } = await startServer((_request, response) => {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not found" } }));
    });
    await expect(
      requestNativeCompaction({
        provider: responsesProvider(baseUrl),
        messages: longHistory(),
        tools: [],
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("canReplayNativeCompaction", () => {
  const payload: NativeCompactionPayload = {
    providerId: "openai",
    endpoint: "https://api.openai.com/v1",
    model: "gpt-5.1",
    protocol: "openai-responses",
    items: [{ type: "compaction", encrypted_content: "x" }],
  };

  it("端点、模型、协议都一致时可回放（忽略尾部斜杠）", () => {
    expect(canReplayNativeCompaction(payload, responsesProvider("https://api.openai.com/v1/"))).toBe(
      true,
    );
  });

  it("换模型或换端点后不可回放", () => {
    expect(
      canReplayNativeCompaction(payload, responsesProvider("https://api.openai.com/v1", { model: "gpt-5.2" })),
    ).toBe(false);
    expect(canReplayNativeCompaction(payload, responsesProvider("https://gateway.example.com/v1"))).toBe(
      false,
    );
  });
});
