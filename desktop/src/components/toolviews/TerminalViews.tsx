import { useMemo } from "react";
import type { ToolViewProps } from "./types";
import {
  asRecord,
  parseGitDiffOutput,
  parseGitStatusOutput,
  parseJobList,
  textArg,
} from "./parse";
import { CodeLines, DiffBlock, OutputText, ToolBadge, ToolNote } from "./parts";
import { parsePatch } from "../../git/patch";
import type { DiffRow } from "./diff";

function actionOf(item: ToolViewProps["item"]): string {
  return textArg(asRecord(item.input), "action").trim();
}

export function CommandView({ item, status, t }: ToolViewProps) {
  const args = asRecord(item.input);
  const command = textArg(args, "command");
  const background = args.background === true;
  const output = item.output ?? "";
  return (
    <div className="mc-tv">
      <div className="mc-tv__terminalhead">
        <span className="mc-tv__prompt" aria-hidden="true">
          $
        </span>
        <span className="mc-tv__cmd" title={command}>
          {command}
        </span>
        {background ? <ToolBadge tone="muted">{t("tool.view.background")}</ToolBadge> : null}
      </div>
      {output ? (
        <OutputText text={output} terminal error={status === "failed"} />
      ) : (
        <ToolNote>{status === "running" ? t("tool.waitingOutput") : t("tool.emptyOutput")}</ToolNote>
      )}
    </div>
  );
}

export function RunCodeView({ item, status, t }: ToolViewProps) {
  const code = textArg(asRecord(item.input), "code");
  const output = item.output ?? "";
  return (
    <div className="mc-tv">
      {code ? <CodeLines text={code} path="snippet.ts" t={t} maxLines={200} /> : null}
      {output ? (
        <OutputText text={output} error={status === "failed"} />
      ) : (
        <ToolNote>{status === "running" ? t("tool.waitingOutput") : t("tool.emptyOutput")}</ToolNote>
      )}
    </div>
  );
}

export function JobView({ item, status, t }: ToolViewProps) {
  const args = asRecord(item.input);
  const action = actionOf(item);
  const jobId = textArg(args, "job_id");
  const output = item.output ?? "";
  const jobs = useMemo(() => (action === "list" ? parseJobList(output) : []), [action, output]);
  const data = textArg(args, "data");
  return (
    <div className="mc-tv">
      <div className="mc-tv__pathrow">
        <span className="mc-tv__path">{jobId || action || t("tool.job")}</span>
        {jobId ? <ToolBadge tone="muted">{action}</ToolBadge> : null}
      </div>
      {jobs.length ? (
        <div className="mc-tv__list">
          {jobs.map((job) => (
            <div className="mc-tv__entry" key={job.id}>
              <span className="mc-tv__toolname">{job.id}</span>
              <ToolBadge tone={job.status.startsWith("running") ? "muted" : "add"}>
                {job.status}
              </ToolBadge>
              <span className="mc-tv__entrydir">{job.command}</span>
            </div>
          ))}
        </div>
      ) : output ? (
        <OutputText text={output} terminal error={status === "failed"} />
      ) : (
        <ToolNote>{status === "running" ? t("tool.waitingOutput") : t("tool.emptyOutput")}</ToolNote>
      )}
      {data ? <OutputText text={data} /> : null}
    </div>
  );
}

function patchRows(patch: string): DiffRow[] {
  const parsed = parsePatch(patch);
  return parsed.rows
    .filter((row) => row.kind !== "meta")
    .map((row) => ({
      kind: row.kind,
      text: row.text,
      ...(row.oldNo !== undefined ? { oldNo: row.oldNo } : {}),
      ...(row.newNo !== undefined ? { newNo: row.newNo } : {}),
    }));
}

export function GitView({ item, status, t }: ToolViewProps) {
  const args = asRecord(item.input);
  const action = actionOf(item);
  const output = item.output ?? "";
  const detail =
    textArg(args, "path") ||
    textArg(args, "name") ||
    textArg(args, "message").slice(0, 80) ||
    (typeof args.sha === "string" ? args.sha.slice(0, 12) : "");
  const diff = useMemo(
    () => (action === "diff" && status !== "failed" ? parseGitDiffOutput(output) : null),
    [action, output, status],
  );
  const statusView = useMemo(
    () => (action === "status" && status !== "failed" ? parseGitStatusOutput(output) : null),
    [action, output, status],
  );
  const rows = useMemo(() => (diff?.patch ? patchRows(diff.patch) : []), [diff?.patch]);

  return (
    <div className="mc-tv">
      <div className="mc-tv__pathrow">
        <span className="mc-tv__path">git {action}</span>
        {detail ? <ToolBadge tone="muted">{detail}</ToolBadge> : null}
        {diff?.added !== undefined ? (
          <>
            <span className="mc-tv__count" data-kind="add">
              +{diff.added}
            </span>
            <span className="mc-tv__count" data-kind="del">
              -{diff.removed ?? 0}
            </span>
          </>
        ) : null}
      </div>
      {status === "failed" ? (
        <OutputText text={output} error />
      ) : statusView ? (
        <>
          {statusView.header ? <ToolNote>{statusView.header}</ToolNote> : null}
          {statusView.groups.map((group) => (
            <div className="mc-tv__section" key={group.label}>
              <p className="mc-tv__difflabel">
                {group.label} ({group.entries.length})
              </p>
              <div className="mc-tv__list">
                {group.entries.map((entry) => (
                  <div className="mc-tv__entry" key={entry}>
                    <span className="mc-tv__entryname mc-tv__mono">{entry}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {statusView.clean ? <ToolNote>{t("tool.view.noChanges")}</ToolNote> : null}
          {statusView.notes.map((note, index) => (
            <ToolNote key={index}>{note}</ToolNote>
          ))}
        </>
      ) : rows.length ? (
        <DiffBlock rows={rows} t={t} truncated={diff?.truncated} />
      ) : output ? (
        <OutputText text={output} />
      ) : (
        <ToolNote>{status === "running" ? t("tool.waitingOutput") : t("tool.emptyOutput")}</ToolNote>
      )}
    </div>
  );
}
