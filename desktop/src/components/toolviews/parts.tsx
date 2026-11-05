import { useMemo, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { LuExternalLink } from "react-icons/lu";
import { highlightToLines } from "../../code-highlight";
import type { TimelineTool } from "../../api";
import type { DiffRow } from "./diff";
import type { NumberedLine } from "./parse";
import { isAbsolutePath, panelPath } from "./paths";

/** 单块内容的高亮/渲染上限：再大就只展示前缀，让用户去右侧看完整文件 */
const MAX_CODE_CHARS = 80_000;
const MAX_DIFF_LINE_CHARS = 4_000;

export function PathRow({
  path,
  t,
  onOpenFile,
  extra,
}: {
  path: string;
  t: TFunction;
  onOpenFile?: (path: string) => void;
  extra?: ReactNode;
}) {
  if (!path) return null;
  const openable = Boolean(onOpenFile) && !isAbsolutePath(path);
  return (
    <div className="mc-tv__pathrow">
      <span className="mc-tv__path" title={path}>
        {path}
      </span>
      {extra}
      {openable ? (
        <button
          type="button"
          className="mc-tv__open"
          title={t("tool.openInPanel")}
          onClick={() => onOpenFile?.(panelPath(path))}
        >
          <LuExternalLink size={12} aria-hidden="true" />
          <span>{t("tool.view.open")}</span>
        </button>
      ) : null}
    </div>
  );
}

export function ToolBadge({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: "add" | "del" | "muted";
}) {
  return (
    <span className="mc-tv__badge" data-tone={tone}>
      {children}
    </span>
  );
}

export function ToolNote({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <p className="mc-tv__note" data-error={error || undefined}>
      {children}
    </p>
  );
}

export function OutputText({
  text,
  terminal = false,
  error = false,
}: {
  text: string;
  terminal?: boolean;
  error?: boolean;
}) {
  if (!text.trim()) return null;
  return (
    <pre className="mc-tv__pre" data-terminal={terminal || undefined} data-error={error || undefined}>
      {text}
    </pre>
  );
}

export function CodeLines({
  text,
  path,
  t,
  maxLines = 400,
}: {
  text: string;
  path?: string;
  t: TFunction;
  maxLines?: number;
}) {
  const rendered = useMemo(() => {
    const capped = text.length > MAX_CODE_CHARS ? text.slice(0, MAX_CODE_CHARS) : text;
    const lines = capped.split(/\r?\n/);
    const shown = lines.slice(0, maxLines);
    return {
      html: highlightToLines(shown.join("\n"), path),
      hidden: lines.length - shown.length,
      clipped: capped.length < text.length,
    };
  }, [text, path, maxLines]);

  if (!text) return <ToolNote>{t("tool.emptyOutput")}</ToolNote>;

  return (
    <>
      <div className="mc-tv__codebox">
        {rendered.html.map((line, index) => (
          <div className="mc-tv__row" data-kind="ctx" key={index}>
            <span className="mc-tv__ln">{index + 1}</span>
            <span
              className="mc-tv__linetext"
              // highlightToLines 已转义普通文本，hljs 只输出 span
              dangerouslySetInnerHTML={{ __html: line || " " }}
            />
          </div>
        ))}
      </div>
      {rendered.hidden > 0 ? (
        <ToolNote>{t("tool.view.moreLines", { count: rendered.hidden })}</ToolNote>
      ) : rendered.clipped ? (
        <ToolNote>{t("tool.view.truncated")}</ToolNote>
      ) : null}
    </>
  );
}

export function NumberedCode({
  rows,
  notes,
  t,
  maxLines = 400,
}: {
  rows: NumberedLine[];
  notes?: string[];
  t: TFunction;
  maxLines?: number;
}) {
  if (!rows.length) {
    return (
      <>
        {notes?.map((note, index) => (
          <ToolNote key={index}>{note}</ToolNote>
        ))}
      </>
    );
  }
  const shown = rows.slice(0, maxLines);
  return (
    <>
      <div className="mc-tv__codebox">
        {shown.map((row) => (
          <div className="mc-tv__row" data-kind="ctx" key={`${row.no}-${row.text}`}>
            <span className="mc-tv__ln">{row.no}</span>
            <span className="mc-tv__linetext">{row.text || " "}</span>
          </div>
        ))}
      </div>
      {rows.length > shown.length ? (
        <ToolNote>{t("tool.view.moreLines", { count: rows.length - shown.length })}</ToolNote>
      ) : null}
      {notes?.map((note, index) => (
        <ToolNote key={index}>{note}</ToolNote>
      ))}
    </>
  );
}

export function DiffBlock({
  rows,
  t,
  truncated = false,
  showLineNumbers = true,
  label,
}: {
  rows: DiffRow[];
  t: TFunction;
  truncated?: boolean;
  showLineNumbers?: boolean;
  label?: string;
}) {
  if (!rows.length) return <ToolNote>{t("tool.view.noChanges")}</ToolNote>;
  return (
    <>
      {label ? <p className="mc-tv__difflabel">{label}</p> : null}
      <div className="mc-tv__codebox mc-tv__diffbox">
        {rows.map((row, index) => (
          <div className="mc-tv__row" data-kind={row.kind} key={index}>
            {showLineNumbers ? <span className="mc-tv__ln">{row.oldNo ?? ""}</span> : null}
            {showLineNumbers ? <span className="mc-tv__ln">{row.newNo ?? ""}</span> : null}
            <span className="mc-tv__gutter">
              {row.kind === "add" ? "+" : row.kind === "del" ? "-" : row.kind === "hunk" ? "@" : " "}
            </span>
            <span className="mc-tv__linetext">
              {row.text.slice(0, MAX_DIFF_LINE_CHARS) || " "}
              {row.text.length > MAX_DIFF_LINE_CHARS ? " …" : ""}
            </span>
          </div>
        ))}
      </div>
      {truncated ? <ToolNote>{t("tool.view.truncated")}</ToolNote> : null}
    </>
  );
}

/** 服务端已落盘 / 已截断的统一提示（各视图不重复画） */
export function ToolOutputNotes({ item, t }: { item: TimelineTool; t: TFunction }) {
  if (!item.spilled && !item.truncated) return null;
  return (
    <div className="mc-tv__notes">
      {item.spilled ? <ToolNote>{t("tool.view.spilled", { path: item.spilled })}</ToolNote> : null}
      {item.truncated ? <ToolNote>{t("tool.view.truncated")}</ToolNote> : null}
    </div>
  );
}
