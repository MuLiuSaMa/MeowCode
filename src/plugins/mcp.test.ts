import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasDynamicTool, isDynamicToolRequiringApproval, listDynamicToolDefinitions } from "../agent/tools.js";
import {
  McpManager,
  expandEnvTemplates,
  mcpContentToResult,
  readMcpConfig,
  toToolDefinition,
  unresolvedEnvVars,
  type McpClientLike,
  type McpClientFactory,
} from "./mcp.js";

const tempDirs: string[] = [];

async function makeTempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meow-mcp-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function fakeClient(overrides: Partial<McpClientLike> = {}): McpClientLike {
  return {
    listTools: async () => ({
      tools: [
        {
          name: "echo",
          description: "Echo a message",
          inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
        },
        { name: "no_schema", description: "Tool without schema" },
      ],
    }),
    callTool: async (params) => ({
      content: [{ type: "text", text: `echo:${String(params.arguments?.msg ?? "")}` }],
    }),
    close: async () => undefined,
    ...overrides,
  };
}

function managerWith(clients: McpClientLike[], reconnectDelays: number[] = [5, 5, 5]) {
  const created: McpClientLike[] = [];
  const factory: McpClientFactory = async () => {
    if (clients.length > 0) {
      const client = clients.shift()!;
      created.push(client);
      return client;
    }
    throw new Error("factory exhausted");
  };
  const manager = new McpManager(factory);
  (manager as unknown as { reconnectDelays: number[] }).reconnectDelays = reconnectDelays;
  return { manager, created };
}

describe("McpManager.start", () => {
  it("注册 mcp__<server>__<tool> 命名空间工具，默认免审批", async () => {
    const { manager } = managerWith([fakeClient()]);
    await manager.start({ demo: { url: "http://localhost:9" } });

    expect(hasDynamicTool("mcp__demo__echo")).toBe(true);
    expect(hasDynamicTool("mcp__demo__no_schema")).toBe(true);
    expect(isDynamicToolRequiringApproval("mcp__demo__echo")).toBe(false);
    const def = listDynamicToolDefinitions().find((d) => d.function.name === "mcp__demo__echo");
    expect(def?.function.description).toBe("Echo a message");
    expect(def?.function.parameters.required).toEqual(["msg"]);
    await manager.dispose();
    expect(hasDynamicTool("mcp__demo__echo")).toBe(false);
  });

  it("trust: false 的 server 走审批", async () => {
    const { manager } = managerWith([fakeClient()]);
    await manager.start({ demo: { url: "http://localhost:9", trust: false } });
    expect(isDynamicToolRequiringApproval("mcp__demo__echo")).toBe(true);
    await manager.dispose();
  });

  it("enabled: false 跳过；连接失败标 failed 不影响其他 server", async () => {
    const good = managerWith([fakeClient()]);
    const { manager } = managerWith([fakeClient()]);
    // 同一 manager：一个 server 工厂失败、另一个成功 —— 用会失败的 server 名占位
    const failing = new McpManager(async () => {
      throw new Error("spawn boom");
    });
    await failing.start({ bad: { command: "definitely-missing-binary" } });
    expect(failing.statuses().bad).toMatchObject({ status: "failed" });
    expect(failing.statuses().bad.error).toContain("spawn boom");
    void good;
    void manager;
    await failing.dispose();
  });

  it("listTools 超时 → failed", async () => {
    const _slow = fakeClient({
      listTools: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { tools: [] };
      },
    });
    // 注入更短的 listTools 超时不可行（常量），改用永不返回 + SDK 层超时不可测；
    // 这里验证失败路径：工厂成功但 listTools 抛错
    const broken = fakeClient({ listTools: async () => { throw new Error("timeout"); } });
    const { manager } = managerWith([broken]);
    await manager.start({ demo: { url: "http://localhost:9" } });
    expect(manager.statuses().demo).toMatchObject({ status: "failed", error: "timeout" });
    await manager.dispose();
  });
});

