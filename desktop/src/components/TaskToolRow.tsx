import { useEffect, useState } from "react";
import {
  LuCircleAlert,
  LuCircleCheck,
  LuCircleX,
  LuLoaderCircle,
  LuPanelRightOpen,
} from "react-icons/lu";
import type { SubagentRun, TimelineTool } from "../api";
import { SUBAGENT_ROLE_LABELS } from "../agentRoles";
import "./TaskToolRow.css";

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return "<1s";
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

const STATUS_LABELS: Record<SubagentRun["status"], string> = {
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  aborted: "已停止",
  interrupted: "已中断",
};

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
  const description =
    agent.description || (typeof args.description === "string" ? args.description : "") || "子 Agent";
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
      title={`打开子 Agent：${description}`}
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
      <span className="mc-taskrow__label">子 Agent</span>
      <span className="mc-taskrow__type" data-type={role}>
        {SUBAGENT_ROLE_LABELS[role]}
      </span>
      {agent.background ? <span className="mc-taskrow__type">后台</span> : null}
      <span className="mc-taskrow__desc" title={description}>
        {description}
      </span>
      <span className="mc-taskrow__meta">
        <span className="mc-taskrow__state">{STATUS_LABELS[agent.status]}</span>
        {durationMs != null ? <span className="mc-taskrow__time">{formatDuration(durationMs)}</span> : null}
      </span>
      <LuPanelRightOpen size={14} className="mc-taskrow__open" aria-hidden="true" />
    </button>
  );
}
