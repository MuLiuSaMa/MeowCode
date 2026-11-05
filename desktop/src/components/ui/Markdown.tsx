import { useMemo, type MouseEvent } from "react";
import { renderMarkdown } from "../../api";
import { highlightHtml } from "../../code-highlight";

/** 聊天代码块上限：流式期间每个增量都会重渲染，过大的块不做高亮 */
const MAX_MARKDOWN_CODE_CHARS = 32_000;

/**
 * marked 产出的 pre>code 逐块做语法高亮（语言来自 language-* 类）。
 * 输入已经过 DOMPurify 消毒；hljs 输出的 span/class 是安全的。
 */
function highlightCodeBlocks(html: string): string {
  if (!html.includes("<pre")) return html;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    let touched = false;
    for (const code of Array.from(doc.querySelectorAll("pre > code"))) {
      const text = code.textContent ?? "";
      if (!text.trim() || text.length > MAX_MARKDOWN_CODE_CHARS) continue;
      const langClass = /language-([\w-]+)/.exec(code.className)?.[1];
      code.innerHTML = highlightHtml(text, langClass);
      touched = true;
    }
    return touched ? doc.body.innerHTML : html;
  } catch {
    return html;
  }
}

export function Markdown({ content, className }: { content: string; className?: string }) {
  const html = useMemo(() => highlightCodeBlocks(renderMarkdown(content ?? "")), [content]);

  /** 聊天里的链接不在应用窗口内跳转：http/https 交系统浏览器 */
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest?.("a");
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) void window.meow.openExternal(href);
  };

  return (
    <div
      className={["mc-markdown", className ?? ""].filter(Boolean).join(" ")}
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
