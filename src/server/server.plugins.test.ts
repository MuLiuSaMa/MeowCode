import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentServer } from "./server";

const TOKEN = "plugins-test-token";
let server: AgentServer;
let baseUrl = "";
let sessionsDir = "";
let workspace = "";
let home = "";

beforeAll(async () => {
  sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-server-plugins-"));
  workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-plugins-"));
  home = await mkdtemp(path.join(tmpdir(), "meowcode-home-plugins-"));
  // 一个可用插件 + 一个将被禁用的插件
  const pluginsDir = path.join(workspace, ".meowcode", "plugins");
  await mkdir(pluginsDir, { recursive: true });
  await writeFile(
    path.join(pluginsDir, "hello.ts"),
    [
      "export default function (api) {",
      "  api.registerTool({",
      "    name: 'hello_tool',",
      "    description: 'says hello',",
      "    parameters: { type: 'object', properties: {} },",
      "    execute: async () => ({ output: 'hello', ok: true }),",
      "  });",
      "}",
    ].join("\n"),
  );
  await writeFile(
    path.join(pluginsDir, "off.ts"),
    "export default function (api) { api.registerCommand({ name: 'offcmd', run: () => 'x' }); }",
  );

  process.env.MEOWCODE_SESSIONS_DIR = sessionsDir;
  process.env.MEOWCODE_WORKSPACE = workspace;
  process.env.MEOWCODE_PLUGINS = JSON.stringify({ disabled: ["off"] });
  process.env.MEOWCODE_PROVIDERS = JSON.stringify([
    { id: "p1", name: "provider", baseUrl: "http://127.0.0.1:1", model: "m", apiKey: "secret" },
  ]);
  process.env.MEOWCODE_SERVER_TOKEN = TOKEN;

  server = await startServer({ port: 0 });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server has no TCP address.");
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 30_000);

afterAll(async () => {
  await server.shutdown("test");
  await Promise.all([
    rm(sessionsDir, { recursive: true, force: true }),
    rm(workspace, { recursive: true, force: true }),
    rm(home, { recursive: true, force: true }),
  ]);
  delete process.env.MEOWCODE_SESSIONS_DIR;
  delete process.env.MEOWCODE_WORKSPACE;
  delete process.env.MEOWCODE_PLUGINS;
  delete process.env.MEOWCODE_GITHUB_TOKEN;
  delete process.env.MEOWCODE_GITCODE_TOKEN;
});

function get(pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
}

describe("GET /plugins", () => {
  it("无 token 拒绝", async () => {
    const response = await fetch(`${baseUrl}/plugins`);
    expect(response.status).toBe(401);
  });

  it("返回插件清单 / MCP 状态 / 命令索引，禁用插件不加载", async () => {
    const response = await get("/plugins");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      plugins: Array<{ id: string; enabled: boolean; toolNames?: string[]; error?: string }>;
      errors: unknown[];
      mcp: Record<string, unknown>;
      mcpErrors: string[];
      commands: Array<{ name: string }>;
    };
    const hello = body.plugins.find((p) => p.id === "hello");
    expect(hello).toMatchObject({ id: "hello", enabled: true, source: "project", toolNames: ["hello_tool"] });
    const off = body.plugins.find((p) => p.id === "off");
    expect(off).toMatchObject({ id: "off", enabled: false });
    expect(off?.toolNames).toBeUndefined();
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.mcpErrors).toEqual([]);
    // off 的命令不应注册
    expect(body.commands.some((c) => c.name === "offcmd")).toBe(false);
  });

  it("插件工具进入新会话的工具列表（经 /session/messages 前先看 /plugins 即可）", async () => {
    // 轻验证：reload 后描述符一致
    const reload = await get("/plugins/reload", { method: "POST" });
    expect(reload.status).toBe(200);
    const body = (await reload.json()) as { plugins: Array<{ id: string; enabled: boolean }> };
    expect(body.plugins.find((p) => p.id === "hello")?.enabled).toBe(true);
    expect(body.plugins.find((p) => p.id === "off")?.enabled).toBe(false);
  });
});

describe("POST /plugins/mcp-credentials", () => {
  it("写入允许的 MCP 凭据 env 并重载插件", async () => {
    delete process.env.MEOWCODE_GITHUB_TOKEN;
    const response = await get("/plugins/mcp-credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: { MEOWCODE_GITHUB_TOKEN: "  gho_test_token  " } }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(process.env.MEOWCODE_GITHUB_TOKEN).toBe("gho_test_token");

    const cleared = await get("/plugins/mcp-credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: { MEOWCODE_GITHUB_TOKEN: null } }),
    });
    expect(cleared.status).toBe(200);
    expect(process.env.MEOWCODE_GITHUB_TOKEN).toBeUndefined();
  });

  it("允许 GitCode 凭据 env", async () => {
    const response = await get("/plugins/mcp-credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: { MEOWCODE_GITCODE_TOKEN: "gitcode-token" } }),
    });
    expect(response.status).toBe(200);
    expect(process.env.MEOWCODE_GITCODE_TOKEN).toBe("gitcode-token");
    await get("/plugins/mcp-credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: { MEOWCODE_GITCODE_TOKEN: null } }),
    });
    expect(process.env.MEOWCODE_GITCODE_TOKEN).toBeUndefined();
  });

  it("拒绝任意环境变量名", async () => {
    const response = await get("/plugins/mcp-credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: { EVIL_TOKEN: "x" } }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_request" },
    });
  });
});
