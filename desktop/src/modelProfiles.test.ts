import { afterEach, describe, expect, it } from "vitest";
import { detectedCapabilities, setModelProfiles } from "./modelProfiles";

afterEach(() => {
  setModelProfiles(null);
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
