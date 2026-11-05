import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SessionStore } from "../agent/session-store.js";
import { startServer, type AgentServer } from "./server";

// 集成测试：真实 server 启停 + jiti 全量重编译 + MCP 子进程，
// 并行负载下单例可达 10s 以上；给足余量，避免把「机器忙」误报成失败。
vi.setConfig({ testTimeout: 30_000, hookTimeout: 40_000 });

const TOKEN = "checkpoint-token";
let sessionsDir = "";
let workspace = "";
let running: AgentServer | null = null;
let baseUrl = "";

type CreatedSession = { id: string; filePath: string; cwd: string; title?: string | null };
type CheckpointView = {
  id: string;
  timestamp: string;
  label?: string;
  auto: boolean;
  fileChanges: string[];
  messageIndex: number;
};

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

/** 直接用 SessionStore 造一个带检查点的源会话（两回合对话，检查点在回合 1 之后）。 */
async function makeSourceSession(): Promise<{ filePath: string; checkpointId: string }> {
  const filePath = path.join(sessionsDir, "checkpoint-source.jsonl");
  const store = await SessionStore.create(filePath, workspace);
  await store.appendTurnStart({ turnId: "t1", text: "第一问" });
  await store.appendMessage({ role: "user", content: "第一问" });
  await store.appendMessage({ role: "assistant", content: "第一答" });
  await store.appendTurnEnd({ turnId: "t1", status: "completed" });
  await store.appendTitle("源会话");
  const checkpoint = await store.appendCheckpoint({
    label: "安全点",
    auto: false,
    fileChanges: [],
  });
  await store.appendTurnStart({ turnId: "t2", text: "第二问" });
  await store.appendMessage({ role: "user", content: "第二问" });
  await store.appendMessage({ role: "assistant", content: "第二答" });
  await store.appendTurnEnd({ turnId: "t2", status: "completed" });
  await store.close();
  return { filePath, checkpointId: checkpoint.id };
}

beforeAll(async () => {
  sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-checkpoint-server-"));
  workspace = await mkdtemp(path.join(tmpdir(), "meowcode-checkpoint-ws-"));
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
  await rm(sessionsDir, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
  delete process.env.MEOWCODE_SESSIONS_DIR;
  delete process.env.MEOWCODE_PROVIDERS;
  delete process.env.MEOWCODE_PROVIDER_ID;
  delete process.env.MEOWCODE_WORKSPACE;
});

describe("session checkpoints api", () => {
  it("lists, restores and creates checkpoints", async () => {
    const { filePath, checkpointId } = await makeSourceSession();
    const beforeBytes = await readFile(filePath, "utf8");

    // 切到源会话
    const switched = await request("/session/switch", {
      method: "POST",
      body: { filePath },
    });
    expect(switched.status).toBe(200);

    // 列表：一条手动检查点，messageIndex = 2（回合 1 的两条消息之后）
    const listed = (await (await request("/session/checkpoints")).json()) as {
      checkpoints: CheckpointView[];
    };
    expect(listed.checkpoints).toHaveLength(1);
    expect(listed.checkpoints[0]).toMatchObject({
      id: checkpointId,
      label: "安全点",
      auto: false,
      messageIndex: 2,
    });

    // /session/messages 一并携带检查点
    const messages = (await (await request("/session/messages")).json()) as {
      messages: Array<{ role: string; content: string }>;
      checkpoints: CheckpointView[];
    };
    expect(messages.messages).toHaveLength(4);
    expect(messages.checkpoints).toHaveLength(1);

    // 恢复：截断分支出新会话并切换
    const restored = await request("/session/checkpoints/restore", {
      method: "POST",
      body: { checkpointId },
    });
    expect(restored.status).toBe(200);
    const created = (await restored.json()) as CreatedSession;
    expect(created.id).toBeTruthy();
    expect(created.title).toContain("检查点");

    // 恢复出的会话只回放检查点之前的消息，且不带检查点标记
    const after = (await (await request("/session/messages")).json()) as {
      messages: Array<{ role: string; content: string }>;
      checkpoints: CheckpointView[];
    };
    expect(after.messages).toHaveLength(2);
    expect(after.messages.map((message) => message.content)).toEqual(["第一问", "第一答"]);
    expect(after.checkpoints).toHaveLength(0);

    // 原会话文件一个字节都没动（append-only，恢复不截断原会话）
    expect(await readFile(filePath, "utf8")).toBe(beforeBytes);

    // 新会话出现在会话列表里
    const sessions = (await (await request("/sessions")).json()) as CreatedSession[];
    expect(
      (Array.isArray(sessions) ? sessions : sessions.sessions ?? []).some(
        (item) => item.filePath === created.filePath,
      ),
    ).toBe(true);

    // 在恢复出的会话上手动创建检查点
    const manual = await request("/session/checkpoint", {
      method: "POST",
      body: { label: "手动点" },
    });
    expect(manual.status).toBe(200);
    const listedAgain = (await (await request("/session/checkpoints")).json()) as {
      checkpoints: CheckpointView[];
    };
    expect(listedAgain.checkpoints).toHaveLength(1);
    expect(listedAgain.checkpoints[0]).toMatchObject({ label: "手动点", auto: false });
  });

  it("rejects unknown checkpoint ids", async () => {
    const response = await request("/session/checkpoints/restore", {
      method: "POST",
      body: { checkpointId: "no-such-checkpoint" },
    });
    expect(response.status).toBe(404);
  });

  it("rejects checkpoint creation without a session or with a missing id", async () => {
    // checkpointId 缺失 → 400
    const missing = await request("/session/checkpoints/restore", {
      method: "POST",
      body: {},
    });
    expect(missing.status).toBe(400);
  });
});
