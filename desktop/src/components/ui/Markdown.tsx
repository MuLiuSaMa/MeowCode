import { useMemo, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { renderMarkdown } from "../../api";
import { highlightHtml } from "../../code-highlight";

/** 聊天代码块上限：流式期间每个增量都会重渲染，过大的块不做高亮 */
const MAX_MARKDOWN_CODE_CHARS = 32_000;

const COPY_ICON = `<svg class="mc-mdcode__icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
const COPIED_ICON = `<svg class="mc-mdcode__icon mc-mdcode__icon--done" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"/></svg>`;

/**
 * marked 产出的 pre>code 逐块做语法高亮（语言来自 language-* 类），
 * 并给每个代码块加右上角复制按钮。
 * 输入已经过 DOMPurify 消毒；hljs 输出的 span/class 是安全的。
 */
function decorateMarkdown(html: string, copyLabel: string): string {
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
    for (const pre of Array.from(doc.querySelectorAll("pre"))) {
      const wrapper = doc.createElement("div");
      wrapper.className = "mc-mdcode";
      pre.replaceWith(wrapper);
      wrapper.appendChild(pre);
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "mc-mdcode__copy";
      button.setAttribute("data-copy-code", "");
      button.setAttribute("aria-label", copyLabel);
      button.title = copyLabel;
      button.innerHTML = `${COPY_ICON}${COPIED_ICON}`;
      wrapper.appendChild(button);
      touched = true;
    }
    return touched ? doc.body.innerHTML : html;
  } catch {
    return html;
  }
}

export function Markdown({ content, className }: { content: string; className?: string }) {
  const { t } = useTranslation("common");
  const copyLabel = t("copyCode");
  const html = useMemo(
    () => decorateMarkdown(renderMarkdown(content ?? ""), copyLabel),
    [content, copyLabel],
  );

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const copyButton = target.closest("button[data-copy-code]") as HTMLButtonElement | null;
    if (copyButton) {
      const code = copyButton.parentElement?.querySelector("pre")?.textContent ?? "";
      const clipboard = navigator.clipboard;
      if (!code || !clipboard) return;
      void clipboard
        .writeText(code)
        .then(() => {
          copyButton.setAttribute("data-copied", "true");
          copyButton.setAttribute("aria-label", t("copied"));
          copyButton.title = t("copied");
          window.setTimeout(() => {
            if (!copyButton.isConnected) return;
            delete copyButton.dataset.copied;
            copyButton.setAttribute("aria-label", copyLabel);
            copyButton.title = copyLabel;
          }, 1600);
        })
        .catch(() => undefined);
      return;
    }

    /* 聊天里的链接不在应用窗口内跳转：http/https 交系统浏览器 */
    const anchor = target.closest?.("a");
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