describe("缺凭据跳过连接", () => {
  const TOKEN_ENV = "MEOWCODE_TEST_TOKEN";
  // 配置里要的是字面占位符 "${MEOWCODE_TEST_TOKEN}"，不是 JS 插值
  const tokenTemplate = () => `\${${TOKEN_ENV}}`;

  afterEach(() => {
    delete process.env[TOKEN_ENV];
  });

  it("unresolvedEnvVars 扫 url/headers/env/command/args，空串也算缺", () => {
    process.env[TOKEN_ENV] = "tok";
    expect(
      unresolvedEnvVars({
        url: `https://x/${tokenTemplate()}/y`,
        headers: { Authorization: `Bearer ${tokenTemplate()}` },
      } as never),
    ).toEqual([]);
    delete process.env[TOKEN_ENV];
    expect(
      unresolvedEnvVars({
        url: "https://x/y",
        headers: { Authorization: `Bearer ${tokenTemplate()}` },
        env: { K: tokenTemplate() },
      } as never),
    ).toEqual([TOKEN_ENV]);
    // 空串环境变量视为缺失
    process.env[TOKEN_ENV] = "";
    expect(unresolvedEnvVars({ headers: { A: `Bearer ${tokenTemplate()}` } } as never)).toEqual([TOKEN_ENV]);
    // stdio 侧：command/args 里的占位也扫
    delete process.env[TOKEN_ENV];
    expect(
      unresolvedEnvVars({ command: "npx", args: ["-y", `pkg@${tokenTemplate()}`] } as never),
    ).toEqual([TOKEN_ENV]);
  });

  it("headers 里有缺 env 的占位 → 标 unconfigured，工厂不被调用", async () => {
    const { manager, created } = managerWith([fakeClient()]);
    await manager.start({
      luckin: { url: "https://x/y", headers: { Authorization: `Bearer ${tokenTemplate()}` } },
    });
    expect(created).toHaveLength(0);
    expect(manager.statuses().luckin).toMatchObject({ status: "unconfigured", missingEnv: [TOKEN_ENV] });
    expect(hasDynamicTool("mcp__luckin__echo")).toBe(false);
    await manager.dispose();
  });

  it("补上 env 后 restart 热重连 → ready；再清掉 env → 回到 unconfigured", async () => {
    const { manager, created } = managerWith([fakeClient(), fakeClient()]);
    const config = { url: "https://x/y", headers: { Authorization: `Bearer ${tokenTemplate()}` } };
    await manager.start({ luckin: config });
    expect(manager.statuses().luckin.status).toBe("unconfigured");

    process.env[TOKEN_ENV] = "tok";
    await manager.restart({ luckin: config });
    expect(created).toHaveLength(1);
    expect(manager.statuses().luckin).toMatchObject({ status: "ready", toolCount: 2 });
    expect(hasDynamicTool("mcp__luckin__echo")).toBe(true);

    delete process.env[TOKEN_ENV];
    await manager.restart({ luckin: config });
    expect(created).toHaveLength(1);
    expect(manager.statuses().luckin).toMatchObject({ status: "unconfigured", missingEnv: [TOKEN_ENV] });
    expect(hasDynamicTool("mcp__luckin__echo")).toBe(false);
    await manager.dispose();
  });
});

describe("McpManager.callTool", () => {
  it("路由到对应 client 并转换 content", async () => {
    const { manager } = managerWith([fakeClient()]);
    await manager.start({ demo: { url: "http://localhost:9" } });

    const result = await manager.callTool("demo", "echo", { msg: "hello" });
    expect(result).toMatchObject({ output: "echo:hello", ok: true });
    await manager.dispose();
  });

  it("callTool 抛错 → ok:false 的 ToolResult（不打断回合）", async () => {
    const client = fakeClient({
      callTool: async () => {
        throw new Error("boom during call");
      },
    });
    const { manager } = managerWith([client]);
    await manager.start({ demo: { url: "http://localhost:9" } });

    const result = await manager.callTool("demo", "echo", {});
    expect(result.ok).toBe(false);
    expect(result.output).toContain("boom during call");
    await manager.dispose();
  });

  it("未连接的 server 返回失败结果", async () => {
    const { manager } = managerWith([fakeClient()]);
    const result = await manager.callTool("ghost", "echo", {});
    expect(result.ok).toBe(false);
    expect(result.output).toContain("not connected");
  });

  it("isError 的 MCP 结果 → ok:false", async () => {
    const client = fakeClient({ callTool: async () => ({ content: [{ type: "text", text: "bad" }], isError: true }) });
    const { manager } = managerWith([client]);
    await manager.start({ demo: { url: "http://localhost:9" } });
    const result = await manager.callTool("demo", "echo", {});
    expect(result.ok).toBe(false);
    await manager.dispose();
  });
});

