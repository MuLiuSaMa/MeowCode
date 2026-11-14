import { describe, expect, it, vi } from "vitest";
import { PluginSlotRegistry } from "./slot-registry";

const component = () => null;

describe("PluginSlotRegistry", () => {
  it("按 order 排序，同 order 按注册顺序", () => {
    const registry = new PluginSlotRegistry();
    registry.register("p1", "rail.actions", { id: "late", order: 20 }, component);
    registry.register("p2", "rail.actions", { id: "early", order: 10 }, component);
    registry.register("p3", "rail.actions", { id: "same-a", order: 10 }, component);
    expect(registry.get("rail.actions").map((item) => item.entry.id)).toEqual([
      "early",
      "same-a",
      "late",
    ]);
  });

  it("keyed 槽位只返回命中的 key，snapshot 引用稳定", () => {
    const registry = new PluginSlotRegistry();
    registry.register("p1", "message.toolCard", { id: "a", key: "run_command" }, component);
    registry.register("p2", "message.toolCard", { id: "b", key: "grep" }, component);
    const first = registry.get("message.toolCard", "grep");
    expect(first.map((item) => item.entry.id)).toEqual(["b"]);
    expect(registry.get("message.toolCard", "grep")).toBe(first);
  });

  it("disposer 幂等；clearPlugin 只清该插件", () => {
    const registry = new PluginSlotRegistry();
    const dispose = registry.register("p1", "rail.actions", { id: "x" }, component);
    registry.register("p2", "rail.actions", { id: "y" }, component);
    dispose();
    dispose();
    expect(registry.get("rail.actions").map((item) => item.pluginId)).toEqual(["p2"]);
    registry.clearPlugin("p2");
    expect(registry.get("rail.actions")).toEqual([]);
  });

  it("未知槽位与 keyed 缺 key 都抛引导错误", () => {
    const registry = new PluginSlotRegistry();
    expect(() =>
      registry.register("p1", "nope" as never, { id: "x" }, component),
    ).toThrow(/unknown plugin slot/);
    expect(() =>
      registry.register("p1", "message.toolCard", { id: "x" }, component),
    ).toThrow(/needs entry.key/);
  });

  it("keyed 同 key 只有 order 最小者生效", () => {
    const registry = new PluginSlotRegistry();
    registry.register("p1", "message.toolCard", { id: "late", key: "grep", order: 20 }, component);
    registry.register("p2", "message.toolCard", { id: "early", key: "grep", order: 10 }, component);
    expect(registry.get("message.toolCard", "grep").map((item) => item.entry.id)).toEqual([
      "early",
    ]);
  });

  it("同插件同槽位同 entry.id 重复注册只保留最新一份", () => {
    const registry = new PluginSlotRegistry();
    registry.register("p1", "rail.footer.actions", { id: "badge", order: 10 }, component);
    registry.register("p1", "rail.footer.actions", { id: "badge", order: 10 }, component);
    registry.register("p2", "rail.footer.actions", { id: "badge", order: 10 }, component);
    expect(registry.get("rail.footer.actions").map((item) => item.pluginId)).toEqual([
      "p1",
      "p2",
    ]);
  });

  it("getSingle 取 order 最小、同 order 先注册的贡献", () => {
    const registry = new PluginSlotRegistry();
    expect(registry.getSingle("chat.empty")).toBeUndefined();
    registry.register("p1", "chat.empty", { id: "late", order: 20 }, component);
    registry.register("p2", "chat.empty", { id: "early", order: 10 }, component);
    expect(registry.getSingle("chat.empty")?.entry.id).toBe("early");
  });

  it("订阅在注册/注销时通知", () => {
    const registry = new PluginSlotRegistry();
    const listener = vi.fn();
    const off = registry.subscribe(listener);
    const dispose = registry.register("p1", "rail.actions", { id: "x" }, component);
    expect(listener).toHaveBeenCalledTimes(1);
    dispose();
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    registry.clearAll();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
