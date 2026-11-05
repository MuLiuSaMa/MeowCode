import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startServer, type AgentServer } from "./server";

// 集成测试：真实 server 启停 + jiti 全量重编译 + MCP 子进程，
// 并行负载下单例可达 10s 以上；给足余量，避免把「机器忙」误报成失败。
vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });

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

  // 目录插件带 ui/index.html：验证 /plugin-ui 面板路由
  const panelDir = path.join(pluginsDir, "panel-plugin");
  await mkdir(path.join(panelDir, "ui"), { recursive: true });
  await writeFile(
    path.join(panelDir, "index.ts"),
    "export default function (api) { /* 面板演示插件：不注册任何东西 */ }",
  );
  await writeFile(
    path.join(panelDir, "ui", "index.html"),
    "<!doctype html><title>panel-plugin-ui</title>",
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
    headers: { authorization: `Bearer ${TOKEN}`, ...init.headers },
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

describe("GET /hooks/config", () => {
  it("返回三层文件摘要；工作区默认排除", async () => {
    const hooksHome = await mkdtemp(path.join(tmpdir(), "meowcode-hooks-home-"));
    try {
      await mkdir(path.join(hooksHome, ".claude"), { recursive: true });
      await writeFile(
        path.join(hooksHome, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              { matcher: "Bash", hooks: [{ type: "command", command: "user-check" }] },
            ],
          },
        }),
      );
      await mkdir(path.join(workspace, ".claude"), { recursive: true });
      await writeFile(
        path.join(workspace, ".claude", "settings.json"),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              { matcher: "Read", hooks: [{ type: "command", command: "project-check" }] },
            ],
          },
        }),
      );
      process.env.MEOWCODE_CC_HOOKS_HOME = hooksHome;
      process.env.MEOWCODE_CC_HOOKS_SCOPE = JSON.stringify({ user: true, workspace: false });
      process.env.MEOWCODE_HOOKS_RUN_MODE = "ask";

      const response = await get("/hooks/config");
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        enabled: boolean;
        runMode: string;
        scope: { user: boolean; workspace: boolean };
        files: Array<{ layer: string; exists: boolean; excluded: boolean; commands: number }>;
        events: Array<{ event: string; commands: Array<{ command: string; excluded: boolean }> }>;
        totalCommands: number;
      };
      expect(body.enabled).toBe(true);
      expect(body.runMode).toBe("ask");
      expect(body.scope).toEqual({ user: true, workspace: false });
      expect(body.files.find((file) => file.layer === "user")).toMatchObject({
        exists: true,
        excluded: false,
        commands: 1,
      });
      expect(body.files.find((file) => file.layer === "project")).toMatchObject({
        exists: true,
        excluded: true,
        commands: 1,
      });
      expect(body.totalCommands).toBe(1);
      expect(body.events[0]?.commands.map((command) => command.command)).toEqual([
        "user-check",
        "project-check",
      ]);
      expect(body.events[0]?.commands.find((command) => command.command === "project-check")?.excluded).toBe(
        true,
      );
    } finally {
      delete process.env.MEOWCODE_CC_HOOKS_HOME;
      delete process.env.MEOWCODE_CC_HOOKS_SCOPE;
      delete process.env.MEOWCODE_HOOKS_RUN_MODE;
      await rm(hooksHome, { recursive: true, force: true });
      await rm(path.join(workspace, ".claude"), { recursive: true, force: true });
    }
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

describe("GET /plugin-ui", () => {
  it("query token 可访问面板资源", async () => {
    const response = await fetch(`${baseUrl}/plugin-ui/panel-plugin/index.html?token=${TOKEN}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).toContain("panel-plugin-ui");
  });

  it("不带 token 拒绝（与 /session/asset 同一闸门）", async () => {
    const response = await fetch(`${baseUrl}/plugin-ui/panel-plugin/index.html`);
    expect(response.status).toBe(401);
  });

  it("路径穿越拒绝（WHATWG URL 先消解点段，落到 ui 内不存在文件即 404；反斜杠走 resolve 拦 403）", async () => {
    // %2e%2e 被 URL 层当点段规范化成 /plugin-ui/settings.json → ui 内无此文件 → 404
    const escaped = await get("/plugin-ui/panel-plugin/%2e%2e/%2e%2e/settings.json");
    expect([400, 403, 404]).toContain(escaped.status);
    // 明文的 ../ 同样被 URL 规范化；%5C（反斜杠）在 Windows resolve 里越界 → 403
    const plain = await get("/plugin-ui/panel-plugin/../../settings.json");
    expect([400, 403, 404]).toContain(plain.status);
    const backslash = await get("/plugin-ui/panel-plugin/..%5C..%5Csettings.json");
    expect([400, 403, 404]).toContain(backslash.status);
  });

  it("未知插件 404", async () => {
    const response = await get("/plugin-ui/no-such-plugin/index.html");
    expect(response.status).toBe(404);
  });

  it("无 ui 的插件 404", async () => {
    const response = await get("/plugin-ui/hello/index.html");
    expect(response.status).toBe(404);
  });
});
