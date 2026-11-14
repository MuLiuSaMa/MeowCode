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
    /** 崩溃后的回退：single 用内置 UI，wrap 用内层内容，list 用 null */
    fallback?: ReactNode;
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
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}

/** 渲染单个贡献：设置页需要按 section id 精确取一条。 */
export function PluginContribution({
  contribution,
  props,
  fallback = null,
}: {
  contribution: { pluginId: string; slot: SlotName; entry: { id: string }; component: ComponentType<Record<string, unknown>> };
  props: Record<string, unknown>;
  fallback?: ReactNode;
}) {
  const Contribution = contribution.component;
  return (
    <PluginContributionBoundary
      pluginId={contribution.pluginId}
      slot={contribution.slot}
      entryId={contribution.entry.id}
      fallback={fallback}
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

/** 替换型槽位：有贡献渲染贡献（崩溃回退 fallback），否则渲染内置 fallback。 */
export function PluginSlotSingle({
  name,
  props,
  fallback = null,
}: {
  name: SlotName;
  props: Record<string, unknown>;
  fallback?: ReactNode;
}) {
  const contribution = usePluginSlot(name)[0];
  if (!contribution) return <>{fallback}</>;
  return <PluginContribution contribution={contribution} props={props} fallback={fallback} />;
}

/**
 * 包裹型槽位：按 order 升序嵌套，最小者最外层；插件组件收到 children。
 * 没有贡献时直接返回 children，不产生额外 DOM，避免破坏宿主布局。
 */
export function PluginWrap({
  name,
  props,
  children,
}: {
  name: SlotName;
  props: Record<string, unknown>;
  children: ReactNode;
}) {
  const contributions = usePluginSlot(name);
  return (
    <>
      {contributions.reduceRight<ReactNode>((inner, contribution) => {
        const Contribution = contribution.component as ComponentType<Record<string, unknown>>;
        return (
          <PluginContributionBoundary
            key={`${contribution.pluginId}:${contribution.entry.id}`}
            pluginId={contribution.pluginId}
            slot={name}
            entryId={contribution.entry.id}
            fallback={inner}
          >
            <Contribution {...props} children={inner} />
          </PluginContributionBoundary>
        );
      }, children)}
    </>
  );
}
