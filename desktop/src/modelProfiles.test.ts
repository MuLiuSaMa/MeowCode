import { afterEach, describe, expect, it } from "vitest";
import {
  catalogForModel,
  detectedCapabilities,
  isStaleCapability,
  modelProfilesRevision,
  remoteReasoningValues,
  setModelProfiles,
  setModelsDevCatalog,
  subscribeModelProfiles,
} from "./modelProfiles";

afterEach(() => {
  setModelProfiles(null);
  setModelsDevCatalog(null);
});

describe("detectedCapabilities 内置兜底", () => {
  it("recognizes the MiMo V2.6 series", () => {
    expect(detectedCapabilities("mimo-v2.6-flash")).toEqual({
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      supportsImage: true,
    });
    expect(detectedCapabilities("mimo-v2.6-pro")).toMatchObject({
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      supportsImage: true,
    });
  });

  it("matches namespaced model ids too", () => {
    expect(detectedCapabilities("xiaomi/mimo-v2.6-pro")).toMatchObject({
      contextWindow: 1_000_000,
      supportsImage: true,
    });
  });

  it("keeps the V2.5 Pro image restriction", () => {
    expect(detectedCapabilities("mimo-v2.5")).toMatchObject({ supportsImage: true });
    expect(detectedCapabilities("mimo-v2.5-pro")).toMatchObject({
      contextWindow: 1_000_000,
      supportsImage: false,
    });
  });

  it("prefers remote rules once they cover the model", () => {
    setModelProfiles([
      { match: "mimo-v2\\.6", contextWindow: 500_000, maxOutputTokens: 32_000, supportsImage: false },
    ]);
    expect(detectedCapabilities("mimo-v2.6-pro")).toEqual({
      contextWindow: 500_000,
      maxOutputTokens: 32_000,
      supportsImage: false,
    });
  });

  it("falls back to built-ins when remote only has the wildcard layer", () => {
    setModelProfiles([{ match: ".*", contextWindow: 200_000 }]);
    expect(detectedCapabilities("mimo-v2.6-flash")).toMatchObject({ contextWindow: 1_000_000 });
    expect(detectedCapabilities("unknown-model")).toEqual({});
  });

  it("returns nothing for models it does not know", () => {
    expect(detectedCapabilities("unknown-model")).toEqual({});
  });
});

describe("GLM-5.4 与上游兜底的优先级", () => {
  it("上游只有 glm-5 泛匹配时，内置的 5.4 规格压过它", () => {
    // ZCode rev 22 的真实形态：只有 .*glm-5 → 200K/64K，没有 5.4 的具体规则
    setModelProfiles([
      { match: ".*glm-5(?:[.\\-:/\\[].*)?", contextWindow: 200_000, maxOutputTokens: 64_000, supportsImage: false },
    ]);
    expect(detectedCapabilities("GLM-5.4")).toMatchObject({
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      supportsImage: true,
    });
    // 同一条兜底对 5.2 仍然生效（没有内置规则覆盖）
    expect(detectedCapabilities("GLM-5.2")).toMatchObject({ contextWindow: 200_000 });
  });

  it("上游补齐同名规则后自动切回远程值（后续自动更新）", () => {
    setModelProfiles([
      { match: ".*glm-5(?:[.\\-:/\\[].*)?", contextWindow: 200_000, maxOutputTokens: 64_000 },
      { match: ".*glm-5\\.4(?:[.\\-:/\\[].*)?", contextWindow: 2_000_000, maxOutputTokens: 200_000 },
    ]);
    expect(detectedCapabilities("GLM-5.4")).toMatchObject({
      contextWindow: 2_000_000,
      maxOutputTokens: 200_000,
    });
  });

  it("远程只要点名了这一版就直接生效，哪怕正则写得更短", () => {
    // 刻意用一个比内置规则"更泛"的写法：含 5.4 版本号即视为远程认领这一版
    setModelProfiles([{ match: ".*5\\.4.*", contextWindow: 3_000_000 }]);
    expect(detectedCapabilities("GLM-5.4")).toMatchObject({ contextWindow: 3_000_000 });
  });

  it("远程只写了部分字段时，其余字段仍由内置同版规则补齐", () => {
    setModelProfiles([
      { match: ".*glm-5(?:[.\\-:/\\[].*)?", contextWindow: 200_000, maxOutputTokens: 64_000, supportsImage: false },
      // 上游只更新了上下文窗口
      { match: ".*glm-5\\.4(?:[.\\-:/\\[].*)?", contextWindow: 2_000_000 },
    ]);
    expect(detectedCapabilities("GLM-5.4")).toMatchObject({
      contextWindow: 2_000_000,
      maxOutputTokens: 131_072,
      supportsImage: true,
    });
  });

  it("远程没点名版本时，仍由内置的具体规则兜底", () => {
    setModelProfiles([{ match: ".*glm-5(?:[.\\-:/\\[].*)?", contextWindow: 200_000 }]);
    expect(detectedCapabilities("GLM-5.4")).toMatchObject({ contextWindow: 1_000_000 });
  });
});

