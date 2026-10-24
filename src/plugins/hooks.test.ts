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
