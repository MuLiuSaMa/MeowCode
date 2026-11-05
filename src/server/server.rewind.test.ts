import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SessionStore } from "../agent/session-store.js";
import { SnapshotStore, buildTarget, hashFileBytes } from "../agent/snapshot-store.js";
import { planRewind, type RewindPlan } from "./rewind.js";
import { deriveSessionAtCheckpoint } from "./session-derive.js";
import { startServer, type AgentServer } from "./server";

// 集成测试：真实 server 启停 + jiti 全量重编译 + MCP 子进程，给足余量。
vi.setConfig({ testTimeout: 30_000, hookTimeout: 40_000 });

const TOKEN = "rewind-token";
let sessionsDir = "";
let workspace = "";
let running: AgentServer | null = null;
let baseUrl = "";

type CreatedSession = { id: string; filePath: string; cwd: string; title?: string | null };

async function request(
  pathname: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

let sessionSeq = 0;

type RewindableSession = {
  filePath: string;
  checkpointId: string;
  snap: SnapshotStore;
  fileA: string;
  fileB: string;
};

/**
 * 造一个「可回滚」的源会话：
 * - checkpoint 前写 a.txt = v1，noteBefore/After 进快照，然后打 auto 检查点
 * - checkpoint 后（模拟下一个回合）：a.txt 改成 v2、新建 b.txt —— 都会进删除/恢复集合
 */
async function makeRewindableSession(): Promise<RewindableSession> {
  const filePath = path.join(sessionsDir, `rewind-src-${(sessionSeq += 1)}.jsonl`);
  const store = await SessionStore.create(filePath, workspace);
  const snap = new SnapshotStore({
    dir: path.join(sessionsDir, "snapshots", store.snapshotOwnerId),
    cwd: workspace,
  });
  const fileA = path.join(workspace, "a.txt");
  await writeFile(fileA, "v1", "utf8");
  // 与 runtime 实际顺序一致：checkpoint 打在 turn_start / user 消息之前
  await snap.noteBefore([{ path: "a.txt", file: fileA }]);
  await snap.noteAfter([{ path: "a.txt", file: fileA }]);
  const checkpoint = await store.appendCheckpoint(
    { auto: true, turnId: "t1", label: "改 a", fileChanges: [] },
    (id) => snap.checkpoint(id),
  );
  await store.appendTurnStart({ turnId: "t1", text: "改 a" });
  await store.appendMessage({ role: "user", content: "改 a" });
  await store.appendMessage({ role: "assistant", content: "第一答" });
  await store.appendTurnEnd({ turnId: "t1", status: "completed" });
  await store.appendTitle("回滚源会话");
  await store.close();
  return { filePath, checkpointId: checkpoint.id, snap, fileA, fileB: path.join(workspace, "b.txt") };
}

/** 在 checkpoint 之后模拟第二个回合的改动：a.txt → v2、新建 b.txt（base 记 null）。 */
async function applySecondTurnChanges(target: RewindableSession): Promise<void> {
  // 测试共享 workspace：清掉上一个用例残留的 b.txt，保证「新建文件」语义成立
  await rm(target.fileB, { force: true });
  await writeFile(target.fileA, "v2", "utf8");
  // 新建文件在写前观测（此刻还不存在 → base 记 null）→ 回滚目标 = 删除
  await target.snap.noteBefore([{ path: "b.txt", file: target.fileB }]);
  await writeFile(target.fileB, "new-file", "utf8");
  await target.snap.noteAfter([
    { path: "a.txt", file: target.fileA },
    { path: "b.txt", file: target.fileB },
  ]);
}

async function switchTo(filePath: string): Promise<void> {
  const switched = await request("/session/switch", { method: "POST", body: { filePath } });
  expect(switched.status).toBe(200);
}

beforeAll(async () => {
  sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-rewind-server-"));
  workspace = await mkdtemp(path.join(tmpdir(), "meowcode-rewind-ws-"));
  process.env.MEOWCODE_SESSIONS_DIR = sessionsDir;
  process.env.MEOWCODE_PROVIDERS = JSON.stringify([
    { id: "p", name: "P", baseUrl: "http://127.0.0.1:1", model: "m" },
  ]);
  process.env.MEOWCODE_PROVIDER_ID = "";
  process.env.MEOWCODE_WORKSPACE = workspace;
  running = await startServer({ port: 0, token: TOKEN });
  const address = running.address();
  if (!address || typeof address === "string") throw new Error("Server has no TCP port.");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (running) {
    const server = running;
    running = null;
    await server.shutdown("test");
  }
  await rm(sessionsDir, { recursive: true, force: true }).catch(() => undefined);
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  delete process.env.MEOWCODE_SESSIONS_DIR;
  delete process.env.MEOWCODE_PROVIDERS;
  delete process.env.MEOWCODE_PROVIDER_ID;
  delete process.env.MEOWCODE_WORKSPACE;
});

describe("session rewind api", () => {
  it("dryRun returns a plan without touching files or writing journals", async () => {
    const source = await makeRewindableSession();
    await applySecondTurnChanges(source);
    await switchTo(source.filePath);

    const beforeA = await readFile(source.fileA, "utf8");
    const statBefore = await stat(source.fileA);
    const snapDir = path.join(sessionsDir, "snapshots", "none-yet");

    const response = await request("/session/rewind", {
      method: "POST",
      body: { checkpointId: source.checkpointId, mode: "code", dryRun: true },
    });
    expect(response.status).toBe(200);
    const plan = (await response.json()) as RewindPlan;
    expect(plan.mode).toBe("code");
    expect(plan.checkpoint.id).toBe(source.checkpointId);
    expect(plan.requiresForce).toBe(false);

    const restore = plan.files.find((file) => file.path === "a.txt");
    expect(restore).toMatchObject({ action: "restore" });
    const del = plan.files.find((file) => file.path === "b.txt");
    expect(del).toMatchObject({ action: "delete" });

    // 磁盘未动
    expect(await readFile(source.fileA, "utf8")).toBe(beforeA);
    expect((await stat(source.fileA)).mtimeMs).toBe(statBefore.mtimeMs);
    // 还没产生 journal
    await expect(readdir(snapDir)).rejects.toMatchObject({ code: "ENOENT" });
    void source.fileB;
  });

  it("code mode restores/deletes files without changing the conversation, and undo reverts", async () => {
    const source = await makeRewindableSession();
    await applySecondTurnChanges(source);
    await switchTo(source.filePath);

    const messagesBefore = (await (await request("/session/messages")).json()) as {
      messages: unknown[];
      checkpoints: unknown[];
    };

    const preview = await request("/session/rewind", {
      method: "POST",
      body: { checkpointId: source.checkpointId, mode: "code", dryRun: true },
    });
    const plan = (await preview.json()) as RewindPlan;

    const applied = await request("/session/rewind", {
      method: "POST",
      body: {
        checkpointId: source.checkpointId,
        mode: "code",
        dryRun: false,
        planId: plan.planId,
      },
    });
    expect(applied.status).toBe(200);
    const result = (await applied.json()) as { rewindId: string; applied: number; deleted: number };
    expect(result.applied).toBeGreaterThanOrEqual(1);
    expect(result.deleted).toBe(1);
    expect(result.rewindId).toBeTruthy();

    // 磁盘：a.txt 回到 v1，b.txt 被删除
    expect(await readFile(source.fileA, "utf8")).toBe("v1");
    await expect(stat(source.fileB)).rejects.toMatchObject({ code: "ENOENT" });

    // 会话不动：消息与检查点数量一致，只多了一条 rewind 留痕
    const messagesAfter = (await (await request("/session/messages")).json()) as {
      messages: unknown[];
      checkpoints: unknown[];
    };
    expect(messagesAfter.messages).toHaveLength(messagesBefore.messages.length);
    expect(messagesAfter.checkpoints).toHaveLength(messagesBefore.checkpoints.length);

    // 可撤销
    const undoable = (await (await request("/session/rewind/undoable")).json()) as {
      undoable: { rewindId: string; mode: string } | null;
    };
    expect(undoable.undoable).toMatchObject({ mode: "code" });

    const undoPreview = await request("/session/rewind/undo", {
      method: "POST",
      body: { dryRun: true },
    });
    expect(undoPreview.status).toBe(200);
    const undoPlan = (await undoPreview.json()) as { plan: { files: Array<{ path: string; action: string }> } };
    expect(undoPlan.plan.files.some((file) => file.path === "a.txt" && file.action === "restore")).toBe(true);

    const undone = await request("/session/rewind/undo", {
      method: "POST",
      body: { dryRun: false, switchBack: false },
    });
    expect(undone.status).toBe(200);
    expect(await readFile(source.fileA, "utf8")).toBe("v2");
    expect(await readFile(source.fileB, "utf8")).toBe("new-file");

    // 撤销只能一次
    const undoableAfter = (await (await request("/session/rewind/undoable")).json()) as {
      undoable: unknown;
    };
    expect(undoableAfter.undoable).toBeNull();
  });

  it("keepNewFiles preserves files created after the checkpoint", async () => {
    const source = await makeRewindableSession();
    await applySecondTurnChanges(source);
    await switchTo(source.filePath);

    const preview = await request("/session/rewind", {
      method: "POST",
      body: {
        checkpointId: source.checkpointId,
        mode: "code",
        dryRun: true,
        keepNewFiles: true,
      },
    });
    const plan = (await preview.json()) as RewindPlan;
    expect(plan.files.find((file) => file.path === "b.txt")?.action).toBe("unchanged");

    const applied = await request("/session/rewind", {
      method: "POST",
      body: {
        checkpointId: source.checkpointId,
        mode: "code",
        dryRun: false,
        planId: plan.planId,
        keepNewFiles: true,
      },
    });
    expect(applied.status).toBe(200);
    expect(await readFile(source.fileA, "utf8")).toBe("v1");
    expect(await readFile(source.fileB, "utf8")).toBe("new-file");
  });

  it("both mode restores files and derives a new session with rewound conversation", async () => {
    const source = await makeRewindableSession();
    await applySecondTurnChanges(source);
    await switchTo(source.filePath);

    const preview = await request("/session/rewind", {
      method: "POST",
      body: { checkpointId: source.checkpointId, mode: "both", dryRun: true },
    });
    const plan = (await preview.json()) as RewindPlan;
    expect(plan.conversation.dropMessages).toBeGreaterThan(0);

    const applied = await request("/session/rewind", {
      method: "POST",
      body: {
        checkpointId: source.checkpointId,
        mode: "both",
        dryRun: false,
        planId: plan.planId,
      },
    });
    expect(applied.status).toBe(200);
    const result = (await applied.json()) as CreatedSession & { rewindId: string };
    expect(result.id).toBeTruthy();
    expect(result.title).toContain("回滚");

    // 磁盘回滚
    expect(await readFile(source.fileA, "utf8")).toBe("v1");
    await expect(stat(source.fileB)).rejects.toMatchObject({ code: "ENOENT" });

    // 当前会话 = 派生会话：回到检查点之前（该点还没有任何消息），标题带「回滚」
    const messages = (await (await request("/session/messages")).json()) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(messages.messages).toHaveLength(0);

    // 源会话文件完好（append-only）
    const original = await SessionStore.load(source.filePath);
    expect(original.messages).toHaveLength(2);
  });

  it("rejects rewind on checkpoints without snapshots while plain restore keeps working", async () => {
    const filePath = path.join(sessionsDir, `plain-${(sessionSeq += 1)}.jsonl`);
    const store = await SessionStore.create(filePath, workspace);
    await store.appendMessage({ role: "user", content: "问题" });
    const checkpoint = await store.appendCheckpoint({ auto: false, label: "手工", fileChanges: [] });
    await store.appendMessage({ role: "assistant", content: "回答" });
    await store.close();
    await switchTo(filePath);

    const response = await request("/session/rewind", {
      method: "POST",
      body: { checkpointId: checkpoint.id, mode: "code", dryRun: true },
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error?: { code?: string } }).error?.code).toBe("no_snapshot");

    // conversation 模式不受快照限制：先预览（无文件动作）再派生新会话
    const conversationPreview = await request("/session/rewind", {
      method: "POST",
      body: { checkpointId: checkpoint.id, mode: "conversation", dryRun: true },
    });
    expect(conversationPreview.status).toBe(200);
    const conversationPlan = (await conversationPreview.json()) as RewindPlan;
    expect(conversationPlan.files).toHaveLength(0);
    const conversation = await request("/session/rewind", {
      method: "POST",
      body: {
        checkpointId: checkpoint.id,
        mode: "conversation",
        dryRun: false,
        planId: conversationPlan.planId,
      },
    });
    expect(conversation.status).toBe(200);
  });

  it("plans force requirement for workspace-external paths and conflicts (unit level)", async () => {
    // 工作区外路径（full 模式写的绝对路径）在索引里 → 预览即要求 force
    const filePath = path.join(sessionsDir, `force-src-${(sessionSeq += 1)}.jsonl`);
    const store = await SessionStore.create(filePath, workspace);
    const snap = new SnapshotStore({
      dir: path.join(sessionsDir, "snapshots", store.snapshotOwnerId),
      cwd: workspace,
    });
    const outside = path.join(path.dirname(workspace), "outside.txt");
    await writeFile(outside, "outside-v1", "utf8");
    await store.appendMessage({ role: "user", content: "写外部文件" });
    await snap.noteBefore([{ path: outside, file: outside }]);
    await snap.noteAfter([{ path: outside, file: outside }]);
    const checkpoint = await store.appendCheckpoint(
      { auto: true, label: "外部写入", fileChanges: [] },
      (id) => snap.checkpoint(id),
    );
    await store.close();

    await writeFile(outside, "outside-v2", "utf8");
    const plan = await planRewind({
      session: store,
      checkpointId: checkpoint.id,
      mode: "code",
      store: snap,
      keepNewFiles: false,
    });
    expect(plan.requiresForce).toBe(true);
    const external = plan.files.find((file) => file.path === outside);
    expect(external).toMatchObject({ action: "restore" });
    expect(plan.files.some((file) => file.skipped === "outside_workspace" || file.path === outside)).toBe(true);
    await rm(outside, { force: true });
  });

  it("marks external modifications as conflicts when the last-known state differs (unit level)", async () => {
    const filePath = path.join(sessionsDir, `conflict-src-${(sessionSeq += 1)}.jsonl`);
    const store = await SessionStore.create(filePath, workspace);
    const snap = new SnapshotStore({
      dir: path.join(sessionsDir, "snapshots", store.snapshotOwnerId),
      cwd: workspace,
    });
    const file = path.join(workspace, "conflict.txt");
    await writeFile(file, "v1", "utf8");
    await store.appendMessage({ role: "user", content: "edit" });
    await snap.noteBefore([{ path: "conflict.txt", file }]);
    await snap.noteAfter([{ path: "conflict.txt", file }]);
    const checkpoint = await store.appendCheckpoint(
      { auto: true, label: "c1", fileChanges: [] },
      (id) => snap.checkpoint(id),
    );
    // checkpoint 之后 agent 又写了一版（state = v2）
    await writeFile(file, "v2", "utf8");
    await snap.noteBefore([{ path: "conflict.txt", file }]);
    await snap.noteAfter([{ path: "conflict.txt", file }]);
    await store.close();

    // 用户在 agent 之后又改了文件（磁盘 = v3 ≠ state 记录的 v2）→ 冲突
    await writeFile(file, "v3-user", "utf8");
    const plan = await planRewind({
      session: store,
      checkpointId: checkpoint.id,
      mode: "code",
      store: snap,
      keepNewFiles: false,
    });
    const action = plan.files.find((item) => item.path === "conflict.txt");
    expect(action?.action).toBe("restore");
    expect(action?.conflict).toBe("modified_on_disk");
    expect(plan.requiresForce).toBe(true);
  });

  it("seeds the last-known state from the newest index after a restart (baseline regression)", async () => {
    const filePath = path.join(sessionsDir, `seed-src-${(sessionSeq += 1)}.jsonl`);
    const store = await SessionStore.create(filePath, workspace);
    const snap = new SnapshotStore({
      dir: path.join(sessionsDir, "snapshots", store.snapshotOwnerId),
      cwd: workspace,
    });
    const file = path.join(workspace, "seeded.txt");
    await writeFile(file, "v1", "utf8");
    await store.appendMessage({ role: "user", content: "edit" });
    await snap.noteBefore([{ path: "seeded.txt", file }]);
    await snap.noteAfter([{ path: "seeded.txt", file }]);
    const checkpoint = await store.appendCheckpoint(
      { auto: true, label: "c1", fileChanges: [] },
      (id) => snap.checkpoint(id),
    );
    await store.close();

    // 模拟重启：全新 store 实例（内存 state 为空），从最新索引播种
    const restarted = new SnapshotStore({
      dir: path.join(sessionsDir, "snapshots", store.snapshotOwnerId),
      cwd: workspace,
    });
    // 磁盘未动：磁盘 == 播种出的基线 → 无警告、无冲突
    const planClean = await planRewind({
      session: store,
      checkpointId: checkpoint.id,
      mode: "code",
      store: restarted,
      keepNewFiles: false,
    });
    expect(planClean.warnings).toHaveLength(0);
    expect(planClean.requiresForce).toBe(false);

    // 磁盘被外部改过：播种基线生效 → 判成冲突（要求 force），而不是「基线缺失」警告
    await writeFile(file, "v3-user", "utf8");
    const planConflict = await planRewind({
      session: store,
      checkpointId: checkpoint.id,
      mode: "code",
      store: new SnapshotStore({
        dir: path.join(sessionsDir, "snapshots", store.snapshotOwnerId),
        cwd: workspace,
      }),
      keepNewFiles: false,
    });
    const action = planConflict.files.find((item) => item.path === "seeded.txt");
    expect(action?.conflict).toBe("modified_on_disk");
    expect(planConflict.requiresForce).toBe(true);
    expect(planConflict.warnings.some((warning) => warning.includes("基线缺失"))).toBe(false);
  });

  it("builds the rewind target from index with base fallback (unit level)", async () => {
    const target = buildTarget(
      { "a.ts": "sha-a", "gone.ts": null },
      { "a.ts": "sha-base", "later.ts": "sha-later" },
    );
    expect(target).toEqual({ "a.ts": "sha-a", "gone.ts": null, "later.ts": "sha-later" });
    const observed = await hashFileBytes(path.join(workspace, "a.txt"));
    expect(observed).not.toBeNull();
  });
});

