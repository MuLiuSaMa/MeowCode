import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getToolCatalog,
  type TimelineItem,
  type ToolCatalogEntry,
} from "../../api";
import { formatDuration } from "../../i18n/format";
import "./TrajectoryView.css";

/**
 * 轨迹视图：turn-aware 事件账本（对照 DSH 的 Trajectory tab）。
 *
 * 顶部三条彩色泳道（输入 / 模型 / 工具）做时间轴概览，中间按轮分组，
 * 点某一行时右侧弹出详情：**键值表 + 可折叠区块（参数 / 结果 / Schema / 计时）**，
 * 而不是一整段文字。工具 Schema 来自 GET /session/tools，工具耗时用
 * tool_started → tool_finished 的本地墙钟差值（含 SSE 延迟，够做诊断）。
 */

type Lane = "input" | "model" | "tool" | "other";
type RowStatus = "ok" | "error" | "running" | "info";

type RowSection = { label: string; body: string };

type LedgerRow = {
  key: string;
  kind: TimelineItem["kind"];
  lane: Lane;
  label: string;
  summary: string;
  status: RowStatus;
  sections: RowSection[];
  durationMs?: number;
  /** 会话内步序号（第几条记录） */
  step: number;
  /** 工具开始的本地墙钟 */
  startedAt?: number;
};

type LedgerTurn = {
  key: string;
  index: number;
  label: string;
  rows: LedgerRow[];
  durationMs?: number;
  status?: string;
};

type Labels = {
  session: string;
  user: string;
  assistant: string;
  compaction: string;
  compactionFailed: string;
  error: string;
  notice: string;
  changes: string;
  streaming: string;
  thinkingOnly: string;
  content: string;
  input: string;
  output: string;
  thinking: string;
};

const LANES: Lane[] = ["input", "model", "tool"];

const firstLine = (text: string, max = 120): string => {
  const line = text.split("\n").find((part) => part.trim())?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

const pretty = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
};

/** 2026-10-06 10:51:55.530 —— 与 DSH 计时区块同口径 */
const formatClock = (ms: number): string => {
  const date = new Date(ms);
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    pad(date.getMilliseconds(), 3)
  );
};

/** 工具入参里最像「在做什么」的那个字段；都没有就退回整段 JSON。 */
const summarizeInput = (input: unknown): string => {
  if (!input || typeof input !== "object") return String(input ?? "");
  const record = input as Record<string, unknown>;
  for (const key of [
    "path",
    "file_path",
    "command",
    "pattern",
    "query",
    "url",
    "description",
    "action",
    "text",
  ]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return firstLine(value, 110);
  }
  const json = JSON.stringify(input) ?? "";
  return json.length > 110 ? `${json.slice(0, 110)}…` : json;
};

