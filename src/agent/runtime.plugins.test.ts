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

  it("tool_call input transform 非法时拒绝执行（重校验）", async () => {
    const registry = new PluginRegistry();
    registry.addHook("broken", "tool_call", () => ({ input: {} }));
    const { runtime } = await setup(registry);

    mockToolRound("run_command", { command: "echo hi" });
    await runtime.prompt("run it");

    const messages = streamMock.mock.calls[1][0].messages as ChatMessage[];
    expect(
      messages.some(
        (m) =>
          m.role === "tool" &&
          m.content.includes("Tool call rejected (invalid_arguments)") &&
          m.content.includes("hook rewrote the arguments"),
      ),
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

  it("tool_call ask：full 模式也强制审批，hookReason 进入事件", async () => {
    const registry = new PluginRegistry();
    const execute = vi.fn(async () => ({ output: "ran", ok: true }));
    registry.addTool("p1", makeTool("plugin_ask", { execute }));
    registry.addHook("ask", "tool_call", () => ({ permission: "ask", reason: "confirm this" }));
    const { runtime, events } = await setup(registry); // full

    mockToolRound("plugin_ask", {});
    const promptPromise = runtime.prompt("go");
    await vi.waitFor(() => {
      if (!events.some((e) => e.type === "approval_required" && e.tool === "plugin_ask")) {
        throw new Error("no approval yet");
      }
    });
    const approval = events.find(
      (e) => e.type === "approval_required" && e.tool === "plugin_ask",
    );
    expect(
      approval && approval.type === "approval_required" ? approval.hookReason : undefined,
    ).toBe("confirm this");
    runtime.respondToApproval("call-1", true);
    await promptPromise;

    expect(execute).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === "approval_resolved" && e.by === "user")).toBe(true);
  });

  it("tool_call allow 不预批准：仍走人工审批", async () => {
    const registry = new PluginRegistry();
    const execute = vi.fn(async () => ({ output: "ran", ok: true }));
    registry.addTool("p1", makeTool("plugin_allow", { execute, requiresApproval: true }));
    registry.addHook("allow", "tool_call", () => ({ permission: "allow" }));
    const { runtime, events } = await setup(registry);
    await runtime.setApprovalMode("ask");

    mockToolRound("plugin_allow", {});
    const promptPromise = runtime.prompt("go");
    await vi.waitFor(() => {
      if (!events.some((e) => e.type === "approval_required" && e.tool === "plugin_allow")) {
        throw new Error("no approval yet");
      }
    });
    runtime.respondToApproval("call-1", true);
    await promptPromise;
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("PermissionRequest allow 自动应答审批，无需用户操作", async () => {
    const registry = new PluginRegistry();
    const execute = vi.fn(async () => ({ output: "ran", ok: true }));
    registry.addTool("p1", makeTool("plugin_perm_allow", { execute, requiresApproval: true }));
    registry.addHook("perm", "permission_request", () => ({ permission: "allow" }));
    const { runtime, events } = await setup(registry);
    await runtime.setApprovalMode("ask");

    mockToolRound("plugin_perm_allow", {});
    await runtime.prompt("go");

    expect(execute).toHaveBeenCalledTimes(1);
    const resolved = events.find((e) => e.type === "approval_resolved");
    expect(resolved && resolved.type === "approval_resolved" && resolved.by).toBe("hook");
    expect(resolved && resolved.type === "approval_resolved" && resolved.approved).toBe(true);
  });

  it("PermissionRequest deny 自动拒绝，工具不执行", async () => {
    const registry = new PluginRegistry();
    const execute = vi.fn(async () => ({ output: "should not run", ok: true }));
    registry.addTool("p1", makeTool("plugin_perm_deny", { execute, requiresApproval: true }));
    registry.addHook("perm", "permission_request", () => ({
      permission: "deny",
      reason: "not this one",
    }));
    const { runtime, events } = await setup(registry);
    await runtime.setApprovalMode("ask");

    mockToolRound("plugin_perm_deny", {});
    await runtime.prompt("go");

    expect(execute).not.toHaveBeenCalled();
    const resolved = events.find((e) => e.type === "approval_resolved");
    expect(resolved && resolved.type === "approval_resolved" && resolved.approved).toBe(false);
    const messages = streamMock.mock.calls[1][0].messages as ChatMessage[];
    expect(
      messages.some(
        (m) =>
          m.role === "tool" && m.content.includes("Permission denied by hook: not this one"),
      ),
    ).toBe(true);
  });

  it("只读批处理同样经过 tool_call ask 审批", async () => {
    const registry = new PluginRegistry();
    registry.addHook("ask-read", "tool_call", (event) =>
      event.tool === "list_dir"
        ? { permission: "ask" as const, reason: "check listing" }
        : undefined,
    );
    const { runtime, events } = await setup(registry); // full
    mockToolRound("list_dir", {});
    const promptPromise = runtime.prompt("list");
    await vi.waitFor(() => {
      if (!events.some((e) => e.type === "approval_required" && e.tool === "list_dir")) {
        throw new Error("no read-only approval yet");
      }
    });
    runtime.respondToApproval("call-1", true);
    await promptPromise;
    expect(events.some((e) => e.type === "tool_finished" && e.callId === "call-1")).toBe(true);
  });

  it("无 plugins 时全部直通（缺省 null 不报错）", async () => {
    const { runtime } = await setup(null);
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "ok" } });
    await expect(runtime.prompt("plain")).resolves.toBeUndefined();
  });
});

