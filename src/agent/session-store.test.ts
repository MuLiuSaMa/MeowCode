import { appendFile, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStore, flushSessionIndex, listSessions } from "./session-store";
import type { ChatMessage } from "./types.js";

async function makeStore(): Promise<{ dir: string; filePath: string; session: SessionStore }> {
  const dir = await mkdtemp(path.join(tmpdir(), "meowcode-sessions-"));
  const filePath = path.join(dir, "session.jsonl");
  const session = await SessionStore.create(filePath, "D:/work");
  return { dir, filePath, session };
}

describe("SessionStore", () => {
  it("persists and reloads messages", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-sessions-"));
    const filePath = path.join(dir, "session.jsonl");
    const session = await SessionStore.create(filePath, "D:/work");
    await session.appendMessage({ role: "user", content: "hello" });
    await session.appendMessage({ role: "assistant", content: "hi" });
    const loaded = await SessionStore.load(filePath);
    expect(loaded.id).toBe(session.id);
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.messages[0]).toEqual({ role: "user", content: "hello" });
    expect((await listSessions(dir)).length).toBe(1);
  });

  it("round-trips worktree metadata through header and summary", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-sessions-"));
    const filePath = path.join(dir, "session.jsonl");
    const worktree = {
      sourceCwd: "D:/work",
      repoRoot: "D:/work",
      path: "C:/data/worktrees/work-1",
      branch: "meowcode/work-1",
      baseSha: "abc123",
      createdAt: "2026-10-25T00:00:00.000Z",
    };
    const session = await SessionStore.create(filePath, worktree.path, { worktree });
    expect(session.worktree).toEqual(worktree);
    await session.appendMessage({ role: "user", content: "hello" });
    await session.flush();

    expect((await SessionStore.load(filePath)).worktree).toEqual(worktree);
    const [summary] = await listSessions(dir);
    expect(summary.worktree).toEqual(worktree);
  });

  it("persists plans and compaction summaries, and slices effective messages", async () => {    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-sessions-"));
    const filePath = path.join(dir, "session.jsonl");
    const session = await SessionStore.create(filePath, "D:/work");
    await session.appendMessage({ role: "user", content: "before" });
    await session.appendPlan([{ title: "Step A", status: "in_progress" }], "why");
    await session.appendCompactionSummary("earlier work summary");
    await session.appendMessage({ role: "assistant", content: "after" });

    expect(session.currentPlan?.steps).toEqual([{ title: "Step A", status: "in_progress" }]);
    expect(session.currentPlan?.explanation).toBe("why");
    expect(session.currentCompactionSummary).toBe("earlier work summary");
    // 压缩点之前的消息条数：前端按它把分隔线插回时间线
    expect(session.lastCompaction).toEqual({ messageIndex: 1, summary: "earlier work summary" });
    // 压缩点之前的历史不再进入有效消息；摘要本身成为首条 user 消息
    expect(session.effectiveMessages.map((message) => message.content)).toEqual([
      "Earlier conversation summary:\nearlier work summary",
      "after",
    ]);

    // 回放：从磁盘重新加载后元数据仍在
    const loaded = await SessionStore.load(filePath);
    expect(loaded.currentPlan?.steps[0].title).toBe("Step A");
    expect(loaded.currentCompactionSummary).toBe("earlier work summary");
    expect(loaded.lastCompaction).toEqual({ messageIndex: 1, summary: "earlier work summary" });
    expect(loaded.effectiveMessages.map((message) => message.content)).toEqual([
      "Earlier conversation summary:\nearlier work summary",
      "after",
    ]);
  });

  it("interleaves context notes into effective messages without showing them as chat history", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-sessions-"));
    const filePath = path.join(dir, "session.jsonl");
    const session = await SessionStore.create(filePath, "D:/work");
    await session.appendMessage({ role: "user", content: "before" });
    await session.appendContextNote("Runtime context: current task plan\n1. [pending] A");
    await session.appendMessage({ role: "assistant", content: "after" });

    expect(session.messages.map((message) => message.content)).toEqual(["before", "after"]);
    expect(session.effectiveMessages).toEqual([
      { role: "user", content: "before" },
      { role: "user", content: "Runtime context: current task plan\n1. [pending] A" },
      { role: "assistant", content: "after" },
    ]);

    const loaded = await SessionStore.load(filePath);
    expect(loaded.effectiveMessages).toHaveLength(3);
    expect(loaded.messages).toHaveLength(2);
  });

  it("keeps the most recent messages verbatim across a compaction point", async () => {
    const { session, filePath } = await makeStore();
    // 旧历史（含大 tool 结果，超出保留预算）：进入摘要
    await session.appendMessage({ role: "user", content: "old question" });
    await session.appendMessage({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }],
    });
    await session.appendMessage({ role: "tool", content: "x".repeat(30_000), tool_call_id: "c1", name: "read_file" });
    // 近期对话：逐字保留
    await session.appendMessage({ role: "user", content: "recent question" });
    await session.appendMessage({ role: "assistant", content: "recent answer" });

    const recent = session.recentKeptMessages({ tokens: 2_000 });
    expect(recent.map((message) => message.content)).toEqual(["recent question", "recent answer"]);

    await session.appendCompactionSummary("summary", recent.length);
    await session.appendMessage({ role: "assistant", content: "after compaction" });

    const expected = [
      "Earlier conversation summary:\nsummary",
      "recent question",
      "recent answer",
      "after compaction",
    ];
    expect(session.effectiveMessages.map((message) => message.content)).toEqual(expected);

    // 回放：从磁盘重新加载后保留段仍在
    const loaded = await SessionStore.load(filePath);
    expect(loaded.effectiveMessages.map((message) => message.content)).toEqual(expected);
  });

  it("recentKeptMessages returns empty when everything fits the keep budget", async () => {
    const { session } = await makeStore();
    await session.appendMessage({ role: "user", content: "only message" });
    // 全部历史都在保留预算内：没有可摘要的旧历史，退回全量摘要
    expect(session.recentKeptMessages({ tokens: 2_000 })).toEqual([]);
  });

  it("cuts keep-recent at unit boundaries so tool pairs stay intact", async () => {
    const { session } = await makeStore();
    const toolCall = (id: string): ChatMessage => ({
      role: "assistant",
      content: null,
      tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: "{}" } }],
    });
    await session.appendMessage({ role: "user", content: "q1" });
    await session.appendMessage(toolCall("c1"));
    await session.appendMessage({ role: "tool", content: "x".repeat(2000), tool_call_id: "c1", name: "read_file" });
    await session.appendMessage({ role: "user", content: "q2" });
    await session.appendMessage(toolCall("c2"));
    await session.appendMessage({ role: "tool", content: "x".repeat(2000), tool_call_id: "c2", name: "read_file" });
    await session.appendMessage({ role: "user", content: "q3" });

    const recent = session.recentKeptMessages({ tokens: 520 });
    // 必须是原序列的连续尾部子集
    expect(recent).toEqual(session.messages.slice(-recent.length));
    // 工具配对完整：保留的 tool 结果，其 assistant 调用也在保留段里
    for (const message of recent) {
      if (message.role === "tool") {
        expect(
          recent.some(
            (other) =>
              other.role === "assistant" &&
              other.tool_calls?.some((call) => call.id === message.tool_call_id),
          ),
        ).toBe(true);
      }
    }
    expect(recent.at(-1)?.content).toBe("q3");
    expect(recent.some((message) => message.content === "q1")).toBe(false);
  });

  it("keeps at least the latest unit when the keep budget is tight", async () => {
    const { session } = await makeStore();
    const toolCall = (id: string): ChatMessage => ({
      role: "assistant",
      content: null,
      tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: "{}" } }],
    });
    await session.appendMessage({ role: "user", content: "read it" });
    await session.appendMessage(toolCall("c1"));
    await session.appendMessage({ role: "tool", content: "x".repeat(8000), tool_call_id: "c1", name: "read_file" });
    await session.appendMessage({ role: "user", content: "next question" });

    // 预算远小于大 tool 结果：最新单元仍必须逐字保留
    const recent = session.recentKeptMessages({ tokens: 300 });
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ role: "user", content: "next question" });
  });

  it("falls back to summary-only behavior for legacy summaries without keepRecentMessages", async () => {
    const { session, filePath } = await makeStore();
    await session.appendMessage({ role: "user", content: "before" });
    await session.appendCompactionSummary("legacy summary", 0);
    await session.appendMessage({ role: "assistant", content: "after" });

    const loaded = await SessionStore.load(filePath);
    expect(loaded.effectiveMessages.map((message) => message.content)).toEqual([
      "Earlier conversation summary:\nlegacy summary",
      "after",
    ]);
  });

  it("reports whether there are messages after the last compaction summary", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-sessions-"));
    const filePath = path.join(dir, "session.jsonl");
    const session = await SessionStore.create(filePath, "D:/work");
    expect(session.hasUncompactedMessages).toBe(false);
    await session.appendMessage({ role: "user", content: "hello" });
    expect(session.hasUncompactedMessages).toBe(true);
    await session.appendCompactionSummary("summary");
    expect(session.hasUncompactedMessages).toBe(false);
    await session.appendContextNote("plan note");
    expect(session.hasUncompactedMessages).toBe(false);
    await session.appendMessage({ role: "assistant", content: "after" });
    expect(session.hasUncompactedMessages).toBe(true);
  });

  it("persists usage entries without polluting chat messages", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-sessions-"));
    const filePath = path.join(dir, "session.jsonl");
    const session = await SessionStore.create(filePath, "D:/work");
    await session.appendMessage({ role: "user", content: "hi" });
    await session.appendUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 60 });
    await session.appendUsage({ inputTokens: 50, outputTokens: 10 });

    const loaded = await SessionStore.load(filePath);
    expect(loaded.messages).toHaveLength(1);
    expect(loaded.effectiveMessages).toHaveLength(1);
    expect(loaded.usageTotals).toEqual({
      inputTokens: 150,
      outputTokens: 30,
      cacheReadTokens: 60,
      cacheWriteTokens: 0,
      cacheInputTokens: 100,
      cacheReported: true,
      hasUsage: true,
    });
    expect((await listSessions(dir))[0].messageCount).toBe(1);
  });

  it("exposes per-call usage samples for the live hit-rate curve", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-sessions-"));
    const session = await SessionStore.create(path.join(dir, "session.jsonl"), "D:/work");
    await session.appendUsage({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 60,
      source: "chat",
    });
    // 未报告缓存读取的调用：画上去会变成假的 0 命中
    await session.appendUsage({ inputTokens: 50, outputTokens: 10, source: "chat" });
    // 标题/压缩等辅助调用不属于主对话曲线
    await session.appendUsage({
      inputTokens: 5,
      outputTokens: 5,
      cacheReadTokens: 1,
      source: "title",
    });
    await session.appendUsage({
      inputTokens: 200,
      outputTokens: 30,
      cacheReadTokens: 180,
      tokensPerSecond: 42.5,
      source: "chat",
    });

    expect(session.usageSamples).toEqual([
      { inputTokens: 100, outputTokens: 20, cacheReadTokens: 60 },
      { inputTokens: 200, outputTokens: 30, cacheReadTokens: 180, tokensPerSecond: 42.5 },
    ]);
  });

  it("persists turn metrics without polluting chat messages", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-sessions-"));
    const filePath = path.join(dir, "session.jsonl");
    const session = await SessionStore.create(filePath, "D:/work");
    await session.appendMessage({ role: "user", content: "hi" });
    await session.appendMetrics({ responseMs: 1200, firstTokenMs: 300, tokensPerSecond: 42.5 });

    const loaded = await SessionStore.load(filePath);
    expect(loaded.messages).toHaveLength(1);
    expect(loaded.lastTurnMetrics).toEqual({
      responseMs: 1200,
      firstTokenMs: 300,
      tokensPerSecond: 42.5,
    });
  });

  it("never overwrites an existing session file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-sessions-"));
    const filePath = path.join(dir, "same.jsonl");
    await SessionStore.create(filePath, "D:/work");
    await expect(SessionStore.create(filePath, "D:/work")).rejects.toMatchObject({
      code: "EEXIST",
    });
  });

  it("uses the latest plan when several were appended", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-sessions-"));
    const filePath = path.join(dir, "session.jsonl");
    const session = await SessionStore.create(filePath, "D:/work");
    await session.appendPlan([{ title: "Old", status: "pending" }]);
    await session.appendPlan([{ title: "New", status: "completed" }]);
    expect(session.currentPlan?.steps).toEqual([{ title: "New", status: "completed" }]);
    expect(session.currentPlan?.explanation).toBeUndefined();
  });

  it("writes v2 headers with branch lineage", async () => {
    const { filePath, session } = await makeStore();
    const header = JSON.parse((await readFile(filePath, "utf8")).split(/\r?\n/)[0]);
    expect(header.version).toBe(2);
    expect(header.id).toBe(session.id);
    const branch = await SessionStore.create(path.join(path.dirname(filePath), "branch.jsonl"), "D:/work", {
      parentSessionId: session.id,
    });
    const branchHeader = JSON.parse((await readFile(branch.filePath, "utf8")).split(/\r?\n/)[0]);
    expect(branchHeader.parentSessionId).toBe(session.id);
    expect(branchHeader.rootSessionId).toBe(session.id);
    await session.close();
    await branch.close();
  });

  it("persists subagent headers and folds the parent index by agentId", async () => {
    const { dir, session } = await makeStore();
    const agentId = "11111111-2222-4333-8444-555555555555";
    const childPath = path.join(dir, "subagents", session.id, `${agentId}.jsonl`);
    const child = await SessionStore.create(childPath, "D:/work", {
      id: agentId,
      parentSessionId: session.id,
      rootSessionId: session.id,
      agentKind: "subagent",
      parentCallId: "call-1",
      description: "Inspect the repo",
    });
    const header = JSON.parse((await readFile(childPath, "utf8")).split(/\r?\n/)[0]);
    expect(header.id).toBe(agentId);
    expect(header.agentKind).toBe("subagent");
    expect(header.parentCallId).toBe("call-1");
    expect(header.description).toBe("Inspect the repo");

    await session.appendSubagent({
      agentId,
      callId: "call-1",
      description: "Inspect the repo",
      status: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    await session.appendSubagent({
      agentId,
      callId: "call-1",
      description: "Inspect the repo",
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:03.000Z",
      durationMs: 3000,
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(session.subagents).toEqual([
      {
        agentId,
        parentSessionId: session.id,
        callId: "call-1",
        description: "Inspect the repo",
        status: "completed",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:00:03.000Z",
        durationMs: 3000,
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);
    // 索引条目不进入对话消息
    expect(session.messages).toEqual([]);
    await child.close();
    await session.close();
  });

  it("projects turn lifecycle, approvals and session settings", async () => {
    const { session } = await makeStore();
    await session.appendQueuedPrompt("q1", "delivered later");
    await session.appendQueuedPrompt("q2", "still queued");
    await session.appendQueuedPrompt("q3", "removed");
    await session.appendQueuedPromptRemoved("q3", "user");
    await session.appendTurnStart({
      turnId: "t1",
      queueId: "q1",
      approvalMode: "read-only",
    });
    await session.appendMessage({ role: "user", content: "delivered later" });
    await session.appendApprovalRequested({
      turnId: "t1",
      callId: "call-1",
      tool: "write_file",
      input: { path: "a.txt" },
    });
    await session.appendSessionSettings({ approvalMode: "full", providerId: "p", model: "m" });

    expect(session.openTurn?.turnId).toBe("t1");
    expect(session.openApprovalRequests.map((entry) => entry.callId)).toEqual(["call-1"]);
    expect(session.recoveredQueue).toEqual([{ id: "q2", text: "still queued" }]);
    expect(session.sessionSettings).toMatchObject({
      approvalMode: "full",
      providerId: "p",
      model: "m",
    });

    await session.appendApproval("call-1", "write_file", { path: "a.txt" }, false, {
      turnId: "t1",
    });
    await session.appendTurnEnd({ turnId: "t1", status: "error", error: "boom" });
    expect(session.openTurn).toBeNull();
    expect(session.openApprovalRequests).toEqual([]);
    expect(session.lastTurnEnd).toMatchObject({ status: "error", error: "boom" });
    await session.close();
  });

  it("aggregates the session mode from the last settings entry", async () => {
    const { session } = await makeStore();
    // 旧会话：没有任何 mode 字段
    expect(session.sessionSettings?.mode).toBeUndefined();
    await session.appendSessionSettings({ mode: "plan" });
    expect(session.sessionSettings?.mode).toBe("plan");
    // 后写赢：approvalMode 与 mode 各自独立聚合
    await session.appendSessionSettings({ approvalMode: "ask", mode: "goal" });
    expect(session.sessionSettings).toMatchObject({ approvalMode: "ask", mode: "goal" });
    await session.close();
  });

  it("tracks multiple compaction points including interrupted ones", async () => {
    const { session } = await makeStore();
    await session.appendMessage({ role: "user", content: "one" });
    await session.appendCompactionStarted({ compactionId: "c1", reason: "manual" });
    await session.appendCompactionSummary("summary one");
    await session.appendCompactionEnd({ compactionId: "c1", status: "completed" });
    await session.appendMessage({ role: "assistant", content: "two" });
    await session.appendCompactionStarted({ compactionId: "c2", reason: "overflow" });
    await session.appendCompactionEnd({ compactionId: "c2", status: "interrupted" });

    expect(session.compactionPoints).toEqual([
      { messageIndex: 1, summary: "summary one", status: "completed" },
      { messageIndex: 2, status: "interrupted" },
    ]);
    expect(session.lastCompaction).toEqual({ messageIndex: 1, summary: "summary one" });
  });

  it("aggregates usage by source", async () => {
    const { session } = await makeStore();
    await session.appendUsage({ inputTokens: 10, outputTokens: 2, source: "chat" });
    await session.appendUsage({ inputTokens: 20, outputTokens: 4, source: "title" });
    await session.appendUsage({ inputTokens: 30, outputTokens: 6, source: "compaction" });
    expect(session.usageBySource.chat).toEqual({
      calls: 1,
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
    });
    expect(session.usageBySource.title.inputTokens).toBe(20);
    expect(session.usageBySource.compaction.outputTokens).toBe(6);
    expect(session.lastChatUsage?.inputTokens).toBe(10);
  });

  it("replays tool digests in effectiveMessages while keeping the raw transcript", async () => {
    const { filePath, session } = await makeStore();
    await session.appendMessage({ role: "user", content: "do it" });
    await session.appendMessage({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } }],
    });
    await session.appendMessage({
      role: "tool",
      content: "x".repeat(5_000),
      tool_call_id: "call-1",
      name: "read_file",
      images: [{ data: "AAAA", mimeType: "image/png" }],
    });
    await session.appendToolDigests([{ callId: "call-1", digest: "main.ts: exports run(), 240 lines" }]);

    const effective = session.effectiveMessages;
    const tool = effective.find((message) => message.role === "tool");
    expect(tool && tool.role === "tool" ? tool.content : "").toBe(
      "[summarized] main.ts: exports run(), 240 lines",
    );
    expect(tool && tool.role === "tool" ? tool.images : undefined).toBeUndefined();
    // 原文不改写：完整记录仍在会话里
    expect(session.messages.find((message) => message.role === "tool")?.content.length).toBe(5_000);

    const loaded = await SessionStore.load(filePath);
    const replayed = loaded.effectiveMessages.find((message) => message.role === "tool");
    expect(replayed && replayed.role === "tool" ? replayed.content : "").toContain("[summarized]");
  });

  it("anchors the last chat usage to the messages it covered", async () => {
    const { session } = await makeStore();
    expect(session.lastChatUsageAnchor).toBeNull();
    await session.appendMessage({ role: "user", content: "hi" });
    await session.appendMessage({ role: "assistant", content: "ok" });
    await session.appendUsage({ inputTokens: 1_234, source: "chat" });
    await session.appendMessage({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c9", type: "function", function: { name: "grep", arguments: "{}" } }],
    });
    await session.appendMessage({ role: "tool", content: "results", tool_call_id: "c9", name: "grep" });

    // 锚点覆盖用量之后没有新增消息的部分：4 条有效消息，用量之后新增 2 条
    expect(session.lastChatUsageAnchor).toEqual({ inputTokens: 1_234, messageCount: 2 });

    // 压缩过的会话不做推算（摘要前缀会让下标失真），交给下一次请求重新锚定
    await session.appendCompactionSummary("summary");
    expect(session.lastChatUsageAnchor).toBeNull();
  });

  it("repairs a torn trailing line before appending", async () => {
    const { dir, filePath, session } = await makeStore();
    await session.appendMessage({ role: "user", content: "before" });
    await session.close();
    await appendFile(filePath, '{"type":"message","id":"broken"', "utf8");

    const loaded = await SessionStore.load(filePath);
    await loaded.appendMessage({ role: "assistant", content: "after" });
    await loaded.close();

    const lines = (await readFile(filePath, "utf8")).trim().split(/\r?\n/);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(lines).toHaveLength(3); // header + before + after
    const recovery = await readdir(path.join(dir, ".recovery"));
    expect(recovery.some((name) => name.endsWith(".partial"))).toBe(true);
  });

  it("keeps the session index fresh and prunes deleted files", async () => {
    const { dir, filePath, session } = await makeStore();
    await session.appendMessage({ role: "user", content: "hello" });
    expect((await listSessions(dir))[0].messageCount).toBe(1);
    expect((await stat(path.join(dir, "index.json"))).isFile()).toBe(true);

    await session.appendMessage({ role: "assistant", content: "hi" });
    expect((await listSessions(dir))[0].messageCount).toBe(2);

    await writeFile(path.join(dir, "index.json"), "{not json", "utf8");
    expect((await listSessions(dir))[0].messageCount).toBe(2);

    await session.close();
    await unlink(filePath);
    expect(await listSessions(dir)).toEqual([]);
  });

  it("debounces index updates instead of writing per append", async () => {
    const { dir, session } = await makeStore();
    await session.appendMessage({ role: "user", content: "a" });
    await session.appendMessage({ role: "assistant", content: "b" });
    await session.appendMessage({ role: "user", content: "c" });
    // 防抖窗口内不产生逐条原子写：定时器未触发，索引文件根本不存在
    const indexExists = await stat(path.join(dir, "index.json")).then(
      () => true,
      () => false,
    );
    expect(indexExists).toBe(false);
    // 主动查询仍走原有对账路径，数据正确
    expect((await listSessions(dir))[0].messageCount).toBe(3);
    await session.close();
  });

  it("flushes the session index on close and on explicit flush", async () => {
    const { dir, session } = await makeStore();
    await session.appendMessage({ role: "user", content: "hello" });
    await session.appendMessage({ role: "assistant", content: "hi" });
    await session.close();
    // close 同步刷新：不等防抖定时器，索引已反映最终状态
    const flushed = JSON.parse(await readFile(path.join(dir, "index.json"), "utf8")) as {
      files: Record<string, { messageCount: number }>;
    };
    expect(Object.values(flushed.files)[0].messageCount).toBe(2);

    // 显式 flush 覆盖后续变更
    const reopened = await SessionStore.load(path.join(dir, "session.jsonl"));
    await reopened.appendMessage({ role: "user", content: "again" });
    const before = JSON.parse(await readFile(path.join(dir, "index.json"), "utf8")) as {
      files: Record<string, { messageCount: number }>;
    };
    expect(Object.values(before.files)[0].messageCount).toBe(2);
    await flushSessionIndex(dir);
    const after = JSON.parse(await readFile(path.join(dir, "index.json"), "utf8")) as {
      files: Record<string, { messageCount: number }>;
    };
    expect(Object.values(after.files)[0].messageCount).toBe(3);
    await reopened.close();
  });
});

describe("SessionStore message images", () => {
  it("keeps attached images in memory but never writes them to disk", async () => {
    const { filePath, session } = await makeStore();
    await session.appendMessage({
      role: "user",
      content: "看图",
      images: [{ data: "AQID", mimeType: "image/png" }],
    });

    // 内存里保留：本轮与后续回合模型仍能引用
    expect(session.effectiveMessages[0]).toMatchObject({
      role: "user",
      content: "看图",
      images: [{ data: "AQID", mimeType: "image/png" }],
    });
    // 磁盘上没有 base64，只有落盘文件 + 引用
    const raw = await readFile(filePath, "utf8");
    expect(raw).not.toContain("AQID");
    const loaded = await SessionStore.load(filePath);
    // 重载后按 imageRefs 从 assets/ 读回：模型与时间线仍然可用（不再重启即丢）
    expect(loaded.effectiveMessages[0]).toMatchObject({
      role: "user",
      content: "看图",
      images: [{ data: "AQID", mimeType: "image/png" }],
    });
    // 回放层剥 base64 但保留引用，前端经 /session/asset 取图
    expect(loaded.messagesForClient[0]).toEqual({
      role: "user",
      content: "看图",
      imageRefs: [{ file: expect.stringMatching(/\//), mimeType: "image/png" }],
    });
  });

  it("persists images to the session assets dir and keeps the JSONL lean", async () => {
    const { dir, filePath, session } = await makeStore();
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    await session.appendMessage({
      role: "user",
      content: "two images",
      images: [
        { data: pngBytes.toString("base64"), mimeType: "image/png" },
        { data: jpegBytes.toString("base64"), mimeType: "image/jpeg" },
      ],
    });

    const sessionDir = path.join(dir, "assets", session.id);
    const files = (await readdir(sessionDir)).sort();
    // 按 mimeType 落对应扩展名；entryId 唯一 ⇒ 文件名不撞
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/-0\.png$/);
    expect(files[1]).toMatch(/-1\.jpg$/);
    // 落盘内容是原始字节（不是 base64 文本）
    expect(await readFile(path.join(sessionDir, files[0]))).toEqual(pngBytes);

    // JSONL 有引用、无 base64
    const raw = await readFile(filePath, "utf8");
    expect(raw).toContain("imageRefs");
    expect(raw).not.toContain(pngBytes.toString("base64"));

    // 资产引用随会话删除清理（目录级）
    await rm(path.join(dir, "assets", session.id), { recursive: true, force: true });
    const reloaded = await SessionStore.load(filePath);
    // 资产丢失时静默跳过：消息本身不受影响
    expect(reloaded.effectiveMessages[0]).toEqual({ role: "user", content: "two images" });
  });

  it("ignores image refs pointing outside the session or with traversal", async () => {
    const { dir, filePath, session } = await makeStore();
    await session.close();
    // 手工注入恶意/越界引用：穿越与他会话 id 都不回读
    const lines = (await readFile(filePath, "utf8")).trim().split(/\r?\n/);
    const header = JSON.parse(lines[0]);
    const bogus = {
      type: "message",
      id: "testref01",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "evil" },
      imageRefs: [
        { file: "../../escape.png", mimeType: "image/png" },
        { file: "other-session/x.png", mimeType: "image/png" },
      ],
    };
    await writeFile(filePath, [...lines, JSON.stringify(bogus)].join("\n") + "\n", "utf8");
    void header;
    const loaded = await SessionStore.load(filePath);
    expect(loaded.effectiveMessages[0]).toEqual({ role: "user", content: "evil" });
    // 会话目录未被穿越写入
    expect(await readdir(dir)).not.toContain("escape.png");
  });
});

describe("SessionStore message documents", () => {
  it("persists PDF attachments to assets and restores them on load", async () => {
    const { dir, filePath, session } = await makeStore();
    const pdfBytes = Buffer.from("%PDF-1.4 fake bytes");
    await session.appendMessage({
      role: "user",
      content: "读这份 PDF",
      documents: [
        { data: pdfBytes.toString("base64"), mimeType: "application/pdf", name: "report.pdf" },
      ],
    });

    // JSONL 只留引用，不含 base64
    const raw = await readFile(filePath, "utf8");
    expect(raw).toContain("documentRefs");
    expect(raw).not.toContain(pdfBytes.toString("base64"));

    // 落盘文件是原始字节，扩展名 .pdf
    const sessionDir = path.join(dir, "assets", session.id);
    const files = (await readdir(sessionDir)).sort();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/-doc0\.pdf$/);
    expect(await readFile(path.join(sessionDir, files[0]))).toEqual(pdfBytes);

    // 重载后回填到内存，模型与投影继续可用
    const loaded = await SessionStore.load(filePath);
    expect(loaded.effectiveMessages[0]).toMatchObject({
      role: "user",
      content: "读这份 PDF",
      documents: [
        {
          data: pdfBytes.toString("base64"),
          mimeType: "application/pdf",
          name: "report.pdf",
        },
      ],
    });
    // 回放层保留引用，前端可经 /session/asset 取原文件
    expect(loaded.messagesForClient[0]).toMatchObject({
      role: "user",
      content: "读这份 PDF",
      documentRefs: [
        { file: expect.stringMatching(/\//), mimeType: "application/pdf", name: "report.pdf" },
      ],
    });
  });

  it("keeps images and documents of the same message apart", async () => {
    const { dir, session } = await makeStore();
    await session.appendMessage({
      role: "user",
      content: "both",
      images: [{ data: "AQID", mimeType: "image/png" }],
      documents: [{ data: "UERG", mimeType: "application/pdf", name: "a.pdf" }],
    });
    const files = (await readdir(path.join(dir, "assets", session.id))).sort();
    expect(files).toHaveLength(2);
    expect(files.some((file) => file.endsWith('-0.png'))).toBe(true);
    expect(files.some((file) => file.endsWith('-doc0.pdf'))).toBe(true);
  });

  it("still loads old sessions that have no document fields", async () => {
    const { filePath, session } = await makeStore();
    await session.appendMessage({ role: "user", content: "legacy" });
    const loaded = await SessionStore.load(filePath);
    expect(loaded.effectiveMessages[0]).toEqual({ role: "user", content: "legacy" });
    expect(loaded.messagesForClient[0]).toEqual({ role: "user", content: "legacy" });
  });
});

describe("checkpoints", () => {
  it("appends checkpoints and keeps messageIndex aligned with messages", async () => {
    const { filePath, session } = await makeStore();
    await session.appendMessage({ role: "user", content: "one" });
    await session.appendMessage({ role: "assistant", content: "two" });
    const manual = await session.appendCheckpoint({
      label: "手工点",
      auto: false,
      fileChanges: [],
    });
    await session.appendMessage({ role: "user", content: "three" });
    const auto = await session.appendCheckpoint({
      auto: true,
      turnId: "t1",
      fileChanges: ["a.ts"],
    });

    const points = session.checkpoints;
    expect(points.map((point) => point.id)).toEqual([manual.id, auto.id]);
    expect(points[0]).toMatchObject({ label: "手工点", auto: false, messageIndex: 2 });
    expect(points[1]).toMatchObject({
      auto: true,
      turnId: "t1",
      fileChanges: ["a.ts"],
      messageIndex: 3,
    });

    // 重载后视图一致（含 messageIndex 口径）
    const reloaded = await SessionStore.load(filePath);
    expect(reloaded.checkpoints).toEqual(points);
    // 检查点不参与消息重放
    expect(reloaded.messagesForClient).toHaveLength(3);
  });
});

describe("SessionStore compaction quality", () => {
  it("records the metric without touching effective messages", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-sessions-"));
    const filePath = path.join(dir, "session.jsonl");
    const session = await SessionStore.create(filePath, "D:/work");
    await session.appendMessage({ role: "user", content: "hello" });
    await session.appendCompactionQuality({
      compactionId: "c1",
      baselineCount: 3,
      rereadPaths: ["src/a.ts"],
      windowTurns: 5,
    });
    await session.appendMessage({ role: "assistant", content: "hi" });

    // 观测条目不进请求历史
    expect(session.effectiveMessages.map((message) => message.content)).toEqual(["hello", "hi"]);
    expect(session.lastCompactionQuality).toMatchObject({
      compactionId: "c1",
      baselineCount: 3,
      rereadPaths: ["src/a.ts"],
      windowTurns: 5,
    });

    const loaded = await SessionStore.load(filePath);
    expect(loaded.lastCompactionQuality?.rereadPaths).toEqual(["src/a.ts"]);
    expect(loaded.effectiveMessages).toHaveLength(2);
  });
});

describe("SessionStore turn file change groups", () => {
  const snapshot = async () => ({
    ownerId: "owner-1",
    file: "index/cp.json",
    count: 2,
    bytes: 12,
    cwd: "D:/work",
  });

  it("aggregates per-path stats and points at the turn's auto checkpoint", async () => {
    const { session } = await makeStore();
    const checkpoint = await session.appendCheckpoint(
      { auto: true, turnId: "t1", fileChanges: [] },
      snapshot,
    );
    await session.appendTurnStart({ turnId: "t1" });
    await session.appendMessage({ role: "user", content: "go" });
    await session.appendMessage({ role: "assistant", content: "ok" });
    await session.appendFileChange(
      "src/a.ts",
      "edit_file",
      "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n- one\n+ two\n+ three",
    );
    await session.appendFileChange(
      "src/a.ts",
      "edit_file",
      "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n+ four",
    );
    await session.appendFileChange(
      "src/b.ts",
      "write_file",
      "--- /dev/null\n+++ b/src/b.ts\n@@\n+ hello",
    );
    await session.appendTurnEnd({ turnId: "t1", status: "completed" });

    expect(session.turnFileChangeGroups).toEqual([
      {
        turnId: "t1",
        messageIndex: 2,
        checkpointId: checkpoint.id,
        canRewind: true,
        files: [
          { path: "src/a.ts", added: 3, removed: 1 },
          { path: "src/b.ts", added: 1, removed: 0 },
        ],
      },
    ]);
  });

  it("skips a turn that never ended (crash) and one with no file changes", async () => {
    const { session } = await makeStore();
    await session.appendTurnStart({ turnId: "t1" });
    await session.appendMessage({ role: "user", content: "go" });
    await session.appendFileChange("a.ts", "edit_file", "--- a/a.ts\n+++ b/a.ts\n@@\n+ x");
    // 没有 turn_end：视为中断，不出卡片

    await session.appendTurnStart({ turnId: "t2" });
    await session.appendMessage({ role: "assistant", content: "ok" });
    await session.appendTurnEnd({ turnId: "t2", status: "completed" });

    expect(session.turnFileChangeGroups).toEqual([]);
  });

  it("marks older checkpoints without a snapshot as not rewindable", async () => {
    const { session } = await makeStore();
    await session.appendCheckpoint({ auto: true, turnId: "t1", fileChanges: [] });
    await session.appendTurnStart({ turnId: "t1" });
    await session.appendFileChange("a.ts", "edit_file", "--- a/a.ts\n+++ b/a.ts\n@@\n+ x");
    await session.appendTurnEnd({ turnId: "t1", status: "completed" });

    const [group] = session.turnFileChangeGroups;
    expect(group.canRewind).toBe(false);
    expect(group.checkpointId).toBeTruthy();
  });
});

describe("SessionStore turn durations", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("measures wall-clock per turn and maps to messageIndex (turn-changes 口径)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T00:00:00.000Z"));
    const { session } = await makeStore();
    await session.appendTurnStart({ turnId: "t1" });
    await session.appendMessage({ role: "user", content: "go" });
    await session.appendMessage({ role: "assistant", content: "ok" });
    vi.setSystemTime(new Date("2026-11-07T00:00:03.500Z"));
    await session.appendTurnEnd({ turnId: "t1", status: "completed" });

    expect(session.turnDurations).toEqual([
      {
        turnId: "t1",
        messageIndex: 2,
        durationMs: 3500,
        status: "completed",
        endedAt: "2026-11-07T00:00:03.500Z",
      },
    ]);
  });

  it("spans continuation segments: first turn_start → last turn_end of same turnId", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T00:00:00.000Z"));
    const { session } = await makeStore();
    await session.appendTurnStart({ turnId: "t1" });
    await session.appendMessage({ role: "user", content: "go" });
    vi.setSystemTime(new Date("2026-11-07T00:00:02.000Z"));
    await session.appendTurnEnd({ turnId: "t1", status: "completed" });
    // 续命段复用同 turnId，不重写 turn_start
    await session.appendMessage({ role: "assistant", content: "more" });
    vi.setSystemTime(new Date("2026-11-07T00:00:05.000Z"));
    await session.appendTurnEnd({ turnId: "t1", status: "completed" });

    expect(session.turnDurations).toEqual([
      {
        turnId: "t1",
        messageIndex: 2,
        durationMs: 5000,
        status: "completed",
        endedAt: "2026-11-07T00:00:05.000Z",
      },
    ]);
  });

  it("keeps aborted turns with a neutral status (not treated as error)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T00:00:00.000Z"));
    const { session } = await makeStore();
    await session.appendTurnStart({ turnId: "t1" });
    await session.appendMessage({ role: "user", content: "go" });
    vi.setSystemTime(new Date("2026-11-07T00:00:01.250Z"));
    await session.appendTurnEnd({ turnId: "t1", status: "aborted" });

    expect(session.turnDurations).toEqual([
      {
        turnId: "t1",
        messageIndex: 1,
        durationMs: 1250,
        status: "aborted",
        endedAt: "2026-11-07T00:00:01.250Z",
      },
    ]);
  });

  it("skips an orphan turn_start (crash) and a turn_end without a start", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T00:00:00.000Z"));
    const { session } = await makeStore();
    // 无 turn_start 的 recovered turn_end：跳过
    await session.appendTurnEnd({ turnId: "recovered-x", status: "interrupted" });
    // 有 start 无 end（崩溃）：跳过
    await session.appendTurnStart({ turnId: "t1" });
    await session.appendMessage({ role: "user", content: "go" });

    expect(session.turnDurations).toEqual([]);
  });

  it("interrupted 轮用最后活动时间，不把重启停机时间算进去", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T00:00:00.000Z"));
    const { session } = await makeStore();
    await session.appendTurnStart({ turnId: "t1" });
    vi.setSystemTime(new Date("2026-11-07T00:00:01.000Z"));
    await session.appendMessage({ role: "user", content: "go" });
    // 崩溃后下次启动才补写 turn_end：墙钟差是 1 小时，真实活动只到第 1 秒
    vi.setSystemTime(new Date("2026-11-07T01:00:00.000Z"));
    await session.appendTurnEnd({ turnId: "t1", status: "interrupted" });

    expect(session.turnDurations).toEqual([
      {
        turnId: "t1",
        messageIndex: 1,
        durationMs: 1000,
        status: "interrupted",
        endedAt: "2026-11-07T00:00:01.000Z",
      },
    ]);
  });

  it("aggregates per-turn chat usage and ignores other sources", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T00:00:00.000Z"));
    const { session } = await makeStore();
    await session.appendTurnStart({ turnId: "t1" });
    await session.appendMessage({ role: "user", content: "go" });
    await session.appendUsage({
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
      source: "chat",
      turnId: "t1",
    });
    // 标题 / 建议等辅助请求不计入本回合
    await session.appendUsage({ inputTokens: 5, outputTokens: 5, source: "title", turnId: "t1" });
    vi.setSystemTime(new Date("2026-11-07T00:00:02.000Z"));
    await session.appendTurnEnd({ turnId: "t1", status: "completed" });

    expect(session.turnDurations).toEqual([
      {
        turnId: "t1",
        messageIndex: 1,
        durationMs: 2000,
        status: "completed",
        endedAt: "2026-11-07T00:00:02.000Z",
        usage: {
          inputTokens: 100,
          outputTokens: 40,
          cacheReadTokens: 30,
          cacheWriteTokens: 10,
          totalTokens: 140,
        },
      },
    ]);
  });
});
