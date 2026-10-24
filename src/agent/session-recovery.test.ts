import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "./session-store";
import { recoverSession } from "./session-recovery";

async function makeStore(): Promise<SessionStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "meowcode-recovery-"));
  return SessionStore.create(path.join(dir, "session.jsonl"), "D:/work");
}

describe("recoverSession", () => {
  it("closes an interrupted turn, repairs approvals/tool results, and restores settings", async () => {
    const session = await makeStore();
    await session.appendSessionSettings({ approvalMode: "read-only" });
    await session.appendQueuedPrompt("pending", "still queued");
    await session.appendTurnStart({ turnId: "t1", text: "hello" });
    await session.appendMessage({ role: "user", content: "hello" });
    await session.appendApprovalRequested({
      turnId: "t1",
      callId: "call-1",
      tool: "write_file",
      input: { path: "a.txt", content: "x" },
    });
    await session.appendMessage({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call-2",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"a.txt"}' },
        },
      ],
    });
    await session.writePartial({ turnId: "t1", round: 2, content: "half an answer" });
    await session.appendCompactionStarted({ compactionId: "c1", turnId: "t1", reason: "overflow" });

    const result = await recoverSession(session);

    expect(result.recovered).toBe(true);
    expect(result.interrupted).toBe(true);
    expect(result.approvalMode).toBe("read-only");
    expect(result.lastError).toBeNull();
    expect(session.openTurns).toEqual([]);
    expect(session.lastTurnEnd?.status).toBe("interrupted");
    expect(session.recoveredQueue).toEqual([{ id: "pending", text: "still queued" }]);

    const messages = session.messages;
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(messages[0]).toEqual({ role: "user", content: "hello" });
    expect(messages[2]).toMatchObject({ role: "tool", tool_call_id: "call-2" });
    expect(messages[3]).toEqual({ role: "assistant", content: "half an answer" });

    const denied = session.entries.find(
      (entry) => entry.type === "approval" && entry.callId === "call-1",
    );
    expect(denied).toMatchObject({ approved: false, reason: "restored_denied" });
    expect(session.compactionPoints.at(-1)).toMatchObject({ status: "interrupted" });

    const count = session.entries.length;
    const second = await recoverSession(session);
    expect(second.recovered).toBe(false);
    expect(session.entries.length).toBe(count);
    await session.close();
  });

  it("restores the prompt text when the crash happened before the user message", async () => {
    const session = await makeStore();
    await session.appendTurnStart({ turnId: "t1", text: "not persisted yet" });
    const result = await recoverSession(session);
    expect(result.actions).toContain("restored user message");
    expect(session.messages).toEqual([{ role: "user", content: "not persisted yet" }]);
    expect(session.lastTurnEnd?.status).toBe("interrupted");
    await session.close();
  });

  it("marks a dangling user message as interrupted without replaying it", async () => {
    const session = await makeStore();
    await session.appendMessage({ role: "user", content: "sent before crash" });

    const result = await recoverSession(session);
    expect(result.interrupted).toBe(true);
    expect(session.messages).toHaveLength(1);
    expect(session.lastTurnEnd?.status).toBe("interrupted");
    expect(session.entries.at(-1)?.type).toBe("recovery");
    await session.close();
  });

  it("restores the session mode and defaults old sessions to default", async () => {
    const session = await makeStore();
    expect((await recoverSession(session)).mode).toBe("default");
    await session.appendSessionSettings({ mode: "goal" });
    expect((await recoverSession(session)).mode).toBe("goal");
    await session.close();
  });

  it("closes a compaction that already produced a summary as completed", async () => {    const session = await makeStore();
    await session.appendCompactionStarted({ compactionId: "c1", reason: "manual" });
    await session.appendCompactionSummary("already summarized");
    const result = await recoverSession(session);
    expect(result.actions).toContain("closed compaction with summary");
    expect(session.compactionPoints).toEqual([
      { messageIndex: 0, summary: "already summarized", status: "completed" },
    ]);
    await session.close();
  });
});
