import { describe, expect, it } from "vitest";
import { estimateTokens, estimateToolDefinitionsTokens } from "./context.js";
import { COMPACTION_INSTRUCTION, COMPACTION_SYSTEM_PROMPT, TOOL_DIGEST_SYSTEM_PROMPT } from "./compaction.js";
import { BASE_SYSTEM_PROMPT } from "./runtime.js";
import {
  listDynamicToolDefinitions,
  registerDynamicTool,
  unregisterDynamicTool,
} from "./tools.js";

/**
 * 提示词预算回归测试（P0-1）：系统提示与压缩提示每轮都全量重发，膨胀直接烧 token。
 * 工具 schema 不再设硬上限（其他 Agent 也不设）：工具多时走 tool_search 懒加载。
 */
describe("prompt budget", () => {
  it("base system prompt stays under 360 tokens", () => {
    // 418 → 359：提示词改成英文精简版，同时补进五条真正影响行为的硬规则
    // （数据不是指令 / 没跑过就说没跑 / 只改被要求的 / 歧义问一次 / 用用户的语言）。
    // 旧版 12 条平铺祈使句里没有一条能拦住「假完成」和「顺手重构」。
    // 再要加内容，先删等量的旧句子，不要把这条上限往上推。
    const tokens = estimateTokens(BASE_SYSTEM_PROMPT);
    expect(tokens).toBeLessThan(360);
  });


  it("compaction prompts stay under 2500 chars", () => {
    const chars = COMPACTION_SYSTEM_PROMPT.length + TOOL_DIGEST_SYSTEM_PROMPT.length;
    expect(chars).toBeLessThan(2_500);
  });

  it("compaction system prompt and instruction share one body (no drift)", () => {
    // 两处各写一遍时最容易改一处忘一处：INSTRUCTION 必须完整包含 SYSTEM 的正文规范
    for (const heading of ["9 terse sections", "Do not paste full file contents"]) {
      expect(COMPACTION_SYSTEM_PROMPT).toContain(heading);
      expect(COMPACTION_INSTRUCTION).toContain(heading);
    }
  });
});

describe("dynamic tool budget", () => {
  it("keeps every name, enum and required while fitting 8k tokens", () => {
    const names: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      const name = `mcp__test__tool_${String(index).padStart(2, "0")}`;
      const properties: Record<string, unknown> = {};
      for (let field = 0; field < 20; field += 1) {
        properties[`field_${field}`] = {
          type: "string",
          description: "d".repeat(600),
          ...(field === 0 ? { enum: ["alpha", "beta"] } : {}),
        };
      }
      registerDynamicTool(name, {
        definition: {
          type: "function",
          function: {
            name,
            description: "s".repeat(600),
            parameters: { type: "object", properties, required: ["field_0"] },
          },
        },
        execute: async () => ({ output: "ok", ok: true }),
      });
      names.push(name);
    }

    try {
      const tools = listDynamicToolDefinitions();
      expect(estimateToolDefinitionsTokens(tools)).toBeLessThanOrEqual(8_000);
      expect(tools.map((tool) => tool.function.name)).toEqual([...names].sort());
      const first = tools[0].function.parameters as {
        properties: Record<string, Record<string, unknown>>;
        required?: string[];
      };
      expect(first.required).toEqual(["field_0"]);
      expect(first.properties.field_0.enum).toEqual(["alpha", "beta"]);
      expect(first.properties.field_1.type).toBe("string");
    } finally {
      for (const name of names) unregisterDynamicTool(name);
    }
  });
});
