import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startServer } from "./server.js";

// 集成测试：真实 server 启停 + jiti 全量重编译 + MCP 子进程，
// 并行负载下单例可达 10s 以上；给足余量，避免把「机器忙」误报成失败。
vi.setConfig({ testTimeout: 30_000, hookTimeout: 40_000 });

const TOKEN = "parallel-token";
let server: http.Server;
let provider: http.Server;
/** 挂起的 provider 响应：压缩用例结束时统一放掉，避免测试进程悬空 */
let providerResponses: http.ServerResponse[] = [];
let baseUrl = "";
let sessionsDir = "";

type SessionInfo = {
  id: string;
  filePath: string;
  runningSessionIds?: string[];
  compactingSessionIds?: string[];
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

async function sessionInfo(): Promise<SessionInfo> {
  const response = await request("/session");
  expect(response.status).toBe(200);
  return (await response.json()) as SessionInfo;
}

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 8000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeAll(async () => {
  sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-parallel-"));
  // 挂起的 SSE provider：立即回响应头，但永不发送 data，回合会一直处于运行中
  provider = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(": waiting\n\n");
    providerResponses.push(response);
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Provider server has no port.");

  process.env.MEOWCODE_PROVIDERS = JSON.stringify([
    {
      id: "p",
      name: "Hanging provider",
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: "m",
      apiKey: "secret",
    },
  ]);
  process.env.MEOWCODE_SESSIONS_DIR = sessionsDir;
  process.env.MEOWCODE_PROVIDER_ID = "p";
  process.env.MEOWCODE_WORKSPACE = "";

  server = await startServer({ port: 0, token: TOKEN });
  const serverAddress = server.address();
  if (!serverAddress || typeof serverAddress === "string") throw new Error("Server has no port.");
  baseUrl = `http://127.0.0.1:${serverAddress.port}`;
});

afterAll(async () => {
  await server.shutdown("test");
  (provider as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await rm(sessionsDir, { recursive: true, force: true });
});

describe("parallel main sessions", () => {
  it("keeps a background turn running and starts another session in parallel", async () => {
    const firstResponse = await request("/session/new", {
      method: "POST",
      body: { cwd: sessionsDir },
    });
    const first = (await firstResponse.json()) as SessionInfo;
    const firstPrompt = await request("/session/prompt", {
      method: "POST",
      body: { message: "first task" },
    });
    expect(firstPrompt.status).toBe(202);
    await waitFor(async () => {
      const info = await sessionInfo();
      return info.runningSessionIds?.includes(first.id) ? info : null;
    });

    // 运行中的会话不能被删除或分支
    const busyDelete = await request("/sessions/delete", {
      method: "POST",
      body: { filePath: first.filePath },
    });
    expect(busyDelete.status).toBe(409);
    const busyBranch = await request("/sessions/branch", {
      method: "POST",
      body: { filePath: first.filePath },
    });
    expect(busyBranch.status).toBe(409);

    // 新建第二个会话时，第一个 runtime 应转入后台继续跑
    const secondResponse = await request("/session/new", {
      method: "POST",
      body: { cwd: sessionsDir },
    });
    const second = (await secondResponse.json()) as SessionInfo;
    const afterNew = await sessionInfo();
    expect(afterNew.id).toBe(second.id);
    expect(afterNew.runningSessionIds).toContain(first.id);
    expect(afterNew.runningSessionIds).not.toContain(second.id);

    // 第二个会话也能同时开始自己的回合
    const secondPrompt = await request("/session/prompt", {
      method: "POST",
      body: { message: "second task" },
    });
    expect(secondPrompt.status).toBe(202);
    await waitFor(async () => {
      const info = await sessionInfo();
      const running = info.runningSessionIds ?? [];
      return running.includes(first.id) && running.includes(second.id) ? info : null;
    });

    // 停止当前会话只影响它自己
    const abortSecond = await request("/session/abort", { method: "POST" });
    expect(abortSecond.status).toBe(200);
    await waitFor(async () => {
      const info = await sessionInfo();
      const running = info.runningSessionIds ?? [];
      return running.includes(first.id) && !running.includes(second.id) ? info : null;
    });

    // 切回后台会话：runtime 提升为当前，回合仍在，可继续停止
    const switched = await request("/session/switch", {
      method: "POST",
      body: { filePath: first.filePath },
    });
    expect(switched.status).toBe(200);
    const back = await sessionInfo();
    expect(back.id).toBe(first.id);
    expect(back.runningSessionIds).toContain(first.id);

    await request("/session/abort", { method: "POST" });
    await waitFor(async () => {
      const info = await sessionInfo();
      return (info.runningSessionIds ?? []).length === 0 ? info : null;
    });
  });

  it("stops a background session by sessionId without switching to it", async () => {
    const firstResponse = await request("/session/new", {
      method: "POST",
      body: { cwd: sessionsDir },
    });
    const first = (await firstResponse.json()) as SessionInfo;
    await request("/session/prompt", { method: "POST", body: { message: "long task" } });
    await waitFor(async () =>
      (await sessionInfo()).runningSessionIds?.includes(first.id) ? true : null,
    );

    const secondResponse = await request("/session/new", {
      method: "POST",
      body: { cwd: sessionsDir },
    });
    const second = (await secondResponse.json()) as SessionInfo;
    await request("/session/prompt", { method: "POST", body: { message: "other task" } });
    await waitFor(async () => {
      const info = await sessionInfo();
      const running = info.runningSessionIds ?? [];
      return running.includes(first.id) && running.includes(second.id) ? info : null;
    });

    const invalid = await request("/session/abort", { method: "POST", body: { sessionId: 42 } });
    expect(invalid.status).toBe(400);
    const unknown = await request("/session/abort", { method: "POST", body: { sessionId: "nope" } });
    expect(unknown.status).toBe(404);

    // 关键：仍停在第二个会话，直接停掉后台的第一个
    const abortBackground = await request("/session/abort", {
      method: "POST",
      body: { sessionId: first.id },
    });
    expect(abortBackground.status).toBe(200);
    await waitFor(async () => {
      const info = await sessionInfo();
      const running = info.runningSessionIds ?? [];
      return !running.includes(first.id) && running.includes(second.id) ? info : null;
    });
    expect((await sessionInfo()).id).toBe(second.id);

    // 不带 sessionId 仍然作用于前台会话
    await request("/session/abort", { method: "POST" });
    await waitFor(async () =>
      (await sessionInfo()).runningSessionIds?.length === 0 ? true : null,
    );
  });

  it("keeps compaction visible after switching away and blocks prompts", async () => {
    const before = await sessionInfo();
    const compactingId = before.id;
    const compactRequest = request("/session/compact", { method: "POST" });
    await waitFor(async () => {
      const info = await sessionInfo();
      return info.compactingSessionIds?.includes(compactingId) ? info : null;
    });

    // 压缩期间当前会话拒绝发送
    const blocked = await request("/session/prompt", {
      method: "POST",
      body: { message: "during compaction" },
    });
    expect(blocked.status).toBe(409);

    // 切到新会话后压缩状态仍按会话保留（后台 runtime 不能因为“空闲”被丢掉）
    const otherResponse = await request("/session/new", {
      method: "POST",
      body: { cwd: sessionsDir },
    });
    const other = (await otherResponse.json()) as SessionInfo;
    const afterNew = await sessionInfo();
    expect(afterNew.id).toBe(other.id);
    expect(afterNew.compactingSessionIds).toContain(compactingId);

    // 放掉挂起的摘要请求：空摘要 → compaction_failed → 状态清空
    for (const response of providerResponses.splice(0)) {
      if (!response.writableEnded && !response.destroyed) response.end();
    }
    const failed = await compactRequest;
    expect(failed.status).toBe(400);
    await waitFor(async () => {
      const info = await sessionInfo();
      return (info.compactingSessionIds ?? []).length === 0 ? info : null;
    });
  });
});