describe("工具执行事件（对应新增的 tool_execution_*）", () => {
  it("被 tool_call block 的调用不会触发 tool_execution_start", async () => {
    const registry = new PluginRegistry();
    const calls: string[] = [];
    registry.addHook("p1", "tool_call", () => {
      calls.push("tool_call");
      return { block: true, reason: "not allowed" };
    });
    registry.addHook("p1", "tool_execution_start", () => {
      calls.push("tool_execution_start");
    });
    registry.addHook("p1", "tool_execution_end", () => {
      calls.push("tool_execution_end");
    });
    const { runtime } = await setup(registry);

    mockToolRound("write_file", { path: "a.txt", content: "x" });
    await runtime.prompt("写个文件");

    // 给 fire-and-forget 的观察类 hook 一点时间；真被拦下时不会有任何执行事件
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual(["tool_call"]);
  });

  it("真正执行的调用两个执行事件都触发", async () => {
    const registry = new PluginRegistry();
    const calls: string[] = [];
    registry.addHook("p1", "tool_call", () => {
      calls.push("tool_call");
    });
    registry.addHook("p1", "tool_execution_start", () => {
      calls.push("tool_execution_start");
    });
    registry.addHook("p1", "tool_execution_end", () => {
      calls.push("tool_execution_end");
    });
    registry.addTool("p1", makeTool("plugin_echo"));
    const { runtime } = await setup(registry);

    mockToolRound("plugin_echo", { foo: "bar" });
    await runtime.prompt("调一下插件工具");
    await vi.waitFor(() => expect(calls).toContain("tool_execution_end"), { timeout: 2000 });

    expect(calls).toContain("tool_call");
    expect(calls).toContain("tool_execution_start");
    expect(calls.indexOf("tool_execution_start")).toBeLessThan(calls.indexOf("tool_execution_end"));
  });
});

describe("context_inject（对应新增的 context_inject）", () => {
  it("注入内容进历史尾部而不是系统提示", async () => {
    const registry = new PluginRegistry();
    registry.addHook("p1", "context_inject", () => ({ notes: ["PLUGIN_INJECTED_NOTE"] }));
    const { runtime } = await setup(registry);

    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "ok" } });
    await runtime.prompt("hello");

    const request = streamMock.mock.calls[0]?.[0] as { messages: ChatMessage[] } | undefined;
    const messages = request?.messages ?? [];
    // 系统提示（第一条）不能被污染：否则请求前缀变化、缓存整段作废
    expect(String(messages[0]?.content)).not.toContain("PLUGIN_INJECTED_NOTE");
    // 但内容必须出现在历史里（context_note 会以 user 消息参与请求）
    const carrier = messages.filter((message) => String(message.content ?? "").includes("PLUGIN_INJECTED_NOTE"));
    expect(carrier).toHaveLength(1);
    expect(messages.indexOf(carrier[0]!)).toBeGreaterThan(0);
  });
});
