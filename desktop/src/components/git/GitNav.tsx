import { useState } from "react";
import {
  LuArrowDownToLine,
  LuArrowUpFromLine,
  LuChevronLeft,
  LuCircleAlert,
  LuGitBranch,
  LuPlus,
  LuRotateCw,
  LuTrash2,
  LuUndo2,
} from "react-icons/lu";
import type { GitFileEntry, GitFileStatus } from "../../api";
import type { GitGroupId, GitView } from "../../git/useGitView";
import { ConfirmDialog } from "./ConfirmDialog";
import "./git.css";

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
      <span className="mc-git__groupcount">{count}</span>
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
 * 源码管理左栏：分支行 + 冲突/已暂存/未暂存三组。
 * 宽度由外层 `.mc-listcol` 控制，这里不写死宽度。
 */
export function GitNav({
  git,
  onOpenBranches,
  onClose,
}: {
  git: GitView;
  onOpenBranches: () => void;
  onClose: () => void;
}) {
  /** 丢弃 / 解决冲突都要确认：两者都会覆盖磁盘上的内容 */
  const [discardPaths, setDiscardPaths] = useState<string[] | null>(null);
  const [resolveTarget, setResolveTarget] = useState<{
    path: string;
    side: "ours" | "theirs" | "mark";
  } | null>(null);
  const status = git.status;
  const isRepo = status?.isRepo === true;
  const groups: Array<{ id: GitGroupId; label: string; entries: GitFileEntry[] }> = [
    { id: "conflicted", label: "冲突", entries: status?.conflicted ?? [] },
    { id: "staged", label: "已暂存", entries: status?.staged ?? [] },
    { id: "unstaged", label: "更改", entries: status?.unstaged ?? [] },
  ];
  const total = groups.reduce((sum, group) => sum + group.entries.length, 0);

  return (
    <nav className="mc-panel mc-panel--conversations mc-git__nav" aria-label="源代码管理">
      <h1 className="mc-settings__heading">源代码管理</h1>
      {isRepo ? (
        <button type="button" className="mc-git__branchrow" onClick={onOpenBranches} title="切换分支">
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
            ? "未检测到 git，请先安装并加入 PATH"
            : status?.reason === "not_a_repo"
              ? "当前工作区不是 Git 仓库"
              : "正在读取仓库状态…"}
        </p>
      )}

      {isRepo ? (
        <div className="mc-git__groups">
          {groups.map((group) => (
            <section key={group.id} className="mc-git__section" data-group={group.id}>
              <GroupHeader
                label={group.label}
                count={group.entries.length}
                {...(group.id === "staged" && group.entries.length
                  ? {
                      action: <LuUndo2 size={12} />,
                      actionTitle: "全部取消暂存",
                      onAction: () => void git.unstage(group.entries.map((entry) => entry.path)),
                    }
                  : group.id === "unstaged" && group.entries.length
                    ? {
                        action: <LuPlus size={12} />,
                        actionTitle: "全部暂存",
                        onAction: () => void git.stage(group.entries.map((entry) => entry.path)),
                      }
                    : {})}
              />
              {group.entries.length === 0 ? (
                <p className="mc-git__empty">暂无</p>
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
                              title="采用我方（ours）"
                              onClick={(event) => {
                                event.stopPropagation();
                                setResolveTarget({ path: entry.path, side: "ours" });
                              }}
                            >
                              我方
                            </button>
                            <button
                              type="button"
                              className="mc-git__rowbtn"
                              title="采用对方（theirs）"
                              onClick={(event) => {
                                event.stopPropagation();
                                setResolveTarget({ path: entry.path, side: "theirs" });
                              }}
                            >
                              对方
                            </button>
                            <button
                              type="button"
                              className="mc-git__rowbtn"
                              title="标记为已解决（内容已手工处理）"
                              onClick={(event) => {
                                event.stopPropagation();
                                setResolveTarget({ path: entry.path, side: "mark" });
                              }}
                            >
                              已解决
                            </button>
                          </>
                        ) : group.id === "staged" ? (
                          <button
                            type="button"
                            className="mc-git__rowbtn"
                            title="取消暂存"
                            aria-label="取消暂存"
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
                              title="暂存"
                              aria-label="暂存"
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
                              title="丢弃改动"
                              aria-label="丢弃改动"
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
        title="丢弃改动"
        message="这些文件的工作区改动会被永久丢弃（未暂存的修改会消失，untracked 文件会被删除）。"
        detail={(discardPaths ?? []).join("\n")}
        confirmLabel="丢弃"
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
            ? "标记为已解决"
            : resolveTarget?.side === "ours"
              ? "采用我方版本"
              : "采用对方版本"
        }
        message={
          resolveTarget?.side === "mark"
            ? "会把该冲突文件标记为已解决（内容保持当前磁盘上的样子）。"
            : "该文件会被直接替换为所选一侧的版本，另一侧的内容会丢失。"
        }
        detail={resolveTarget?.path}
        confirmLabel="确认"
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
              {total} 个变更 · {status?.name}
            </span>
            <div className="mc-git__footactions">
              <button
                type="button"
                className="mc-settings__back"
                title="刷新"
                onClick={() => void git.refresh()}
              >
                <LuRotateCw size={12} /> 刷新
              </button>
              <button
                type="button"
                className="mc-settings__back"
                title={status?.upstream ? "拉取（--ff-only）" : "当前分支没有上游"}
                disabled={!status?.upstream || git.busy !== null}
                onClick={() => void git.pull()}
              >
                <LuArrowDownToLine size={12} /> 拉取
              </button>
              <button
                type="button"
                className="mc-settings__back"
                title={status?.branch ? "推送" : "detached HEAD 无法推送"}
                disabled={!status?.branch || git.busy !== null}
                onClick={() => void git.push()}
              >
                <LuArrowUpFromLine size={12} /> 推送
              </button>
            </div>
          </>
        ) : null}
        <button type="button" className="mc-settings__back" onClick={onClose}>
          <LuChevronLeft size={13} /> 返回对话
        </button>
      </div>
    </nav>
  );
}

/** 分支行的小提示：无上游/ahead/behind 的解释（GitBody 头部复用）。 */
export function describeUpstream(status: { upstream?: string; ahead?: number; behind?: number } | null): string {
  if (!status?.upstream) return "没有上游分支";
  const parts = [status.upstream];
  if (status.ahead) parts.push(`领先 ${status.ahead}`);
  if (status.behind) parts.push(`落后 ${status.behind}`);
  return parts.join(" · ");
}

/** 仓库不可用时给用户的排错提示。 */
export function GitRepoHint({ reason }: { reason?: string }) {
  const text =
    reason === "git_unavailable"
      ? "未检测到 git：请安装 Git 并确认 `git --version` 在终端可用。"
      : reason === "not_a_repo"
        ? "当前工作区不是 Git 仓库。在终端执行 `git init` 后回到这里刷新。"
        : "无法读取仓库状态。";
  return (
    <div className="mc-git__placeholder">
      <LuCircleAlert size={16} />
      {text}
    </div>
  );
}