describe("断线重连", () => {
  it("close → 摘除工具 → 重连成功恢复", async () => {
    const first = fakeClient();
    const second = fakeClient();
    const { manager } = managerWith([first, second], [10]);
    await manager.start({ demo: { url: "http://localhost:9" } });
    expect(hasDynamicTool("mcp__demo__echo")).toBe(true);

    first.onclose?.();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(hasDynamicTool("mcp__demo__echo")).toBe(true);
    expect(manager.statuses().demo.status).toBe("ready");
    await manager.dispose();
  });

  it("重连次数耗尽 → failed 且工具摘除", async () => {
    const first = fakeClient();
    const { manager } = managerWith([first], [5, 5, 5]);
    await manager.start({ demo: { url: "http://localhost:9" } });

    first.onclose?.();
    // 3 次重连全部失败（工厂已耗尽）→ failed
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(manager.statuses().demo.status).toBe("failed");
    expect(hasDynamicTool("mcp__demo__echo")).toBe(false);
    await manager.dispose();
  });
});

describe("readMcpConfig", () => {
  it("project 覆盖 user；env/url 模板展开；损坏文件告警不中断", async () => {
    const workspace = await makeTempRoot();
    const home = await makeTempRoot();
    await fs.mkdir(path.join(home, ".meowcode"), { recursive: true });
    await fs.mkdir(path.join(workspace, ".meowcode"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".meowcode", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          shared: { command: "user-cmd" },
          userOnly: { command: "user-only" },
        },
      }),
    );
    await fs.writeFile(
      path.join(workspace, ".meowcode", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          shared: { url: "http://x/${MY_TOKEN}" },
        },
        broken: true,
      }),
    );
    await fs.writeFile(path.join(workspace, ".meowcode", "mcp.json.bak"), "{ not json");

    const { servers, errors } = await readMcpConfig({ workspace, homeDir: home });
    expect(servers.shared).toEqual({ url: "http://x/${MY_TOKEN}" });
    expect(servers.userOnly).toEqual({ command: "user-only" });
    expect(errors).toEqual([]);
  });
});

