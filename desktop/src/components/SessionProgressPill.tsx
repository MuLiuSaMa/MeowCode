import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuCheck, LuX } from "react-icons/lu";
import type { PlanState, SessionChangeSummary } from "../api";
import { Spinner } from "./ui/Spinner";
import "./SessionProgressPill.css";

const STATUS_KEYS: Record<string, string> = {
  pending: "plan.status.pending",
  in_progress: "plan.status.inProgress",
  completed: "plan.status.completed",
  cancelled: "plan.status.cancelled",
};

type OpenPanel = "steps" | "files" | null;

/**
 * 输入框上方的悬浮信息胶囊：
 * - 左侧是计划步骤进度（spinner / check + 步骤 X / Y）
 * - 右侧是本对话已修改文件数与 +A/-D
 * - hover 任一段向上展开对应浮层（步骤列表 / 文件列表）
 *
 * 数据：plan 来自 App 的 plan_updated；changes 来自 GET /session/changes?summary=1。
 * 何时收起由设置里的「输入框上方信息胶囊」偏好决定：提交后（默认，跟随未提交状态）
 * 或对话结束后（回合结束就收起，下一轮有新的步骤/改动才重新出现）。
 */
export function SessionProgressPill({
  plan,
  changes,
  streaming,
  dismissed = false,
}: {
  plan?: PlanState | null;
  changes?: SessionChangeSummary[];
  streaming: boolean;
  /** 设置里选了「对话结束后消失」且已达到收起条件：整颗胶囊直接不渲染 */
  dismissed?: boolean;
}) {
  const { t } = useTranslation("shell");
  const steps = plan?.steps ?? [];
  const fileChanges = changes ?? [];
  const total = steps.length;
  const done = steps.filter((step) => step.status === "completed").length;
  const active = steps.some((step) => step.status === "in_progress");
  const allDone = total > 0 && done === total;
  const running = !allDone && (streaming || active);
  const added = fileChanges.reduce((sum, change) => sum + change.added, 0);
  const removed = fileChanges.reduce((sum, change) => sum + change.removed, 0);
  const showFiles = fileChanges.length > 0;
  const [open, setOpen] = useState<OpenPanel>(null);
  const closeTimer = useRef<number | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const cardId = useId();

  /**
   * 全部完成的计划在回合结束后收起：记录收起那一刻的步骤签名，
   * 计划内容不变就一直不显示（下一轮真正更新计划才重新出现）。
   */
  const stepsSignature = JSON.stringify(steps.map((step) => [step.title, step.status]));
  const [dismissedDoneSignature, setDismissedDoneSignature] = useState<string | null>(null);
  useEffect(() => {
    // 回合进行中不收起，等结束那一刻拍快照
    if (streaming) return;
    setDismissedDoneSignature(allDone ? stepsSignature : null);
  }, [streaming, allDone, stepsSignature]);
  const stepsDismissed = allDone && dismissedDoneSignature === stepsSignature;
  const showSteps = total > 0 && !stepsDismissed;

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(null), 140);
  }, [cancelClose]);

  useEffect(() => () => cancelClose(), [cancelClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  if (dismissed) return null;
  if (!showSteps && !showFiles) return null;

  const openPanel = (panel: Exclude<OpenPanel, null>) => {
    cancelClose();
    setOpen(panel);
  };

  return (
    <div
      ref={anchorRef}
      className="mc-sessionpill-anchor"
      onMouseEnter={cancelClose}
      onMouseLeave={scheduleClose}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) scheduleClose();
      }}
    >
      {open ? (
        <div
          className="mc-sessionpill-card"
          id={cardId}
          role="region"
          aria-label={open === "steps" ? t("plan.aria") : t("plan.filesChanged", { n: fileChanges.length })}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          {open === "steps" ? (
            <ol className="mc-sessionpill__steps">
              {steps.map((step, index) => (
                <li
                  key={`${index}-${step.title}`}
                  className="mc-sessionpill__step"
                  data-status={step.status}
                  title={t(STATUS_KEYS[step.status] ?? "plan.status.pending")}
                >
                  <span className="mc-sessionpill__status" data-kind={step.status} aria-hidden>
                    {step.status === "completed" ? (
                      <LuCheck size={11} />
                    ) : step.status === "in_progress" ? (
                      <Spinner size={12} />
                    ) : step.status === "cancelled" ? (
                      <LuX size={11} />
                    ) : null}
                  </span>
                  <span className="mc-sessionpill__steptitle">{step.title}</span>
                </li>
              ))}
            </ol>
          ) : (
            <>
              <div className="mc-sessionpill__cardtitle">
                {t("plan.filesChanged", { n: fileChanges.length })}
              </div>
              <ul className="mc-sessionpill__files">
                {fileChanges.map((change) => (
                  <li className="mc-sessionpill__file" key={change.path}>
                    <span className="mc-sessionpill__path" title={change.path}>
                      {change.path}
                    </span>
                    <span className="mc-sessionpill__stats">
                      <span className="mc-sessionpill__add">+{change.added}</span>
                      <span className="mc-sessionpill__del">-{change.removed}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}

      <div className="mc-sessionpill" role="group" aria-label={t("plan.aria")}>
        {showSteps ? (
          <button
            type="button"
            className="mc-sessionpill__part"
            aria-expanded={open === "steps"}
            aria-controls={open === "steps" ? cardId : undefined}
            aria-label={t("plan.stepsProgress", { done, total })}
            onMouseEnter={() => openPanel("steps")}
            onFocus={() => openPanel("steps")}
            onClick={() => openPanel("steps")}
          >
            <span
              className="mc-sessionpill__icon"
              data-state={running ? "running" : allDone ? "done" : "idle"}
              aria-hidden
            >
              {running ? (
                <Spinner size={13} />
              ) : allDone ? (
                <LuCheck size={10} />
              ) : (
                <span className="mc-sessionpill__dot" />
              )}
            </span>
            <span>{t("plan.stepsProgress", { done, total })}</span>
          </button>
        ) : null}

        {showSteps && showFiles ? (
          <span className="mc-sessionpill__sep" aria-hidden>
            ·
          </span>
        ) : null}

        {showFiles ? (
          <button
            type="button"
            className="mc-sessionpill__part"
            aria-expanded={open === "files"}
            aria-controls={open === "files" ? cardId : undefined}
            aria-label={t("plan.filesChanged", { n: fileChanges.length })}
            onMouseEnter={() => openPanel("files")}
            onFocus={() => openPanel("files")}
            onClick={() => openPanel("files")}
          >
            <span>{t("plan.filesChanged", { n: fileChanges.length })}</span>
            <span className="mc-sessionpill__stats">
              <span className="mc-sessionpill__add">+{added}</span>
              <span className="mc-sessionpill__del">-{removed}</span>
            </span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
