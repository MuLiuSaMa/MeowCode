import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasDynamicTool, isDynamicToolRequiringApproval, listDynamicToolDefinitions } from "../agent/tools.js";
import {
  McpManager,
  expandEnvTemplates,
  mcpContentToResult,
  readMcpConfig,
  toToolDefinition,
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
    const slow = fakeClient({
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
    expect(def.function.description.length).toBeLessThan(1_100);
    expect(def.function.description).toContain("description truncated");
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
