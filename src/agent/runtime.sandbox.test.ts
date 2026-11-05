import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeowEvent, SessionEntry, ToolResult } from "./types";

const { streamMock, executeToolMock } = vi.hoisted(() => ({
  streamMock: vi.fn(),
  executeToolMock: vi.fn(),
}));

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
vi.mock("./tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools.js")>();
  return { ...actual, executeTool: executeToolMock };
});

const { AgentRuntime } = await import("./runtime.js");

function makeRuntime(sessionsDir: string): InstanceType<typeof AgentRuntime> {
  return new AgentRuntime({
    providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
    sessionsDir,
    homeDir: sessionsDir,
  });
}

function denial(kind: "write_denied" | "unknown_denied" = "write_denied"): ToolResult {
  return {
    ok: false,
    output: "Set-Content : Access is denied.",
    sandboxDenial: {
      kind,
      evidence: "Set-Content : Access is denied.",
      exitCode: 1,
      writableRoots: [],
    },
  };
}

function toolCall(id: string) {
  return {
    message: {
      role: "assistant" as const,
      content: null,
      tool_calls: [
        {
          id,
          type: "function" as const,
          function: {
            name: "run_command",
            arguments: JSON.stringify({ command: "Set-Content out.txt hello" }),
          },
        },
      ],
    },
  };
}

async function readyRuntime() {
  const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-sandbox-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-sandbox-ws-"));
  const runtime = makeRuntime(dir);
  await runtime.newSession(workspace);
  runtime.setApprovalMode("full");
  return { runtime, workspace };
}

beforeEach(() => {
  streamMock.mockReset();
  executeToolMock.mockReset();
});

describe("runtime sandbox escape approval", () => {
  it("asks once, retries outside the sandbox, and records both attempts", async () => {
    const { runtime } = await readyRuntime();
    executeToolMock.mockImplementation(async (_tool, _input, _cwd, options) =>
      options?.sandbox === "bypass"
        ? { ok: true, output: "bypass-ok" }
        : denial(),
    );
    streamMock
      .mockResolvedValueOnce(toolCall("call1"))
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    const approvalEvent = new Promise<Extract<MeowEvent, { type: "approval_required" }>>(
      (resolve) => {
        runtime.onEvent((event) => {
          if (event.type === "approval_required") resolve(event);
        });
      },
    );
    const prompt = runtime.prompt("go");
    const approval = await approvalEvent;
    expect(approval.callId).toBe("call1:outside");
    expect(approval.sandboxEscape).toEqual({
      command: "Set-Content out.txt hello",
      detail: "Set-Content : Access is denied.",
    });
    runtime.respondToApproval(approval.callId, true);
    await prompt;

    expect(executeToolMock).toHaveBeenCalledTimes(2);
    expect(executeToolMock.mock.calls[0]?.[3]?.sandbox).toBe("enforce");
    expect(executeToolMock.mock.calls[1]?.[3]?.sandbox).toBe("bypass");

    const entries = runtime.current?.entries ?? [];
    const recorded = entries.find(
      (entry): entry is Extract<SessionEntry, { type: "approval" }> =>
        entry.type === "approval" && entry.callId === "call1:outside",
    );
    expect(recorded?.approved).toBe(true);
    expect(recorded?.reason).toBe("sandbox_escape");

    const toolMessage = runtime.current?.messages.find(
      (message) => message.role === "tool" && message.tool_call_id === "call1",
    );
    expect(toolMessage?.content).toContain("retried without the sandbox");
    expect(toolMessage?.content).toContain("bypass-ok");
  });

  it("keeps the sandbox result when the user denies the escape", async () => {
    const { runtime } = await readyRuntime();
    executeToolMock.mockResolvedValue(denial());
    streamMock
      .mockResolvedValueOnce(toolCall("call2"))
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    const approvalEvent = new Promise<Extract<MeowEvent, { type: "approval_required" }>>(
      (resolve) => {
        runtime.onEvent((event) => {
          if (event.type === "approval_required") resolve(event);
        });
      },
    );
    const prompt = runtime.prompt("go");
    const approval = await approvalEvent;
    runtime.respondToApproval(approval.callId, false);
    await prompt;

    expect(executeToolMock).toHaveBeenCalledTimes(1);
    const entries = runtime.current?.entries ?? [];
    const recorded = entries.find(
      (entry): entry is Extract<SessionEntry, { type: "approval" }> =>
        entry.type === "approval" && entry.callId === "call2:outside",
    );
    expect(recorded?.approved).toBe(false);
    expect(recorded?.reason).toBe("sandbox_denied");
    const toolMessage = runtime.current?.messages.find(
      (message) => message.role === "tool" && message.tool_call_id === "call2",
    );
    expect(toolMessage?.content).toContain("Access is denied");
    expect(toolMessage?.content).not.toContain("retried without the sandbox");
  });

  it("does not ask for an unknown denial", async () => {
    const { runtime } = await readyRuntime();
    executeToolMock.mockResolvedValue(denial("unknown_denied"));
    streamMock
      .mockResolvedValueOnce(toolCall("call3"))
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    const events: MeowEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.prompt("go");

    expect(events.some((event) => event.type === "approval_required")).toBe(false);
    expect(executeToolMock).toHaveBeenCalledTimes(1);
  });
});
