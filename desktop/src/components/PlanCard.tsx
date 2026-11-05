import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuChevronDown } from "react-icons/lu";
import type { PlanState } from "../api";
import { Markdown } from "./ui/Markdown";
import "./PlanCard.css";

/** 表里只存 key：步骤状态文案在组件内查表，切语言才会跟着刷新。 */
const STATUS_KEYS: Record<PlanState["steps"][number]["status"], string> = {
  pending: "plan.status.pending",
  in_progress: "plan.status.inProgress",
  completed: "plan.status.completed",
  cancelled: "plan.status.cancelled",
};

/** 当前条：优先进行中，其次下一条待开始；全部结束返回 -1 */
function currentIndex(steps: PlanState["steps"]): number {
  const running = steps.findIndex((step) => step.status === "in_progress");
  if (running !== -1) return running;
  return steps.findIndex((step) => step.status === "pending");
}

/** 输入框上方的任务列表：收起时只显示当前一条，点击展开全部步骤 */
export function PlanCard({ plan }: { plan: PlanState }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const { t } = useTranslation("shell");
  if (!plan.steps.length) return null;

  const index = currentIndex(plan.steps);
  const current = index >= 0 ? plan.steps[index] : null;
  const done = plan.steps.filter((step) => step.status === "completed").length;
  const allCompleted = plan.steps.every((step) => step.status === "completed");
  const status = current?.status ?? "completed";
  const headline = current?.title ?? (allCompleted ? t("plan.allDone") : t("plan.endedHeadline"));

  return (
    <section className="mc-plancard" data-open={open} aria-label={t("plan.aria")}>
      <button
        type="button"
        className="mc-plancard__head"
        aria-expanded={open}
        aria-controls={bodyId}
        title={open ? t("plan.collapse") : t("plan.expand")}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="mc-plancard__marker" data-status={status} aria-hidden />
        <span className="mc-plancard__state" data-status={status}>
          {current ? t(STATUS_KEYS[current.status]) : t("plan.ended")}
        </span>
        <span className="mc-plancard__current mc-truncate">{headline}</span>
        <span className="mc-plancard__count">
          {done}/{plan.steps.length}
        </span>
        <LuChevronDown size={13} className="mc-plancard__chev" />
      </button>

      {open ? (
        <div className="mc-plancard__body" id={bodyId}>
          {plan.explanation ? <Markdown content={plan.explanation} className="mc-plancard__note" /> : null}
          <ol className="mc-plancard__steps">
            {plan.steps.map((step, stepIndex) => (
              <li
                key={`${stepIndex}-${step.title}`}
                className="mc-plancard__step"
                data-status={step.status}
                data-current={stepIndex === index}
              >
                <span className="mc-plancard__dot" aria-hidden />
                <span className="mc-plancard__text">{step.title}</span>
                <span className="mc-plancard__status">{t(STATUS_KEYS[step.status])}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
