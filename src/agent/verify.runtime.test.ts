import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, MeowEvent } from "./types";

const { streamMock, executeToolMock } = vi.hoisted(() => ({
  streamMock: vi.fn(),
  executeToolMock: vi.fn(),
}));

let actualExecuteTool: typeof import("./tools.js").executeTool | undefined;

vi.mock("./provider.js", () => ({
  completionUrl: vi.fn(),
  streamChatCompletion: streamMock,
}));
vi.mock("./title-generator.js", () => ({
  generateSessionTitle: vi.fn().mockResolvedValue("Test title"),
}));
// 只拦 executeTool：run_command 返回预置结果，写类工具透传真实现（真实落盘临时工作区）
vi.mock("./tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools.js")>();
  actualExecuteTool = actual.executeTool;
  return { ...actual, executeTool: executeToolMock };
});

const { AgentRuntime } = await import("./runtime.js");

const createdWorkspaces: string[] = [];

async function makeWorkspace(config?: unknown): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-verify-runtime-"));
  createdWorkspaces.push(workspace);
  if (config !== undefined) {
    await mkdir(path.join(workspace, ".meowcode"), { recursive: true });
    await writeFile(
      path.join(workspace, ".meowcode", "verify.json"),
      JSON.stringify(config),
      "utf8",
    );
  }
  return workspace;
}

function makeRuntime(sessionsDir: string) {
  return new AgentRuntime({
    providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
    sessionsDir,
  });
}

function collectEvents(runtime: InstanceType<typeof AgentRuntime>): MeowEvent[] {
  const events: MeowEvent[] = [];
  runtime.onEvent((event) => events.push(event));
  return events;
}

/** 预置 run_command 结果队列；其余工具走真实实现 */
function queueRunCommandResults(results: Array<{ ok: boolean; output: string }>): void {
  const queue = [...results];
  executeToolMock.mockImplementation(
    async (
      name: string,
      input: unknown,
      workspace: string,
      options?: Parameters<NonNullable<typeof actualExecuteTool>>[3],
    ) => {
      if (name === "run_command") {
        return queue.shift() ?? { ok: true, output: "" };
      }
      return actualExecuteTool!(name as "write_file", input, workspace, options);
    },
  );
}

function toolMessagesOf(request: unknown, name: string): string[] {
  const messages = (request as { messages: ChatMessage[] }).messages;
  return messages
    .filter((message) => message.role === "tool" && message.name === name)
    .map((message) => String(message.content));
}

const TSC_ERROR = "src/a.ts(1,2): error TS2345: Argument of type 'string' is not assignable.";
const VERIFY_CONFIG = { typecheck: "npx --no-install tsc --noEmit" };

beforeEach(() => {
  streamMock.mockReset();
  executeToolMock.mockReset();
});

