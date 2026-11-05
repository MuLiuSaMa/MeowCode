import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeowEvent } from "./types";
import { resetSandboxSettingsForTests, setSandboxSettings } from "./sandbox/policy.js";

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

function toolCall(command: string) {
  return {
    message: {
      role: "assistant" as const,
      content: null,
      tool_calls: [
        {
          id: "delete1",
          type: "function" as const,
          function: { name: "run_command", arguments: JSON.stringify({ command }) },
        },
      ],
    },
  };
}

async function readyRuntime() {
  const dir = await mkdtemp(path.join(tmpdir(), "meowcode-delete-confirm-"));
  const runtime = makeRuntime(dir);
  await runtime.newSession();
  runtime.setApprovalMode("full");
  return runtime;
}

beforeEach(() => {
  streamMock.mockReset();
  executeToolMock.mockReset();
  executeToolMock.mockResolvedValue({ ok: true, output: "ok" });
});

afterEach(() => {
  resetSandboxSettingsForTests();
});

function enableWorkspaceWrite(confirmDelete: boolean) {
  setSandboxSettings({
    enabled: true,
    mode: "workspace-write",
    writableRoots: [],
    allowTemp: false,
    grantTimeoutMs: 30_000,
    confirmDelete,
  });
}

describe("file deletion confirmation", () => {
  it("asks before a deletion in workspace-write mode even in full approval mode", async () => {
    enableWorkspaceWrite(true);
    const runtime = await readyRuntime();
    streamMock
      .mockResolvedValueOnce(toolCall("Remove-Item out.txt"))
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
    expect(approval.tool).toBe("run_command");
    runtime.respondToApproval(approval.callId, true);
    await prompt;

    expect(executeToolMock).toHaveBeenCalledTimes(1);
  });

  it("does not execute a deletion when the confirmation is denied", async () => {
    enableWorkspaceWrite(true);
    const runtime = await readyRuntime();
    streamMock
      .mockResolvedValueOnce(toolCall("Remove-Item out.txt"))
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

    expect(executeToolMock).not.toHaveBeenCalled();
  });

  it("skips the confirmation in full-access sandbox mode", async () => {
    setSandboxSettings({
      enabled: false,
      mode: "workspace-write",
      writableRoots: [],
      allowTemp: false,
      grantTimeoutMs: 30_000,
      confirmDelete: true,
    });
    const runtime = await readyRuntime();
    streamMock
      .mockResolvedValueOnce(toolCall("Remove-Item out.txt"))
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    const events: MeowEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.prompt("go");

    expect(events.some((event) => event.type === "approval_required")).toBe(false);
    expect(executeToolMock).toHaveBeenCalledTimes(1);
  });

  it("skips the confirmation when the setting is off", async () => {
    enableWorkspaceWrite(false);
    const runtime = await readyRuntime();
    streamMock
      .mockResolvedValueOnce(toolCall("Remove-Item out.txt"))
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    const events: MeowEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.prompt("go");

    expect(events.some((event) => event.type === "approval_required")).toBe(false);
    expect(executeToolMock).toHaveBeenCalledTimes(1);
  });

  it("does not ask for non-deletion commands", async () => {
    enableWorkspaceWrite(true);
    const runtime = await readyRuntime();
    streamMock
      .mockResolvedValueOnce(toolCall("Get-ChildItem"))
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    const events: MeowEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.prompt("go");

    expect(events.some((event) => event.type === "approval_required")).toBe(false);
    expect(executeToolMock).toHaveBeenCalledTimes(1);
  });
});
