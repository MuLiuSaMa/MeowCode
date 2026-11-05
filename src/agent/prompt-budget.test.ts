import { describe, expect, it } from "vitest";
import { estimateTokens, estimateToolDefinitionsTokens } from "./context.js";
import { COMPACTION_SYSTEM_PROMPT, TOOL_DIGEST_SYSTEM_PROMPT } from "./compaction.js";
import { BASE_SYSTEM_PROMPT } from "./runtime.js";
import {
  listDynamicToolDefinitions,
  registerDynamicTool,
  toolDefinitions,
  unregisterDynamicTool,
} from "./tools.js";

/**
 * 提示词预算回归测试（P0-1，参考 metis 的 prompt 预算契约）：
 * system prompt 与工具 schema 每轮请求都全量重发，膨胀直接烧 token。
 * 超预算 = 回归，改描述前先想清楚值不值这几十个 token。
 */
describe("prompt budget", () => {
  it("base system prompt stays under 420 tokens", () => {
    const tokens = estimateTokens(BASE_SYSTEM_PROMPT);
    expect(tokens).toBeLessThan(420);
  });

  it("tool schemas stay under 5200 tokens", () => {
    // 2200 → 2350：新增 run_code（PTC code mode）的定义。它每次使用省掉的是
    // 整轮多工具往返的全上下文重发，每请求 ~150 token 的固定成本明确划算。
    // 2350 → 2700：read_file 增加 PDF 页范围、新增 read_video（9 帧拼图 ~1.5k
    // token/次，替掉"整段视频进上下文"的不可行方案），两者合计 ~220 token。
    // 2700 → 3400：新增 memory_read/write/delete 三件（跨会话记忆）。索引注入
    // + 按需读取替代"每会话全量回放"，~500 token 固定成本换长期记忆能力。
    // 3400 → 3700：新增 web_search/web_fetch（服务商原生联网搜索 + 页面抓取），
    // 两者合计 ~210 token；省掉的是"不知道就说不知道"或整页 HTML 的往返。
    // 3700 → 5200：新增 job（后台任务）、git（结构化 git）、delete_file、
    // move_file、apply_patch，task 同时扩了 resume/fork；实测 4781 token。
    // 再往上应优先走 tool_search 延迟加载，而不是继续堆常驻 schema。
    const tokens = estimateTokens(JSON.stringify(toolDefinitions));
    expect(tokens).toBeLessThan(5_200);
  });

  it("compaction prompts stay under 2500 chars", () => {
    const chars = COMPACTION_SYSTEM_PROMPT.length + TOOL_DIGEST_SYSTEM_PROMPT.length;
    expect(chars).toBeLessThan(2_500);
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
