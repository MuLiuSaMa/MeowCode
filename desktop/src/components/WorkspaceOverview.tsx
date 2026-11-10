import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuCheck,
  LuChevronRight,
  LuCircleAlert,
  LuFileDiff,
  LuGitBranch,
  LuGitCommitHorizontal,
  LuPause,
  LuSquare,
  LuTerminal,
  LuX,
} from "react-icons/lu";
import {
  gitBranches,
  gitSwitchBranch,
  type GitBranch,
  type GitStatus,
  type SubagentRun,
  type SubagentStatus,
} from "../api";
import { CustomSelect, type CustomSelectOption } from "./ui/CustomSelect";
import { Spinner } from "./ui/Spinner";
import "./WorkspaceOverview.css";

function workspaceTotals(status: GitStatus | null): { added: number; removed: number } {
  if (!status?.isRepo) return { added: 0, removed: 0 };
  if (typeof status.addedTotal === "number" && typeof status.removedTotal === "number") {
    return { added: status.addedTotal, removed: status.removedTotal };
  }
  const seen = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const entry of [...status.conflicted, ...status.unstaged, ...status.staged]) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    added += entry.added ?? 0;
    removed += entry.removed ?? 0;
  }
  return { added, removed };
}

function statusIcon(status: SubagentStatus) {
  if (status === "running") return <Spinner size={13} />;
  if (status === "completed") return <LuCheck size={13} />;
  if (status === "failed") return <LuCircleAlert size={13} />;
  if (status === "aborted") return <LuX size={13} />;
  return <LuPause size={13} />;
}

/**
 * 聊天区右上角的工作区概览：默认收成胶囊（只显示 git 更改），
 * 展开后显示工作区全部 git 更改摘要、分支切换、提交或推送入口、
 * 当前会话的子智能体，以及 agent 启动的后台终端。
 * 子 Agent 启动时由 App 自动展开；点击子 Agent 打开右侧栏对话。
 * 后台终端只在这里列出，点一条才在右侧面板开页签；关页签不杀进程，条目也继续留着，
 * 只有任务进程退出（跑完 / 被 Ctrl+C 中断 / 被 ■ 停掉）才由 App 移除条目。
 */
