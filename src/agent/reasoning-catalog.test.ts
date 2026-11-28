import { describe, expect, it } from "vitest";
import {
  defaultEffortForModel,
  isEffortSupported,
  recommendedEffortForModel,
  reasoningLevelsForModel,
} from "./reasoning-catalog.js";

/**
 * 这张表的价值在"不要把不认识的档位发给服务商"：
 * DeepSeek 一类只认 low/high/max，发 medium 会被当成高档，用户以为调快了、其实没有。
 */
describe("reasoning catalog", () => {
  it("deepseek 只用 low/high/max，推荐 low", () => {
    const model = "deepseek-v4.1-flash-economy";
    expect(reasoningLevelsForModel(model)).toEqual(["low", "high", "max"]);
    expect(recommendedEffortForModel(model)).toBe("low");
    expect(isEffortSupported(model, "medium")).toBe(false);
  });

  it("claude / gpt 这类有 medium 的推荐 medium", () => {
    expect(recommendedEffortForModel("claude-opus-5")).toBe("medium");
    expect(reasoningLevelsForModel("gpt-5.3-codex")).toContain("medium");
    expect(recommendedEffortForModel("grok-4.6")).toBe("medium");
  });

  it("未知模型走通用四档，推荐 medium，不拦任何空值", () => {
    const model = "some-local-model";
    expect(reasoningLevelsForModel(model)).toEqual(["minimal", "low", "medium", "high"]);
    expect(recommendedEffortForModel(model)).toBe("medium");
    expect(isEffortSupported(model, "")).toBe(true);
  });

  it("推荐值必须落在自己的档位表里", () => {
    for (const model of ["deepseek-v4-pro", "glm-5.3", "kimi-k3", "gpt-5.6", "claude-sonnet-5"]) {
      expect(reasoningLevelsForModel(model)).toContain(recommendedEffortForModel(model));
    }
  });

  it("GLM-5.4 与 5.3 同一套档位（low/high/max），推荐 low", () => {
    const model = "zcode/GLM-5.4";
    expect(reasoningLevelsForModel(model)).toEqual(["low", "high", "max"]);
    expect(recommendedEffortForModel(model)).toBe("low");
    expect(defaultEffortForModel(model)).toBe("low");
  });
});

describe("defaultEffortForModel（没有接口查默认档位时的兜底）", () => {
  it("有 medium 就用 medium", () => {
    expect(defaultEffortForModel("claude-opus-5")).toBe("medium");
    expect(defaultEffortForModel("gpt-5.6")).toBe("medium");
  });

  it("没有 medium 档的模型取最低一档，而不是往上顶", () => {
    expect(defaultEffortForModel("deepseek-v4.1-flash-economy")).toBe("low");
    expect(defaultEffortForModel("glm-5.3")).toBe("low");
  });

  it("不认识的模型不下发（连支不支持都不知道）", () => {
    expect(defaultEffortForModel("some-local-model")).toBeUndefined();
    expect(defaultEffortForModel("")).toBeUndefined();
  });

  it("用户手配的档位表优先于目录", () => {
    // 自定义网关只认这两档：别按目录发 medium，发过去不是 400 就是被当最高档
    expect(defaultEffortForModel("some-local-model", ["low", "high"])).toBe("low");
    expect(defaultEffortForModel("deepseek-v4-pro", ["medium", "high"])).toBe("medium");
  });
});
