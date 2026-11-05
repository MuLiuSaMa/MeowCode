import { useMemo } from "react";
import { LuArrowRight } from "react-icons/lu";
import type { ToolViewProps } from "./types";
import { asRecord, parseCodexPatch, parseMultiEditInput, parseNumberedOutput, parseReadManyOutput, textArg } from "./parse";
import { diffLines, type DiffRow } from "./diff";
import { CodeLines, DiffBlock, NumberedCode, OutputText, PathRow, ToolBadge, ToolNote } from "./parts";

function pathOf(item: ToolViewProps["item"]): string {
  return textArg(asRecord(item.input), "path").trim();
}

export function ReadFileView({ item, status, t, onOpenFile }: ToolViewProps) {
  const output = item.output ?? "";
  const path = pathOf(item);
  const args = asRecord(item.input);
  const parsed = useMemo(() => parseNumberedOutput(output), [output]);
  const range = [
    typeof args.offset === "number" || typeof args.offset === "string" ? `offset ${args.offset}` : "",
    typeof args.limit === "number" || typeof args.limit === "string" ? `limit ${args.limit}` : "",
  ].filter(Boolean);

  return (
    <div className="mc-tv">
      <PathRow
        path={path}
        t={t}
        onOpenFile={onOpenFile}
        extra={range.length ? <ToolBadge tone="muted">{range.join(" · ")}</ToolBadge> : undefined}
      />
      {status === "failed" ? (
        <OutputText text={output} error />
      ) : parsed.numbered ? (
        <NumberedCode rows={parsed.lines} notes={parsed.notes} t={t} />
      ) : output ? (
        <OutputText text={output} />
      ) : (
        <ToolNote>{status === "running" ? t("tool.waitingOutput") : t("tool.outputNotSaved")}</ToolNote>
      )}
    </div>
  );
}

