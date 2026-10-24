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
    // start 一次 + restart 一次 = 两个连接；第三个才是重连逻辑多起的那只
    expect(created).toHaveLength(2);
    expect(created[0].closed).toBe(true);
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
