import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuArrowUp, LuCircleAlert, LuSquare } from "react-icons/lu";
import type { SubagentRun } from "../../api";
import { SUBAGENT_READ_ONLY, SUBAGENT_ROLE_LABELS } from "../../agentRoles";
import { MessageList } from "../MessageList";
import { Spinner } from "../ui/Spinner";
import "./SubagentTab.css";

/** 状态文案只存 key：在组件里查表，切语言才会跟着刷新。 */
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

/** 一个子 Agent 的转录：与主对话同一套消息/工具卡片；结束后可继续对话。 */
export function SubagentTab({
  agentId,
  run,
  onEnsure,
  onStop,
  onContinue,
  onSteer,
  onOpenFile,
}: {
  agentId: string;
  run?: SubagentRun;
  onEnsure: (agentId: string) => void;
  onStop?: (agentId: string) => void;
  onContinue?: (agentId: string, message: string) => Promise<void>;
  onSteer?: (agentId: string, message: string) => Promise<void>;
  /** read_file 工具行点击 → 右侧「文件」页签打开 */
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useTranslation("panel");
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
  const roleLabel = SUBAGENT_ROLE_LABELS[role];
  const readOnly = SUBAGENT_READ_ONLY.has(role);
  const fallbackTitle = t("subagent.fallbackTitle");

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

  const submitSteer = async () => {
    const text = input.trim();
    if (!text || !onSteer || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await onSteer(agentId, text);
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
        <span className="mc-subagent__title" title={run?.description || fallbackTitle}>
          <span className="mc-truncate">{run?.description || fallbackTitle}</span>
          <span className="mc-subagent__type" data-type={role}>
            {roleLabel}
          </span>
          {run?.background ? <span className="mc-subagent__bg">{t("subagent.background")}</span> : null}
        </span>
        {status === "running" && onStop ? (
          <button
            type="button"
            className="mc-subagent__stop"
            title={t("subagent.stop")}
            aria-label={t("subagent.stop")}
            onClick={() => onStop(agentId)}
          >
            <LuSquare size={12} />
          </button>
        ) : null}
        <span className="mc-subagent__status" data-status={status}>
          {t(STATUS_KEYS[status])}
        </span>
      </div>
      <div className="mc-subagent__meta">
        <span className="mc-subagent__readonly">
          {readOnly ? t("subagent.readOnly") : t("subagent.canContinue")}
        </span>
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
              {inputTokens ? t("subagent.tokensIn", { tokens: inputTokens }) : ""}
              {inputTokens && outputTokens ? " · " : ""}
              {outputTokens ? t("subagent.tokensOut", { tokens: outputTokens }) : ""}
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
      {run?.steerError ? (
        <div className="mc-subagent__error" role="alert" title={run.steerError}>
          <LuCircleAlert size={14} />
          <span>{run.steerError}</span>
        </div>
      ) : null}
      {loading ? (
        <div className="mc-subagent__loading">
          <Spinner size={22} />
          <span>{t("subagent.loadingTranscript")}</span>
        </div>
      ) : timeline.length ? (
        <MessageList
          items={timeline}
          canUse={false}
          waiting={waiting}
          preparing={run?.preparing}
          onOpenFile={onOpenFile}
        />
      ) : (
        <div className="mc-subagent__loading">{t("subagent.emptyTranscript")}</div>
      )}
      {sendError ? (
        <div className="mc-subagent__error" role="alert" title={sendError}>
          <LuCircleAlert size={14} />
          <span>{sendError}</span>
        </div>
      ) : null}
      {status === "running" && run?.pendingSteers?.length ? (
        <div className="mc-subagent__pending" role="status">
          {t("subagent.pendingSteers", { count: run.pendingSteers.length })}
        </div>
      ) : null}
      {status === "running" && onSteer ? (
        <form
          className="mc-subagent__composer"
          onSubmit={(event) => {
            event.preventDefault();
            void submitSteer();
          }}
        >
          <textarea
            className="mc-subagent__input mc-subagent__input--steer"
            value={input}
            rows={1}
            maxLength={4000}
            placeholder={
              readOnly
                ? t("subagent.steerPlaceholderReadOnly", { role: roleLabel })
                : t("subagent.steerPlaceholder")
            }
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submitSteer();
              }
            }}
            disabled={sending}
          />
          <button
            type="submit"
            className="mc-subagent__send"
            aria-label={t("subagent.steer")}
            title={t("subagent.steerTitle")}
            disabled={!input.trim() || sending}
          >
            <LuArrowUp size={14} />
          </button>
        </form>
      ) : onContinue ? (
        status === "running" ? (
          <div className="mc-subagent__continue-hint">{t("subagent.runningHint")}</div>
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
                  ? t("subagent.continuePlaceholderReadOnly", { role: roleLabel })
                  : t("subagent.continuePlaceholder")
              }
              onChange={(event) => setInput(event.target.value)}
              disabled={sending}
            />
            <button
              type="submit"
              className="mc-subagent__send"
              aria-label={t("subagent.send")}
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
