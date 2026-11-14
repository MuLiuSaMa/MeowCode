import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 工具调用被拒后的同 turn 自纠路径。
 *
 * 让模型返回坏参数，断言下一次请求里拿到的是
 * 「类别 + 工具名 + 原因 + 收到的参数 + 修法」的结构化反馈，而不是一句
 * `Tool call rejected: ...`、`Unknown tool: ...`，或者更糟的静默执行。
 *
 * 两条执行路径都要覆盖：
 * - 只读批（read_file 等）走 executeReadOnlyToolCall，参数解析失败曾被吞成 {}，
 *   工具于是带 undefined 参数执行，回给模型的是一句无从纠正的 "undefined not found."
 * - 串行路径（write_file 等）走 executeToolCall
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
  generateSessionTitle: vi.fn().mockResolvedValue("Tool feedback"),
}));

const { AgentRuntime } = await import("./runtime.js");

beforeEach(() => {
  streamMock.mockReset();
});

/** 跑一个只有一次工具调用的回合，返回第二请求里第一条 tool 消息的内容。 */
async function firstToolResultContent(
  toolName: string,
  rawArguments: string,
): Promise<{ content: string; requestCount: number }> {
  const sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-feedback-"));
  const runtime = new AgentRuntime({
    providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
    sessionsDir,
    homeDir: sessionsDir,
  });
  await runtime.newSession(sessionsDir);
  runtime.setApprovalMode("full");

  streamMock
    .mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: toolName, arguments: rawArguments },
          },
        ],
      },
    })
    .mockResolvedValueOnce({ message: { role: "assistant", content: "fixed" } });

  await runtime.prompt("go");

  expect(streamMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  const secondRequest = streamMock.mock.calls[1][0] as {
    messages: Array<{ role: string; content: string | null }>;
  };
  const toolMessage = secondRequest.messages.find((message) => message.role === "tool");
  expect(toolMessage).toBeDefined();
  return { content: toolMessage!.content ?? "", requestCount: streamMock.mock.calls.length };
}

describe("tool rejection feedback", () => {
  it("keeps the read-only path from executing on malformed arguments", async () => {
    const { content } = await firstToolResultContent("read_file", '{"path": "a.ts",');

    // 回归点：这条路径曾经把解析失败吞成 {}，回一句 "undefined not found."
    expect(content).not.toContain("undefined not found.");
    expect(content).toContain("Tool call rejected (invalid_arguments).");
    expect(content).toContain("Tool: read_file");
    expect(content).toContain("not valid JSON");
    expect(content).toContain("Arguments received:");
    expect(content).toContain("Fix: send one JSON object");
    // 坏参数的行号信息要保留，模型才能定位是哪个逗号
    expect(content).toMatch(/position \d+/);
  });

  it("returns the same feedback on the serial (mutating) path", async () => {
    const { content } = await firstToolResultContent("write_file", '{"path": "a.ts" "content": "x"}');

    expect(content).toContain("Tool call rejected (invalid_arguments).");
    expect(content).toContain("Tool: write_file");
    expect(content).toContain("Fix: send one JSON object");
  });

  it("names the missing field instead of a bare rejection", async () => {
    const { content } = await firstToolResultContent("write_file", '{"path": "a.ts"}');

    expect(content).toContain("Tool call rejected (invalid_arguments).");
    expect(content).toContain('missing required string argument "content"');
    // 缺少字段时不该回显成「不是 JSON」——两者修法完全不同
    expect(content).not.toContain("not valid JSON");
  });
});
