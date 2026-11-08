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

  it("认不出的模型返回 undefined，由调用方退回 MeowCode 的 Logo", () => {
    expect(modelIconKey("some-unknown-model")).toBeUndefined();
    expect(modelIconKey("")).toBeUndefined();
  });
});