export function WorkspaceOverview({
  status,
  subagents,
  terminals,
  open,
  onToggle,
  onClose,
  onOpenGit,
  onOpenSubagent,
  onOpenTerminal,
  onStopTerminal,
}: {
  status: GitStatus | null;
  subagents: SubagentRun[];
  /** agent 启动的后台终端（运行中） */
  terminals: Array<{ id: string; command: string }>;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onOpenGit: () => void;
  onOpenSubagent: (agentId: string) => void;
  onOpenTerminal: (termId: string, command: string) => void;
  onStopTerminal: (termId: string) => void;
}) {
  const { t } = useTranslation(["chat", "panel"]);
  const rootRef = useRef<HTMLDivElement>(null);
  const totals = useMemo(() => workspaceTotals(status), [status]);
  const [branches, setBranches] = useState<GitBranch[] | null>(null);
  const [branchBusy, setBranchBusy] = useState<string | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 分支下拉打开时第一次 Esc 只关下拉，不连卡片一起关
      if (document.querySelector(".mc-customselect__menu")) return;
      onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (rootRef.current?.contains(target)) return;
      // CustomSelect 的菜单 portal 在 body 下：点选项不能把概览卡片一起关掉
      if (target.closest?.(".mc-customselect__menu")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [onClose, open]);

  // 展开时拉一次分支列表：卡片里的分支下拉直接切换，菜单走 CustomSelect 的 portal，不被卡片滚动裁切
  useEffect(() => {
    if (!open || !status?.isRepo) return;
    let cancelled = false;
    setBranches(null);
    setBranchError(null);
    void gitBranches()
      .then((result) => {
        if (!cancelled) setBranches(result.branches);
      })
      .catch((error) => {
        if (cancelled) return;
        setBranches([]);
        setBranchError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [open, status?.isRepo]);

  const sorted = useMemo(
    () =>
      [...subagents].sort((left, right) => {
        const leftRunning = left.status === "running" ? 0 : 1;
        const rightRunning = right.status === "running" ? 0 : 1;
        if (leftRunning !== rightRunning) return leftRunning - rightRunning;
        return (right.startedAt ?? "").localeCompare(left.startedAt ?? "");
      }),
    [subagents],
  );

  const branchName = status?.isRepo ? status.branch : undefined;
  const branchOptions = useMemo<Array<CustomSelectOption<string>>>(() => {
    if (branches?.length) {
      return branches.map((branch) => ({ value: branch.name, label: branch.name }));
    }
    return branchName ? [{ value: branchName, label: branchName }] : [];
  }, [branchName, branches]);

  if (!status && sorted.length === 0 && terminals.length === 0) return null;
  if (status && !status.isRepo && sorted.length === 0 && terminals.length === 0) return null;

  const isRepo = status?.isRepo === true;
  const failed = status?.reason === "git_failed" || status?.reason === "git_unavailable";
  const hasChanges =
    isRepo && status !== null &&
    status.staged.length + status.unstaged.length + status.conflicted.length > 0;
  const changesLabel = isRepo
    ? hasChanges
      ? t("overview.changes")
      : t("overview.noChanges")
    : failed
      ? t("overview.gitFailed")
      : status
        ? t("overview.notRepo")
        : t("overview.changes");
  const showStats = hasChanges;

  // 干净工作区且没有子 Agent / 后台终端：右上角不保留一个空概览入口
  if (isRepo && !hasChanges && sorted.length === 0 && terminals.length === 0) return null;

  const switchBranch = async (name: string) => {
    if (branchBusy !== null || name === status?.branch) return;
    setBranchBusy(name);
    setBranchError(null);
    try {
      await gitSwitchBranch({ name });
      // 菜单里的当前分支打勾需要重新拉一次；git_changed 只刷新外层 status
      const result = await gitBranches().catch(() => null);
      if (result) setBranches(result.branches);
    } catch (error) {
      setBranchError(error instanceof Error ? error.message : String(error));
    } finally {
      setBranchBusy(null);
    }
  };

  return (
    <div className="mc-workspaceov" ref={rootRef}>
      <button
        type="button"
        className="mc-workspaceov__capsule"
        aria-expanded={open}
        aria-label={open ? t("overview.close") : t("overview.open")}
        title={t("overview.changes")}
        onClick={onToggle}
      >
        <LuFileDiff size={14} className="mc-workspaceov__icon" />
        {showStats ? (
          <span className="mc-workspaceov__stats">
            <span className="mc-workspaceov__add">+{totals.added}</span>
            <span className="mc-workspaceov__del">-{totals.removed}</span>
          </span>
        ) : (
          <span className="mc-workspaceov__label">{changesLabel}</span>
        )}
      </button>

      {open ? (
        <div className="mc-workspaceov__card" role="region" aria-label={t("overview.open")}>
          <div className="mc-workspaceov__changes">
            <span className="mc-workspaceov__sectiontitle">
              <LuFileDiff size={14} aria-hidden />
              {changesLabel}
            </span>
            {showStats ? (
              <span className="mc-workspaceov__stats">
                <span className="mc-workspaceov__add">+{totals.added}</span>
                <span className="mc-workspaceov__del">-{totals.removed}</span>
              </span>
            ) : null}
          </div>

          {isRepo && branchName ? (
            <CustomSelect
              value={branchName}
              options={branchOptions}
              onChange={(name) => void switchBranch(name)}
              ariaLabel={t("overview.switchBranch")}
              icon={<LuGitBranch size={13} />}
              className="mc-workspaceov__branchselect"
              disabled={branchBusy !== null}
            />
          ) : null}
          {branchError ? <p className="mc-workspaceov__error">{branchError}</p> : null}

          {isRepo ? (
            <button type="button" className="mc-workspaceov__commit" onClick={onOpenGit}>
              <LuGitCommitHorizontal size={14} aria-hidden />
              <span>{t("overview.commitOrPush")}</span>
              <LuChevronRight size={13} className="mc-workspaceov__chevron" aria-hidden />
            </button>
          ) : null}

          <div className="mc-workspaceov__divider" />

          <div className="mc-workspaceov__agenthead">
            <span>{t("overview.agents")}</span>
            <span className="mc-workspaceov__count">{sorted.length}</span>
          </div>

          {sorted.length ? (
            <div className="mc-workspaceov__agents">
              {sorted.map((run) => (
                <button
                  key={run.agentId}
                  type="button"
                  className="mc-workspaceov__agent"
                  data-status={run.status}
                  onClick={() => onOpenSubagent(run.agentId)}
                >
                  <span
                    className="mc-workspaceov__agenticon"
                    data-status={run.status}
                    aria-hidden
                  >
                    {statusIcon(run.status)}
                  </span>
                  <span className="mc-workspaceov__agenttext">
                    <span
                      className="mc-workspaceov__agentdesc"
                      title={run.description || run.agentType || run.agentId}
                    >
                      {run.description || run.agentType || run.agentId}
                    </span>
                    <span className="mc-workspaceov__agentmeta">
                      {t(`panel:runStatus.${run.status}`)}
                      {run.background ? ` · ${t("panel:subagent.background")}` : ""}
                    </span>
                  </span>
                  <LuChevronRight size={13} className="mc-workspaceov__chevron" aria-hidden />
                </button>
              ))}
            </div>
          ) : (
            <p className="mc-workspaceov__empty">{t("overview.noAgents")}</p>
          )}

          <div className="mc-workspaceov__divider" />

          <div className="mc-workspaceov__agenthead">
            <span>{t("overview.terminals")}</span>
            <span className="mc-workspaceov__count">{terminals.length}</span>
          </div>

          {terminals.length ? (
            <div className="mc-workspaceov__agents">
              {terminals.map((item) => (
                <div key={item.id} className="mc-workspaceov__termrow">
                  <button
                    type="button"
                    className="mc-workspaceov__agent mc-workspaceov__termopen"
                    onClick={() => onOpenTerminal(item.id, item.command)}
                    title={item.command}
                  >
                    <span className="mc-workspaceov__agenticon" aria-hidden>
                      <LuTerminal size={13} />
                    </span>
                    <span className="mc-workspaceov__agenttext">
                      <span className="mc-workspaceov__agentdesc">{item.command}</span>
                      <span className="mc-workspaceov__agentmeta">
                        {t("overview.terminalRunning")}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="mc-workspaceov__termstop"
                    aria-label={t("overview.stopTerminal")}
                    title={t("overview.stopTerminal")}
                    onClick={() => onStopTerminal(item.id)}
                  >
                    <LuSquare size={11} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="mc-workspaceov__empty">{t("overview.noTerminals")}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
