import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PluginRegistry } from "../plugins/registry.js";
import type { PluginTool } from "../plugins/types.js";
import type { ChatMessage, MeowEvent } from "./types.js";

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));
vi.mock("./provider.js", () => ({
  completionUrl: vi.fn(),
  streamChatCompletion: streamMock,
}));
vi.mock("./title-generator.js", () => ({
  generateSessionTitle: vi.fn().mockResolvedValue("Test title"),
}));

const { AgentRuntime } = await import("./runtime.js");

function makeTool(name: string, overrides: Partial<PluginTool> = {}): PluginTool {
  return {
    name,
    description: `plugin tool ${name}`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ output: `plugin says hi via ${name}`, ok: true }),
    ...overrides,
  };
}

type Harness = {
  runtime: InstanceType<typeof AgentRuntime>;
  events: MeowEvent[];
};

async function setup(plugins: PluginRegistry | null): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), "meowcode-rt-plugins-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-rt-ws-"));
  const runtime = new AgentRuntime({
    providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
    sessionsDir: dir,
    ...(plugins ? { plugins } : {}),
  });
  const events: MeowEvent[] = [];
  runtime.onEvent((event) => events.push(event));
  await runtime.newSession(workspace);
  runtime.setApprovalMode("full");
  return { runtime, events };
}

/** 两次模型响应：先调工具，再收尾 */
function mockToolRound(toolName: string, args: Record<string, unknown>) {
  streamMock
    .mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: toolName, arguments: JSON.stringify(args) },
          },
        ],
      },
    })
    .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });
}

beforeEach(() => {
  streamMock.mockReset();
});

