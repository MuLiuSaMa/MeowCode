import type { PluginDescriptor } from "../api";

/** 已加载插件是否需要因为客户端脚本变化而重新 apply。 */
export function shouldReloadPlugin(
  existing: { rev?: string } | undefined,
  descriptor: PluginDescriptor,
): boolean {
  if (!existing) return true;
  const rev = descriptor.ui?.client?.rev;
  // 旧 server 没有 rev 时保持原行为：不主动重置运行中的插件
  return rev !== undefined && existing.rev !== rev;
}
