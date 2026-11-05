import { describe, expect, it } from "vitest";
import { resolveProviderModelsOptions } from "./models-list";

const stored = {
  baseUrl: "https://api.example.com/v1",
  protocol: "anthropic-messages" as const,
  apiKey: "sk-stored",
  authStyle: "api-key" as const,
  extraHeaders: { "X-Title": "MeowCode" },
};

describe("resolveProviderModelsOptions", () => {
  it("falls back to the stored provider when the form has no key", () => {
    const result = resolveProviderModelsOptions(
      { baseUrl: "https://api.example.com/v1", protocol: "anthropic-messages" },
      stored,
    );
    expect(result).toEqual({
      ok: true,
      options: {
        baseUrl: "https://api.example.com/v1",
        protocol: "anthropic-messages",
        apiKey: "sk-stored",
        authStyle: "api-key",
        extraHeaders: { "X-Title": "MeowCode" },
      },
    });
  });

  it("lets explicit request values win over the stored provider", () => {
    const result = resolveProviderModelsOptions(
      {
        baseUrl: "https://other.example.com",
        apiKey: "sk-typed",
        authStyle: "bearer",
        extraHeaders: {},
      },
      stored,
    );
    expect(result).toEqual({
      ok: true,
      options: {
        baseUrl: "https://other.example.com",
        protocol: "anthropic-messages",
        apiKey: "sk-typed",
        authStyle: "bearer",
        extraHeaders: {},
      },
    });
  });

  it("treats an empty typed key as missing", () => {
    const result = resolveProviderModelsOptions({ apiKey: "  " }, stored);
    expect(result.ok && result.options.apiKey).toBe("sk-stored");
  });

  it("requires baseUrl when no stored provider matches", () => {
    expect(resolveProviderModelsOptions({}, undefined)).toEqual({
      ok: false,
      error: "baseUrl is required.",
    });
  });
});
