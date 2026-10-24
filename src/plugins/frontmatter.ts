/**
 * 极简 markdown frontmatter 解析：文件以 "---" 行开头、以下一个 "---" 行结束，
 * 块内逐行 `key: value`。不支持嵌套/多行值 —— 命令与技能声明足够用。
 */
export function parseMarkdownFrontmatter(
  raw: string,
): { meta: Record<string, string>; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { meta: {}, body: normalized.trim() };
  }
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) {
    return { meta: {}, body: normalized.trim() };
  }
  const headerBlock = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n+/, "").trim();
  const meta: Record<string, string> = {};
  for (const line of headerBlock.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    meta[match[1].toLowerCase()] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body };
}
