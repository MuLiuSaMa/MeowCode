import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRequestSnapshot } from "./request-snapshot.js";
import type { ChatMessage, ProviderConfig, ToolDefinition } from "./types";

/**
 * 模型可见请求的回归基线。
 *
 * 这里固定一个最小会话（一条 AGENTS.md + 一句用户输入），把 runtime 真实组装、
 * 经 Anthropic 序列化后的请求做成结构快照。任何提示词、工具描述、工具顺序、
 * 消息形态的改动都会让快照变红 —— 这正是「调教效果可回归」的起点。
 *
 * 快照只存长度 + sha1 + 短前缀，不存全文；需要看原文时按索引回源码取。
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
  generateSessionTitle: vi.fn().mockResolvedValue("Request snapshot"),
}));

const { AgentRuntime } = await import("./runtime.js");
const { resetGatewayCacheDegradation, resolveCachePlan } = await import("./cache-profile.js");
const { anthropicTools, toAnthropicMessages } = await import("./anthropic.js");

const provider: ProviderConfig = {
  id: "p",
  name: "P",
  protocol: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  model: "claude-sonnet-4-5",
  contextWindow: 200_000,
};

/** 其余三个画像：只用于验证「画像不改内容」。 */
const otherProfiles: ProviderConfig[] = [
  {
    id: "qwen",
    name: "Qwen",
    protocol: "anthropic-messages",
    baseUrl: "https://dashscope.aliyuncs.com/api/v2/apps/claude-code-proxy",
    model: "qwen3-max",
    contextWindow: 200_000,
  },
  {
    id: "gw",
    name: "Gateway",
    protocol: "anthropic-messages",
    baseUrl: "https://api.some-gateway.dev/v1",
    model: "glm-4.6",
    contextWindow: 200_000,
  },
  {
    id: "none",
    name: "Chat",
    protocol: "openai-chat-completions",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    contextWindow: 128_000,
  },
];

type RequestOptions = {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  toolCacheAnchor?: number;
};

function snapshotOf(caseProvider: ProviderConfig, call: RequestOptions, replacements: Array<[string, string]>) {
  const plan = resolveCachePlan(caseProvider);
  const { system, messages } = toAnthropicMessages(call.messages, plan);
  return buildRequestSnapshot({
    system,
    tools: anthropicTools(call.tools, plan, call.toolCacheAnchor),
    messages,
    replacements,
  });
}

beforeEach(() => {
  streamMock.mockReset();
  resetGatewayCacheDegradation();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("request snapshot", () => {
  it("matches the pinned first-turn request snapshot", async () => {
    const sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-snap-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-snap-ws-"));
    await writeFile(
      path.join(workspace, "AGENTS.md"),
      "Always run the tests before claiming success.\n",
    );

    const runtime = new AgentRuntime({
      providers: [provider],
      sessionsDir,
      workspace,
      homeDir: sessionsDir,
    });
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    streamMock.mockResolvedValue({ message: { role: "assistant", content: "ok" } });

    await runtime.prompt("snapshot me");

    expect(streamMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    const call = streamMock.mock.calls[0][0] as RequestOptions;
    const snapshot = snapshotOf(provider, call, [
      [sessionsDir, "<sessions>"],
      [workspace, "<workspace>"],
    ]);
    expect(snapshot).toMatchSnapshot();
  });

  it("keeps model-visible content identical across cache profiles", async () => {
    const sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-snap2-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-snap2-ws-"));
    await writeFile(path.join(workspace, "AGENTS.md"), "Keep the tree clean.\n");

    const runtime = new AgentRuntime({
      providers: [provider],
      sessionsDir,
      workspace,
      homeDir: sessionsDir,
    });
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    streamMock.mockResolvedValue({ message: { role: "assistant", content: "ok" } });
    await runtime.prompt("profile check");

    const call = streamMock.mock.calls[0][0] as RequestOptions;
    const replacements: Array<[string, string]> = [
      [sessionsDir, "<sessions>"],
      [workspace, "<workspace>"],
    ];
    const [native, ...others] = [provider, ...otherProfiles].map((caseProvider) =>
      snapshotOf(caseProvider, call, replacements),
    );

    // 画像只决定断点位置与数量；system / tools / messages 的内容摘要必须完全一致
    for (const other of others) {
      expect(other.system).toEqual(native.system);
      expect(other.tools).toEqual(native.tools);
      expect(other.messages).toEqual(native.messages);
    }
  });
});
