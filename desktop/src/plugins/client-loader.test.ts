import { describe, expect, it, vi } from "vitest";
import {
  applyPluginClient,
  disposeFromApplyResult,
  evaluatePluginClient,
  type PluginStyles,
} from "./client-loader";
import type { PluginClientContext } from "./types";

function makeCtx(register = vi.fn()): PluginClientContext {
  return {
    plugin: { id: "demo", name: "Demo", version: "1.0.0", permissions: ["ui"] },
    slots: { register: register as unknown as PluginClientContext["slots"]["register"] },
    pages: { register: () => () => {} },
    actions: {
      sendPrompt: async () => {},
      insertComposerText: () => {},
      openPanel: () => {},
      toast: () => {},
      openExternal: async () => {},
      openPage: (_pageId: string, _pluginId?: string) => {},
      openView: () => {},
      showChat: () => {},
    },
    store: {
      getState: () => ({ theme: "light", locale: "zh-CN", view: "chat" }),
      subscribe: () => () => {},
    },
    rpc: { call: async () => undefined },
    storage: {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
    },
    timers: { setTimeout: () => () => {}, setInterval: () => () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

const styles = { insert: () => () => {}, dispose: () => {} } as unknown as PluginStyles;

describe("evaluatePluginClient", () => {
  it("闭包符号面可用：注册槽位并在 apply 后拿到 disposer", async () => {
    const register = vi.fn(() => () => {});
    const ctx = makeCtx(register);
    const module = await evaluatePluginClient(
      `return {
        apply(ctx) {
          return ctx.slots.register("rail.actions", { id: "hello", order: 1 }, () => null);
        },
      };`,
      { ctx, styles, host: { call: async () => undefined }, pluginId: "demo" },
    );
    await applyPluginClient(module, ctx);
    expect(register).toHaveBeenCalledWith("rail.actions", { id: "hello", order: 1 }, expect.any(Function));
  });

  it("访问被遮蔽的 fetch 会抛引导错误", async () => {
    const ctx = makeCtx();
    const module = await evaluatePluginClient(
      `return { apply() { fetch("https://example.com"); } };`,
      { ctx, styles, host: { call: async () => undefined }, pluginId: "demo" },
    );
    await expect(applyPluginClient(module, ctx)).rejects.toThrow(/fetch is not available/);
  });

  it("语法错误在执行前抛出", async () => {
    await expect(
      evaluatePluginClient("this is not javascript {", {
        ctx: makeCtx(),
        styles,
        host: { call: async () => undefined },
        pluginId: "demo",
      }),
    ).rejects.toThrow();
  });

  it("apply 返回函数数组时按逆序清理且幂等", () => {
    const calls: string[] = [];
    const dispose = disposeFromApplyResult([
      () => calls.push("a"),
      () => calls.push("b"),
    ]);
    dispose();
    dispose();
    expect(calls).toEqual(["b", "a"]);
  });
});
