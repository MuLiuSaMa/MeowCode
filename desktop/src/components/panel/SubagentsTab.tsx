import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuArrowUpRight, LuChevronRight, LuSquare } from "react-icons/lu";
import type { SubagentRun } from "../../api";
import { SUBAGENT_ROLE_LABELS } from "../../agentRoles";
import { formatDuration } from "../../i18n/format";
import { deriveStage } from "../../../../src/agent/stage";
import { StageBadge } from "../stage/StageBadge";
import "./SubagentsTab.css";

const STATUS_KEYS: Record<SubagentRun["status"], string> = {
  running: "runStatus.running",
  completed: "runStatus.completed",
  failed: "runStatus.failed",
  aborted: "runStatus.aborted",
  interrupted: "runStatus.interrupted",
};

/**
 * 收进折叠组的终态：跑完/失败/主动停的都算「不用再看」。
 * `interrupted` 故意排除在外 —— 它等人确认是否续跑（`deriveStage` 归为 person/review），
 * 收起来就等于把唯一的处置入口藏了。
 */
const FOLDED_STATUSES = new Set<SubagentRun["status"]>(["completed", "failed", "aborted"]);

function formatTokens(value?: number): string | null {
  if (value === undefined) return null;
  if (value < 1_000) return String(value);
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${Math.round(value / 1_000)}k`;
}

/** 当前父会话的子 Agent 总览：状态、耗时、Token、打开与单个停止。 */
export function SubagentsTab({
  runs,
  onOpen,
  onStop,
}: {
  runs: SubagentRun[];
  onOpen: (agentId: string) => void;
  onStop: (agentId: string) => void;
}) {
  const { t } = useTranslation("panel");
  const doneId = useId();
  const [now, setNow] = useState(Date.now());
  // 默认收起：上面只留还在跑 / 等人处置的，已结束的折起来不占视野
  const [doneOpen, setDoneOpen] = useState(false);
  const hasRunning = runs.some((run) => run.status === "running");
  useEffect(() => {
    if (!hasRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasRunning]);

  // 需要人处理的排最前（进程中断要确认续跑），其次运行中，其余按开始时间倒序
  const ordered = [...runs].sort((a, b) => {
    const left = deriveStage({ kind: "subagent", status: a.status });
    const right = deriveStage({ kind: "subagent", status: b.status });
    if (left.needsHuman !== right.needsHuman) return left.needsHuman ? -1 : 1;
    const leftRunning = left.stage.stage === "working";
    const rightRunning = right.stage.stage === "working";
    if (leftRunning !== rightRunning) return leftRunning ? -1 : 1;
    return (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
  });

  const active = ordered.filter((run) => !FOLDED_STATUSES.has(run.status));
  const finished = ordered.filter((run) => FOLDED_STATUSES.has(run.status));

  // 跑完一个 / 新起一个就回到默认收起：手动展开只是临时看一眼，
  // 状态一变就重新折上，免得早就结束的条目一直占着视野
  const foldSignature = ordered.map((run) => `${run.agentId}:${run.status}`).join("|");
  useEffect(() => {
    setDoneOpen(false);
  }, [foldSignature]);

  if (!ordered.length) {
    return (
      <div className="mc-subagents">
        <div className="mc-subagents__empty">
          <span>{t("subagents.emptyTitle")}</span>
          <span>{t("subagents.emptyHint")}</span>
        </div>
      </div>
    );
  }

  const failedCount = finished.filter((run) => run.status === "failed").length;
  const doneLabel = `${t("subagents.doneGroup", { n: finished.length })}${
    failedCount > 0 ? ` · ${t("runStatus.failed")} ${failedCount}` : ""
  }`;

  const renderRow = (run: SubagentRun) => {
    const startedMs = Date.parse(run.startedAt);
    const liveMs =
      run.status === "running" && Number.isFinite(startedMs)
        ? Math.max(0, now - startedMs)
        : null;
    const durationMs = run.durationMs ?? liveMs;
    const input = formatTokens(run.usage?.inputTokens);
    const output = formatTokens(run.usage?.outputTokens);
    return (
      <div className="mc-subagents__row" key={run.agentId} data-status={run.status}>
        <button
          type="button"
          className="mc-subagents__main"
          onClick={() => onOpen(run.agentId)}
          title={t("subagents.open")}
        >
          <span className="mc-subagents__icon">
            <StageBadge
              stage={deriveStage({ kind: "subagent", status: run.status }).stage}
              size={15}
            />
          </span>
          <span className="mc-subagents__body">
            <span className="mc-subagents__title">
              <span className="mc-truncate">{run.description}</span>
              <span className="mc-subagents__type" data-type={run.agentType ?? "general"}>
                {SUBAGENT_ROLE_LABELS[run.agentType ?? "general"]}
              </span>
              {run.background ? (
                <span className="mc-subagents__bg">{t("subagent.background")}</span>
              ) : null}
              {run.childResult ? (
                <span
                  className="mc-subagents__childresult"
                  data-valid={run.childResult.valid}
                  title={
                    run.childResult.valid
                      ? run.childResult.summary
                      : t("subagents.invalidTooltip", {
                          reason: run.childResult.invalidReason ?? t("subagents.invalidFallback"),
                          summary: run.childResult.summary,
                        })
                  }
                >
                  {run.childResult.valid ? t("subagents.verified") : t("subagents.unverified")}
                  {run.childResult.criticalFindings
                    ? ` · ${t("subagents.criticalFindings", {
                        count: run.childResult.criticalFindings,
                      })}`
                    : ""}
                </span>
              ) : null}
            </span>
            <span className="mc-subagents__meta">
              <span>{t(STATUS_KEYS[run.status])}</span>
              {durationMs != null ? (
                <>
                  <span className="mc-subagents__dot">·</span>
                  <span>{formatDuration(durationMs)}</span>
                </>
              ) : null}
              {input || output ? (
                <>
                  <span className="mc-subagents__dot">·</span>
                  <span>
                    {input ? t("subagent.tokensIn", { tokens: input }) : ""}
                    {input && output ? " · " : ""}
                    {output ? t("subagent.tokensOut", { tokens: output }) : ""}
                  </span>
                </>
              ) : null}
            </span>
          </span>
          <LuArrowUpRight size={14} className="mc-subagents__open" aria-hidden="true" />
        </button>
        {run.status === "running" ? (
          <button
            type="button"
            className="mc-subagents__stop"
            title={t("subagent.stop")}
            aria-label={t("subagent.stop")}
            onClick={() => onStop(run.agentId)}
          >
            <LuSquare size={12} />
          </button>
        ) : null}
      </div>
    );
  };

  return (
    <div className="mc-subagents">
      <div className="mc-subagents__hint">{t("subagents.onlyCurrentSession")}</div>
      {active.length ? <div className="mc-subagents__list">{active.map(renderRow)}</div> : null}
      {finished.length ? (
        <div className="mc-subagents__done">
          <button
            type="button"
            className="mc-subagents__doneHead"
            aria-expanded={doneOpen}
            aria-controls={doneId}
            title={doneLabel}
            onClick={() => setDoneOpen((open) => !open)}
          >
            <LuChevronRight
              size={12}
              className="mc-subagents__chev"
              data-open={doneOpen}
              aria-hidden="true"
            />
            <span className="mc-subagents__doneLabel">{doneLabel}</span>
          </button>
          <div className="mc-subagents__doneBody" id={doneId} data-open={doneOpen}>
            <div className="mc-subagents__doneInner">
              <div className="mc-subagents__list">{finished.map(renderRow)}</div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
