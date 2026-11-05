import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeowEvent } from "./types";
import { readApprovalRules } from "./approval-rules";

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

function makeRuntime(sessionsDir: string) {
  return new AgentRuntime({
    providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
    sessionsDir,
    homeDir: sessionsDir,
  });
}

function toolCallMessage(id: string, command: string) {
  return {
    message: {
      role: "assistant" as const,
      content: null,
      tool_calls: [
        {
          id,
          type: "function" as const,
          function: { name: "run_command", arguments: JSON.stringify({ command }) },
        },
      ],
    },
  };
}

async function waitFor<T>(probe: () => T | null | undefined, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor timed out");
}

beforeEach(() => {
  streamMock.mockReset();
});

describe("approval decisions", () => {
  it("拒绝理由回灌模型", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-approval-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-approval-ws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("ask");
    const events: MeowEvent[] = [];
    runtime.onEvent((event) => events.push(event));

    streamMock
      .mockResolvedValueOnce(toolCallMessage("c1", "echo hi"))
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    const running = runtime.prompt("go");
    const pending = await waitFor(() => runtime.pendingApproval);
    runtime.respondToApproval(pending.callId, {
      approved: false,
      feedback: "use pnpm test instead",
    });
    await running;

    const secondRequest = streamMock.mock.calls[1][0] as { messages: Array<{ content?: unknown }> };
    const serialized = JSON.stringify(secondRequest.messages);
    expect(serialized).toContain("Reason: use pnpm test instead");
    const resolved = events.find((event) => event.type === "approval_resolved");
    if (resolved?.type === "approval_resolved") {
      expect(resolved.feedback).toBe("use pnpm test instead");
    }
  });

  it("批准时记住命令：同命令第二次不再弹窗", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-approval-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-approval-ws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("ask");
    const events: MeowEvent[] = [];
    runtime.onEvent((event) => events.push(event));

    streamMock
      .mockResolvedValueOnce(toolCallMessage("c1", "echo hi"))
      .mockResolvedValueOnce({ message: { role: "assistant", content: "first done" } })
      .mockResolvedValueOnce(toolCallMessage("c2", "echo hi"))
      .mockResolvedValueOnce({ message: { role: "assistant", content: "second done" } });

    const first = runtime.prompt("go");
    const pending = await waitFor(() => runtime.pendingApproval);
    runtime.respondToApproval(pending.callId, { approved: true, remember: "command-exact" });
    await first;

    const rules = await readApprovalRules(workspace);
    expect(rules).toHaveLength(1);
    expect(rules[0].match.kind).toBe("command-exact");
    expect(rules[0].match.value).toBe("echo hi");

    const approvalsBefore = events.filter((event) => event.type === "approval_required").length;
    await runtime.prompt("again");
    const approvalsAfter = events.filter((event) => event.type === "approval_required").length;
    expect(approvalsAfter).toBe(approvalsBefore);

    const raw = JSON.parse(
      await readFile(path.join(workspace, ".meowcode", "approvals.json"), "utf8"),
    ) as { rules: Array<{ match: { kind: string } }> };
    expect(raw.rules[0].match.kind).toBe("command-exact");
  });
});
