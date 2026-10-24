import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentServer } from "./server";

const TOKEN = "restart-token";
let sessionsDir = "";
let running: AgentServer | null = null;

type CreatedSession = { id: string; filePath: string; cwd: string; createdAt: string };

async function request(
  baseUrl: string,
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

async function start(): Promise<string> {
  process.env.MEOWCODE_PROVIDERS = JSON.stringify([
    { id: "p", name: "P", baseUrl: "http://127.0.0.1:1", model: "m" },
  ]);
  running = await startServer({ port: 0, token: TOKEN });
  const address = running.address();
  if (!address || typeof address === "string") throw new Error("Server has no TCP port.");
  return `http://127.0.0.1:${address.port}`;
}

async function stop(): Promise<void> {
  if (!running) return;
  const server = running;
  running = null;
  await server.shutdown("test");
}

beforeAll(async () => {
  sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-restart-"));
  process.env.MEOWCODE_SESSIONS_DIR = sessionsDir;
  process.env.MEOWCODE_PROVIDER_ID = "";
  process.env.MEOWCODE_WORKSPACE = "";
});

afterAll(async () => {
  await stop();
  await rm(sessionsDir, { recursive: true, force: true });
  delete process.env.MEOWCODE_SESSIONS_DIR;
  delete process.env.MEOWCODE_PROVIDER_ID;
  delete process.env.MEOWCODE_WORKSPACE;
});

describe("agent server restart", () => {
  it("restores the last active session instead of the newest one", async () => {
    const firstBase = await start();
    const firstResponse = await request(firstBase, "/session/new", {
      method: "POST",
      body: { cwd: sessionsDir },
    });
    const first = (await firstResponse.json()) as CreatedSession;
    const secondResponse = await request(firstBase, "/session/new", {
      method: "POST",
      body: { cwd: sessionsDir },
    });
    const second = (await secondResponse.json()) as CreatedSession;
    expect(second.id).not.toBe(first.id);

    // 切回较早的会话：state.json 应记录 first，而不是“最新”的 second
    const switched = await request(firstBase, "/session/switch", {
      method: "POST",
      body: { filePath: first.filePath },
    });
    expect(switched.status).toBe(200);
    await stop();

    const secondBase = await start();
    const current = (await (
      await request(secondBase, "/session")
    ).json()) as CreatedSession;
    expect(current.id).toBe(first.id);
    expect(current.filePath).toBe(first.filePath);
  });

  it("restores the last side session", async () => {
    const firstBase = await start();
    const created = (await (
      await request(firstBase, "/side/session/new", {
        method: "POST",
        body: { cwd: sessionsDir },
      })
    ).json()) as CreatedSession;
    await stop();

    const secondBase = await start();
    const response = await request(secondBase, "/side/session");
    expect(response.status).toBe(200);
    const current = (await response.json()) as CreatedSession;
    expect(current.id).toBe(created.id);
    expect(current.filePath).toBe(created.filePath);
  });
});
