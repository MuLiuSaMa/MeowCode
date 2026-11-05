import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  LuArrowDownToLine,
  LuArrowUpFromLine,
  LuCircleAlert,
  LuGitBranch,
  LuPlus,
  LuRotateCw,
  LuTrash2,
  LuUndo2,
} from "react-icons/lu";
import type { GitFileEntry, GitFileStatus } from "../../api";
import type { GitGroupId, GitView } from "../../git/useGitView";
import { formatNumber } from "../../i18n/format";
import { ConfirmDialog } from "./ConfirmDialog";
import "./git.css";

/** 每组最多渲染的行数，见下方 groups 的注释 */
const MAX_ROWS = 1_000;

const STATUS_LETTER: Record<GitFileStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
  untracked: "U",
  conflicted: "!",
};

function baseNameOf(filePath: string): string {
  const index = filePath.lastIndexOf("/");
  return index >= 0 ? filePath.slice(index + 1) : filePath;
}

function dirNameOf(filePath: string): string {
  const index = filePath.lastIndexOf("/");
  return index > 0 ? filePath.slice(0, index) : "";
}

function statusOf(entry: GitFileEntry, group: GitGroupId): GitFileStatus {
  if (group === "conflicted") return "conflicted";
  if (group === "staged") return entry.index ?? "modified";
  return entry.worktree ?? "modified";
}

