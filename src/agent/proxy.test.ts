import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PROXY_CONFIG,
  getProxyConfig,
  maskProxyUrl,
  normalizeProxyUrl,
  readProxyFromEnv,
  resolveProxyUrl,
  setProxyConfig,
  shouldBypassProxy,
} from "./proxy";

afterEach(() => {
  setProxyConfig(DEFAULT_PROXY_CONFIG);
});

describe("normalizeProxyUrl", () => {
  it("adds a scheme when missing", () => {
    expect(normalizeProxyUrl("127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
    expect(normalizeProxyUrl("http://127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
    expect(normalizeProxyUrl("https://proxy.local:8080/")).toBe("https://proxy.local:8080");
  });

  it("rejects empty and non-http protocols", () => {
    expect(normalizeProxyUrl("")).toBeUndefined();
    expect(normalizeProxyUrl("   ")).toBeUndefined();
    expect(normalizeProxyUrl("socks5://127.0.0.1:1080")).toBeUndefined();
    expect(normalizeProxyUrl("http://")).toBeUndefined();
  });
});

describe("maskProxyUrl", () => {
  it("hides credentials", () => {
    expect(maskProxyUrl("http://user:secret@proxy.local:8080")).not.toContain("secret");
    expect(maskProxyUrl("http://proxy.local:8080")).toBe("http://proxy.local:8080");
  });
});

describe("NO_PROXY matching", () => {
  it("supports wildcard, bare host, leading dot and ports", () => {
    expect(shouldBypassProxy("https://api.openai.com/v1", "*")).toBe(true);
    expect(shouldBypassProxy("http://localhost:11434/api", "localhost")).toBe(true);
    expect(shouldBypassProxy("http://127.0.0.1:11434", "127.0.0.1:11434")).toBe(true);
    expect(shouldBypassProxy("https://a.example.com/x", ".example.com")).toBe(true);
    expect(shouldBypassProxy("https://example.com/x", "example.com")).toBe(true);
    expect(shouldBypassProxy("https://api.openai.com/v1", "localhost,127.0.0.1")).toBe(false);
  });

  it("does not crash on an unparsable target", () => {
    expect(shouldBypassProxy("not a url", "localhost")).toBe(false);
  });
});

describe("readProxyFromEnv", () => {
  it("defaults to direct", () => {
    expect(readProxyFromEnv({})).toEqual({ mode: "direct", url: "" });
  });

  it("honours an explicit mode", () => {
    expect(readProxyFromEnv({ MEOWCODE_PROXY_MODE: "system" })).toEqual({
      mode: "system",
      url: "",
    });
  });

  it("treats a bare url as manual", () => {
    expect(readProxyFromEnv({ MEOWCODE_PROXY_URL: "http://127.0.0.1:7890" })).toEqual({
      mode: "manual",
      url: "http://127.0.0.1:7890",
    });
  });

  it("ignores an unknown mode and falls back to direct", () => {
    expect(readProxyFromEnv({ MEOWCODE_PROXY_MODE: "bogus" }).mode).toBe("direct");
  });
});

describe("resolveProxyUrl", () => {
  it("returns nothing in direct mode", () => {
    expect(resolveProxyUrl({ mode: "direct", url: "http://p:1" }, {})).toBeUndefined();
  });

  it("uses the manual url", () => {
    expect(resolveProxyUrl({ mode: "manual", url: "127.0.0.1:7890" }, {})).toBe(
      "http://127.0.0.1:7890",
    );
  });

  it("falls back to the usual env vars in system mode", () => {
    expect(resolveProxyUrl({ mode: "system", url: "" }, { HTTPS_PROXY: "http://p:1" })).toBe(
      "http://p:1",
    );
    expect(resolveProxyUrl({ mode: "system", url: "" }, { HTTP_PROXY: "http://p:2" })).toBe(
      "http://p:2",
    );
    expect(resolveProxyUrl({ mode: "system", url: "" }, {})).toBeUndefined();
  });

  it("prefers the desktop-resolved url over env vars", () => {
    expect(
      resolveProxyUrl(
        { mode: "system", url: "" },
        { MEOWCODE_PROXY_URL: "http://resolved:9", HTTPS_PROXY: "http://env:1" },
      ),
    ).toBe("http://resolved:9");
  });

  it("lets NO_PROXY bypass a local target in system mode only", () => {
    const env = { HTTPS_PROXY: "http://p:1", NO_PROXY: "localhost,127.0.0.1" };
    expect(resolveProxyUrl({ mode: "system", url: "" }, env, "http://127.0.0.1:11434/api")).toBeUndefined();
    expect(resolveProxyUrl({ mode: "system", url: "" }, env, "https://api.openai.com/v1")).toBe(
      "http://p:1",
    );
    // 手动模式是用户的明确意图，不套 NO_PROXY
    expect(
      resolveProxyUrl({ mode: "manual", url: "http://p:1" }, env, "http://127.0.0.1:11434"),
    ).toBe("http://p:1");
  });
});

describe("setProxyConfig", () => {
  it("stores the config and rejects unknown modes", () => {
    setProxyConfig({ mode: "manual", url: " http://127.0.0.1:7890 " });
    expect(getProxyConfig()).toEqual({ mode: "manual", url: "http://127.0.0.1:7890" });

    setProxyConfig({ mode: "nope" as never, url: "x" });
    expect(getProxyConfig()).toEqual(DEFAULT_PROXY_CONFIG);
  });
});
