import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "./types";

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));
vi.mock("./provider.js", () => ({
  completionUrl: vi.fn(),
  streamChatCompletion: streamMock,
  utilityProvider: (provider: Record<string, unknown>, maxTokens: number) => ({
    ...provider,
    maxTokens,
    reasoningEffort: undefined,
  }),
}));
vi.mock("./title-generator.js", () => ({
  generateSessionTitle: vi.fn().mockResolvedValue("Test title"),
}));

const { AgentRuntime } = await import("./runtime.js");

function makeRuntime(dir: string, options: Record<string, unknown> = {}) {
  return new AgentRuntime({
    providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
    sessionsDir: dir,
    homeDir: dir,
    ...options,
  });
}

function taskCall(id: string, args: Record<string, unknown>) {
  return {
    message: {
      role: "assistant" as const,
      content: null,
      tool_calls: [
        {
          id,
          type: "function" as const,
          function: { name: "task", arguments: JSON.stringify(args) },
        },
      ],
    },
  };
}

function messagesOf(callIndex: number): ChatMessage[] {
  return (streamMock.mock.calls[callIndex][0] as { messages: ChatMessage[] }).messages;
}

beforeEach(() => {
  streamMock.mockReset();
});

describe("subagent modes", () => {
  it("fork 子会话继承父历史前缀", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-fork-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(dir);

    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "root answer" } });
    await runtime.prompt("root question");

    streamMock
      .mockResolvedValueOnce(
        taskCall("t1", { mode: "fork", description: "child", prompt: "do child work" }),
      )
      .mockResolvedValueOnce({ message: { role: "assistant", content: "child done" } })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "parent done" } });
    await runtime.prompt("fork it");

    // 找到子 Agent 的请求（含 child 指令），父历史必须在其中
    const childIndex = streamMock.mock.calls.findIndex((call) =>
      JSON.stringify((call[0] as { messages: ChatMessage[] }).messages).includes("do child work"),
    );
    expect(childIndex).toBeGreaterThanOrEqual(0);
    const childMessages = JSON.stringify(messagesOf(childIndex));
    expect(childMessages).toContain("root question");
    expect(childMessages).toContain("root answer");
  });

  it("嵌套深度用尽时拒绝 task，并给出明确原因", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-depth-"));
    const runtime = makeRuntime(dir, { enableTaskTool: false, subagentDepth: 2 });
    await runtime.newSession(dir);

    streamMock
      .mockResolvedValueOnce(taskCall("t1", { description: "nested" }))
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });
    await runtime.prompt("go");

    const serialized = JSON.stringify(messagesOf(1));
    expect(serialized).toContain("nesting depth reached");
  });
});
