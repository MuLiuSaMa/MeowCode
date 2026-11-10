import { useMemo } from "react";
import { LuFile, LuFolder } from "react-icons/lu";
import type { ToolViewProps } from "./types";
import {
  asRecord,
  parseDirectoryListing,
  parseGrepOutput,
  parsePathList,
  splitLiteralHighlight,
  textArg,
} from "./parse";
import { OutputText, PathRow, ToolNote } from "./parts";
import { panelPath } from "./paths";

function pathOf(item: ToolViewProps["item"]): string {
  const path = textArg(asRecord(item.input), "path").trim();
  // 工作区根目录（"." / "./"）没有可展示、可打开的路径：PathRow 直接不渲染
  return path === "." || path === "./" ? "" : path;
}

function dirOf(path: string): string {
  const parts = path.split(/[\\/]/);
  parts.pop();
  return parts.join("/");
}

function nameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function ListDirView({ item, status, t, onOpenFile }: ToolViewProps) {
  const path = pathOf(item);
  const output = item.output ?? "";
  const parsed = useMemo(() => parseDirectoryListing(output), [output]);
  return (
    <div className="mc-tv">
      <PathRow path={path} t={t} onOpenFile={onOpenFile} />
      {status === "failed" ? (
        <OutputText text={output} error />
      ) : parsed.entries.length ? (
        <div className="mc-tv__list">
          {parsed.entries.map((entry) => (
            <div className="mc-tv__entry" key={`${entry.kind}-${entry.name}`}>
              {entry.kind === "dir" ? (
                <LuFolder size={13} className="mc-tv__icon" aria-hidden="true" />
              ) : (
                <LuFile size={13} className="mc-tv__icon" aria-hidden="true" />
              )}
              <span className="mc-tv__entryname">{entry.name}</span>
            </div>
          ))}
        </div>
      ) : (
        <OutputText text={output} />
      )}
      {parsed.entries.length
        ? parsed.notes.map((note, index) => <ToolNote key={index}>{note}</ToolNote>)
        : null}
    </div>
  );
}

export function GlobView({ item, status, onOpenFile }: ToolViewProps) {
  const output = item.output ?? "";
  const path = pathOf(item);
  const parsed = useMemo(() => parsePathList(output), [output]);
  return (
    <div className="mc-tv">
      {status === "failed" ? <OutputText text={output} error /> : null}
      {parsed.paths.length ? (
        <div className="mc-tv__list">
          {parsed.paths.map((file) => {
            const dir = dirOf(file);
            return (
              <button
                type="button"
                className="mc-tv__entry mc-tv__entrybtn"
                key={file}
                title={file}
                disabled={!onOpenFile}
                onClick={() => onOpenFile?.(panelPath(file))}
              >
                <LuFile size={13} className="mc-tv__icon" aria-hidden="true" />
                <span className="mc-tv__entryname">{nameOf(file)}</span>
                {dir ? <span className="mc-tv__entrydir">{dir}</span> : null}
              </button>
            );
          })}
        </div>
      ) : status === "failed" ? null : (
        <OutputText text={output} />
      )}
      {parsed.paths.length
        ? parsed.notes.map((note, index) => <ToolNote key={index}>{note}</ToolNote>)
        : null}
      {path && parsed.paths.length ? <ToolNote>{path}</ToolNote> : null}
    </div>
  );
}

export function GrepView({ item, status, t, onOpenFile }: ToolViewProps) {
  const args = asRecord(item.input);
  const output = item.output ?? "";
  const pattern = textArg(args, "pattern");
  const caseSensitive = args.caseSensitive !== false;
  const parsed = useMemo(() => parseGrepOutput(output), [output]);
  return (
    <div className="mc-tv">
      {status === "failed" ? <OutputText text={output} error /> : null}
      {parsed.groups.map((group) => (
        <div className="mc-tv__section" key={group.file}>
          <PathRow path={group.file} t={t} onOpenFile={onOpenFile} />
          <div className="mc-tv__codebox">
            {group.matches.map((match) => (
              <div className="mc-tv__row" data-kind="ctx" key={`${match.line}-${match.text}`}>
                <span className="mc-tv__ln">{match.line}</span>
                <span className="mc-tv__linetext">
                  {splitLiteralHighlight(match.text, pattern, caseSensitive).map((segment, index) =>
                    segment.hit ? (
                      <mark className="mc-tv__mark" key={index}>
                        {segment.text}
                      </mark>
                    ) : (
                      <span key={index}>{segment.text}</span>
                    ),
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
      {!parsed.groups.length && status !== "failed" ? <OutputText text={output} /> : null}
      {parsed.groups.length
        ? parsed.notes.map((note, index) => <ToolNote key={index}>{note}</ToolNote>)
        : null}
    </div>
  );
}

export function DiagnosticsView({ item, status, t, onOpenFile }: ToolViewProps) {
  const output = item.output ?? "";
  const parsed = useMemo(() => parseGrepOutput(output), [output]);
  if (!parsed.parsed || status === "failed") {
    return (
      <div className="mc-tv">
        <OutputText text={output} error={status === "failed"} />
      </div>
    );
  }
  return (
    <div className="mc-tv">
      {parsed.groups.map((group) => (
        <div className="mc-tv__section" key={group.file}>
          <PathRow path={group.file} t={t} onOpenFile={onOpenFile} />
          <div className="mc-tv__list">
            {group.matches.map((match) => (
              <div className="mc-tv__entry" key={`${match.line}-${match.text}`}>
                <span className="mc-tv__entrydir">L{match.line}</span>
                <span className="mc-tv__entryname">{match.text}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
      {parsed.notes.map((note, index) => (
        <ToolNote key={index}>{note}</ToolNote>
      ))}
    </div>
  );
}
