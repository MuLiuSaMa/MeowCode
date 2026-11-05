import { describe, expect, it, vi } from "vitest";
import { PluginRegistry } from "./registry.js";
import { runHook } from "./hooks.js";
import type { ToolCallHookEvent } from "./types.js";

function toolCallEvent(overrides: Partial<ToolCallHookEvent> = {}): ToolCallHookEvent {
  return {
    hook: "tool_call",
    sessionId: "s1",
    callId: "c1",
    tool: "run_command",
    input: { command: "echo hi" },
    ...overrides,
  };
}

describe("runHook 直通", () => {
  it("registry 为空或无 handler 时返回 undefined", async () => {
    expect(await runHook(null, "tool_call", toolCallEvent())).toBeUndefined();
    expect(await runHook(undefined, "tool_call", toolCallEvent())).toBeUndefined();
    const empty = new PluginRegistry();
    expect(await runHook(empty, "tool_call", toolCallEvent())).toBeUndefined();
  });
});

describe("tool_call hook", () => {
  it("input 链式 transform：后者看到前者改过的值，返回合并结果", async () => {
    const registry = new PluginRegistry();
    const seen: unknown[] = [];
    registry.addHook("p1", "tool_call", (event) => {
      seen.push(event.input);
      return { input: { command: "echo transformed" } };
    });
    registry.addHook("p2", "tool_call", (event) => {
      seen.push(event.input);
      return { input: { ...event.input, extra: true } };
    });

    const result = await runHook(registry, "tool_call", toolCallEvent());

    expect(seen).toEqual([
      { command: "echo hi" },
      { command: "echo transformed" },
    ]);
    expect(result).toEqual({ input: { command: "echo transformed", extra: true } });
  });

  it("block 短路：后续 handler 不再执行", async () => {
    const registry = new PluginRegistry();
    const after = vi.fn();
    registry.addHook("p1", "tool_call", () => ({ block: true, reason: "not allowed" }));
    registry.addHook("p2", "tool_call", after);

    const result = await runHook(registry, "tool_call", toolCallEvent());

    expect(result).toEqual({ block: true, reason: "not allowed" });
    expect(after).not.toHaveBeenCalled();
  });

  it("block 无 reason 时返回 { block: true }", async () => {
    const registry = new PluginRegistry();
    registry.addHook("p1", "tool_call", () => ({ block: true }));
    expect(await runHook(registry, "tool_call", toolCallEvent())).toEqual({ block: true });
  });
});

describe("tool_result / prompt_submit hook", () => {
  it("output/ok 可改写并链式累积", async () => {
    const registry = new PluginRegistry();
    registry.addHook("p1", "tool_result", () => ({ output: "first" }));
    registry.addHook("p2", "tool_result", (event) => ({ output: `${event.output}+second`, ok: false }));

    const result = await runHook(registry, "tool_result", {
      hook: "tool_result",
      sessionId: "s1",
      callId: "c1",
      tool: "run_command",
      input: { command: "echo hi" },
      output: "raw",
      ok: true,
    });

    expect(result).toEqual({ output: "first+second", ok: false });
  });

  it("prompt_submit text 链式改写", async () => {
    const registry = new PluginRegistry();
    registry.addHook("p1", "prompt_submit", (event) => ({ text: `${event.text} [p1]` }));
    registry.addHook("p2", "prompt_submit", (event) => ({ text: `${event.text} [p2]` }));

    const result = await runHook(registry, "prompt_submit", {
      hook: "prompt_submit",
      sessionId: "s1",
      text: "hello",
    });

    expect(result).toEqual({ text: "hello [p1] [p2]" });
  });

  it("prompt_submit block 短路", async () => {
    const registry = new PluginRegistry();
    registry.addHook("p1", "prompt_submit", () => ({ block: true, reason: "banned word" }));
    const result = await runHook(registry, "prompt_submit", {
      hook: "prompt_submit",
      sessionId: "s1",
      text: "hello",
    });
    expect(result).toEqual({ block: true, reason: "banned word" });
  });
});

describe("permission_request hook", () => {
  const event = {
    hook: "permission_request" as const,
    sessionId: "s1",
    callId: "c1",
    tool: "run_command",
    input: { command: "ls" },
  };

  it("allow 记录，后续 deny 立即短路并优先", async () => {
    const registry = new PluginRegistry();
    const after = vi.fn();
    registry.addHook("p1", "permission_request", () => ({ permission: "allow" }));
    registry.addHook("p2", "permission_request", () => ({ permission: "deny", reason: "no" }));
    registry.addHook("p3", "permission_request", after);

    const result = await runHook(registry, "permission_request", event);
    expect(result).toEqual({ permission: "deny", reason: "no" });
    expect(after).not.toHaveBeenCalled();
  });

  it("block 归一为 deny", async () => {
    const registry = new PluginRegistry();
    registry.addHook("p1", "permission_request", () => ({ block: true, reason: "blocked" }));
    expect(await runHook(registry, "permission_request", event)).toEqual({
      permission: "deny",
      reason: "blocked",
    });
  });

  it("第二参数透传 context", async () => {
    const registry = new PluginRegistry();
    const requestApproval = vi.fn(async () => true);
    registry.addHook("p1", "permission_request", (_event, context) => {
      expect(context?.requestApproval).toBe(requestApproval);
      return { permission: "allow" };
    });
    await runHook(registry, "permission_request", event, { requestApproval });
  });
});

