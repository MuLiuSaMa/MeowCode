import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { consensus, extractModelsDev } = require("./models-dev.cjs") as {
  consensus: (values: Array<number | boolean | string | null>) => number | boolean | string | null;
  extractModelsDev: (payload: unknown) => Record<
    string,
    { contextWindow: number; maxOutputTokens?: number; supportsImage?: boolean; levels?: string[] }
  >;
};

/** 造一个 models.dev 形状的服务商条目。 */
function provider(models: Record<string, unknown>) {
  return { models };
}

function model(context: number, output?: number, inputs: string[] = ["text"], levels?: string[]) {
  return {
    limit: { context, ...(output ? { output } : {}) },
    modalities: { input: inputs },
    ...(levels ? { reasoning_options: [{ type: "effort", values: levels }] } : {}),
  };
}

describe("models.dev 抽表", () => {
  it("多数票优先，离群的大数字不会带偏", () => {
    const models = extractModelsDev({
      a: provider({
        "glm-5.4": model(1_000_000, 131_072, ["text", "image"], ["low", "high", "max"]),
      }),
      b: provider({
        "glm-5.4": model(1_000_000, 131_072, ["text", "image"], ["low", "high", "max"]),
      }),
      c: provider({
        "glm-5.4": model(1_048_576, 1_048_576, ["text"], ["low", "medium", "high", "max"]),
      }),
    });
    expect(models["glm-5.4"]).toEqual({
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      supportsImage: true,
      levels: ["low", "high", "max"],
    });
  });

  it("票数并列时：数字取大、布尔取 true", () => {
    const models = extractModelsDev({
      a: provider({ "gpt-5.6": model(372_000, 64_000, ["text"]) }),
      b: provider({ "gpt-5.6": model(1_050_000, 128_000, ["text", "image"]) }),
    });
    expect(models["gpt-5.6"]).toMatchObject({
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      supportsImage: true,
    });
  });

  it("没有上下文的条目直接跳过，id 统一小写", () => {
    const models = extractModelsDev({
      a: provider({
        "GLM-5.4": model(1_000_000),
        broken: { limit: {}, modalities: { input: ["text"] } },
      }),
    });
    expect(Object.keys(models)).toEqual(["glm-5.4"]);
  });

  it("命名空间 id（zhipuai/glm-5.3-flash）并入同一条一起投票", () => {
    const models = extractModelsDev({
      a: provider({ "glm-5.3-flash": model(1_000_000, 131_072, ["text", "image"], ["low", "high", "max"]) }),
      b: provider({ "zhipuai/glm-5.3-flash": model(1_000_000, 131_072, ["text"], ["low", "medium", "high"]) }),
    });
    expect(Object.keys(models)).toEqual(["glm-5.3-flash"]);
    expect(models["glm-5.3-flash"]).toMatchObject({
      supportsImage: true,
      levels: ["low", "high", "max"],
    });
  });

  it("没有思考档位时不写 levels 字段", () => {
    const models = extractModelsDev({ a: provider({ "glm-5.3": model(1_000_000) }) });
    expect(models["glm-5.3"].levels).toBeUndefined();
  });

  it("consensus：空数组返回 null，参数里 null 被忽略", () => {
    expect(consensus([])).toBeNull();
    expect(consensus([null, null])).toBeNull();
    expect(consensus([3, 3, null, 9])).toBe(3);
  });
});
