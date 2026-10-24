import { useMemo, type MouseEvent } from "react";
import { renderMarkdown } from "../../api";

export function Markdown({ content, className }: { content: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(content ?? ""), [content]);

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
