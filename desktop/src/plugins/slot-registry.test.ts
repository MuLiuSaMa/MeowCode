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
