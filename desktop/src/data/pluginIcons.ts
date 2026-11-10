import { listPlugins } from "../api";

/**
 * 已安装插件的图标表（pluginId → iconUrl）。
 *
 * 聊天消息里的插件 chip 只留了 id，图标要在渲染时补：内置插件（builtin 元数据）
 * 和本地自建插件都不在市场目录里，不能只查市场图标表，否则发送后会掉成兜底图标。
 */
let cache: Promise<Record<string, string>> | null = null;

export function loadPluginIconMap(): Promise<Record<string, string>> {
  if (!cache) {
    cache = listPlugins()
      .then((overview) => {
        const map: Record<string, string> = {};
        for (const plugin of overview.plugins) {
          if (plugin.iconUrl) map[plugin.id] = plugin.iconUrl;
        }
        return map;
      })
      .catch(() => {
        // 失败清缓存，下次渲染再试
        cache = null;
        return {};
      });
  }
  return cache;
}

/** 插件增删改后调用：下次读取重新拉取 */
export function invalidatePluginIconMap(): void {
  cache = null;
}
