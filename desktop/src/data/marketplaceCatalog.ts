import { listMarketplace, type MarketplaceListResult } from "../api";

/**
 * 市场目录（条目 + 图标 dataUrl）的进程内缓存。
 * 图标/名称基本不变，输入框 `/` 面板、+ 菜单、聊天卡片共用一次请求。
 * 失败时清空缓存，下次调用可重试。
 */
let cache: Promise<MarketplaceListResult> | null = null;

export function loadMarketplaceCatalog(): Promise<MarketplaceListResult> {
  if (!cache) {
    cache = listMarketplace().catch((error) => {
      cache = null;
      throw error;
    });
  }
  return cache;
}

/** 安装/卸载后调用：下次读取重新拉取安装态 */
export function invalidateMarketplaceCatalog(): void {
  cache = null;
}