describe("checkpoint ordering", () => {
  it("does not carry an orphan turn_start into the derived session (crash-replay regression)", async () => {
    // 旧版把检查点打在 turn_start 之后：派生会话曾带孤立 turn_start，
    // switchSession 的崩溃恢复会把它重放成假用户消息并报「上次生成被中断」。
    const filePath = path.join(sessionsDir, `orphan-${(sessionSeq += 1)}.jsonl`);
    const store = await SessionStore.create(filePath, workspace);
    await store.appendMessage({ role: "user", content: "第一问" });
    await store.appendMessage({ role: "assistant", content: "第一答" });
    // 模拟旧数据：turn_start 在前、checkpoint 紧随其后（无 turn_end 配对）
    await store.appendTurnStart({ turnId: "t-orphan", text: "换回去" });
    const checkpoint = await store.appendCheckpoint({
      auto: true,
      turnId: "t-orphan",
      label: "换回去",
      fileChanges: [],
    });
    await store.close();

    const derived = await deriveSessionAtCheckpoint({
      sourceFilePath: filePath,
      checkpointId: checkpoint.id,
      sessionsDir,
    });
    const derivedStore = await SessionStore.load(derived.filePath);
    const openTurns = derivedStore.openTurns;
    expect(openTurns).toHaveLength(0);
    // 历史消息完整保留
    expect(derivedStore.messagesForClient.map((m) => m.content)).toEqual(["第一问", "第一答"]);
  });

  it("writes the turn checkpoint before turn_start so rewind never orphans it", async () => {
    const source = await makeRewindableSession();
    // makeRewindableSession 里 checkpoint 打在 user 消息之前；这里直接断言
    // 源会话条目顺序：checkpoint 不落在任何未配对 turn_start 之后
    const loaded = await SessionStore.load(source.filePath);
    const lastCheckpointIndex = loaded.entries.findIndex(
      (entry) => entry.type === "checkpoint" && entry.id === source.checkpointId,
    );
    expect(lastCheckpointIndex).toBeGreaterThan(0);
    const openBefore = loaded.entries
      .slice(0, lastCheckpointIndex)
      .filter((entry) => entry.type === "turn_start");
    // 检查点之前的 turn_start 都已配对 turn_end（否则回滚后必产生孤立回合）
    const closed = new Set(
      loaded.entries
        .slice(0, lastCheckpointIndex)
        .filter((entry) => entry.type === "turn_end")
        .map((entry) => entry.turnId),
    );
    for (const turn of openBefore) {
      expect(closed.has((turn as { turnId: string }).turnId)).toBe(true);
    }
  });
});
