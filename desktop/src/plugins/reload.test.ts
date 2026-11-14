import { describe, expect, it } from "vitest";
import type { PluginDescriptor } from "../api";
import { shouldReloadPlugin } from "./reload";

function descriptor(rev?: string): PluginDescriptor {
  return {
    id: "demo",
    path: "demo/index.ts",
    source: "user",
    enabled: true,
    ui: {
      client: {
        entry: "client.js",
        permissions: ["ui"],
        ...(rev ? { rev } : {}),
      },
    },
  };
}

describe("shouldReloadPlugin", () => {
  it("未加载过就加载", () => {
    expect(shouldReloadPlugin(undefined, descriptor("a"))).toBe(true);
  });

  it("rev 相同不重置插件状态", () => {
    expect(shouldReloadPlugin({ rev: "a" }, descriptor("a"))).toBe(false);
  });

  it("rev 变化后重新加载", () => {
    expect(shouldReloadPlugin({ rev: "a" }, descriptor("b"))).toBe(true);
  });

  it("旧 server 没有 rev 时不主动重置", () => {
    expect(shouldReloadPlugin({ rev: "a" }, descriptor())).toBe(false);
  });
});
