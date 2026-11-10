import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  executeTool,
  hasDynamicTool,
  isDynamicToolRequiringApproval,
  listDynamicToolDefinitions,
} from "../agent/tools.js";
import { PluginRegistry } from "./registry.js";
import type { PluginManifest, PluginTool } from "./types.js";

function makeTool(name: string, overrides: Partial<PluginTool> = {}): PluginTool {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ output: "ok", ok: true }),
    ...overrides,
  };
}

describe("PluginRegistry.addTool", () => {
  it("注册动态工具并可被 executeTool 侧查到", () => {
    const registry = new PluginRegistry();
    const result = registry.addTool("p1", makeTool("my_tool"));
    expect(result.ok).toBe(true);
    expect(hasDynamicTool("my_tool")).toBe(true);
    expect(listDynamicToolDefinitions().map((d) => d.function.name)).toContain("my_tool");
    registry.unregisterAll();
    expect(hasDynamicTool("my_tool")).toBe(false);
  });

  it("重名注册被拒", () => {
    const registry = new PluginRegistry();
    expect(registry.addTool("p1", makeTool("dup_tool")).ok).toBe(true);
    const second = registry.addTool("p2", makeTool("dup_tool"));
    expect(second.ok).toBe(false);
    expect(second.error).toContain("already registered");
    registry.unregisterAll();
  });

  it("保留名被拒：内置名 / task / update_plan / browser_ 前缀", () => {
    const registry = new PluginRegistry();
    for (const name of ["list_dir", "read_file", "task", "update_plan", "browser_navigate", "browser_custom"]) {
      const result = registry.addTool("p1", makeTool(name));
      expect(result.ok, name).toBe(false);
      expect(result.error, name).toContain("reserved");
    }
    registry.unregisterAll();
  });

  it("requiresApproval 透传到动态工具表", async () => {
    const registry = new PluginRegistry();
    registry.addTool("p1", makeTool("gate_tool", { requiresApproval: true }));
    registry.addTool("p1", makeTool("free_tool"));
    expect(isDynamicToolRequiringApproval("gate_tool")).toBe(true);
    expect(isDynamicToolRequiringApproval("free_tool")).toBe(false);
    const result = await executeTool("free_tool", {}, "D:/tmp");
    expect(result.ok).toBe(true);
    registry.unregisterAll();
  });
});

describe("PluginRegistry hooks/commands", () => {
  it("hook 按 event 分桶，hasHooks/hookEventsOf 正确", () => {
    const registry = new PluginRegistry();
    registry.addHook("p1", "tool_call", () => undefined);
    registry.addHook("p2", "tool_call", () => undefined);
    registry.addHook("p1", "turn_end", () => undefined);
    expect(registry.getHookHandlers("tool_call")).toHaveLength(2);
    expect(registry.hasHooks("tool_call")).toBe(true);
    expect(registry.hasHooks("prompt_submit")).toBe(false);
    expect(registry.hookEventsOf("p1").sort()).toEqual(["tool_call", "turn_end"]);
  });

  it("命令重名被拒，listCommands 带来源", () => {
    const registry = new PluginRegistry();
    expect(registry.addCommand("p1", { name: "deploy", run: () => "x" })).toBe(true);
    expect(registry.addCommand("p2", { name: "deploy", run: () => "y" })).toBe(false);
    expect(registry.listCommands()).toEqual([
      { name: "deploy", source: "plugin:p1" },
    ]);
  });
});

describe("PluginRegistry.rollbackPlugin", () => {
  it("只回滚指定插件的部分注册", () => {
    const registry = new PluginRegistry();
    registry.addTool("a", makeTool("tool_a"));
    registry.addTool("b", makeTool("tool_b"));
    registry.addHook("a", "tool_call", () => undefined);
    registry.addHook("b", "tool_call", () => undefined);
    registry.addCommand("a", { name: "cmd_a", run: () => "x" });

    registry.rollbackPlugin("a");

    expect(hasDynamicTool("tool_a")).toBe(false);
    expect(hasDynamicTool("tool_b")).toBe(true);
    expect(registry.getHookHandlers("tool_call")).toHaveLength(1);
    expect(registry.getHookHandlers("tool_call")[0]?.pluginId).toBe("b");
    expect(registry.getCommand("cmd_a")).toBeUndefined();
    registry.unregisterAll();
  });
});

