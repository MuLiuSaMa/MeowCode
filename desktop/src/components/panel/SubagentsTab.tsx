import { useEffect, useState } from "react";
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

const STATUS_LABELS: Record<SubagentRun["status"], string> = {
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  aborted: "已停止",
  interrupted: "已中断",
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
          <span>当前会话还没有子 Agent</span>
          <span>主 Agent 派发 task 后会出现在这里</span>
        </div>
      </div>
    );
  }

  return (
    <div className="mc-subagents">
      <div className="mc-subagents__hint">仅显示当前会话的子 Agent</div>
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
                title="打开子 Agent 转录"
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
                    {run.background ? <span className="mc-subagents__bg">后台</span> : null}
                    {run.childResult ? (
                      <span
                        className="mc-subagents__childresult"
                        data-valid={run.childResult.valid}
                        title={
                          run.childResult.valid
                            ? run.childResult.summary
                            : `${run.childResult.invalidReason ?? "宿主校验未通过"}：${run.childResult.summary}`
                        }
                      >
                        {run.childResult.valid ? "已核验" : "校验未过"}
                        {run.childResult.criticalFindings
                          ? ` · ${run.childResult.criticalFindings} 严重`
                          : ""}
                      </span>
                    ) : null}
                  </span>
                  <span className="mc-subagents__meta">
                    <span>{STATUS_LABELS[run.status]}</span>
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
                          {input ? `入 ${input}` : ""}
                          {input && output ? " / " : ""}
                          {output ? `出 ${output}` : ""}
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
                  title="停止这个子 Agent"
                  aria-label="停止这个子 Agent"
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
