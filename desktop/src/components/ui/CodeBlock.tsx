import "./CodeBlock.css";

export function CodeBlock({ label, text }: { label?: string; text: string }) {
  return (
    <div className="mc-codeblock">
      {label ? <span className="mc-codeblock__label">{label}</span> : null}
      <pre className="mc-codeblock__code mc-mono">{text}</pre>
    </div>
  );
}
