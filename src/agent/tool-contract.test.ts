import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_TOOL_CONTRACTS, isParallelSafeContract } from "./tool-contract.js";
import {
  admitToolDefinition,
  executeTool,
  isToolParallelSafe,
  registerDynamicTool,
  toolDefinitions,
  unregisterDynamicTool,
} from "./tools.js";
import type { ToolDefinition } from "./types.js";
import type { DynamicTool } from "./tools.js";
import type { ToolContract } from "./tool-contract.js";

const registered: string[] = [];

afterEach(() => {
  for (const name of registered.splice(0)) unregisterDynamicTool(name);
});

function definition(name: string): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description: "test tool",
      parameters: { type: "object", properties: {} },
    },
  };
}

function register(
  name: string,
  extra: { contract?: ToolContract; execute?: DynamicTool["execute"] } = {},
) {
  const result = registerDynamicTool(name, {
    definition: definition(name),
    execute: async () => ({ ok: true, output: "ok" }),
    ...extra,
  });
  expect(result.ok).toBe(true);
  registered.push(name);
}

describe("工具契约", () => {
  it("静态工具与治理工具都有契约", () => {
    for (const tool of [...toolDefinitions, admitToolDefinition]) {
      expect(BUILTIN_TOOL_CONTRACTS[tool.function.name], tool.function.name).toBeDefined();
    }
  });

  it("只读且并发安全的工具才允许并发", () => {
    expect(isToolParallelSafe("read_file")).toBe(true);
    expect(isToolParallelSafe("grep")).toBe(true);
    expect(isToolParallelSafe("web_fetch")).toBe(true);
    expect(isToolParallelSafe("write_file")).toBe(false);
    // run_code 的 meow 桥可以写文件，历史并行是隐患，契约收紧为串行
    expect(isToolParallelSafe("run_code")).toBe(false);
    expect(isToolParallelSafe("task")).toBe(false);
    expect(isToolParallelSafe("browser_navigate")).toBe(false);
    expect(isToolParallelSafe("no_such_tool")).toBe(false);
  });

  it("动态工具缺省串行，声明 readOnly + parallelSafe 后才并发", () => {
    register("mcp__demo__read");
    expect(isToolParallelSafe("mcp__demo__read")).toBe(false);

    register("mcp__demo__fast", {
      contract: { readOnly: true, parallelSafe: true, sideEffects: "network" },
    });
    expect(isToolParallelSafe("mcp__demo__fast")).toBe(true);

    // 只读但未声明并发安全：仍然串行（契约两个条件必须同时满足）
    expect(isParallelSafeContract({ readOnly: true, parallelSafe: false, sideEffects: "none" })).toBe(
      false,
    );
  });

  it("动态工具的超时可中断执行", async () => {
    register("mcp__demo__slow", {
      contract: {
        readOnly: true,
        parallelSafe: true,
        sideEffects: "network",
        timeoutMs: 20,
      },
      execute: (_input, _workspace, options) =>
        new Promise((resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          setTimeout(() => resolve({ ok: true, output: "late" }), 200);
        }),
    });

    const result = await executeTool("mcp__demo__slow", {}, process.cwd());
    expect(result.ok).toBe(false);
    expect(result.output).toContain("timed out after 20ms");
  });
});
