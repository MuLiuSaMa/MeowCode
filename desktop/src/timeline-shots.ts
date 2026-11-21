import type { TimelineImage, TimelineItem } from "./api";

/**
 * 收集「本回合」工具产出的截图：从时间线末尾往回扫，直到最近一条用户消息。
 *
 * 工具所在的组在回合结束后默认折叠，截图留在组里用户就看不到了；
 * 回合收尾时把它们取出来，在正文末尾整组展示一次。
 */
export function collectTurnImages(items: TimelineItem[]): TimelineImage[] {
  const images: TimelineImage[] = [];
  const seen = new Set<string>();
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "message" && item.role === "user") break;
    if (item.kind !== "tool" || !item.images?.length) continue;
    for (const image of item.images) {
      const key = image.dataUrl ?? image.src ?? "";
      if (!key || seen.has(key)) continue;
      seen.add(key);
      images.unshift(image);
    }
  }
  return images;
}