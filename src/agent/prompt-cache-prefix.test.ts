import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ProviderConfig, ToolDefinition } from "./types";

/**
 * 缓存前缀的字节级契约（参考 metis 的 prompt-cache-prefix 回归测试）。
 *
 * 前缀缓存命中与否只看「请求体的字节前缀是否与上次相同」，任何一处
 * 悄悄变化的描述、顺序或系统消息都会让整段历史按全价重算。
 * 这里从 runtime 组装的请求出发，走真实的 Anthropic 序列化，
 * 断言连续两回合的 tools / system 逐字节相同、messages 互为字面前缀。
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
  generateSessionTitle: vi.fn().mockResolvedValue("Cache prefix"),
}));

const { AgentRuntime } = await import("./runtime.js");
const { resolveCachePlan } = await import("./cache-profile.js");
const { anthropicTools, toAnthropicMessages } = await import("./anthropic.js");
const { trimMessages } = await import("./context.js");
const { registerDynamicTool, unregisterDynamicTool } = await import("./tools.js");

const provider: ProviderConfig = {
  id: "p",
  name: "P",
  protocol: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  model: "claude-sonnet-4-5",
  contextWindow: 200_000,
};

type RequestOptions = {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  toolCacheAnchor?: number;
};

function mcpTool(name: string, description = `${name} description`): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties: {} },
    },
  };
}

/** 递归剥离 cache_control：尾断点按设计会随对话推进而移动。 */
function stripCacheControl<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => stripCacheControl(item)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === "cache_control") continue;
      out[key] = stripCacheControl(item);
    }
    return out as T;
  }
  return value;
}

function serialize(options: RequestOptions) {
  const plan = resolveCachePlan(provider);
  const { system, messages } = toAnthropicMessages(options.messages, plan);
  return {
    plan,
    tools: anthropicTools(options.tools, plan, options.toolCacheAnchor),
    system,
    messages,
  };
}

