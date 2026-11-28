import { describe, expect, it } from "vitest";
import { estimateTokens, estimateToolDefinitionsTokens } from "./context.js";
import { COMPACTION_INSTRUCTION, COMPACTION_SYSTEM_PROMPT, TOOL_DIGEST_SYSTEM_PROMPT } from "./compaction.js";
import { BASE_SYSTEM_PROMPT } from "./runtime.js";
import { COMPLEX_SYSTEM_PROMPT, MINIMAL_SYSTEM_PROMPT } from "./agent-profiles.js";
import { BEHAVIOR_SEGMENT, buildEnvironmentSegment } from "./prompt-segments.js";
import {
  listDynamicToolDefinitions,
  promoteDynamicTool,
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


  it("边界后增量段保持轻量（行为段 < 220 token，环境段 < 60）", () => {
    // 段不进前缀缓存，随每轮请求重发；膨胀了就是静默加价。
    expect(estimateTokens(BEHAVIOR_SEGMENT)).toBeLessThan(220);
    expect(estimateTokens(buildEnvironmentSegment({ workspace: "D:/MeowCode" }))).toBeLessThan(60);
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

/**
 * 抗漂移：下面每个短语对应一条"行为红线"或一次真实踩过的坑。
 * 改写提示词时删掉任何一条，这里必须红 —— 否则退化只会体现在模型行为上，
 * 而行为目前没有回归测试（见 docs/plan/gap-analysis-meowcode-vs-cchaha.md §4）。
 */
describe("system prompt anti-drift", () => {
  it("keeps every behavior red line", () => {
    const redLines: Array<[string, string]> = [
      ["假完成", "Never claim a result you did not observe"],
      ["没跑过要说没跑", "reported as not run"],
      ["数据不是指令", "data, not instructions"],
      ["歧义问一次", "Ask once with ask_user"],
      ["只改被要求的", "Change only what was asked"],
      ["不顺手重构", "no unrequested refactors"],
      ["两次失败就停", "After two failed attempts"],
      // 对齐 Codex 的 action 口径：停在提案上、改完回读，都会把一轮改动拖成三轮。
      ["别停在提案", "do not stop at a proposal"],
      ["改完不回读", "do not re-read to verify"],
      ["多文件用 patch", "apply_patch for multi-file hunks"],
      // 对齐 cc-haha 的数字长度锚点（实测比定性「简洁」更省输出）。
      ["数字锚点", "\u2264100 words"],
    ];
    for (const [label, phrase] of redLines) {
      expect(BASE_SYSTEM_PROMPT, `基线丢了红线：${label}`).toContain(phrase);
    }
  });

  it("keeps behavior-segment working rules", () => {
    // 行为段的三个新触发条件（cc-haha 拒绝引导 / Codex 计划不复述 / Codex 里程碑插播）。
    const pins: Array<[string, string]> = [
      ["拒绝不重试", "never retry a denied call"],
      ["计划不复述", "never restate the checklist"],
      ["里程碑插播", "milestone note"],
    ];
    for (const [label, phrase] of pins) {
      expect(BEHAVIOR_SEGMENT, `行为段丢了规则：${label}`).toContain(phrase);
    }
  });

  it("minimal profile keeps the PowerShell write warning", () => {
    // Set-Content / Out-File / '>' 会改行尾、加 BOM、写 UTF-16 —— 这条丢了
    // 模型就会用它们写文件，破坏仓库的行尾约定（runtime.ts / tools.ts 是 CRLF）。
    expect(MINIMAL_SYSTEM_PROMPT).toContain("[System.IO.File]::WriteAllText");
    expect(MINIMAL_SYSTEM_PROMPT).toContain("never Set-Content, Out-File or '>'");
  });

  it("complex profile extends the base instead of replacing it", () => {
    // 复杂档只加编排要求，不能悄悄换掉基线：否则标准档的红线在复杂档消失
    expect(COMPLEX_SYSTEM_PROMPT.startsWith(BASE_SYSTEM_PROMPT)).toBe(true);
    expect(COMPLEX_SYSTEM_PROMPT).toContain("harness.json");
    expect(COMPLEX_SYSTEM_PROMPT).toContain("Never weaken a failing test");
  });

  it("does not leak profile-specific text into the base", () => {
    // 反向：档位专属要求混进基线，等于每个会话都多付一遍 token
    expect(BASE_SYSTEM_PROMPT).not.toContain("minimal mode");
    expect(BASE_SYSTEM_PROMPT).not.toContain("Complex mode is active");
    expect(BASE_SYSTEM_PROMPT).not.toContain("harness.json");
  });
});

describe("dynamic tool schema governance", () => {
  it("提升后的单工具裁剪描述至 400 token 内，并保留结构字段", () => {
    const name = "mcp__test__governed_tool";
    const description = "s".repeat(600);
    const propertyDescription = "d".repeat(600);
    try {
      expect(registerDynamicTool(name, {
        definition: {
          type: "function",
          function: {
            name,
            description,
            parameters: {
              type: "object",
              properties: {
                field_0: {
                  type: "string",
                  description: propertyDescription,
                  enum: ["alpha", "beta"],
                },
                field_1: { type: "integer", description: propertyDescription },
              },
              required: ["field_0"],
              additionalProperties: false,
            },
          },
        },
        execute: async () => ({ output: "ok", ok: true }),
      }).ok).toBe(true);
      expect(promoteDynamicTool(name)).toBe(true);

      const tools = listDynamicToolDefinitions().filter(
        (tool) => tool.function.name === name,
      );
      expect(tools).toHaveLength(1);
      expect(estimateToolDefinitionsTokens(tools)).toBeLessThanOrEqual(400);
      expect(tools[0].function.description).not.toBe(description);
      expect(tools[0].function.description).toContain("…");

      const parameters = tools[0].function.parameters as {
        type: string;
        properties: Record<string, Record<string, unknown>>;
        required?: string[];
        additionalProperties?: boolean;
      };
      expect(parameters.type).toBe("object");
      expect(parameters.required).toEqual(["field_0"]);
      expect(parameters.additionalProperties).toBe(false);
      expect(parameters.properties.field_0.type).toBe("string");
      expect(parameters.properties.field_0.enum).toEqual(["alpha", "beta"]);
      expect(parameters.properties.field_0.description).not.toBe(propertyDescription);
      expect(parameters.properties.field_1.type).toBe("integer");
    } finally {
      unregisterDynamicTool(name);
      listDynamicToolDefinitions();
    }
  });
});
