import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "./types";

const { streamMock, diagnoseMock } = vi.hoisted(() => ({
  streamMock: vi.fn(),
  diagnoseMock: vi.fn(),
}));

vi.mock("./provider.js", () => ({
  completionUrl: vi.fn(),
  streamChatCompletion: streamMock,
}));
vi.mock("./title-generator.js", () => ({
  generateSessionTitle: vi.fn().mockResolvedValue("Test title"),
}));
vi.mock("../lsp/manager.js", () => ({
  getLspManager: () => ({ diagnose: diagnoseMock }),
}));

const { AgentRuntime } = await import("./runtime.js");

const workspaces: string[] = [];

async function makeRuntime() {
  const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-lsp-runtime-"));
  const sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-lsp-sessions-"));
  workspaces.push(workspace, sessionsDir);
  const runtime = new AgentRuntime({
    providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
    sessionsDir,
  });
  await runtime.newSession(workspace);
  await runtime.setApprovalMode("full");
  return { runtime, workspace };
}

beforeEach(() => {
  streamMock.mockReset();
  diagnoseMock.mockReset();
});

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
        () => undefined,
      ),
    ),
  );
});

function writeCall(id: string, target: string): unknown {
  return {
    id,
    type: "function",
    function: {
      name: "write_file",
      arguments: JSON.stringify({ path: target, content: "const a = 1;\n" }),
    },
  };
}

describe("post-write LSP feedback", () => {
  it("attaches diagnostics to the tool result", async () => {
    const { runtime, workspace } = await makeRuntime();
    const file = path.join(workspace, "src", "a.ts");
    diagnoseMock.mockResolvedValue({
      serverNames: ["fake"],
      diagnostics: [
        {
          file,
          line: 1,
          column: 1,
          severity: "error",
          code: "FAKE1",
          message: "fake semantic error",
        },
      ],
    });
    streamMock.mockImplementation(async ({ messages }: { messages: ChatMessage[] }) => {
      const hasTool = messages.some((message) => message.role === "tool");
      if (!hasTool) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [writeCall("w1", "src/a.ts")],
          },
        };
      }
      return { message: { role: "assistant", content: "done" } };
    });

    await runtime.prompt("write the file");

    const second = streamMock.mock.calls
      .map((call) => call[0] as { messages: ChatMessage[] })
      .find((request) => request.messages.some((message) => message.role === "tool"));
    expect(second).toBeDefined();
    const toolMessage = second!.messages.find(
      (message) => message.role === "tool" && message.name === "write_file",
    );
    const content = String(toolMessage?.content ?? "");
    expect(content).toContain("--- lsp diagnostics: 1 error");
    expect(content).toContain("src/a.ts(1,1): error FAKE1: fake semantic error");
    expect(content).toContain("Automatic verification feedback");
    expect(diagnoseMock).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: workspace, files: [file] }),
    );
    await runtime.closeSession();
  });

  it("leaves the tool result unchanged when diagnostics are clean", async () => {
    const { runtime } = await makeRuntime();
    diagnoseMock.mockResolvedValue({ serverNames: ["fake"], diagnostics: [] });
    streamMock.mockImplementation(async ({ messages }: { messages: ChatMessage[] }) => {
      const hasTool = messages.some((message) => message.role === "tool");
      if (!hasTool) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [writeCall("w1", "src/a.ts")],
          },
        };
      }
      return { message: { role: "assistant", content: "done" } };
    });

    await runtime.prompt("write the file");
    const second = streamMock.mock.calls
      .map((call) => call[0] as { messages: ChatMessage[] })
      .find((request) => request.messages.some((message) => message.role === "tool"));
    const toolMessage = second!.messages.find(
      (message) => message.role === "tool" && message.name === "write_file",
    );
    expect(String(toolMessage?.content ?? "")).not.toContain("lsp diagnostics");
    await runtime.closeSession();
  });
});