beforeEach(() => {
  streamMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("prompt cache prefix", () => {
  it("keeps tools, system and history byte-identical across turns", async () => {
    const sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-cache-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-cache-ws-"));
    await writeFile(path.join(workspace, "AGENTS.md"), "Always run the tests before claiming success.\n");

    const runtime = new AgentRuntime({
      providers: [provider],
      sessionsDir,
      workspace,
      homeDir: sessionsDir,
    });
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    streamMock
      .mockResolvedValueOnce({ message: { role: "assistant", content: "first" } })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "second" } });

    await runtime.prompt("first question");
    await runtime.prompt("second question");

    expect(streamMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    const first = serialize(streamMock.mock.calls[0][0] as RequestOptions);
    const second = serialize(streamMock.mock.calls[1][0] as RequestOptions);

    // 工具目录：内容与顺序都必须逐字节一致，否则 tools 断点整段失效
    expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
    // 系统提示：含 cache_control 位置在内完全一致
    expect(JSON.stringify(second.system)).toBe(JSON.stringify(first.system));

    // 历史必须以上一回合为字面前缀（剥掉会移动的尾断点）
    const firstHistory = stripCacheControl(first.messages);
    const secondHistory = stripCacheControl(second.messages);
    expect(secondHistory.length).toBeGreaterThan(firstHistory.length);
    expect(JSON.stringify(secondHistory.slice(0, firstHistory.length))).toBe(
      JSON.stringify(firstHistory),
    );
  });

  it("keeps a single-turn tool loop append-only under a large window", () => {
    const plan = resolveCachePlan(provider);
    const messages: ChatMessage[] = [
      { role: "system", content: "base" },
      { role: "system", content: "instructions" },
      { role: "user", content: "do it" },
    ];
    let previous: Array<Record<string, unknown>> | null = null;
    for (let round = 0; round < 8; round += 1) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          { id: `call-${round}`, type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      });
      messages.push({
        role: "tool",
        content: "x".repeat(6_000),
        tool_call_id: `call-${round}`,
        name: "read_file",
      });
      // 大窗口下请求期不得改写历史：每次请求都是上一次的字面前缀
      const trimmed = trimMessages(messages, 200_000, 4_096);
      const { messages: serialized } = toAnthropicMessages(trimmed, plan);
      const history = stripCacheControl(serialized);
      if (previous) {
        expect(JSON.stringify(history.slice(0, previous.length))).toBe(JSON.stringify(previous));
      }
      previous = history;
    }
  });

  it("keeps the same tool bytes after a second session in the same workspace", async () => {
    const sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-cache2-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-cache2-ws-"));
    const runtime = new AgentRuntime({
      providers: [provider],
      sessionsDir,
      workspace,
      homeDir: sessionsDir,
    });
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    streamMock.mockResolvedValue({ message: { role: "assistant", content: "ok" } });

    await runtime.prompt("hello");
    await runtime.newSession(workspace);
    await runtime.prompt("hello again");

    const bodies = streamMock.mock.calls.map((call) => serialize(call[0] as RequestOptions));
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(bodies.at(-1)!.tools)).toBe(JSON.stringify(bodies[0].tools));
    expect(JSON.stringify(bodies.at(-1)!.system)).toBe(JSON.stringify(bodies[0].system));
  });

  it("keeps the old tool breakpoint when an MCP tool is appended mid-session", async () => {
    const sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-cache3-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-cache3-ws-"));
    const runtime = new AgentRuntime({ providers: [provider], sessionsDir, workspace, homeDir: sessionsDir });
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    streamMock.mockResolvedValue({ message: { role: "assistant", content: "ok" } });

    await runtime.prompt("first");
    const extra = mcpTool("mcp__demo__extra");
    expect(registerDynamicTool(extra.function.name, {
      definition: extra,
      execute: async () => ({ ok: true, output: "ok" }),
    }).ok).toBe(true);
    try {
      await runtime.prompt("second");
    } finally {
      unregisterDynamicTool(extra.function.name);
    }

    const first = serialize(streamMock.mock.calls[0][0] as RequestOptions);
    const second = serialize(streamMock.mock.calls[1][0] as RequestOptions);
    expect(second.tools.length).toBeGreaterThan(first.tools.length);
    // 旧快照（含锚点上的 cache_control）必须逐字节保留
    expect(JSON.stringify(second.tools.slice(0, first.tools.length))).toBe(
      JSON.stringify(first.tools),
    );
    expect((second.tools.at(-1) as Record<string, unknown>).cache_control).toBeUndefined();
  });

  it("keeps tool bytes when an MCP tool disappears, and drops it at the next session", async () => {
    const sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-cache4-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-cache4-ws-"));
    const runtime = new AgentRuntime({ providers: [provider], sessionsDir, workspace, homeDir: sessionsDir });
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    streamMock.mockResolvedValue({ message: { role: "assistant", content: "ok" } });

    const gone = mcpTool("mcp__demo__gone");
    expect(registerDynamicTool(gone.function.name, {
      definition: gone,
      execute: async () => ({ ok: true, output: "ok" }),
    }).ok).toBe(true);
    try {
      await runtime.prompt("first");
      unregisterDynamicTool(gone.function.name);
      await runtime.prompt("second");

      const first = serialize(streamMock.mock.calls[0][0] as RequestOptions);
      const second = serialize(streamMock.mock.calls[1][0] as RequestOptions);
      // 删除延后：会话内工具块字节完全不变
      expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));

      // 新会话是缓存安全边界：延后的删除真正生效
      await runtime.newSession(workspace);
      await runtime.prompt("third");
      const third = serialize(streamMock.mock.calls[2][0] as RequestOptions);
      expect(third.tools.map((tool) => tool.name)).not.toContain(gone.function.name);
    } finally {
      unregisterDynamicTool(gone.function.name);
    }
  });

  it("applies deferred removals on an explicit catalog rebuild", async () => {
    const sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-cache5-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-cache5-ws-"));
    const runtime = new AgentRuntime({ providers: [provider], sessionsDir, workspace, homeDir: sessionsDir });
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    streamMock.mockResolvedValue({ message: { role: "assistant", content: "ok" } });

    const gone = mcpTool("mcp__demo__rebuild");
    expect(registerDynamicTool(gone.function.name, {
      definition: gone,
      execute: async () => ({ ok: true, output: "ok" }),
    }).ok).toBe(true);
    try {
      await runtime.prompt("first");
      unregisterDynamicTool(gone.function.name);
      runtime.rebuildToolCatalog("compaction");
      await runtime.prompt("second");
      const second = serialize(streamMock.mock.calls[1][0] as RequestOptions);
      expect(second.tools.map((tool) => tool.name)).not.toContain(gone.function.name);
    } finally {
      unregisterDynamicTool(gone.function.name);
    }
  });

  it("applies profile tool whitelists immediately", async () => {
    const sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-cache6-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-cache6-ws-"));
    const runtime = new AgentRuntime({ providers: [provider], sessionsDir, workspace, homeDir: sessionsDir });
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    streamMock.mockResolvedValue({ message: { role: "assistant", content: "ok" } });

    await runtime.prompt("first");
    await runtime.setAgentProfile("minimal");
    await runtime.prompt("second");

    const second = serialize(streamMock.mock.calls[1][0] as RequestOptions);
    const names = second.tools.map((tool) => tool.name);
    expect(names).toContain("read_file");
    expect(names).toContain("run_command");
    expect(names).not.toContain("write_file");
  });
});
