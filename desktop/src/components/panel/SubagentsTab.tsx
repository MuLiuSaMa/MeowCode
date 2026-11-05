import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuArrowUpRight,
  LuCircleAlert,
  LuCircleCheck,
  LuCircleX,
  LuLoaderCircle,
  LuSquare,
} from "react-icons/lu";
import type { SubagentRun } from "../../api";
import { SUBAGENT_ROLE_LABELS } from "../../agentRoles";
import "./SubagentsTab.css";

const STATUS_KEYS: Record<SubagentRun["status"], string> = {
  running: "runStatus.running",
  completed: "runStatus.completed",
  failed: "runStatus.failed",
  aborted: "runStatus.aborted",
  interrupted: "runStatus.interrupted",
};

function formatDuration(ms: number): string {
  if (ms < 1_000) return "<1s";
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

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
  const [now, setNow] = useState(Date.now());
  const hasRunning = runs.some((run) => run.status === "running");
  useEffect(() => {
    if (!hasRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasRunning]);

  const ordered = [...runs].sort((a, b) => {
    if (a.status === "running" && b.status !== "running") return -1;
    if (b.status === "running" && a.status !== "running") return 1;
    return (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
  });

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

  return (
    <div className="mc-subagents">
      <div className="mc-subagents__hint">{t("subagents.onlyCurrentSession")}</div>
      <div className="mc-subagents__list">
        {ordered.map((run) => {
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
                <span className="mc-subagents__icon" aria-hidden="true">
                  {run.status === "running" ? (
                    <LuLoaderCircle size={15} className="mc-subagents__spin" />
                  ) : run.status === "failed" ? (
                    <LuCircleX size={15} />
                  ) : run.status === "aborted" || run.status === "interrupted" ? (
                    <LuCircleAlert size={15} />
                  ) : (
                    <LuCircleCheck size={15} />
                  )}
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
        })}
      </div>
    </div>
  );
}
