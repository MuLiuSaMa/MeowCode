import { Component, type ComponentType, type ReactNode } from "react";
import { reportPluginError } from "./errors";
import { usePluginSlot } from "./runtime";
import { pluginSlots } from "./slot-registry";
import type { SlotName } from "./types";

/** 单个贡献的错误边界：抛错就摘掉该条目并上报，不影响其他插件。 */
class PluginContributionBoundary extends Component<
  {
    pluginId: string;
    slot: SlotName;
    entryId: string;
    children: ReactNode;
  },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    reportPluginError(this.props.pluginId, message, this.props.slot);
    pluginSlots.remove(this.props.pluginId, this.props.slot, this.props.entryId);
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** 渲染单个贡献：设置页需要按 section id 精确取一条。 */
export function PluginContribution({
  contribution,
  props,
}: {
  contribution: { pluginId: string; slot: SlotName; entry: { id: string }; component: ComponentType<Record<string, unknown>> };
  props: Record<string, unknown>;
}) {
  const Contribution = contribution.component;
  return (
    <PluginContributionBoundary
      pluginId={contribution.pluginId}
      slot={contribution.slot}
      entryId={contribution.entry.id}
    >
      <Contribution {...props} />
    </PluginContributionBoundary>
  );
}

/** 渲染一个槽位的全部贡献；没有贡献时返回 fallback。 */
export function PluginSlot({
  name,
  slotKey,
  props,
  fallback = null,
}: {
  name: SlotName;
  slotKey?: string;
  props: Record<string, unknown>;
  fallback?: ReactNode;
}) {
  const contributions = usePluginSlot(name, slotKey);
  if (contributions.length === 0) return <>{fallback}</>;
  return (
    <>
      {contributions.map((contribution) => {
        const Contribution = contribution.component as ComponentType<Record<string, unknown>>;
        return (
          <PluginContributionBoundary
            key={`${contribution.pluginId}:${contribution.entry.id}`}
            pluginId={contribution.pluginId}
            slot={name}
            entryId={contribution.entry.id}
          >
            <Contribution {...props} />
          </PluginContributionBoundary>
        );
      })}
    </>
  );
}
