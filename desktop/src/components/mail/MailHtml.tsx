import { useEffect, useMemo, useRef, useState } from "react";
import { buildMailSrcDoc, type MailHtmlColors } from "./mail-html";

function readColors(): MailHtmlColors {
  const fallbackFont = "system-ui, sans-serif";
  const fontFamily =
    typeof document === "undefined"
      ? fallbackFont
      : getComputedStyle(document.documentElement).getPropertyValue("--font-sans").trim() ||
        fallbackFont;
  // 邮件 HTML 几乎都按白底深字设计（例如 QQ 邮箱发出的正文带 color:#333），
  // 正文固定用浅色画布，避免暗色主题下出现深底深字。
  return {
    background: "#ffffff",
    foreground: "#202124",
    accent: "#0b57d0",
    border: "#dadce0",
    fontFamily,
  };
}

export function MailHtml({ html, allowImages }: { html: string; allowImages: boolean }) {
  const [height, setHeight] = useState(240);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const colors = useMemo(readColors, [html]);
  const srcDoc = useMemo(
    () => buildMailSrcDoc(html, allowImages, colors),
    [html, allowImages, colors],
  );

  useEffect(
    () => () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    },
    [],
  );

  const attach = () => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!doc) return;
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href") || "";
      if (!href) return;
      event.preventDefault();
      if (/^https?:\/\//i.test(href)) void window.meow.openExternal(href);
    };
    doc.addEventListener("click", onClick);
    const resize = () => {
      setHeight(Math.max(160, doc.documentElement.scrollHeight));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(doc.documentElement);
    if (doc.body) observer.observe(doc.body);
    cleanupRef.current = () => {
      doc.removeEventListener("click", onClick);
      observer.disconnect();
    };
  };

  return (
    <iframe
      ref={frameRef}
      className="mc-mail__frame"
      title="message"
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      style={{ height }}
      onLoad={attach}
    />
  );
}
