import { describe, expect, it } from "vitest";
import {
  PLUGIN_SLOT_MAP,
  PLUGIN_SLOT_NAMES,
  PLUGIN_UI_SLOTS,
  pluginSlotDefinition,
} from "./ui-slots.js";

const KINDS = new Set(["list", "keyed", "single", "wrap", "page", "tab"]);

describe("PLUGIN_UI_SLOTS", () => {
  it("槽位名唯一且都是合法 kind", () => {
    const names = new Set<string>();
    for (const slot of PLUGIN_UI_SLOTS) {
      expect(names.has(slot.name)).toBe(false);
      names.add(slot.name);
      expect(KINDS.has(slot.kind)).toBe(true);
      expect(slot.group.length).toBeGreaterThan(0);
      expect(slot.location.length).toBeGreaterThan(0);
      expect(slot.summary.length).toBeGreaterThan(0);
      expect(slot.props.length).toBeGreaterThan(0);
    }
  });

  it("目录、名字表与映射三份数据一致", () => {
    expect(new Set(PLUGIN_SLOT_NAMES)).toEqual(new Set(PLUGIN_UI_SLOTS.map((slot) => slot.name)));
    expect(Object.keys(PLUGIN_SLOT_MAP)).toHaveLength(PLUGIN_UI_SLOTS.length);
    for (const slot of PLUGIN_UI_SLOTS) {
      expect(PLUGIN_SLOT_MAP[slot.name]).toBe(slot);
      expect(pluginSlotDefinition(slot.name)).toBe(slot);
    }
  });

  it("keyed 槽位声明 key 取值域，找不到的槽位返回 undefined", () => {
    for (const slot of PLUGIN_UI_SLOTS) {
      if (slot.kind === "keyed") expect(slot.keyDomain?.length).toBeGreaterThan(0);
    }
    expect(pluginSlotDefinition("no.such.slot")).toBeUndefined();
  });
});
