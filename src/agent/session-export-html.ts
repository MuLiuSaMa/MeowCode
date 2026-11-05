/**
 * 会话导出的 HTML 渲染：单文件自包含（内联样式、图片 data URI、无脚本、无外链字体）。
 * 需要分享给没有 Markdown 渲染器的人时用这个。
 */
import type { ExportDoc, ExportImage, ExportItem } from "./session-export.js";
import type { MarkdownOptions } from "./session-export-markdown.js";

export type HtmlOptions = MarkdownOptions;

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderImage(image: ExportImage, inline: boolean): string {
  const label = escapeHtml(image.name ?? "image");
  if (inline && image.data) {
    return `<img alt="${label}" src="data:${image.mimeType};base64,${image.data}">`;
  }
  if (image.file) {
    return `<img alt="${label}" src="${inline ? "" : "assets/"}${escapeHtml(image.file)}">`;
  }
  if (image.data) {
    return `<img alt="${label}" src="data:${image.mimeType};base64,${image.data}">`;
  }
  return `<span class="muted">[${label}]</span>`;
}

function renderItems(items: ExportItem[], inlineImages: boolean): string {
  const parts: string[] = [];
  for (const item of items) {
    if (item.kind === "user") {
      parts.push(`<div class="user">${escapeHtml(item.text).replace(/\n/g, "<br>")}</div>`);
      for (const image of item.images) parts.push(renderImage(image, inlineImages));
      continue;
    }
    if (item.kind === "assistant") {
      if (item.thinking) {
        parts.push(
          `<details class="thinking"><summary>Thinking</summary><pre>${escapeHtml(item.thinking)}</pre></details>`,
        );
      }
      if (item.text.trim()) {
        parts.push(`<div class="assistant">${escapeHtml(item.text).replace(/\n/g, "<br>")}</div>`);
      }
      continue;
    }
    if (item.kind === "approval") {
      const verdict = item.approved ? "approved" : "denied";
      const reason = item.reason ? ` (${escapeHtml(item.reason)})` : "";
      parts.push(`<div class="approval">Approval: <code>${escapeHtml(item.tool)}</code> → ${verdict}${reason}</div>`);
    }
  }

  const tools = items.filter(
    (item): item is Extract<ExportItem, { kind: "tool" }> => item.kind === "tool",
  );
  if (tools.length) {
    const names = [...new Set(tools.map((item) => item.call.tool))].join(", ");
    const body = tools
      .map(
        (item, index) =>
          `<div class="tool"><strong>${index + 1}. <code>${escapeHtml(item.call.tool)}</code></strong>` +
          `<pre>${escapeHtml(JSON.stringify(item.call.input, null, 2) ?? "")}</pre>` +
          `<pre class="result">${escapeHtml(item.call.output ?? "")}</pre></div>`,
      )
      .join("");
    parts.push(
      `<details class="tools"><summary>Tool calls ×${tools.length} · ${escapeHtml(names)}</summary>${body}</details>`,
    );
  }
  return parts.join("\n");
}

export function renderHtml(doc: ExportDoc, options: HtmlOptions = {}): string {
  const exportedAt = options.exportedAt ?? new Date().toISOString();
  const title = doc.session.title?.trim() || `Session ${doc.session.id.slice(0, 8)}`;
  const inlineImages = options.inlineImages !== false;

  const turns = [...doc.turns, ...(doc.loose ? [doc.loose] : [])]
    .map((turn) => {
      const body = renderItems(turn.items, inlineImages);
      if (!body) return "";
      const status =
        turn.status && turn.status !== "completed"
          ? `<div class="status">Turn status: ${escapeHtml(turn.status)}${turn.error ? ` — ${escapeHtml(turn.error)}` : ""}</div>`
          : "";
      return `<section class="turn">${status}${body}</section>`;
    })
    .filter(Boolean)
    .join("\n");

  const meta = [
    ["Session ID", doc.session.id],
    ["Workspace", doc.session.cwd],
    ["Created", doc.session.createdAt],
    ["Messages", String(doc.session.messageCount)],
    ...(doc.session.model ? [["Model", `${doc.session.providerId ?? "?"} / ${doc.session.model}`]] : []),
    ["Exported", exportedAt],
  ]
    .map(([label, value]) => `<li><span class="k">${escapeHtml(String(label))}</span><span class="v">${escapeHtml(String(value))}</span></li>`)
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --bg: #ffffff; --fg: #1f2328; --muted: #6b7280; --border: #e5e7eb; --card: #f6f7f9; --user: #eef4ff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #16181d; --fg: #e6e8eb; --muted: #9aa1ab; --border: #2b2f36; --card: #1d2026; --user: #1e2735; } }
  body { margin: 0; padding: 32px 20px 64px; background: var(--bg); color: var(--fg);
         font: 15px/1.7 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  main { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 16px; }
  ul.meta { list-style: none; padding: 14px 16px; margin: 0 0 24px; background: var(--card); border: 1px solid var(--border); border-radius: 10px; }
  ul.meta li { display: flex; gap: 12px; font-size: 13px; }
  ul.meta .k { color: var(--muted); min-width: 92px; }
  ul.meta .v { word-break: break-all; }
  .turn { border-top: 1px solid var(--border); padding-top: 20px; margin-top: 20px; }
  .user { background: var(--user); border-radius: 10px; padding: 10px 14px; margin: 12px 0; }
  .assistant { margin: 12px 0; white-space: pre-wrap; }
  .thinking pre, .tool pre { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; overflow-x: auto; font-size: 12.5px; }
  details { margin: 10px 0; }
  summary { cursor: pointer; color: var(--muted); font-size: 13px; }
  .tool { margin: 10px 0; }
  .tool .result { max-height: 360px; }
  .approval, .status { color: var(--muted); font-size: 13px; margin: 8px 0; }
  img { max-width: 100%; border-radius: 8px; margin: 8px 0; }
  code { font-family: ui-monospace, Consolas, monospace; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<ul class="meta">${meta}</ul>
${turns}
</main>
</body>
</html>
`;
}