describe("PluginRegistry.listDescriptors", () => {
  it("汇总插件元数据与注册清单", () => {
    const registry = new PluginRegistry();
    registry.addPlugin("p1", "project", "D:/w/.meowcode/plugins/p1.ts");
    registry.addTool("p1", makeTool("tool_x"));
    registry.addCommand("p1", { name: "cmd_x", run: () => "x" });
    registry.addHook("p1", "session_start", () => undefined);
    const descriptors = registry.listDescriptors();
    expect(descriptors).toEqual([
      {
        id: "p1",
        path: "D:/w/.meowcode/plugins/p1.ts",
        source: "project",
        enabled: true,
        toolNames: ["tool_x"],
        commandNames: ["cmd_x"],
        hookEvents: ["session_start"],
      },
    ]);
  });
});

describe("PluginRegistry.createApi", () => {
  it("registerTool 重名时告警且不崩溃", () => {
    const registry = new PluginRegistry();
    const api1 = registry.createApi("p1", "D:/w", "C:/Users/t");
    const api2 = registry.createApi("p2", "D:/w", "C:/Users/t");
    api1.registerTool(makeTool("shared_tool"));
    expect(() => api2.registerTool(makeTool("shared_tool"))).not.toThrow();
    expect(registry.toolNamesOf("p2")).toHaveLength(0);
    registry.unregisterAll();
  });

  it("api.workspace / storage 读写", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meow-plugin-storage-"));
    try {
      const registry = new PluginRegistry();
      const api = registry.createApi("p1", "D:/w", dir);
      expect(api.workspace).toBe("D:/w");
      await api.storage.set("counter", 41);
      await api.storage.set("counter", 42);
      expect(await api.storage.get<number>("counter")).toBe(42);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("PluginRegistry manifest permissions", () => {
  const manifest: PluginManifest = {
    id: "p1",
    version: "1.0.0",
    apiVersion: 2,
    permissions: ["tools"],
  };

  it("未声明 hooks/commands/rpc 时对应注册被拒", () => {
    const registry = new PluginRegistry();
    registry.addPlugin("p1", "user", "/tmp/p1", manifest);
    expect(() => registry.addHook("p1", "turn_end", () => undefined)).toThrow(/hooks/);
    expect(() => registry.addCommand("p1", { name: "cmd", run: () => "" })).toThrow(/commands/);
    expect(() => registry.addRpc("p1", "do", () => undefined)).toThrow(/rpc/);
    registry.unregisterAll();
  });

  it("tools 权限允许注册工具，storage 权限缺失时 client 侧仍按 API 检查", () => {
    const registry = new PluginRegistry();
    registry.addPlugin("p1", "user", "/tmp/p1", manifest);
    expect(registry.addTool("p1", makeTool("manifest_tool")).ok).toBe(true);
    registry.unregisterAll();
  });

  it("RPC 注册后可查询，rollback 精确清理", () => {
    const registry = new PluginRegistry();
    registry.addPlugin("p1", "user", "/tmp/p1", {
      ...manifest,
      permissions: ["rpc"] as const,
    });
    registry.addRpc("p1", "ping", () => "pong");
    expect(registry.getRpc("p1", "ping")).toBeDefined();
    expect(registry.rpcMethodsOf("p1")).toEqual(["ping"]);
    registry.rollbackPlugin("p1");
    expect(registry.getRpc("p1", "ping")).toBeUndefined();
    registry.unregisterAll();
  });

  it("descriptor 暴露 manifest 与 client 描述", () => {
    const registry = new PluginRegistry();
    registry.addPlugin(
      "p1",
      "user",
      "/tmp/p1",
      { ...manifest, permissions: ["ui"] as const },
      { client: { entry: "client.js", permissions: ["ui"] } },
    );
    const [descriptor] = registry.listDescriptors();
    expect(descriptor?.version).toBe("1.0.0");
    expect(descriptor?.manifest?.permissions).toEqual(["ui"]);
    expect(descriptor?.ui?.client).toEqual({ entry: "client.js", permissions: ["ui"] });
    registry.unregisterAll();
  });
});