afterEach(async () => {
  while (createdWorkspaces.length) {
    const workspace = createdWorkspaces.pop()!;
    await rm(workspace, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("post-write verification loop", () => {
  it("feeds typecheck failures back and completes after the model fixes the code", async () => {
    const sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-verify-sessions-"));
    createdWorkspaces.push(sessionsDir);
    const workspace = await makeWorkspace(VERIFY_CONFIG);
    const runtime = makeRuntime(sessionsDir);
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    collectEvents(runtime);
    queueRunCommandResults([
      { ok: false, output: TSC_ERROR },
      { ok: true, output: "" },
    ]);
    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: "a.ts", content: "const x: number = 'bad';" }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-2",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: "a.ts", content: "const x: number = 1;" }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    await runtime.prompt("fix the type error");

    const runCommandCalls = executeToolMock.mock.calls.filter(([name]) => name === "run_command");
    expect(runCommandCalls).toHaveLength(2);
    // mock 记录的 messages 是活引用（repairToolPairs 返回新数组、push 在调用后发生），
    // 取最后一次调用的数组即为回合终态：两次写入的回执按序在列
    const finalMessages = (
      streamMock.mock.calls[streamMock.mock.calls.length - 1]![0] as { messages: ChatMessage[] }
    ).messages;
    const writeOutputs = toolMessagesOf({ messages: finalMessages }, "write_file");
    expect(writeOutputs).toHaveLength(2);
    expect(writeOutputs[0]).toContain("--- auto-verify: typecheck FAILED");
    expect(writeOutputs[0]).toContain("TS2345");
    expect(writeOutputs[1]).not.toContain("auto-verify");
  });

  it("keeps tool output clean when verification passes", async () => {
    const sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-verify-sessions-"));
    createdWorkspaces.push(sessionsDir);
    const workspace = await makeWorkspace(VERIFY_CONFIG);
    const runtime = makeRuntime(sessionsDir);
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    collectEvents(runtime);
    queueRunCommandResults([{ ok: true, output: "" }]);
    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: "a.ts", content: "export const ok = 1;" }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    await runtime.prompt("write a file");

    const toolOutput = toolMessagesOf(streamMock.mock.calls[1]![0], "write_file").join("\n");
    expect(toolOutput).not.toContain("auto-verify");
    expect(toolOutput).not.toContain("FAILED");
  });

  it("stops feeding failures after maxFeedbackPerTurn and asks the model to report honestly", async () => {
    const sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-verify-sessions-"));
    createdWorkspaces.push(sessionsDir);
    const workspace = await makeWorkspace(VERIFY_CONFIG);
    const runtime = makeRuntime(sessionsDir);
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    const events = collectEvents(runtime);
    queueRunCommandResults([
      { ok: false, output: TSC_ERROR },
      { ok: false, output: TSC_ERROR },
      { ok: false, output: TSC_ERROR },
    ]);
    const writeCall = (id: string) => ({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id,
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: "a.ts", content: `const x = ${id};` }),
            },
          },
        ],
      },
    });
    streamMock
      .mockResolvedValueOnce(writeCall("call-1"))
      .mockResolvedValueOnce(writeCall("call-2"))
      .mockResolvedValueOnce(writeCall("call-3"))
      .mockResolvedValueOnce({ message: { role: "assistant", content: "final" } });

    await runtime.prompt("keep writing");

    // 每次写都跑了验证
    const runCommandCalls = executeToolMock.mock.calls.filter(([name]) => name === "run_command");
    expect(runCommandCalls).toHaveLength(3);
    const finalMessages = (
      streamMock.mock.calls[streamMock.mock.calls.length - 1]![0] as { messages: ChatMessage[] }
    ).messages;
    const writeOutputs = toolMessagesOf({ messages: finalMessages }, "write_file");
    expect(writeOutputs).toHaveLength(3);
    expect(writeOutputs[0]).toContain("TS2345");
    expect(writeOutputs[1]).toContain("TS2345");
    expect(writeOutputs[2]).toContain("tell the user");
    expect(writeOutputs[2]).not.toContain("TS2345");
  });

  it("respects the include extension filter", async () => {
    const sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-verify-sessions-"));
    createdWorkspaces.push(sessionsDir);
    const workspace = await makeWorkspace(VERIFY_CONFIG);
    const runtime = makeRuntime(sessionsDir);
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    collectEvents(runtime);
    queueRunCommandResults([]);
    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: "notes.md", content: "# notes" }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    await runtime.prompt("write markdown");

    expect(executeToolMock).not.toHaveBeenCalledWith(
      "run_command",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("does not verify when no verify command can be detected", async () => {
    const sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-verify-sessions-"));
    createdWorkspaces.push(sessionsDir);
    const workspace = await makeWorkspace(undefined);
    const runtime = makeRuntime(sessionsDir);
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    collectEvents(runtime);
    queueRunCommandResults([]);
    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: "a.ts", content: "export const ok = 1;" }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    await runtime.prompt("write a file");

    expect(executeToolMock).not.toHaveBeenCalledWith(
      "run_command",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("reports honestly on the first failure when maxFeedbackPerTurn is 0", async () => {
    const sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-verify-sessions-"));
    createdWorkspaces.push(sessionsDir);
    const workspace = await makeWorkspace({ ...VERIFY_CONFIG, maxFeedbackPerTurn: 0 });
    const runtime = makeRuntime(sessionsDir);
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    collectEvents(runtime);
    queueRunCommandResults([{ ok: false, output: TSC_ERROR }]);
    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: "a.ts", content: "const x: number = 'bad';" }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "final" } });

    await runtime.prompt("write it");

    const finalMessages = (
      streamMock.mock.calls[streamMock.mock.calls.length - 1]![0] as { messages: ChatMessage[] }
    ).messages;
    const writeOutputs = toolMessagesOf({ messages: finalMessages }, "write_file");
    expect(writeOutputs).toHaveLength(1);
    expect(writeOutputs[0]).toContain("tell the user");
    expect(writeOutputs[0]).not.toContain("TS2345");
  });
});