export function ReadManyView({ item, status, t, onOpenFile }: ToolViewProps) {
  const output = item.output ?? "";
  const sections = useMemo(() => parseReadManyOutput(output), [output]);
  if (!output) {
    return (
      <div className="mc-tv">
        <ToolNote>{status === "running" ? t("tool.waitingOutput") : t("tool.outputNotSaved")}</ToolNote>
      </div>
    );
  }
  return (
    <div className="mc-tv">
      {sections.map((section, index) => {
        const parsed = parseNumberedOutput(section.body);
        return (
          <div className="mc-tv__section" key={`${section.path}-${index}`}>
            <PathRow path={section.path} t={t} onOpenFile={onOpenFile} />
            {parsed.numbered ? (
              <NumberedCode rows={parsed.lines} notes={parsed.notes} t={t} maxLines={160} />
            ) : (
              <OutputText text={section.body} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function WriteFileView({ item, status, t, onOpenFile }: ToolViewProps) {
  const args = asRecord(item.input);
  const path = pathOf(item);
  const content = textArg(args, "content");
  if (status === "failed") {
    return (
      <div className="mc-tv">
        <PathRow path={path} t={t} onOpenFile={onOpenFile} />
        <OutputText text={item.output ?? ""} error />
      </div>
    );
  }
  return (
    <div className="mc-tv">
      <PathRow path={path} t={t} onOpenFile={onOpenFile} />
      {content ? (
        <CodeLines text={content} path={path} t={t} />
      ) : (
        <ToolNote>{status === "running" ? t("tool.waitingOutput") : t("tool.emptyOutput")}</ToolNote>
      )}
    </div>
  );
}

export function EditFileView({ item, status, t, onOpenFile }: ToolViewProps) {
  const args = asRecord(item.input);
  const path = pathOf(item);
  const oldString = textArg(args, "oldString");
  const newString = textArg(args, "newString");
  const diff = useMemo(() => diffLines(oldString, newString), [oldString, newString]);

  return (
    <div className="mc-tv">
      <PathRow path={path} t={t} onOpenFile={onOpenFile} />
      {status === "failed" ? <OutputText text={item.output ?? ""} error /> : null}
      {oldString || newString ? (
        // oldString 只是片段：行号相对片段而非文件，不显示以免误读
        <DiffBlock rows={diff.rows} t={t} truncated={diff.truncated} showLineNumbers={false} />
      ) : (
        <OutputText text={item.output ?? ""} error={status === "failed"} />
      )}
      {args.replaceAll === true ? <ToolNote>{t("tool.view.replaceAll")}</ToolNote> : null}
    </div>
  );
}

export function MultiEditView({ item, status, t, onOpenFile }: ToolViewProps) {
  const parsed = useMemo(() => parseMultiEditInput(item.input), [item.input]);
  return (
    <div className="mc-tv">
      {status === "failed" ? <OutputText text={item.output ?? ""} error /> : null}
      {parsed.error && !parsed.groups.length ? <ToolNote error>{parsed.error}</ToolNote> : null}
      {parsed.groups.map((group) => (
        <div className="mc-tv__section" key={group.path}>
          <PathRow path={group.path} t={t} onOpenFile={onOpenFile} />
          {group.edits.map((edit, index) => {
            const diff = diffLines(edit.oldString, edit.newString);
            return (
              <DiffBlock
                key={index}
                label={group.edits.length > 1 ? `#${index + 1}` : undefined}
                rows={diff.rows}
                t={t}
                truncated={diff.truncated}
                showLineNumbers={false}
              />
            );
          })}
          {group.edits.some((edit) => edit.replaceAll) ? (
            <ToolNote>{t("tool.view.replaceAll")}</ToolNote>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function ApplyPatchView({ item, status, t, onOpenFile }: ToolViewProps) {
  const patchText = textArg(asRecord(item.input), "patch");
  const parsed = useMemo(() => parseCodexPatch(patchText), [patchText]);
  return (
    <div className="mc-tv">
      {status === "failed" ? <OutputText text={item.output ?? ""} error /> : null}
      {parsed.error && !parsed.operations.length ? <ToolNote error>{parsed.error}</ToolNote> : null}
      {parsed.operations.map((operation, index) => {
        const badge =
          operation.kind === "add"
            ? t("tool.view.added")
            : operation.kind === "delete"
              ? t("tool.view.deleted")
              : t("tool.view.updated");
        const tone =
          operation.kind === "add" ? "add" : operation.kind === "delete" ? "del" : ("muted" as const);
        return (
          <div className="mc-tv__section" key={`${operation.path}-${index}`}>
            <PathRow
              path={operation.path}
              t={t}
              onOpenFile={onOpenFile}
              extra={<ToolBadge tone={tone}>{badge}</ToolBadge>}
            />
            {operation.kind === "add" ? (
              <DiffBlock
                rows={operation.addedLines.map((text, line) => ({
                  kind: "add" as const,
                  text,
                  newNo: line + 1,
                }))}
                t={t}
                showLineNumbers={false}
              />
            ) : operation.kind === "delete" ? null : (
              operation.hunks.map((hunk, hunkIndex) => {
                const diff = diffLines(hunk.oldLines.join("\n"), hunk.newLines.join("\n"));
                const rows: DiffRow[] = diff.rows;
                return (
                  <DiffBlock
                    key={hunkIndex}
                    rows={rows}
                    t={t}
                    truncated={diff.truncated}
                    showLineNumbers={false}
                  />
                );
              })
            )}
          </div>
        );
      })}
    </div>
  );
}

export function DeleteFileView({ item, status, t, onOpenFile }: ToolViewProps) {
  const path = pathOf(item);
  return (
    <div className="mc-tv">
      <PathRow path={path} t={t} onOpenFile={onOpenFile} extra={<ToolBadge tone="del">{t("tool.view.deleted")}</ToolBadge>} />
      {status === "failed" && item.output ? <OutputText text={item.output} error /> : null}
    </div>
  );
}

export function MoveFileView({ item, status, t, onOpenFile }: ToolViewProps) {
  const args = asRecord(item.input);
  const from = textArg(args, "from").trim();
  const to = textArg(args, "to").trim();
  return (
    <div className="mc-tv">
      <div className="mc-tv__moverow">
        <PathRow path={from} t={t} onOpenFile={onOpenFile} />
        <LuArrowRight size={14} className="mc-tv__arrow" aria-hidden="true" />
        <PathRow path={to} t={t} onOpenFile={onOpenFile} />
      </div>
      {status === "failed" && item.output ? <OutputText text={item.output} error /> : null}
    </div>
  );
}

export function ReadVideoView({ item, t, onOpenFile }: ToolViewProps) {
  const path = pathOf(item);
  return (
    <div className="mc-tv">
      <PathRow path={path} t={t} onOpenFile={onOpenFile} />
      {item.output ? <OutputText text={item.output} /> : <ToolNote>{t("tool.emptyOutput")}</ToolNote>}
    </div>
  );
}