function buildTurns(items: TimelineItem[], labels: Labels): LedgerTurn[] {
  const turns: LedgerTurn[] = [];
  let current: LedgerTurn | null = null;
  let turnCounter = 0;
  let step = 0;

  const openTurn = (label: string): LedgerTurn => {
    turnCounter += 1;
    const turn: LedgerTurn = { key: `turn-${turnCounter}`, index: turnCounter, label, rows: [] };
    turns.push(turn);
    return turn;
  };

  for (const item of items) {
    // 检查点分隔线不进账本：它不是「发生了什么」，只是可回滚的位置
    if (item.kind === "checkpoint") continue;

    if (item.kind === "message" && item.role === "user") {
      current = openTurn(firstLine(item.content, 80));
      step += 1;
      current.rows.push({
        key: item.key,
        kind: "message",
        lane: "input",
        label: labels.user,
        summary: firstLine(item.content),
        status: "info",
        sections: [{ label: labels.content, body: item.content }],
        step,
      });
      continue;
    }

    if (!current) current = openTurn(labels.session);

    if (item.kind === "message" && item.role === "assistant") {
      const thinking = item.thinking?.trim() ?? "";
      const body = item.content.trim();
      step += 1;
      current.rows.push({
        key: item.key,
        kind: "message",
        lane: "model",
        label: labels.assistant,
        summary: item.streaming
          ? labels.streaming
          : firstLine(item.content) || (thinking ? labels.thinkingOnly : ""),
        status: item.streaming ? "running" : "ok",
        sections: [
          ...(body ? [{ label: labels.content, body }] : []),
          ...(thinking ? [{ label: labels.thinking, body: thinking }] : []),
        ],
        durationMs: item.thinkingMs,
        step,
      });
      continue;
    }

    if (item.kind === "tool") {
      step += 1;
      current.rows.push({
        key: item.key,
        kind: "tool",
        lane: "tool",
        label: item.tool,
        summary: summarizeInput(item.input),
        status:
          item.ok === false
            ? "error"
            : // 回放条目没有 ok 字段（历史重建不做实时判定），按已完成展示；
              // 只有真正在跑（无 replayed、无 ok）的才显示进行中
              item.ok === true || item.replayed === true
              ? "ok"
              : "running",
        sections: [
          { label: labels.input, body: pretty(item.input) },
          ...(item.output ? [{ label: labels.output, body: item.output }] : []),
        ],
        durationMs: item.durationMs,
        startedAt: item.startedAt,
        step,
      });
      continue;
    }

    if (item.kind === "turn-info") {
      current.durationMs = item.durationMs;
      current.status = item.status;
      continue;
    }

    if (item.kind === "compaction") {
      step += 1;
      current.rows.push({
        key: item.key,
        kind: "compaction",
        lane: "other",
        label: labels.compaction,
        summary: item.failed ? labels.compactionFailed : item.running ? labels.streaming : "",
        status: item.failed ? "error" : item.running ? "running" : "ok",
        sections: item.summary ? [{ label: labels.content, body: item.summary }] : [],
        step,
      });
      continue;
    }

    if (item.kind === "error") {
      step += 1;
      current.rows.push({
        key: item.key,
        kind: "error",
        lane: "other",
        label: labels.error,
        summary: firstLine(item.message),
        status: "error",
        sections: [{ label: labels.content, body: item.message }],
        step,
      });
      continue;
    }

    if (item.kind === "notice") {
      step += 1;
      current.rows.push({
        key: item.key,
        kind: "notice",
        lane: "other",
        label: labels.notice,
        summary: firstLine(item.message),
        status: "info",
        sections: [{ label: labels.content, body: item.message }],
        step,
      });
      continue;
    }

    if (item.kind === "turn-changes") {
      step += 1;
      current.rows.push({
        key: item.key,
        kind: "turn-changes",
        lane: "other",
        label: labels.changes,
        summary: item.files.map((file) => file.path).join(" · "),
        status: "info",
        sections: item.files.map((file) => ({
          label: file.path,
          body: `${file.added ?? 0} + / ${file.removed ?? 0} -`,
        })),
        step,
      });
    }
  }

  return turns;
}