function GroupHeader({
  label,
  count,
  action,
  actionTitle,
  onAction,
}: {
  label: string;
  count: number;
  action?: React.ReactNode;
  actionTitle?: string;
  onAction?: () => void;
}) {
  return (
    <div className="mc-git__group">
      <span className="mc-git__grouplabel">{label}</span>
      <span className="mc-git__groupcount">{formatNumber(count)}</span>
      {onAction ? (
        <button
          type="button"
          className="mc-git__groupbtn"
          title={actionTitle}
          aria-label={actionTitle}
          onClick={onAction}
        >
          {action}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Git 管理左栏：分支行 + 冲突/已暂存/未暂存三组。
 * 宽度由外层 `.mc-listcol` 控制，这里不写死宽度。
 */
export function GitNav({
  git,
  onOpenBranches,
}: {
  git: GitView;
  onOpenBranches: () => void;
}) {
  const { t } = useTranslation("git");
  /** 丢弃 / 解决冲突都要确认：两者都会覆盖磁盘上的内容 */
  const [discardPaths, setDiscardPaths] = useState<string[] | null>(null);
  const [resolveTarget, setResolveTarget] = useState<{
    path: string;
    side: "ours" | "theirs" | "mark";
  } | null>(null);
  const status = git.status;
  const isRepo = status?.isRepo === true;
  /**
   * 列表最多渲染这么多行：几万个未跟踪文件（比如把参考仓库拷进工作区）会把渲染进程直接卡死。
   * 服务端已经截断过一次，这里再兜一层——老版本服务端 / 异常数据也不会把界面拖死。
   */
  const rows = (entries: GitFileEntry[] | undefined) => (entries ?? []).slice(0, MAX_ROWS);
  /** 分组标题在组件内查表：切语言才会跟着刷新 */
  const groupLabels = useMemo<Record<GitGroupId, string>>(
    () => ({
      conflicted: t("group.conflicted"),
      staged: t("group.staged"),
      unstaged: t("group.unstaged"),
    }),
    [t],
  );
  /** entries 是渲染用的截断列表，total 才是真实数量 */
  const groups: Array<{ id: GitGroupId; label: string; entries: GitFileEntry[]; total: number }> = [
    {
      id: "conflicted",
      label: groupLabels.conflicted,
      entries: rows(status?.conflicted),
      total: status?.conflictedCount ?? status?.conflicted.length ?? 0,
    },
    {
      id: "staged",
      label: groupLabels.staged,
      entries: rows(status?.staged),
      total: status?.stagedCount ?? status?.staged.length ?? 0,
    },
    {
      id: "unstaged",
      label: groupLabels.unstaged,
      entries: rows(status?.unstaged),
      total: status?.unstagedCount ?? status?.unstaged.length ?? 0,
    },
  ];
  const total = groups.reduce((sum, group) => sum + group.total, 0);

  return (
    <nav className="mc-panel mc-panel--conversations mc-git__nav" aria-label={t("nav.ariaLabel")}>
      <h1 className="mc-settings__heading">{t("nav.heading")}</h1>
      {isRepo ? (
        <button type="button" className="mc-git__branchrow" onClick={onOpenBranches} title={t("branch.switch")}>
          <LuGitBranch size={13} />
          <span className="mc-git__branchname">
            {status?.branch || (status?.detached ? "detached HEAD" : "—")}
          </span>
          {status?.ahead || status?.behind ? (
            <span className="mc-git__aheadbehind">
              {status?.ahead ? `↑${status.ahead}` : ""}
              {status?.behind ? `↓${status.behind}` : ""}
            </span>
          ) : null}
        </button>
      ) : (
        <p className="mc-git__subtitle">
          {status?.reason === "git_unavailable"
            ? t("repo.unavailable")
            : status?.reason === "not_a_repo"
              ? t("repo.notRepo")
              : t("repo.reading")}
        </p>
      )}

      {isRepo ? (
        <div className="mc-git__groups">
          {groups.map((group) => (
            <section key={group.id} className="mc-git__section" data-group={group.id}>
              <GroupHeader
                label={group.label}
                count={group.total}
                {...(group.id === "staged" && group.total
                  ? {
                      action: <LuUndo2 size={12} />,
                      actionTitle: t("group.unstageAll"),
                      onAction: () => void git.unstageAll(),
                    }
                  : group.id === "unstaged" && group.total
                    ? {
                        action: <LuPlus size={12} />,
                        actionTitle: t("group.stageAll"),
                        onAction: () => void git.stageAll(),
                      }
                    : {})}
              />
              {group.total > group.entries.length ? (
                <p className="mc-git__truncated">
                  {t("list.truncated", {
                    shown: formatNumber(group.entries.length),
                    total: formatNumber(group.total),
                  })}
                  {group.id === "staged"
                    ? t("list.truncatedStaged")
                    : group.id === "unstaged"
                      ? t("list.truncatedUnstaged")
                      : ""}
                </p>
              ) : null}
              {group.entries.length === 0 ? (
                <p className="mc-git__empty">{t("group.empty")}</p>
              ) : (
                group.entries.map((entry) => {
                  const active =
                    git.selection?.kind === "file" &&
                    git.selection.path === entry.path &&
                    (group.id === "conflicted" || git.selection.side === (group.id === "staged" ? "index" : "worktree"));
                  const statusKind = statusOf(entry, group.id);
                  return (
                    <div
                      key={`${group.id}:${entry.path}`}
                      className="mc-git__row"
                      data-active={active}
                      role="button"
                      tabIndex={0}
                      title={entry.origPath ? `${entry.origPath} → ${entry.path}` : entry.path}
                      onClick={() => git.selectFile(entry, group.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          git.selectFile(entry, group.id);
                        }
                      }}
                    >
                      <span className="mc-git__letter" data-kind={statusKind}>
                        {STATUS_LETTER[statusKind]}
                      </span>
                      <span className="mc-git__filename">{baseNameOf(entry.path)}</span>
                      <span className="mc-git__dirname">{dirNameOf(entry.path)}</span>
                      {entry.added || entry.removed ? (
                        <span className="mc-git__rowstat">
                          {entry.added ? <em data-kind="add">+{entry.added}</em> : null}
                          {entry.removed ? <em data-kind="del">−{entry.removed}</em> : null}
                        </span>
                      ) : null}
                      <span className="mc-git__rowactions">
                        {group.id === "conflicted" ? (
                          <>
                            <button
                              type="button"
                              className="mc-git__rowbtn"
                              title={t("conflict.oursTitle")}
                              onClick={(event) => {
                                event.stopPropagation();
                                setResolveTarget({ path: entry.path, side: "ours" });
                              }}
                            >
                              {t("conflict.ours")}
                            </button>
                            <button
                              type="button"
                              className="mc-git__rowbtn"
                              title={t("conflict.theirsTitle")}
                              onClick={(event) => {
                                event.stopPropagation();
                                setResolveTarget({ path: entry.path, side: "theirs" });
                              }}
                            >
                              {t("conflict.theirs")}
                            </button>
                            <button
                              type="button"
                              className="mc-git__rowbtn"
                              title={t("conflict.markTitle")}
                              onClick={(event) => {
                                event.stopPropagation();
                                setResolveTarget({ path: entry.path, side: "mark" });
                              }}
                            >
                              {t("conflict.mark")}
                            </button>
                          </>
                        ) : group.id === "staged" ? (
                          <button
                            type="button"
                            className="mc-git__rowbtn"
                            title={t("file.unstage")}
                            aria-label={t("file.unstage")}
                            onClick={(event) => {
                              event.stopPropagation();
                              void git.unstage([entry.path]);
                            }}
                          >
                            <LuUndo2 size={12} />
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="mc-git__rowbtn"
                              title={t("file.stage")}
                              aria-label={t("file.stage")}
                              onClick={(event) => {
                                event.stopPropagation();
                                void git.stage([entry.path]);
                              }}
                            >
                              <LuPlus size={12} />
                            </button>
                            <button
                              type="button"
                              className="mc-git__rowbtn"
                              title={t("file.discard")}
                              aria-label={t("file.discard")}
                              onClick={(event) => {
                                event.stopPropagation();
                                setDiscardPaths([entry.path]);
                              }}
                            >
                              <LuTrash2 size={12} />
                            </button>
                          </>
                        )}
                      </span>
                    </div>
                  );
                })
              )}
            </section>
          ))}
        </div>
      ) : null}

      <ConfirmDialog
        open={discardPaths !== null}
        title={t("discard.title")}
        message={t("discard.message")}
        detail={(discardPaths ?? []).join("\n")}
        confirmLabel={t("discard.confirm")}
        danger
        busy={git.busy === "discard"}
        onCancel={() => setDiscardPaths(null)}
        onConfirm={() => {
          const paths = discardPaths ?? [];
          setDiscardPaths(null);
          void git.discard(paths);
        }}
      />
      <ConfirmDialog
        open={resolveTarget !== null}
        title={
          resolveTarget?.side === "mark"
            ? t("conflict.resolveTitleMark")
            : resolveTarget?.side === "ours"
              ? t("conflict.resolveTitleOurs")
              : t("conflict.resolveTitleTheirs")
        }
        message={
          resolveTarget?.side === "mark"
            ? t("conflict.resolveMessageMark")
            : t("conflict.resolveMessageReplace")
        }
        detail={resolveTarget?.path}
        confirmLabel={t("dialog.confirm")}
        danger={resolveTarget?.side !== "mark"}
        busy={Boolean(git.busy?.startsWith("resolve:"))}
        onCancel={() => setResolveTarget(null)}
        onConfirm={() => {
          const target = resolveTarget;
          setResolveTarget(null);
          if (target) void git.resolve(target.path, target.side);
        }}
      />

      <div className="mc-git__navfoot">
        {isRepo ? (
          <>
            <span className="mc-git__footmeta">
              {t("footer.changes", { count: total })} · {status?.name}
            </span>
            <div className="mc-git__footactions">
              <button
                type="button"
                className="mc-settings__back"
                title={t("action.refresh")}
                onClick={() => void git.refresh()}
              >
                <LuRotateCw size={12} /> {t("action.refresh")}
              </button>
              <button
                type="button"
                className="mc-settings__back"
                title={status?.upstream ? t("pull.title") : t("pull.noUpstream")}
                disabled={!status?.upstream || git.busy !== null}
                onClick={() => void git.pull()}
              >
                <LuArrowDownToLine size={12} /> {t("action.pull")}
              </button>
              <button
                type="button"
                className="mc-settings__back"
                title={status?.branch ? t("action.push") : t("push.detached")}
                disabled={!status?.branch || git.busy !== null}
                onClick={() => void git.push()}
              >
                <LuArrowUpFromLine size={12} /> {t("action.push")}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </nav>
  );
}

/** 分支行的小提示：无上游/ahead/behind 的解释（GitBody 头部复用）。 */
export function describeUpstream(
  status: { upstream?: string; ahead?: number; behind?: number } | null,
  t: TFunction<"git">,
): string {
  if (!status?.upstream) return t("upstream.none");
  const parts = [status.upstream];
  if (status.ahead) parts.push(t("upstream.ahead", { count: status.ahead }));
  if (status.behind) parts.push(t("upstream.behind", { count: status.behind }));
  return parts.join(" · ");
}

/** 仓库不可用时给用户的排错提示。 */
export function GitRepoHint({ reason }: { reason?: string }) {
  const { t } = useTranslation("git");
  const text =
    reason === "git_unavailable"
      ? t("repoHint.unavailable")
      : reason === "not_a_repo"
        ? t("repoHint.notRepo")
        : t("repoHint.failed");
  return (
    <div className="mc-git__placeholder">
      <LuCircleAlert size={16} />
      {text}
    </div>
  );
}