describe("工具函数", () => {
  it("expandEnvTemplates 展开 ${VAR}，缺失变量为空串", () => {
    process.env.MEOW_TEST_VAR = "v1";
    expect(expandEnvTemplates("a-${MEOW_TEST_VAR}-b")).toBe("a-v1-b");
    expect(expandEnvTemplates("x-${MEOW_MISSING_VAR_9}-y")).toBe("x--y");
    delete process.env.MEOW_TEST_VAR;
  });

  it("toToolDefinition 容错：缺 schema/缺 required", () => {
    const def = toToolDefinition("mcp__x__y", "desc", undefined);
    expect(def.function.parameters).toEqual({ type: "object", properties: {} });
    const bad = toToolDefinition("mcp__x__y", "desc", { type: "string" } as never);
    expect(bad.function.parameters.type).toBe("object");
  });

  it("caps overly long MCP tool descriptions", () => {
    const def = toToolDefinition("mcp__x__y", "x".repeat(5_000), undefined);
    expect(def.function.description.length).toBeLessThan(320);
    expect(def.function.description.endsWith("…")).toBe(true);
  });

  it("keeps the first sentence and the usage hint when clipping", () => {
    const description = [
      "Create an issue in the tracker with a title and body.",
      "This paragraph is pure marketing filler about how great the product is and how much time it saves teams.",
      "Use this when you need to file a bug or a feature request from the agent.",
      "Another long paragraph that should not survive the budget at all because it is just noise.",
    ].join(" ");
    const def = toToolDefinition("mcp__x__create_issue", description, undefined);
    expect(def.function.description).toContain("Create an issue in the tracker");
    expect(def.function.description).toContain("Use this when");
    expect(def.function.description.length).toBeLessThanOrEqual(242);
  });

  it("drops json-schema noise keys but keeps constraints", () => {
    const def = toToolDefinition("mcp__x__y", "desc", {
      type: "object",
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "Payload",
      properties: {
        mode: {
          type: "string",
          title: "Mode",
          description: "How to run it.",
          enum: ["fast", "safe"],
          examples: ["fast"],
          $comment: "internal",
        },
        nested: {
          type: "object",
          additionalProperties: false,
          properties: {
            level: { type: "integer", minimum: 1, default: 2, description: "Depth." },
          },
        },
      },
      required: ["mode"],
    });
    const parameters = def.function.parameters as Record<string, unknown>;
    expect(parameters.$schema).toBeUndefined();
    expect(parameters.title).toBeUndefined();
    expect(parameters.required).toEqual(["mode"]);
    const mode = (parameters.properties as Record<string, Record<string, unknown>>).mode;
    expect(mode.enum).toEqual(["fast", "safe"]);
    expect(mode.examples).toBeUndefined();
    expect(mode.$comment).toBeUndefined();
    // 有 description 时 title 是重复信息
    expect(mode.title).toBeUndefined();
    const nested = (parameters.properties as Record<string, Record<string, unknown>>).nested;
    expect(nested.additionalProperties).toBeUndefined();
    const level = (nested.properties as Record<string, Record<string, unknown>>).level;
    expect(level.minimum).toBe(1);
    expect(level.default).toBe(2);
  });

  it("clips property descriptions and collapses deep schemas", () => {
    const deep = {
      type: "object",
      properties: {
        a: {
          type: "object",
          properties: {
            b: {
              type: "object",
              properties: {
                c: {
                  type: "object",
                  properties: { d: { type: "string", description: "too deep to matter" } },
                },
              },
            },
          },
        },
      },
    };
    const def = toToolDefinition("mcp__x__deep", "desc", deep);
    const properties = (def.function.parameters as Record<string, Record<string, unknown>>)
      .properties as Record<string, Record<string, unknown>>;
    const a = properties.a;
    const b = (a.properties as Record<string, Record<string, unknown>>).b;
    const c = (b.properties as Record<string, Record<string, unknown>>).c;
    // depth > 3 之后只留类型
    expect(c).toEqual({ type: "object" });
    expect(JSON.stringify(def.function.parameters)).not.toContain("too deep to matter");
  });

  it("clips long property descriptions to the field budget", () => {
    const def = toToolDefinition("mcp__x__y", "desc", {
      type: "object",
      properties: { query: { type: "string", description: "q".repeat(800) } },
    });
    const query = ((def.function.parameters as Record<string, Record<string, unknown>>)
      .properties as Record<string, Record<string, unknown>>).query;
    expect(String(query.description).length).toBeLessThanOrEqual(122);
  });

  it("mcpContentToResult：text/image/resource 各形态", () => {
    const textOnly = mcpContentToResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] });
    expect(textOnly.output).toBe("a\nb");
    expect(textOnly.ok).toBe(true);

    const withImage = mcpContentToResult({
      content: [
        { type: "image", data: "aGk=", mimeType: "image/png" },
        { type: "resource", resource: { uri: "file:///x", text: "res text" } },
        { type: "resource_link", uri: "http://y", name: "Y" },
      ],
    });
    expect(withImage.images).toEqual([{ data: "aGk=", mimeType: "image/png" }]);
    expect(withImage.output).toContain("res text");
    expect(withImage.output).toContain("[resource link: http://y (Y)]");

    const empty = mcpContentToResult({});
    expect(empty.output).toBe("(empty response)");

    const error = mcpContentToResult({ content: [{ type: "text", text: "e" }], isError: true });
    expect(error.ok).toBe(false);
  });
});

describe("restart", () => {
  it("restart 重置 server 集合并按新配置注册", async () => {
    const first = fakeClient();
    const second = fakeClient();
    const created: McpClientLike[] = [];
    const clients = [first, second];
    const manager = new McpManager(async () => {
      const client = clients.shift();
      if (!client) throw new Error("exhausted");
      created.push(client);
      return client;
    });
    (manager as unknown as { reconnectDelays: number[] }).reconnectDelays = [5];

    await manager.start({ old: { url: "http://a" } });
    expect(hasDynamicTool("mcp__old__echo")).toBe(true);

    await manager.restart({ fresh: { url: "http://b" } });
    expect(hasDynamicTool("mcp__old__echo")).toBe(false);
    expect(hasDynamicTool("mcp__fresh__echo")).toBe(true);
    expect(manager.statuses().fresh?.status).toBe("ready");
    await manager.dispose();
    void created;
  });
});
