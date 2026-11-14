export type PlanPreview = { title: string; body: string };

function cleanInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();
}

/**
 * 计划文档 → 卡片标题 + 前几行正文。
 * 标题优先取文档第一个 Markdown 标题；没有标题才退回第一行/文件名。
 * 不内置任何业务文案，所有内容都来自 plans/ 下的文档本身。
 */
export function extractPlanPreview(content: string, fallbackTitle: string): PlanPreview {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end > 0) start = end + 1;
  }

  const headingIndex = lines.findIndex(
    (line, index) => index >= start && /^\s*#{1,6}\s+\S/.test(line),
  );
  const titleIndex = headingIndex >= 0
    ? headingIndex
    : lines.findIndex((line, index) => index >= start && line.trim());
  if (titleIndex < 0) return { title: fallbackTitle, body: "" };

  const title =
    cleanInline(lines[titleIndex].replace(/^\s*#{1,6}\s+/, "")) || fallbackTitle;
  const body = lines
    .slice(titleIndex + 1)
    .map((line) => line.replace(/^\s*#{1,6}\s+/, "").replace(/^\s*[-*+]\s+/, "").replace(/^\s*>\s?/, ""))
    .map(cleanInline)
    .filter((line) => line && !/^[-*_]{3,}$/.test(line))
    .slice(0, 3)
    .join("\n");

  return { title, body };
}