import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  LuCircleAlert,
  LuCircleCheck,
  LuCircleX,
  LuLoaderCircle,
  LuPanelRightOpen,
} from "react-icons/lu";
import type { SubagentRun, TimelineTool } from "../api";
import { SUBAGENT_ROLE_LABELS } from "../agentRoles";
import { formatNumber } from "../i18n/format";
import "./TaskToolRow.css";

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function formatDuration(ms: number, t: TFunction): string {
  if (ms < 1_000) return t("taskRow.durationUnderSecond");
  const seconds = ms / 1_000;
  if (seconds < 60) {
    return t("taskRow.durationSeconds", {
      value: formatNumber(seconds, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    });
  }
  const minutes = Math.floor(seconds / 60);
  return t("taskRow.durationMinutes", {
    minutes: formatNumber(minutes),
    seconds: formatNumber(Math.round(seconds % 60)),
  });
}

export function TaskToolRow({
  item,
  agent,
  onOpen,
}: {
  item: TimelineTool;
  agent: SubagentRun;
  onOpen: (agentId: string) => void;
}) {
  const args = asRecord(item.input);
  const { t } = useTranslation("shell");
  const description =
    agent.description ||
    (typeof args.description === "string" ? args.description : "") ||
    t("subagent.label");
  const role = agent.agentType ?? "general";
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (agent.status !== "running") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [agent.status]);

  const startedMs = Date.parse(agent.startedAt);
  const liveMs =
    agent.status === "running" && Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : null;
  const durationMs = agent.durationMs ?? liveMs;

  return (
    <button
      type="button"
      className="mc-taskrow"
      data-status={agent.status}
      title={t("taskRow.open", { name: description })}
      onClick={() => onOpen(agent.agentId)}
    >
      <span className="mc-taskrow__icon" aria-hidden="true">
        {agent.status === "running" ? (
          <LuLoaderCircle size={16} className="mc-taskrow__spin" />
        ) : agent.status === "failed" ? (
          <LuCircleX size={16} />
        ) : agent.status === "aborted" || agent.status === "interrupted" ? (
          <LuCircleAlert size={16} />
        ) : (
          <LuCircleCheck size={16} />
        )}
      </span>
      <span className="mc-taskrow__label">{t("subagent.label")}</span>
      <span className="mc-taskrow__type" data-type={role}>
        {SUBAGENT_ROLE_LABELS[role]}
      </span>
      {agent.background ? <span className="mc-taskrow__type">{t("taskRow.background")}</span> : null}
      <span className="mc-taskrow__desc" title={description}>
        {description}
      </span>
      <span className="mc-taskrow__meta">
        <span className="mc-taskrow__state">{t(`taskRow.status.${agent.status}`)}</span>
        {durationMs != null ? (
          <span className="mc-taskrow__time">{formatDuration(durationMs, t)}</span>
        ) : null}
      </span>
      <LuPanelRightOpen size={14} className="mc-taskrow__open" aria-hidden="true" />
    </button>
  );
}
