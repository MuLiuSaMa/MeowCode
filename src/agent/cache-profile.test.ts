import { beforeEach, describe, expect, it } from "vitest";
import {
  BREAKPOINT_CAP,
  cacheControlFor,
  hasBreakpoint,
  noteGatewayMinimalCache,
  resetGatewayCacheDegradation,
  resolveCachePlan,
  sessionAffinityKey,
  supportsLineageAffinity,
} from "./cache-profile.js";
import type { ProviderConfig } from "./types.js";

beforeEach(() => resetGatewayCacheDegradation());

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
    expect(plan.breakpoints).toEqual(["tools", "system1", "anchor", "tail"]);
    expect(hasBreakpoint(plan, "anchor")).toBe(true);
    expect(hasBreakpoint(plan, "system0")).toBe(false);
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

  it("asks for the full four breakpoints on an unknown Anthropic-compatible gateway", () => {
    // 网关默认按官方形态要满额：4 断点是 Anthropic 自己的合法形态，多数网关原样转发。
    // 真被拒由协议层分级降级记住可用档位（见下面的 ceiling 用例）。
    const plan = resolveCachePlan(
      provider({ baseUrl: "https://api.some-gateway.dev/v1", model: "glm-4.6" }),
    );
    expect(plan.profile).toBe("anthropic-gateway");
    expect(plan.breakpoints).toEqual(["tools", "system1", "anchor", "tail"]);
  });

  it("switches to the minimal breakpoint table after a gateway rejects them", () => {
    const gateway = provider({ id: "gw-1", baseUrl: "https://api.some-gateway.dev/v1", model: "glm-4.6" });
    noteGatewayMinimalCache(gateway.id);
    const plan = resolveCachePlan(gateway);
    // 降级不是「截断满额列表」：必须保住稳定前缀与对话尾部
    expect(plan.breakpoints).toEqual(["system0", "tail"]);
    expect(hasBreakpoint(plan, "tail")).toBe(true);
    // 只影响被记过的 provider，别的网关照旧满额
    expect(
      resolveCachePlan(provider({ id: "gw-2", baseUrl: "https://other.example/v1", model: "glm-4.6" }))
        .breakpoints,
    ).toHaveLength(4);
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

describe("auto cache TTL", () => {
  it("defaults to auto when the provider does not choose a TTL", () => {
    expect(resolveCachePlan(provider({ pace: "interactive" })).ttl).toBe("1h");
    expect(resolveCachePlan(provider({ pace: "machine" })).ttl).toBe("5m");
  });

  it("gives human-paced sessions 1h and machine-paced ones 5m", () => {
    expect(resolveCachePlan(provider({ cacheTtl: "auto", pace: "interactive" })).ttl).toBe("1h");
    expect(resolveCachePlan(provider({ cacheTtl: "auto", pace: "machine" })).ttl).toBe("5m");
    // 未盖章 pace 走最保守档
    expect(resolveCachePlan(provider({ cacheTtl: "auto" })).ttl).toBe("5m");
  });

  it("clamps 1h down on endpoints that were never measured", () => {
    // 画像仍是 native（模型名含 claude），但端点没进实测白名单 → 不发 1h
    expect(
      resolveCachePlan(
        provider({ cacheTtl: "1h", baseUrl: "https://gateway.example.com/v1", model: "claude-x" }),
      ).ttl,
    ).toBe("5m");
    // Qwen 恒 5m
    expect(
      resolveCachePlan(
        provider({ cacheTtl: "auto", pace: "interactive", baseUrl: "https://dashscope.aliyuncs.com/v1", model: "qwen3-max" }),
      ).ttl,
    ).toBe("5m");
  });

  it("never emits a ttl on protocols without breakpoints", () => {
    const chat = resolveCachePlan(
      provider({ protocol: "openai-chat-completions", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", cacheTtl: "auto", pace: "interactive" }),
    );
    expect(chat.enabled).toBe(false);
    expect(chat.ttl).toBe("5m");
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

describe("supportsLineageAffinity", () => {
  it("only trusts content-addressed official OpenAI endpoints", () => {
    expect(
      supportsLineageAffinity(
        provider({ protocol: "openai-responses", baseUrl: "https://api.openai.com/v1", model: "gpt-5.1" }),
      ),
    ).toBe(true);
    expect(
      supportsLineageAffinity(
        provider({ protocol: "openai-chat-completions", baseUrl: "https://api.openai.com/v1", model: "gpt-5.1" }),
      ),
    ).toBe(true);
    // 第三方网关分片规则不可证伪
    expect(
      supportsLineageAffinity(
        provider({ protocol: "openai-responses", baseUrl: "https://proxy.example.com/v1", model: "gpt-5.1" }),
      ),
    ).toBe(false);
    // Anthropic 用显式断点，不走这套亲和键
    expect(supportsLineageAffinity(provider({}))).toBe(false);
  });
});