describe("订阅（界面按新规则重算）", () => {
  it("规则表或目录变化都会通知订阅者并推进版本号", () => {
    const seen: number[] = [];
    const off = subscribeModelProfiles(() => seen.push(modelProfilesRevision()));
    setModelsDevCatalog({ "glm-5.4": { contextWindow: 1_000_000 } });
    setModelProfiles([{ match: ".*glm-5" }]);
    off();
    // 取消订阅后不再收到
    setModelProfiles(null);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0] + 1);
  });
});

describe("models.dev 目录（第二路远程）", () => {
  it("模型级目录优先于 ZCode 规则，并认识网关前缀", () => {
    setModelsDevCatalog({
      "glm-5.4": {
        contextWindow: 1_000_000,
        maxOutputTokens: 131_072,
        supportsImage: true,
        levels: ["low", "high", "max"],
      },
    });
    setModelProfiles([{ match: ".*glm-5(?:[.\\-:/\\[].*)?", contextWindow: 200_000 }]);
    expect(detectedCapabilities("zcode/GLM-5.4")).toMatchObject({
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      supportsImage: true,
    });
    expect(remoteReasoningValues("GLM-5.4")).toEqual(["low", "high", "max"]);
  });

  it("目录只给部分字段时，其余字段由规则补", () => {
    setModelsDevCatalog({ "glm-5.4": { contextWindow: 2_000_000 } });
    setModelProfiles([
      { match: ".*glm-5\\.4(?:[.\\-:/\\[].*)?", maxOutputTokens: 200_000 },
    ]);
    expect(detectedCapabilities("GLM-5.4")).toMatchObject({
      contextWindow: 2_000_000,
      maxOutputTokens: 200_000,
    });
  });

  it("后缀退化只在分隔符处发生，glm-5 不会吃掉 glm-5.4", () => {
    setModelsDevCatalog({ "glm-5": { contextWindow: 200_000 } });
    expect(catalogForModel("glm-5.4")).toBeUndefined();
    expect(catalogForModel("glm-5-economy")?.contextWindow).toBe(200_000);
    expect(catalogForModel("zcode/GLM-5")?.contextWindow).toBe(200_000);
  });
});

describe("isStaleCapability（旧条目自动升到新规则）", () => {
  it("旧规则填的 20 万判定为过期，手填值不动", () => {
    setModelProfiles([{ match: ".*glm-5(?:[.\\-:/\\[].*)?", contextWindow: 200_000, maxOutputTokens: 64_000 }]);
    // 20 万正是上游 glm-5 兜底给的值 → 说明当初是自动填的，可以纠正
    expect(isStaleCapability("GLM-5.4", "contextWindow", 200_000)).toBe(true);
    expect(isStaleCapability("GLM-5.4", "maxOutputTokens", 64_000)).toBe(true);
    // 已经是新值，不用动
    expect(isStaleCapability("GLM-5.4", "contextWindow", 1_000_000)).toBe(false);
    // 和任何规则都对不上 → 当成用户手填
    expect(isStaleCapability("GLM-5.4", "contextWindow", 150_000)).toBe(false);
    expect(isStaleCapability("unknown-model", "contextWindow", 200_000)).toBe(false);
  });
});