export function TrajectoryView({ items, sessionId }: { items: TimelineItem[]; sessionId?: string }) {
  const { t } = useTranslation("panel");
  const [query, setQuery] = useState("");
  const [collapsedTurns, setCollapsedTurns] = useState<Set<string>>(() => new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Record<string, ToolCatalogEntry>>({});

  // 工具目录只拉一次：Schema 区块按工具名查表
  useEffect(() => {
    let live = true;
    void getToolCatalog(sessionId)
      .then((result) => {
        if (!live) return;
        setCatalog(Object.fromEntries(result.tools.map((tool) => [tool.name, tool])));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [sessionId]);

  const labels = useMemo<Labels>(
    () => ({
      session: t("traj.session"),
      user: t("traj.user"),
      assistant: t("traj.assistant"),
      compaction: t("traj.compaction"),
      compactionFailed: t("traj.compactionFailed"),
      error: t("traj.error"),
      notice: t("traj.notice"),
      changes: t("traj.changes"),
      streaming: t("traj.streaming"),
      thinkingOnly: t("traj.thinkingOnly"),
      content: t("traj.content"),
      input: t("traj.input"),
      output: t("traj.output"),
      thinking: t("traj.thinking"),
    }),
    [t],
  );

  const statusLabels = useMemo<Record<RowStatus, string>>(
    () => ({
      ok: t("traj.statusOk"),
      error: t("traj.statusError"),
      running: t("traj.statusRunning"),
      info: t("traj.statusInfo"),
    }),
    [t],
  );

  const laneLabels = useMemo<Record<Lane, string>>(
    () => ({
      input: t("traj.laneInput"),
      model: t("traj.laneModel"),
      tool: t("traj.laneTool"),
      other: t("traj.laneOther"),
    }),
    [t],
  );

  const turns = useMemo(() => buildTurns(items, labels), [items, labels]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return turns;
    return turns
      .map((turn) => ({
        ...turn,
        rows: turn.rows.filter((row) =>
          `${row.label} ${row.summary} ${row.sections.map((section) => section.body).join(" ")}`
            .toLowerCase()
            .includes(needle),
        ),
      }))
      .filter((turn) => turn.rows.length > 0);
  }, [turns, query]);

  const totals = useMemo(() => {
    let calls = 0;
    let duration = 0;
    for (const turn of turns) {
      for (const row of turn.rows) if (row.lane === "tool") calls += 1;
      duration += turn.durationMs ?? 0;
    }
    return { turns: turns.length, calls, duration };
  }, [turns]);

  /** 三条泳道共用同一批槽位：非本泳道的格子只占位、不上色，保证三行对齐 */
  const timelineRows = useMemo(
    () => filtered.flatMap((turn) => turn.rows.filter((row) => row.lane !== "other")),
    [filtered],
  );

  const selected = useMemo(() => {
    if (!selectedKey) return null;
    for (const turn of turns) {
      const row = turn.rows.find((item) => item.key === selectedKey);
      if (row) return { row, turn };
    }
    return null;
  }, [turns, selectedKey]);

  const toggleTurn = (key: string) => {
    setCollapsedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const allCollapsed =
    filtered.length > 0 && filtered.every((turn) => collapsedTurns.has(turn.key));

  const schema = selected?.row.kind === "tool" ? catalog[selected.row.label] : undefined;

  return (
    <div className="mc-traj">
      <div className="mc-traj__main">
        <div className="mc-traj__bar">
          <span className="mc-traj__stats">
            {t("traj.stats", {
              turns: totals.turns,
              calls: totals.calls,
              duration: formatDuration(totals.duration),
            })}
          </span>
          <input
            className="mc-traj__filter"
            value={query}
            placeholder={t("traj.filter")}
            aria-label={t("traj.filter")}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="button"
            className="mc-traj__bulk"
            onClick={() =>
              setCollapsedTurns(allCollapsed ? new Set() : new Set(filtered.map((turn) => turn.key)))
            }
          >
            {allCollapsed ? t("traj.expandAll") : t("traj.collapseAll")}
          </button>
        </div>

        {/* 时间轴概览：输入 / 模型 / 工具 三条泳道，各用一种颜色；点格子选中记录 */}
        <div className="mc-traj__strip" role="group" aria-label={t("traj.timeline")}>
          {LANES.map((lane) => (
            <div key={lane} className="mc-traj__lane" data-lane={lane}>
              <span className="mc-traj__lanelabel">{laneLabels[lane]}</span>
              <div className="mc-traj__laneticks">
                {timelineRows.map((row) => (
                  <span
                    key={row.key}
                    className="mc-traj__slot"
                    data-empty={row.lane !== lane ? "true" : undefined}
                  >
                    {row.lane === lane ? (
                      <button
                        type="button"
                        className="mc-traj__tick"
                        data-lane={row.lane}
                        data-status={row.status}
                        data-active={row.key === selectedKey ? "true" : undefined}
                        title={`${row.label}${row.summary ? ` · ${row.summary}` : ""}`}
                        aria-label={`${row.label} ${row.summary}`}
                        onClick={() => setSelectedKey(row.key)}
                      />
                    ) : null}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mc-traj__ledger">
          {filtered.length === 0 ? <p className="mc-traj__empty">{t("traj.empty")}</p> : null}
          {filtered.map((turn) => {
            const collapsed = collapsedTurns.has(turn.key);
            return (
              <section key={turn.key} className="mc-traj__turn">
                <button
                  type="button"
                  className="mc-traj__turnhead"
                  aria-expanded={!collapsed}
                  onClick={() => toggleTurn(turn.key)}
                >
                  <span className="mc-traj__turnno">{turn.index}</span>
                  <span className="mc-traj__turnlabel">{turn.label || t("traj.session")}</span>
                  <span className="mc-traj__turnmeta">
                    {t("traj.rows", { count: turn.rows.length })}
                    {turn.durationMs !== undefined ? ` · ${formatDuration(turn.durationMs)}` : ""}
                  </span>
                </button>
                {collapsed
                  ? null
                  : turn.rows.map((row) => (
                      <button
                        key={row.key}
                        type="button"
                        className="mc-traj__row"
                        data-lane={row.lane}
                        data-status={row.status}
                        data-selected={row.key === selectedKey ? "true" : undefined}
                        onClick={() => setSelectedKey(row.key === selectedKey ? null : row.key)}
                      >
                        <span className="mc-traj__dot" aria-hidden />
                        <span className="mc-traj__name">{row.label}</span>
                        <span className="mc-traj__summary">{row.summary}</span>
                        {row.durationMs !== undefined ? (
                          <span className="mc-traj__dur">{formatDuration(row.durationMs)}</span>
                        ) : null}
                      </button>
                    ))}
              </section>
            );
          })}
        </div>
      </div>

      {/* 详情：键值表 + 可折叠区块（参数 / 结果 / Schema / 计时），对照 DSH inspector */}
      {selected ? (
        <aside className="mc-traj__inspector" aria-label={t("traj.detail")}>
          <header className="mc-traj__inshead">
            <span className="mc-traj__inskind" data-lane={selected.row.lane}>
              {laneLabels[selected.row.lane]}
            </span>
            <span className="mc-traj__institle">{selected.row.label}</span>
            <span className="mc-traj__insstepmeta">
              {t("traj.turnStep", { turn: selected.turn.index, step: selected.row.step })}
            </span>
            <button
              type="button"
              className="mc-traj__insclose"
              aria-label={t("traj.close")}
              title={t("traj.close")}
              onClick={() => setSelectedKey(null)}
            >
              ×
            </button>
          </header>

          <dl className="mc-traj__kv">
            <dt>{t("traj.kvTurn")}</dt>
            <dd>
              #{selected.turn.index} · {selected.turn.label || t("traj.session")}
            </dd>
            <dt>{t("traj.kvStatus")}</dt>
            <dd data-status={selected.row.status}>{statusLabels[selected.row.status]}</dd>
            {selected.row.kind === "tool" ? (
              <>
                <dt>{t("traj.kvTool")}</dt>
                <dd data-lane="tool">{selected.row.label}</dd>
              </>
            ) : null}
            {selected.row.startedAt !== undefined ? (
              <>
                <dt>{t("traj.kvStarted")}</dt>
                <dd>{formatClock(selected.row.startedAt)}</dd>
              </>
            ) : null}
            {selected.row.durationMs !== undefined ? (
              <>
                <dt>{t("traj.kvDuration")}</dt>
                <dd>{formatDuration(selected.row.durationMs)}</dd>
              </>
            ) : null}
            {selected.turn.durationMs !== undefined && selected.row.kind !== "tool" ? (
              <>
                <dt>{t("traj.kvTurnDuration")}</dt>
                <dd>{formatDuration(selected.turn.durationMs)}</dd>
              </>
            ) : null}
          </dl>

          <div className="mc-traj__insbody">
            {selected.row.sections.map((section, index) => (
              <details
                key={`${section.label}-${index}`}
                className="mc-traj__insblock"
                open={index === 0}
              >
                <summary>{section.label}</summary>
                <pre>{section.body}</pre>
              </details>
            ))}

            {schema ? (
              <details className="mc-traj__insblock mc-traj__insblock--schema">
                <summary>
                  {t("traj.schema")} · {schema.name}
                </summary>
                {schema.description ? (
                  <p className="mc-traj__insdesc">{schema.description}</p>
                ) : null}
                <pre>{pretty(schema.parameters)}</pre>
              </details>
            ) : null}

            {selected.row.sections.length === 0 && !schema ? (
              <p className="mc-traj__insempty">{t("traj.noDetail")}</p>
            ) : null}
          </div>
        </aside>
      ) : null}
    </div>
  );
}
