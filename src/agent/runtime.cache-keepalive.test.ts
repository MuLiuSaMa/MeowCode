import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, MeowEvent, ProviderConfig, TokenUsage, ToolDefinition } from "./types";

/**
 * 缓存保活（5m TTL 空档重放前缀）的调度与口径。
 *
 * 保活是「零命中率污染」的后台请求：不落盘 usage、不发事件，只为了在
 * 人类离开的 19 分钟里让服务端缓存持续热着。但它只有与主请求逐字节同前缀
 * 才有意义（cc-haha 实测参数差异能把命中率从 92.7% 打到 61%），所以这里
 * 用真实 runtime 组装请求、只 mock 传输层，断言字节与门禁。
 */

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));
vi.mock("./provider.js", () => ({
  completionUrl: vi.fn(),
  streamChatCompletion: streamMock,
  utilityProvider: (provider: Record<string, unknown>, maxTokens: number) => ({
    ...provider,
    maxTokens,
  }),
}));
vi.mock("./title-generator.js", () => ({
  generateSessionTitle: vi.fn().mockResolvedValue("Keepalive"),
}));

const { AgentRuntime } = await import("./runtime.js");

type StreamOptions = {
  provider: ProviderConfig & { maxTokens?: number; thinkingBudget?: number };
  messages: ChatMessage[];
  tools: ToolDefinition[];
  toolCacheAnchor?: number;
  onUsage?: (usage: TokenUsage) => void;
};

const KEEPALIVE_DELAY_MS = 290_000;

const anthropic: ProviderConfig = {
  id: "a",
  name: "Anthropic",
  protocol: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  model: "claude-sonnet-4-5",
  contextWindow: 200_000,
};

const qwen: ProviderConfig = {
  id: "q",
  name: "Qwen",
  protocol: "anthropic-messages",
  baseUrl: "https://dashscope.aliyuncs.com",
  model: "qwen3-coder-plus",
};

const chat: ProviderConfig = {
  id: "c",
  name: "Chat",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-5.1",
};

async function makeRuntime(provider: ProviderConfig): Promise<{
  runtime: InstanceType<typeof AgentRuntime>;
  workspace: string;
}> {
  const sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-keepalive-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-keepalive-ws-"));
  const runtime = new AgentRuntime({
    providers: [provider],
    sessionsDir,
    workspace,
    homeDir: sessionsDir,
  });
  await runtime.newSession(workspace);
  runtime.setApprovalMode("full");
  return { runtime, workspace };
}

function requests(): StreamOptions[] {
  return streamMock.mock.calls.map((call) => call[0] as StreamOptions);
}

/** 保活 ping 用 max_tokens=1 与真实回合区分。 */
function pingRequests(): StreamOptions[] {
  return requests().filter((request) => request.provider.maxTokens === 1);
}

function metaOf(runtime: InstanceType<typeof AgentRuntime>, providerId: string) {
  const map = (
    runtime as unknown as { providerRequestMeta: Map<string, { key: string; at: number }> }
  ).providerRequestMeta;
  return map.get(providerId);
}

