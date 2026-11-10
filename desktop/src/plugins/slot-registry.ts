import type { ComponentType } from "react";
import type { SlotContribution, SlotEntry, SlotName } from "./types";

/**
 * 渲染器内的槽位注册表：插件通过 ctx.slots.register 贡献组件，
 * 宿主组件用 usePluginSlot 订阅。注册/注销都按插件归属精确清理。
 */
export class PluginSlotRegistry {
  private contributions = new Map<SlotName, SlotContribution[]>();
  private listeners = new Set<() => void>();
  private snapshots = new Map<string, SlotContribution[]>();
  private seq = 0;

  register(
    pluginId: string,
    slot: SlotName,
    entry: SlotEntry,
    component: ComponentType<Record<string, unknown>>,
  ): () => void {
    const list = this.contributions.get(slot) ?? [];
    const contribution: SlotContribution = {
      pluginId,
      slot,
      entry: { ...entry },
      component,
      seq: this.seq++,
    };
    list.push(contribution);
    this.contributions.set(slot, list);
    this.invalidate();

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const current = this.contributions.get(slot);
      if (!current) return;
      const index = current.indexOf(contribution);
      if (index < 0) return;
      current.splice(index, 1);
      this.invalidate();
    };
  }

  remove(pluginId: string, slot: SlotName, entryId: string): void {
    const current = this.contributions.get(slot);
    if (!current) return;
    const index = current.findIndex(
      (item) => item.pluginId === pluginId && item.entry.id === entryId,
    );
    if (index < 0) return;
    current.splice(index, 1);
    this.invalidate();
  }

  clearPlugin(pluginId: string): void {
    let changed = false;
    for (const [slot, list] of this.contributions) {
      const kept = list.filter((item) => item.pluginId !== pluginId);
      if (kept.length !== list.length) {
        this.contributions.set(slot, kept);
        changed = true;
      }
    }
    if (changed) this.invalidate();
  }

  clearAll(): void {
    this.contributions.clear();
    this.invalidate();
  }

  /** keyed 槽位（message.toolCard）按 entry.key 命中；其他槽位忽略 key。 */
  get(slot: SlotName, key?: string): SlotContribution[] {
    const cacheKey = `${slot}\u0000${key ?? ""}`;
    const cached = this.snapshots.get(cacheKey);
    if (cached) return cached;
    const filtered = (this.contributions.get(slot) ?? [])
      .filter((item) => (key === undefined ? true : item.entry.key === key))
      .sort((a, b) => (a.entry.order ?? 1000) - (b.entry.order ?? 1000) || a.seq - b.seq);
    this.snapshots.set(cacheKey, filtered);
    return filtered;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private invalidate(): void {
    this.snapshots.clear();
    for (const listener of this.listeners) listener();
  }
}

export const pluginSlots = new PluginSlotRegistry();
