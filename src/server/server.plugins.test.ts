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

describe("POST /config/hooks", () => {
  it("热更新运行方式与工作区范围，不重启 server 且 GET /hooks/config 立即反映", async () => {
    const set = await get("/config/hooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runMode: "ask", includeWorkspace: true }),
    });
    expect(set.status).toBe(200);
    const conf = await get("/hooks/config");
    const body = (await conf.json()) as { runMode: string; scope: { workspace: boolean } };
    expect(body.runMode).toBe("ask");
    expect(body.scope.workspace).toBe(true);

    const bad = await get("/config/hooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runMode: "maybe" }),
    });
    expect(bad.status).toBe(400);

    // 还原给后续用例
    await get("/config/hooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runMode: "auto", includeWorkspace: false }),
    });
    delete process.env.MEOWCODE_HOOKS_RUN_MODE;
    delete process.env.MEOWCODE_CC_HOOKS_SCOPE;
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

describe("POST /plugins/disabled", () => {
  it("运行中热更新禁用列表：不重启 server，插件工具与命令立即增删", async () => {
    // 启用此前被禁用的 off 插件
    const enabled = await get("/plugins/disabled", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disabled: [] }),
    });
    expect(enabled.status).toBe(200);
    const enabledBody = (await enabled.json()) as {
      plugins: Array<{ id: string; enabled: boolean }>;
      commands: Array<{ name: string }>;
    };
    expect(enabledBody.plugins.find((p) => p.id === "off")?.enabled).toBe(true);
    expect(enabledBody.commands.some((c) => c.name === "offcmd")).toBe(true);
    // 同一个 server 实例继续响应（设置类热更新不走进程重启）
    expect(server.address()).not.toBeNull();

    // 再禁用：同一个 server 上立即回退
    const disabled = await get("/plugins/disabled", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disabled: ["off"] }),
    });
    expect(disabled.status).toBe(200);
    const disabledBody = (await disabled.json()) as {
      plugins: Array<{ id: string; enabled: boolean }>;
      commands: Array<{ name: string }>;
    };
    expect(disabledBody.plugins.find((p) => p.id === "off")?.enabled).toBe(false);
    expect(disabledBody.plugins.find((p) => p.id === "hello")?.enabled).toBe(true);
    expect(disabledBody.commands.some((c) => c.name === "offcmd")).toBe(false);
  });

  it("disabled 不是数组时拒绝", async () => {
    const response = await get("/plugins/disabled", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disabled: "off" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
  });
});

describe("PUT /config/providers", () => {
  it("运行中热替换服务商列表：不重启 server，新列表立即对新会话生效", async () => {
    const response = await get("/config/providers", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providers: [
          { id: "p2", name: "provider2", baseUrl: "http://127.0.0.1:1", model: "m2", apiKey: "k2" },
        ],
        providerId: "p2",
      }),
    });
    expect(response.status).toBe(200);
    const listed = await get("/config/providers");
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      providers: Array<{ id: string; model: string }>;
      activeProviderId: string;
    };
    expect(body.providers.map((provider) => provider.id)).toEqual(["p2"]);
    expect(body.providers[0]?.model).toBe("m2");
    expect(body.activeProviderId).toBe("p2");
    // 同一个 server 实例继续响应（没有走进程重启）
    expect(server.address()).not.toBeNull();

    // 还原给后续用例
    await get("/config/providers", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providers: [
          { id: "p1", name: "provider", baseUrl: "http://127.0.0.1:1", model: "m", apiKey: "secret" },
        ],
        providerId: "p1",
      }),
    });
  });

  it("providers 不是数组时拒绝", async () => {
    const response = await get("/config/providers", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providers: "p1" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
  });
});

describe("GET /plugin-ui", () => {
  it("query token 可访问面板资源", async () => {
    const response = await fetch(`${baseUrl}/plugin-ui/panel-plugin/index.html?token=${TOKEN}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toContain("no-store");
    // 渲染层 fetch 插件脚本是跨源请求（dev: Vite 源 → agent server；打包: file://）
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.text()).toContain("panel-plugin-ui");
  });

  it("不带 token 拒绝（与 /session/asset 同一闸门）", async () => {
    const response = await fetch(`${baseUrl}/plugin-ui/panel-plugin/index.html`);
    expect(response.status).toBe(401);
    // 错误响应也带 CORS 头，渲染层才能读到 401 而不是笼统的 Failed to fetch
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("OPTIONS 预检放行，便于将来 fetch 带自定义头", async () => {
    const response = await fetch(`${baseUrl}/plugin-ui/panel-plugin/index.html`, {
      method: "OPTIONS",
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
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
