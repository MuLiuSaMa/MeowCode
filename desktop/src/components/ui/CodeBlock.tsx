import { useMemo } from "react";
import { highlightHtml } from "../../code-highlight";
import "./CodeBlock.css";

export function CodeBlock({
  label,
  text,
  language,
}: {
  label?: string;
  text: string;
  /** 传语言 id（如 "json"）时做语法高亮；不传保持纯文本（日志类输出不着色） */
  language?: string;
}) {
  const html = useMemo(
    () => (language ? highlightHtml(text, language) : null),
    [text, language],
  );
  return (
    <div className="mc-codeblock">
      {label ? <span className="mc-codeblock__label">{label}</span> : null}
      {html !== null ? (
        <pre className="mc-codeblock__code mc-mono" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="mc-codeblock__code mc-mono">{text}</pre>
      )}
    </div>
  );
}
