import { afterEach, describe, expect, it } from "vitest";
import { listDynamicToolDefinitions, unregisterDynamicTool } from "../agent/tools.js";
import { McpManager, type McpClientLike, type McpClientFactory } from "./mcp.js";

/**
 * MCP 生命周期串行化：并发 start / restart / dispose 不能再互相踩。
 *
 * 曾经的现场：启动时后台连接 MCP 的同时，市场/凭据变更触发了 reload → restart，
 * restart 把「正在连接中」的 client 拆了 → 那个 client 的 close 事件又触发重连 →
 * 同一个 server 起了两个进程，第二份工具注册被「already registered」跳过，
 * 状态变成 ready: 0 tools（工具其实还在，但计数归零）。
 */

function fakeClient(tools: string[] = ["echo"]): McpClientLike & { closed: boolean } {
  const client = {
    closed: false,
    listTools: async () => ({
      tools: tools.map((name) => ({
        name,
        description: `tool ${name}`,
        inputSchema: { type: "object", properties: {}, required: [] },
      })),
    }),
    callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
    close: async () => {
      client.closed = true;
    },
  } as unknown as McpClientLike & { closed: boolean };
  return client;
}

afterEach(() => {
  for (const definition of listDynamicToolDefinitions()) {
    unregisterDynamicTool(definition.function.name);
  }
});

describe("McpManager 生命周期串行化", () => {
  it("start 与 restart 并发时只连一次，不出现第二份重复注册", async () => {
    const created: Array<McpClientLike & { closed: boolean }> = [];
    const factory: McpClientFactory = async () => {
      const client = fakeClient(["echo"]);
      created.push(client);
      return client;
    };
    const manager = new McpManager(factory);
    const servers = { demo: { command: "demo" } };

    // 启动（后台）与重载同时发生
    await Promise.all([manager.start(servers), manager.restart(servers)]);

    // 工具不重复注册，计数与实际一致
    const mcpTools = listDynamicToolDefinitions().filter((item) =>
      item.function.name.startsWith("mcp__demo__"),
    );
    expect(mcpTools).toHaveLength(1);
    expect(manager.statuses().demo).toEqual({ status: "ready", toolCount: 1 });
    // 同配置 restart 走 diff：保留 start 建立的连接，不产生第二个 client
    expect(created).toHaveLength(1);
    expect(created[0].closed).toBe(false);
  });

  it("拆连接触发的 close 不会安排重连（不再多起一个进程）", async () => {
    const created: Array<McpClientLike & { closed: boolean }> = [];
    const factory: McpClientFactory = async () => {
      const client = fakeClient(["echo"]);
      created.push(client);
      return client;
    };
    const manager = new McpManager(factory);
    (manager as unknown as { reconnectDelays: number[] }).reconnectDelays = [5, 5, 5];
    await manager.start({ demo: { command: "demo" } });
    expect(manager.statuses().demo?.status).toBe("ready");

    await manager.dispose();

    // dispose 之后不应有重连计时器在跑：等一会儿也不该有新的 client
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(created).toHaveLength(1);
    expect(manager.statuses().demo?.status).toBe("failed");
  });
});

describe("McpManager diff 式 restart", () => {
  function hasTool(name: string): boolean {
    return listDynamicToolDefinitions().some((item) => item.function.name === name);
  }

  it("配置未变的 server 不拆不重连；被移除的才拆", async () => {
    const created: Array<McpClientLike & { closed: boolean }> = [];
    const factory: McpClientFactory = async () => {
      const client = fakeClient(["echo"]);
      created.push(client);
      return client;
    };
    const manager = new McpManager(factory);
    await manager.start({ keep: { command: "a" }, drop: { command: "b" } });
    expect(manager.statuses().keep?.status).toBe("ready");
    expect(manager.statuses().drop?.status).toBe("ready");

    // 卸载 drop：只拆 drop，keep 的连接原地保留
    await manager.restart({ keep: { command: "a" } });

    expect(created).toHaveLength(2); // 没有为 keep 重起进程
    expect(created[0].closed).toBe(false);
    expect(created[1].closed).toBe(true);
    expect(hasTool("mcp__keep__echo")).toBe(true);
    expect(hasTool("mcp__drop__echo")).toBe(false);
    expect(manager.statuses().keep).toEqual({ status: "ready", toolCount: 1 });
    expect(manager.statuses().drop).toBeUndefined();
    await manager.dispose();
  });

  it("配置变化的 server 关旧连新（键序不同但等价的配置不算变化）", async () => {
    const created: Array<McpClientLike & { closed: boolean }> = [];
    const factory: McpClientFactory = async () => {
      const client = fakeClient(["echo"]);
      created.push(client);
      return client;
    };
    const manager = new McpManager(factory);
    await manager.start({ demo: { command: "node", args: ["x"] } });
    // 同配置但键序打乱 → 不重连
    await manager.restart({ demo: { args: ["x"], command: "node" } });
    expect(created).toHaveLength(1);
    // 配置真变了 → 关旧连新
    await manager.restart({ demo: { command: "node", args: ["x"], env: { K: "1" } } });
    expect(created).toHaveLength(2);
    expect(created[0].closed).toBe(true);
    expect(manager.statuses().demo).toEqual({ status: "ready", toolCount: 1 });
    await manager.dispose();
  });

  it("此前失败的 server 借 restart 重试", async () => {
    let failFirst = true;
    const created: Array<McpClientLike & { closed: boolean }> = [];
    const factory: McpClientFactory = async () => {
      if (failFirst) throw new Error("boom");
      const client = fakeClient(["echo"]);
      created.push(client);
      return client;
    };
    const manager = new McpManager(factory);
    await manager.start({ demo: { command: "a" } });
    expect(manager.statuses().demo?.status).toBe("failed");

    failFirst = false;
    await manager.restart({ demo: { command: "a" } });
    expect(manager.statuses().demo).toEqual({ status: "ready", toolCount: 1 });
    await manager.dispose();
  });

  it("凭据环境变量变化时 diff-restart 重连该 server（令牌热更新生效）", async () => {
    const created: Array<McpClientLike & { closed: boolean }> = [];
    const factory: McpClientFactory = async () => {
      const client = fakeClient(["echo"]);
      created.push(client);
      return client;
    };
    const manager = new McpManager(factory);
    const envName = "MEOWCODE_TEST_TOKEN_XYZ";
    const saved = process.env[envName];
    const servers = { demo: { command: "a", env: { K: `\${${envName}}` } } };

    process.env[envName] = "tok-old";
    await manager.start(servers);
    expect(created).toHaveLength(1);

    // 令牌没变：保持连接，不重连
    await manager.restart(servers);
    expect(created).toHaveLength(1);
    expect(created[0].closed).toBe(false);

    // 令牌热更新（mcp.json 不变）：凭据指纹变化 → 关旧连新
    process.env[envName] = "tok-new";
    await manager.restart(servers);
    expect(created).toHaveLength(2);
    expect(created[0].closed).toBe(true);
    expect(manager.statuses().demo).toEqual({ status: "ready", toolCount: 1 });

    // 清除令牌（缺失/空串同义）：不再拿空凭据硬连，转 unconfigured 等待补齐
    delete process.env[envName];
    await manager.restart(servers);
    expect(created).toHaveLength(2);
    expect(created[1].closed).toBe(true);
    expect(manager.statuses().demo).toMatchObject({ status: "unconfigured", missingEnv: [envName] });

    if (saved === undefined) delete process.env[envName];
    else process.env[envName] = saved;
    await manager.dispose();
  });
});
