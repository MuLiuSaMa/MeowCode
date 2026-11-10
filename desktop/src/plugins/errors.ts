import { reportPluginUiError } from "../api";

/** 同一插件+槽位 5 秒内只上报一次，避免渲染循环把 server 日志刷爆。 */
const THROTTLE_MS = 5_000;
const lastReported = new Map<string, number>();

export function reportPluginError(pluginId: string, message: string, slot?: string): void {
  const key = `${pluginId}\u0000${slot ?? ""}`;
  const now = Date.now();
  const previous = lastReported.get(key);
  if (previous !== undefined && now - previous < THROTTLE_MS) return;
  lastReported.set(key, now);
  void reportPluginUiError(pluginId, message, slot);
}

export function reportPluginLoadError(pluginId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  // 加载失败不受槽位节流影响：每个插件实例只加载一次
  void reportPluginUiError(pluginId, `client load failed: ${message}`);
}
