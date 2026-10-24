import { describe, expect, it } from "vitest";
import {
  BREAKPOINT_CAP,
  cacheControlFor,
  hasBreakpoint,
  resolveCachePlan,
  sessionAffinityKey,
} from "./cache-profile.js";
import type { ProviderConfig } from "./types.js";

function provider(patch: Partial<ProviderConfig>): ProviderConfig {
  return {
    id: "p",
    name: "p",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
    protocol: "anthropic-messages",
    ...patch,
  };
}

describe("resolveCachePlan", () => {
  it("gives the native Anthropic endpoint all four breakpoints", () => {
    const plan = resolveCachePlan(provider({}));
    expect(plan.profile).toBe("anthropic-native");
    expect(plan.breakpoints).toEqual(["tools", "system0", "system1", "tail"]);
    expect(plan.enabled).toBe(true);
    expect(plan.dropped).toBe(0);
  });

  it("recognises Claude models served through a gateway", () => {
    const plan = resolveCachePlan(
      provider({ baseUrl: "https://gateway.example.com", model: "claude-opus-4" }),
    );
    expect(plan.profile).toBe("anthropic-native");
  });

  it("drops the tools breakpoint for Qwen / DashScope (they reject it)", () => {
    const plan = resolveCachePlan(
      provider({
        baseUrl: "https://dashscope.aliyuncs.com/api/v2/apps/claude-code-proxy",
        model: "qwen3-max",
      }),
    );
    expect(plan.profile).toBe("qwen");
    expect(plan.breakpoints).toEqual(["system0", "tail"]);
    expect(hasBreakpoint(plan, "tools")).toBe(false);
    expect(hasBreakpoint(plan, "tail")).toBe(true);
  });

  it("falls back to system+tail on an unknown Anthropic-compatible gateway", () => {
    const plan = resolveCachePlan(
      provider({ baseUrl: "https://api.some-gateway.dev/v1", model: "glm-4.6" }),
    );
    expect(plan.profile).toBe("anthropic-gateway");
    expect(plan.breakpoints).toEqual(["system0", "tail"]);
  });

  it("never returns more breakpoints than the Anthropic cap", () => {
    for (const baseUrl of [
      "https://api.anthropic.com",
      "https://dashscope.aliyuncs.com",
      "https://x.dev",
      "not a url",
    ]) {
      const plan = resolveCachePlan(provider({ baseUrl }));
      expect(plan.breakpoints.length).toBeLessThanOrEqual(BREAKPOINT_CAP);
      expect(plan.dropped).toBe(0);
    }
  });

  it("does not tag breakpoints for chat completions", () => {
    const plan = resolveCachePlan(
      provider({ baseUrl: "https://api.openai.com/v1", model: "gpt-4o", protocol: "openai-chat-completions" }),
    );
    expect(plan.profile).toBe("none");
    expect(plan.enabled).toBe(false);
    expect(cacheControlFor(plan)).toBeUndefined();
  });
});

describe("cacheControlFor", () => {
  it("omits the ttl field by default (5m)", () => {
    expect(cacheControlFor(resolveCachePlan(provider({})))).toEqual({ type: "ephemeral" });
  });

  it("sends ttl 1h only when explicitly configured", () => {
    expect(cacheControlFor(resolveCachePlan(provider({ cacheTtl: "1h" })))).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });
});

describe("responses retention", () => {
  it("asks for 24h retention only on the official endpoint with a whitelisted model", () => {
    const official = resolveCachePlan(
      provider({
        protocol: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.1-codex",
      }),
    );
    expect(official.retention).toBe("24h");
  });

  it("skips retention for third-party gateways and older models", () => {
    const gateway = resolveCachePlan(
      provider({
        protocol: "openai-responses",
        baseUrl: "https://proxy.example.com/v1",
        model: "gpt-5",
      }),
    );
    expect(gateway.retention).toBeUndefined();
    const legacy = resolveCachePlan(
      provider({
        protocol: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-3.5-turbo",
      }),
    );
    expect(legacy.retention).toBeUndefined();
  });
});

describe("sessionAffinityKey", () => {
  it("is stable per session and purpose, capped at 64 chars", () => {
    expect(sessionAffinityKey("abc")).toBe("abc:main");
    expect(sessionAffinityKey("abc", "title")).toBe("abc:title");
    expect(sessionAffinityKey("x".repeat(200)).length).toBe(64);
  });
});
