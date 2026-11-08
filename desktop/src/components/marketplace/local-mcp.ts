import type { InstalledMcpEntry, MarketplaceEntryLike } from "../../api";

/**
 * 「已安装」分区要展示本机真实配置的 MCP，而市场索引只覆盖带安装标记的那部分：
 * 手动添加的（对话框建的）与直接手写进 mcp.json 的都不在索引里。
 * 这里把它们合成成市场条目，官方与社区通道的「已安装」分区就能一并列出。
 *
 * 已在索引里的条目不合成——它们本来就带着名称、图标、说明等完整信息。
 */
export function localMcpEntries(
  /** 当前通道索引里已有的 MCP id */
  indexedIds: ReadonlySet<string>,
  /** 本机 mcp.json 里的全部 MCP */
  installed: readonly InstalledMcpEntry[],
  /** 连接方式摘要为空时的兜底说明（调用方传翻译后的文案） */
  fallbackDescription: string,
): MarketplaceEntryLike[] {
  return installed
    .filter((entry) => !indexedIds.has(entry.id))
    .map((entry) => ({
      id: entry.id,
      type: "mcp" as const,
      name: entry.id,
      description: entry.target || fallbackDescription,
      category: "",
      source: entry.source,
      tags: [],
      version: "",
      installed: true,
      localMcpSource: entry.source,
      localMcpEnabled: entry.enabled,
    }));
}
