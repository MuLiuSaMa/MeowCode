import { useEffect, useState } from "react";
import { LuArrowUp, LuCircleAlert, LuSquare } from "react-icons/lu";
import type { SubagentRun } from "../../api";
import { SUBAGENT_READ_ONLY, SUBAGENT_ROLE_LABELS } from "../../agentRoles";
import { MessageList } from "../MessageList";
import { Spinner } from "../ui/Spinner";
import "./SubagentTab.css";

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

/** 一个子 Agent 的转录：与主对话同一套消息/工具卡片；结束后可继续对话。 */
export function SubagentTab({
  agentId,
  run,
  onEnsure,
  onStop,
  onContinue,
}: {
  agentId: string;
  run?: SubagentRun;
  onEnsure: (agentId: string) => void;
  onStop?: (agentId: string) => void;
  onContinue?: (agentId: string, message: string) => Promise<void>;
}) {
  const needsHydration = !run || (!run.hydrated && run.status !== "running");
  useEffect(() => {
    if (needsHydration) onEnsure(agentId);
  }, [agentId, needsHydration, onEnsure]);

  const [now, setNow] = useState(Date.now());
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  useEffect(() => {
    if (run?.status !== "running") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [run?.status]);

  const status = run?.status ?? "running";
  const startedMs = run ? Date.parse(run.startedAt) : Number.NaN;
  const liveMs =
    run && status === "running" && Number.isFinite(startedMs)
      ? Math.max(0, now - startedMs)
      : null;
  const durationMs = run?.durationMs ?? liveMs;
  const inputTokens = formatTokens(run?.usage?.inputTokens);
  const outputTokens = formatTokens(run?.usage?.outputTokens);
  const timeline = run?.timeline ?? [];
  const last = timeline.at(-1);
  const streaming = last?.kind === "message" && last.role === "assistant" && last.streaming;
  const waiting = status === "running" && !streaming;
  const loading = !run || (!timeline.length && (status === "running" || !run.hydrated));
  const role = run?.agentType ?? "general";
  const readOnly = SUBAGENT_READ_ONLY.has(role);

  const submitContinue = async () => {
    const text = input.trim();
    if (!text || !onContinue || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await onContinue(agentId, text);
      setInput("");
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mc-subagent">
      <div className="mc-subagent__head">
        <span className="mc-subagent__title" title={run?.description ?? "子 Agent"}>
          <span className="mc-truncate">{run?.description ?? "子 Agent"}</span>
          <span className="mc-subagent__type" data-type={role}>
            {SUBAGENT_ROLE_LABELS[role]}
          </span>
          {run?.background ? <span className="mc-subagent__bg">后台</span> : null}
        </span>
        {status === "running" && onStop ? (
          <button
            type="button"
            className="mc-subagent__stop"
            title="停止这个子 Agent"
            aria-label="停止这个子 Agent"
            onClick={() => onStop(agentId)}
          >
            <LuSquare size={12} />
          </button>
        ) : null}
        <span className="mc-subagent__status" data-status={status}>
          {STATUS_LABELS[status]}
        </span>
      </div>
      <div className="mc-subagent__meta">
        <span className="mc-subagent__readonly">{readOnly ? "只读执行" : "可继续对话"}</span>
        {durationMs != null ? (
          <>
            <span className="mc-subagent__dot">·</span>
            <span>{formatDuration(durationMs)}</span>
          </>
        ) : null}
        {inputTokens || outputTokens ? (
          <>
            <span className="mc-subagent__dot">·</span>
            <span>
              {inputTokens ? `入 ${inputTokens}` : ""}
              {inputTokens && outputTokens ? " · " : ""}
              {outputTokens ? `出 ${outputTokens}` : ""}
            </span>
          </>
        ) : null}
        {run?.callId ? <span className="mc-subagent__taskid">task {run.callId.slice(0, 8)}</span> : null}
      </div>
      {run?.error && (status === "failed" || status === "aborted") ? (
        <div className="mc-subagent__error" role="alert" title={run.error}>
          <LuCircleAlert size={14} />
          <span>{run.error}</span>
        </div>
      ) : null}
      {loading ? (
        <div className="mc-subagent__loading">
          <Spinner size={22} />
          <span>正在加载转录…</span>
        </div>
      ) : timeline.length ? (
        <MessageList
          items={timeline}
          canUse={false}
          waiting={waiting}
          preparing={run?.preparing}
        />
      ) : (
        <div className="mc-subagent__loading">暂无转录</div>
      )}
      {sendError ? (
        <div className="mc-subagent__error" role="alert" title={sendError}>
          <LuCircleAlert size={14} />
          <span>{sendError}</span>
        </div>
      ) : null}
      {onContinue ? (
        status === "running" ? (
          <div className="mc-subagent__continue-hint">运行中，完成后可以继续对话</div>
        ) : (
          <form
            className="mc-subagent__composer"
            onSubmit={(event) => {
              event.preventDefault();
              void submitContinue();
            }}
          >
            <input
              className="mc-subagent__input"
              value={input}
              placeholder={
                readOnly
                  ? `继续让 ${SUBAGENT_ROLE_LABELS[role]} 执行（只读）…`
                  : "继续让子 Agent 工作…"
              }
              onChange={(event) => setInput(event.target.value)}
              disabled={sending}
            />
            <button
              type="submit"
              className="mc-subagent__send"
              aria-label="发送"
              disabled={!input.trim() || sending}
            >
              <LuArrowUp size={14} />
            </button>
          </form>
        )
      ) : null}
    </div>
  );
}
