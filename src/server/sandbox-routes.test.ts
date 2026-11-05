import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { probeMock, revokeMock } = vi.hoisted(() => ({
  probeMock: vi.fn(async (_options: unknown) => ({ ok: true, durationMs: 12 })),
  revokeMock: vi.fn(async (_options: unknown) => ({ ok: true, revoked: true, durationMs: 7 })),
}));

vi.mock("../agent/sandbox/runner-client.js", () => ({
  probeSandbox: probeMock,
  revokeSandboxGrantsRemote: revokeMock,
}));

import { startServer, type AgentServer } from "./server";

const TOKEN = "sandbox-routes-token";
let server: AgentServer;
let baseUrl = "";
let workspace = "";
let homeDir = "";

const auth = {
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
};

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "meowcode-sandbox-routes-"));
  homeDir = await mkdtemp(path.join(tmpdir(), "meowcode-sandbox-routes-home-"));
  process.env.MEOWCODE_SERVER_TOKEN = TOKEN;
  process.env.MEOWCODE_WORKSPACE = workspace;
  process.env.MEOWCODE_SESSIONS_DIR = path.join(workspace, ".sessions");
  process.env.MEOWCODE_HOME_DIR = homeDir;
  process.env.MEOWCODE_PROVIDERS = JSON.stringify([
    { id: "p", name: "P", baseUrl: "http://127.0.0.1:1", model: "m" },
  ]);
  server = await startServer({ port: 0 });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server has no TCP address.");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await server.shutdown("test");
  await rm(workspace, { recursive: true, force: true });
  await rm(homeDir, { recursive: true, force: true });
  delete process.env.MEOWCODE_SERVER_TOKEN;
  delete process.env.MEOWCODE_WORKSPACE;
  delete process.env.MEOWCODE_SESSIONS_DIR;
  delete process.env.MEOWCODE_HOME_DIR;
  delete process.env.MEOWCODE_PROVIDERS;
});

describe("sandbox config routes", () => {
  it("probes once when enabling and returns the live settings", async () => {
    const response = await fetch(`${baseUrl}/config/sandbox`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ enabled: true, allowTemp: false }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      enabled: true,
      allowTemp: false,
      confirmDelete: false,
      workspace,
      probeDurationMs: 12,
    });
    expect(probeMock).toHaveBeenCalledTimes(1);
    expect(probeMock.mock.calls[0]?.[0]).toMatchObject({
      workspace,
      settings: { enabled: true, allowTemp: false },
    });
  });

  it("accepts a partial patch without re-probing unchanged roots", async () => {
    const response = await fetch(`${baseUrl}/config/sandbox`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ allowTemp: true }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: true, allowTemp: true });
    expect(probeMock).toHaveBeenCalledTimes(1);
  });

  it("updates delete confirmation live without probing", async () => {
    const response = await fetch(`${baseUrl}/config/sandbox`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ confirmDelete: true }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: true, confirmDelete: true });
    expect(probeMock).toHaveBeenCalledTimes(1);

    const invalid = await fetch(`${baseUrl}/config/sandbox`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ confirmDelete: "yes" }),
    });
    expect(invalid.status).toBe(400);
  });

  it("rejects a writable root that is not an existing directory", async () => {
    const response = await fetch(`${baseUrl}/config/sandbox`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ writableRoots: [path.join(workspace, "missing")] }),
    });
    expect(response.status).toBe(400);
  });

  it("routes probe and revoke through the server workspace", async () => {
    const probe = await fetch(`${baseUrl}/config/sandbox/probe`, {
      method: "POST",
      headers: auth,
    });
    expect(probe.status).toBe(200);
    expect(await probe.json()).toMatchObject({ ok: true, backend: "windows-acl", workspace });

    const revoke = await fetch(`${baseUrl}/config/sandbox/revoke`, {
      method: "POST",
      headers: auth,
    });
    expect(revoke.status).toBe(200);
    expect(await revoke.json()).toMatchObject({ ok: true, revoked: true });
    expect(revokeMock).toHaveBeenCalledWith({ workspace, settings: expect.any(Object) });
  });

  it("reports a failed probe without applying the setting", async () => {
    probeMock.mockResolvedValueOnce({ ok: false, detail: "probe exploded", durationMs: 1 });
    const response = await fetch(`${baseUrl}/config/sandbox`, {
      method: "PUT",
      headers: auth,
      // 已启用时新增可写根会触发 probe
      body: JSON.stringify({ writableRoots: [workspace] }),
    });
    expect(response.status).toBe(400);
    const get = await fetch(`${baseUrl}/config/sandbox`, { headers: auth });
    expect(await get.json()).toMatchObject({ enabled: true, writableRoots: [] });
  });
});