beforeEach(() => {
  streamMock.mockReset();
  // 只伪造计时器与时钟：fs / stat 等仍走真实异步，避免测试环境卡死
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("cache keepalive", () => {
  it("replays the exact main-request prefix after the TTL window", async () => {
    const { runtime } = await makeRuntime({ ...anthropic, cacheTtl: "5m" });
    streamMock.mockResolvedValue({ message: { role: "assistant", content: "hello" } });

    await runtime.prompt("first question");
    expect(pingRequests()).toHaveLength(0);
    const main = requests()[0];

    const before = metaOf(runtime, anthropic.id);
    await vi.advanceTimersByTimeAsync(KEEPALIVE_DELAY_MS);
    const pings = pingRequests();
    expect(pings).toHaveLength(1);
    const ping = pings[0];

    // 参数只改输出预算与思考：这三个字段是保活不写坏缓存的全部前提
    expect(ping.provider.maxTokens).toBe(1);
    expect(ping.provider.thinkingBudget).toBeUndefined();
    expect(ping.provider.reasoningEffort).toBeUndefined();
    // 前缀必须与主请求逐字节一致，否则读的不是同一条缓存
    expect(JSON.stringify(ping.messages.slice(0, main.messages.length))).toBe(
      JSON.stringify(main.messages),
    );
    expect(JSON.stringify(ping.tools)).toBe(JSON.stringify(main.tools));
    expect(ping.toolCacheAnchor).toBe(main.toolCacheAnchor);

    // 成功 ping 即一次真实触缓存：空闲诊断从它起算
    const after = metaOf(runtime, anthropic.id);
    expect(after?.key).toBe(before?.key);
    expect((after?.at ?? 0) - (before?.at ?? 0)).toBeGreaterThanOrEqual(KEEPALIVE_DELAY_MS - 1000);
  });

  it("stops after four pings", async () => {
    const { runtime } = await makeRuntime({ ...anthropic, cacheTtl: "5m" });
    streamMock.mockResolvedValue({ message: { role: "assistant", content: "ok" } });

    await runtime.prompt("hello");
    for (let index = 0; index < 6; index += 1) {
      await vi.advanceTimersByTimeAsync(KEEPALIVE_DELAY_MS);
    }
    expect(pingRequests()).toHaveLength(4);
  });

  it("never pings when the protocol has no cache profile", async () => {
    const { runtime } = await makeRuntime(chat);
    streamMock.mockResolvedValue({ message: { role: "assistant", content: "ok" } });

    await runtime.prompt("hello");
    await vi.advanceTimersByTimeAsync(KEEPALIVE_DELAY_MS);
    expect(pingRequests()).toHaveLength(0);
  });

  it("never pings a 1h TTL session", async () => {
    const { runtime } = await makeRuntime({ ...anthropic, cacheTtl: "1h" });
    streamMock.mockResolvedValue({ message: { role: "assistant", content: "ok" } });

    await runtime.prompt("hello");
    await vi.advanceTimersByTimeAsync(KEEPALIVE_DELAY_MS);
    expect(pingRequests()).toHaveLength(0);
  });

  it("pings the qwen profile on its 5m TTL", async () => {
    const { runtime } = await makeRuntime(qwen);
    streamMock.mockResolvedValue({ message: { role: "assistant", content: "ok" } });

    await runtime.prompt("hello");
    await vi.advanceTimersByTimeAsync(KEEPALIVE_DELAY_MS);
    expect(pingRequests()).toHaveLength(1);
  });

  it("restarts the idle window on a new prompt", async () => {
    const { runtime } = await makeRuntime({ ...anthropic, cacheTtl: "5m" });
    streamMock.mockResolvedValue({ message: { role: "assistant", content: "ok" } });

    await runtime.prompt("first");
    await vi.advanceTimersByTimeAsync(100_000);
    await runtime.prompt("second");
    // 相对第一条已过 300s，但相对第二条只有 200s：旧计划必须已被取消
    await vi.advanceTimersByTimeAsync(200_000);
    expect(pingRequests()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(pingRequests()).toHaveLength(1);
  });

  it("cancels the pending ping when the session changes", async () => {
    const { runtime, workspace } = await makeRuntime({ ...anthropic, cacheTtl: "5m" });
    streamMock.mockResolvedValue({ message: { role: "assistant", content: "ok" } });

    await runtime.prompt("hello");
    await runtime.newSession(workspace);
    await vi.advanceTimersByTimeAsync(KEEPALIVE_DELAY_MS);
    expect(pingRequests()).toHaveLength(0);
  });

  it("logs keepalive usage without broadcasting or persisting it", async () => {
    const { runtime } = await makeRuntime({ ...anthropic, cacheTtl: "5m" });
    streamMock.mockResolvedValue({ message: { role: "assistant", content: "ok" } });
    const events: MeowEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runtime.prompt("hello");
    await vi.advanceTimersByTimeAsync(KEEPALIVE_DELAY_MS);
    const ping = pingRequests()[0];
    expect(ping.onUsage).toBeTypeOf("function");

    const seen = events.length;
    ping.onUsage?.({
      inputTokens: 5_000,
      outputTokens: 1,
      cacheReadTokens: 4_800,
      cacheWriteTokens: 0,
    });

    // 命中率口径保持干净：只打诊断日志，不发未落盘的 usage 事件
    expect(events.slice(seen).some((event) => event.type === "usage")).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("cache keepalive: read=4800 write=0 input=5000"),
    );
  });
});
