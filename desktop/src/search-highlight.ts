/**
 * 检索片段高亮切分：把服务端返回的命中偏移切成 [普通文本, 命中文本, ...] 交替段。
 * 纯函数；对服务端偏移做完整防御（越界/乱序/重叠/空区间全部规范化），前端绝不信任偏移原样切 DOM。
 */

export type HighlightSegment = {
  text: string;
  hit: boolean;
};

type Range = { start: number; end: number };

function normalizeRanges(ranges: readonly Range[], textLength: number): Range[] {
  const valid = ranges
    .map((range) => ({
      start: Math.max(0, Math.min(Math.floor(range.start), textLength)),
      end: Math.max(0, Math.min(Math.floor(range.end), textLength)),
    }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: Range[] = [];
  for (const range of valid) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** 把 text 按 ranges 切成 hit/普通交替段；ranges 为空时返回单段原文。 */
export function splitHighlight(text: string, ranges: readonly Range[]): HighlightSegment[] {
  if (!text) return [];
  const normalized = normalizeRanges(ranges, text.length);
  if (normalized.length === 0) return [{ text, hit: false }];

  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const range of normalized) {
    if (range.start > cursor) {
      segments.push({ text: text.slice(cursor, range.start), hit: false });
    }
    // 相邻命中段直接拼接（normalize 已合并重叠，这里只会遇到零间隙相邻）
    const hitText = text.slice(range.start, range.end);
    const last = segments[segments.length - 1];
    if (last?.hit && range.start <= cursor) {
      last.text += hitText;
    } else {
      segments.push({ text: hitText, hit: true });
    }
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), hit: false });
  }
  return segments.filter((segment) => segment.text.length > 0);
}