describe("tool_call permission 折叠", () => {
  it("ask 优先于 allow，deny 归一为 block", async () => {
    const registry = new PluginRegistry();
    registry.addHook("p1", "tool_call", () => ({ permission: "allow" }));
    registry.addHook("p2", "tool_call", () => ({ permission: "ask", reason: "confirm" }));
    expect(await runHook(registry, "tool_call", toolCallEvent())).toEqual({
      permission: "ask",
      reason: "confirm",
    });

    const deny = new PluginRegistry();
    deny.addHook("p1", "tool_call", () => ({ permission: "deny", reason: "no" }));
    expect(await runHook(deny, "tool_call", toolCallEvent())).toEqual({
      block: true,
      reason: "no",
    });
  });
});

describe("失败降级", () => {
  it("handler 抛错视为空结果，后续 handler 继续执行", async () => {
    const registry = new PluginRegistry();
    const good = vi.fn(() => ({ input: { command: "safe" } }));
    registry.addHook("bad", "tool_call", () => {
      throw new Error("plugin bug");
    });
    registry.addHook("good", "tool_call", good);

    const report = vi.spyOn(registry, "reportHandlerError").mockImplementation(() => undefined);
    const result = await runHook(registry, "tool_call", toolCallEvent());

    expect(result).toEqual({ input: { command: "safe" } });
    expect(good).toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith("bad", "tool_call", expect.any(Error));
    report.mockRestore();
  });

  it("reportHandlerError 走 console.error", () => {
    const registry = new PluginRegistry();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    registry.reportHandlerError("p1", "tool_call", new Error("boom"));
    expect(spy).toHaveBeenCalledWith('[plugin:p1] hook "tool_call" handler failed:', "boom");
    spy.mockRestore();
  });
});

describe("观察类 hook", () => {
  it("turn_start/turn_end/session_start 全部执行且返回 undefined", async () => {
    const registry = new PluginRegistry();
    const a = vi.fn();
    const b = vi.fn();
    registry.addHook("pa", "turn_end", a);
    registry.addHook("pb", "turn_end", b);

    const result = await runHook(registry, "turn_end", {
      hook: "turn_end",
      sessionId: "s1",
      turnId: "t1",
      status: "completed",
    });

    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});

describe("hook 超时", () => {
  it("handler 卡住时按「无结果」放行，并记录错误", async () => {
    const registry = new PluginRegistry();
    const spy = vi.spyOn(registry, "reportHandlerError").mockImplementation(() => undefined);
    registry.addHook("slow", "tool_call", () => new Promise(() => undefined));

    const result = await runHook(registry, "tool_call", toolCallEvent(), undefined, {
      timeoutMs: 20,
    });

    expect(result).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[2])).toContain("timed out");
  });

  it("超时的 handler 不会误阻断后面的 handler", async () => {
    const registry = new PluginRegistry();
    vi.spyOn(registry, "reportHandlerError").mockImplementation(() => undefined);
    registry.addHook("slow", "tool_call", () => new Promise(() => undefined));
    registry.addHook("fast", "tool_call", () => ({ block: true, reason: "denied later" }));

    const result = await runHook(registry, "tool_call", toolCallEvent(), undefined, {
      timeoutMs: 20,
    });

    expect(result).toEqual({ block: true, reason: "denied later" });
  });
});

describe("context_inject hook", () => {
  const injectEvent = {
    hook: "context_inject" as const,
    sessionId: "s1",
    turnId: "t1",
    text: "帮我改一下 auth",
    phase: "turn_start" as const,
  };

  it("多个 handler 的 notes 累积，空白条目被丢弃", async () => {
    const registry = new PluginRegistry();
    registry.addHook("p1", "context_inject", () => ({ notes: ["记得跑测试"] }));
    registry.addHook("p2", "context_inject", () => ({ notes: ["   ", "cache 相关要小心"] }));

    const result = await runHook(registry, "context_inject", injectEvent);

    expect(result).toEqual({ notes: ["记得跑测试", "cache 相关要小心"] });
  });

  it("没有 notes 时返回 undefined", async () => {
    const registry = new PluginRegistry();
    registry.addHook("p1", "context_inject", () => ({ notes: [] }));
    expect(await runHook(registry, "context_inject", injectEvent)).toBeUndefined();
  });
});

describe("before_provider_request hook", () => {
  const baseEvent = () => ({
    hook: "before_provider_request" as const,
    sessionId: "s1",
    providerId: "p1",
    model: "m1",
    protocol: "openai-chat-completions",
    messages: [{ role: "user" as const, content: "hi" }],
    toolNames: ["read_file"],
  });

  it("messages 链式改写：后一个 handler 看到前者改后的消息", async () => {
    const registry = new PluginRegistry();
    const seen: string[] = [];
    registry.addHook("p1", "before_provider_request", (event) => {
      seen.push(String(event.messages[0]?.content));
      return { messages: [{ role: "user", content: "hi from p1" }] };
    });
    registry.addHook("p2", "before_provider_request", (event) => {
      seen.push(String(event.messages[0]?.content));
      return { extraBody: { temperature: 0 } };
    });

    const result = await runHook(registry, "before_provider_request", baseEvent());

    expect(seen).toEqual(["hi", "hi from p1"]);
    expect(result).toMatchObject({
      messages: [{ role: "user", content: "hi from p1" }],
      extraBody: { temperature: 0 },
    });
  });

  it("extraBody 在多个 handler 之间合并而不是覆盖", async () => {
    const registry = new PluginRegistry();
    registry.addHook("p1", "before_provider_request", () => ({ extraBody: { temperature: 0 } }));
    registry.addHook("p2", "before_provider_request", () => ({ extraBody: { top_p: 0.5 } }));

    const result = await runHook(registry, "before_provider_request", baseEvent());

    expect(result).toEqual({ extraBody: { temperature: 0, top_p: 0.5 } });
  });
});
