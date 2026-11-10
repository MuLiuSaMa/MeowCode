import { describe, expect, it } from "vitest";
import { modelIconKey } from "./providerIcons";

describe("modelIconKey", () => {
  it("Claude 用 Claude 自己的标，而不是 Anthropic 的企业标", () => {
    expect(modelIconKey("claude-sonnet-4-5")).toBe("claude");
    expect(modelIconKey("claude-3-5-haiku")).toBe("claude");
  });

  it("小众模型能识别到各自的品牌标", () => {
    expect(modelIconKey("longcat-flash-chat")).toBe("longcat");
    expect(modelIconKey("yi-lightning")).toBe("yi");
    expect(modelIconKey("internlm2.5-20b")).toBe("internlm");
    expect(modelIconKey("skywork-13b")).toBe("skywork");
    expect(modelIconKey("tiangong-3")).toBe("tiangong");
    expect(modelIconKey("ling-flash-2.0")).toBe("ling");
    expect(modelIconKey("rwkv-7")).toBe("rwkv");
    expect(modelIconKey("codegeex4")).toBe("codegeex");
  });

  it("带连字符的前缀不会误伤别的模型", () => {
    // 文心一言是百度的，不能被 "yi" 抢走
    expect(modelIconKey("yiyan-4")).toBeUndefined();
    // kling 是视频模型，不是蚂蚁的 Ling
    expect(modelIconKey("kling-video")).toBeUndefined();
  });

  it("聚合平台的 vendor 前缀不影响识别", () => {
    expect(modelIconKey("openrouter/anthropic/claude-sonnet-4")).toBe("claude");
    expect(modelIconKey("openrouter/deepseek/deepseek-v3")).toBe("deepseek");
    expect(modelIconKey("openrouter/meta-llama/llama-3.1-70b")).toBe("meta");
  });

  it("模型 id 里任意位置带品牌词都能识别（大小写 / 随机前后缀）", () => {
    expect(modelIconKey("jwadijawodwa-deepseek-1313013")).toBe("deepseek");
    expect(modelIconKey("acme-DeepSeek-V3-prod")).toBe("deepseek");
    // 连分隔符都没有：靠独特品牌词兜底
    expect(modelIconKey("zwdeepseekv3random")).toBe("deepseek");
    expect(modelIconKey("my-Claude-Sonnet-4-proxy")).toBe("claude");
    expect(modelIconKey("QWEN2.5-72B-Instruct")).toBe("qwen");
    expect(modelIconKey("vendor_Kimi_K2_turbo")).toBe("moonshot-kimi");
    expect(modelIconKey("x-google-gemini-2.5-flash")).toBe("google-gemini");
    expect(modelIconKey("zzz-llama-3.3-70b")).toBe("meta");
    expect(modelIconKey("jwadijawodwa-glm-4.6")).toBe("zai");
  });

  it("短品牌词只在开头或独立成词时才算，不会误伤随机串", () => {
    // o3 只出现在词中间，不当成 openai
    expect(modelIconKey("proto3-model")).toBeUndefined();
    // phi / step / seed / nova 同理：词中间出现、或只是词首（stepstone）都不算
    expect(modelIconKey("graphite-7b")).toBeUndefined();
    expect(modelIconKey("chat-stepstone-v2")).toBeUndefined();
  });

  it("认不出的模型返回 undefined，由调用方退回 MeowCode 的 Logo", () => {
    expect(modelIconKey("some-unknown-model")).toBeUndefined();
    expect(modelIconKey("")).toBeUndefined();
  });

  it("真实聚合平台的 model id 都能认出品牌", () => {
    expect(modelIconKey("deepseek-ai/DeepSeek-V3.2")).toBe("deepseek");
    expect(modelIconKey("Pro/deepseek-ai/DeepSeek-R1")).toBe("deepseek");
    expect(modelIconKey("Qwen/Qwen3-235B-A22B")).toBe("qwen");
    expect(modelIconKey("moonshotai/Kimi-K2")).toBe("moonshot-kimi");
    expect(modelIconKey("zai-org/GLM-4.6")).toBe("zai");
    expect(modelIconKey("MiniMaxAI/MiniMax-M2")).toBe("minimax");
    expect(modelIconKey("XiaomiMiMo/MiMo-V2-Flash")).toBe("xiaomi-mimo");
    expect(modelIconKey("stepfun-ai/Step-3")).toBe("stepfun");
    expect(modelIconKey("PaddlePaddle/ERNIE-4.5-300B")).toBe("wenxin");
    expect(modelIconKey("openai/gpt-oss-120b")).toBe("openai");
    expect(modelIconKey("google/gemma-3-27b-it")).toBe("google-gemini");
    expect(modelIconKey("meta-llama/Llama-4-Scout")).toBe("meta");
    expect(modelIconKey("mistralai/Mistral-Large")).toBe("mistral");
    expect(modelIconKey("anthropic/claude-opus-4")).toBe("claude");
    expect(modelIconKey("x-ai/grok-4")).toBe("xai");
    expect(modelIconKey("01-ai/Yi-34B")).toBe("yi");
    expect(modelIconKey("internlm/internlm2_5-7b")).toBe("internlm");
  });
});
