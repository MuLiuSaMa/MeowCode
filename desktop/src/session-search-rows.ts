import type { SessionSearchHit, SessionSearchSnippet } from "./api";

/**
 * 检索结果 → 弹窗扁平行。
 * 每个会话先出一行「会话头」（snippet: null），其后是该会话的命中片段行；
 * 片段按 messageIndex 升序排（同一条消息的多个片段保持服务端顺序），
 * 跨会话顺序与服务端排序一致，键盘 ↑↓ 直接在这一维数组上移动。
 */
export type SearchRow = {
  key: string;
  hit: SessionSearchHit;
  /** null = 会话头行（标题命中但无正文片段时是该会话唯一的行） */
  snippet: SessionSearchSnippet | null;
};

export function flattenHitRows(hits: readonly SessionSearchHit[]): SearchRow[] {
  const rows: SearchRow[] = [];
  for (const hit of hits) {
    rows.push({ key: `${hit.sessionId}:header`, hit, snippet: null });
    const snippets = hit.snippets
      .map((snippet, index) => ({ snippet, index }))
      .sort((a, b) => a.snippet.messageIndex - b.snippet.messageIndex || a.index - b.index);
    for (const { snippet, index } of snippets) {
      rows.push({ key: `${hit.sessionId}:s${index}`, hit, snippet });
    }
  }
  return rows;
}
