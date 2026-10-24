import { describe, expect, it } from "vitest";
import { estimateTokens } from "./context.js";
import { COMPACTION_SYSTEM_PROMPT, TOOL_DIGEST_SYSTEM_PROMPT } from "./compaction.js";
import { BASE_SYSTEM_PROMPT } from "./runtime.js";
import { toolDefinitions } from "./tools.js";

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

  it("tool schemas stay under 2700 tokens", () => {
    // 2200 → 2350：新增 run_code（PTC code mode）的定义。它每次使用省掉的是
    // 整轮多工具往返的全上下文重发，每请求 ~150 token 的固定成本明确划算。
    // 2350 → 2700：read_file 增加 PDF 页范围、新增 read_video（9 帧拼图 ~1.5k
    // token/次，替掉"整段视频进上下文"的不可行方案），两者合计 ~220 token。
    // 上限仍兜住"描述悄悄膨胀"的回归。
    const tokens = estimateTokens(JSON.stringify(toolDefinitions));
    expect(tokens).toBeLessThan(2_700);
  });

  it("compaction prompts stay under 2500 chars", () => {
    const chars = COMPACTION_SYSTEM_PROMPT.length + TOOL_DIGEST_SYSTEM_PROMPT.length;
    expect(chars).toBeLessThan(2_500);
  });
});