describe("插件工具接入（P2）", () => {
  it("插件工具进入模型请求的 tools 列表并可执行", async () => {
    const registry = new PluginRegistry();
    const execute = vi.fn(async () => ({ output: "plugin says hi", ok: true }));
    registry.addTool("p1", makeTool("plugin_echo", { execute }));
    const { runtime } = await setup(registry);

    mockToolRound("plugin_echo", { foo: "bar" });
    await runtime.prompt("use plugin");

    const request = streamMock.mock.calls[0][0];
    const tools = request.tools as Array<{ function: { name: string } }>;
    expect(tools.map((t) => t.function.name)).toContain("plugin_echo");

    // execute 收到插件上下文；结果进入第二轮请求
    expect(execute).toHaveBeenCalledTimes(1);
    const secondMessages = streamMock.mock.calls[1][0].messages as ChatMessage[];
    expect(
      secondMessages.some(
        (m) => m.role === "tool" && m.name === "plugin_echo" && m.content.includes("plugin says hi"),
      ),
    ).toBe(true);
  });

  it("allowedTools 白名单过滤插件工具", async () => {
    const registry = new PluginRegistry();
    registry.addTool("p1", makeTool("plugin_echo"));
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-rt-plugins-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-rt-ws-"));
    const runtime = new AgentRuntime({
      providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
      sessionsDir: dir,
      plugins: registry,
      allowedTools: ["list_dir", "read_file"], // 只读子 Agent 形态
    });
    await runtime.newSession(workspace);
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "ok" } });
    await runtime.prompt("hi");
    const tools = streamMock.mock.calls[0][0].tools as Array<{ function: { name: string } }>;
    expect(tools.map((t) => t.function.name)).not.toContain("plugin_echo");
  });

  it("requiresApproval 的插件工具触发审批流", async () => {
    const registry = new PluginRegistry();
    const execute = vi.fn(async () => ({ output: "approved run", ok: true }));
    registry.addTool("p1", makeTool("plugin_gate", { execute, requiresApproval: true }));
    const { runtime, events } = await setup(registry);
    await runtime.setApprovalMode("ask"); // full 会自动放行，改用 ask 才走审批

    mockToolRound("plugin_gate", {});
    const promptPromise = runtime.prompt("use gated plugin");
    // 等审批事件出现
    await vi.waitFor(() => {
      if (!events.some((e) => e.type === "approval_required")) {
        throw new Error("no approval yet");
      }
    });
    const approval = events.find((e) => e.type === "approval_required");
    expect(approval && approval.type === "approval_required" && approval.tool).toBe("plugin_gate");
    runtime.respondToApproval("call-1", true);
    await promptPromise;

    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("生命周期 hooks（P3）", () => {
  it("tool_call block：工具不执行，原因作为工具结果", async () => {
    const registry = new PluginRegistry();
    const execute = vi.fn(async () => ({ output: "should not run", ok: true }));
    registry.addTool("p1", makeTool("plugin_danger", { execute }));
    registry.addHook("guard", "tool_call", () => ({ block: true, reason: "not today" }));
    const { runtime, events } = await setup(registry);

    mockToolRound("plugin_danger", {});
    await runtime.prompt("try it");

    expect(execute).not.toHaveBeenCalled();
    const finished = events.find((e) => e.type === "tool_finished");
    expect(finished && finished.type === "tool_finished" && finished.ok).toBe(false);
    const messages = streamMock.mock.calls[1][0].messages as ChatMessage[];
    expect(
      messages.some((m) => m.role === "tool" && m.content.includes("Tool call blocked by plugin: not today")),
    ).toBe(true);
  });

  it("tool_call input transform：execute 收到改写后的参数", async () => {
    const registry = new PluginRegistry();
    const execute = vi.fn(async (input: Record<string, unknown>) => ({
      output: `ran with ${String(input.command)}`,
      ok: true,
    }));
    registry.addTool("p1", makeTool("plugin_transform", { execute }));
    registry.addHook("mutator", "tool_call", (event) => ({
      input: { ...event.input, command: "echo safe" },
    }));
    const { runtime } = await setup(registry);

    mockToolRound("plugin_transform", { command: "rm -rf /" });
    await runtime.prompt("run it");

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ command: "echo safe" }),
      expect.anything(),
    );
  });

  it("tool_result transform：输出被改写后进入下一轮请求", async () => {
    const registry = new PluginRegistry();
    registry.addTool("p1", makeTool("plugin_loud"));
    registry.addHook("redactor", "tool_result", () => ({ output: "[redacted]" }));
    const { runtime } = await setup(registry);

    mockToolRound("plugin_loud", {});
    await runtime.prompt("go");

    const messages = streamMock.mock.calls[1][0].messages as ChatMessage[];
    const toolMessage = messages.find((m) => m.role === "tool" && m.name === "plugin_loud");
    expect(toolMessage?.content).toBe("[redacted]");
  });

  it("prompt_submit block：不调模型，assistant 消息呈现原因", async () => {
    const registry = new PluginRegistry();
    registry.addHook("guard", "prompt_submit", () => ({ block: true, reason: "banned" }));
    const { runtime, events } = await setup(registry);

    await runtime.prompt("something bad");

    expect(streamMock).not.toHaveBeenCalled();
    const complete = events.find((e) => e.type === "message_complete");
    expect(complete && complete.type === "message_complete" && complete.text).toContain(
      "Prompt blocked by plugin: banned",
    );
    // 会话落盘里有这条 assistant 消息
    const session = runtime.current!;
    expect(session.effectiveMessages.some((m) => m.role === "assistant" && m.content?.includes("banned"))).toBe(true);
  });

  it("prompt_submit text transform：模型收到改写后的文本", async () => {
    const registry = new PluginRegistry();
    registry.addHook("expander", "prompt_submit", (event) => ({ text: `${event.text} (project: alpha)` }));
    const { runtime } = await setup(registry);

    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "ok" } });
    await runtime.prompt("summarize");

    const messages = streamMock.mock.calls[0][0].messages as ChatMessage[];
    const userMessage = messages.find((m) => m.role === "user");
    expect(userMessage?.content).toBe("summarize (project: alpha)");
  });

  it("session_start / turn_start / turn_end 观察事件触发", async () => {
    const registry = new PluginRegistry();
    const sessionStart = vi.fn();
    const turnStart = vi.fn();
    const turnEnd = vi.fn();
    registry.addHook("obs", "session_start", sessionStart);
    registry.addHook("obs", "turn_start", turnStart);
    registry.addHook("obs", "turn_end", turnEnd);
    const { runtime } = await setup(registry);

    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "ok" } });
    await runtime.prompt("hi");

    expect(sessionStart).toHaveBeenCalledTimes(1);
    expect(turnStart).toHaveBeenCalledTimes(1);
    expect(turnEnd).toHaveBeenCalledTimes(1);
    const endEvent = turnEnd.mock.calls[0][0];
    expect(endEvent.status).toBe("completed");
  });

  it("无 plugins 时全部直通（缺省 null 不报错）", async () => {
    const { runtime } = await setup(null);
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "ok" } });
    await expect(runtime.prompt("plain")).resolves.toBeUndefined();
  });
});
