import type { GitStatus, SessionChangeSummary } from "../api";

function normalizePath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

/**
 * 胶囊里的「本对话已修改文件」只保留仍未提交的路径：
 * git status 里不存在的文件 = 已提交/已清理，从统计和列表里消失。
 * staged 仍算未提交（还没 commit）；status 列表被截断时无法可靠判断，宁可全部显示。
 */
export function filterUncommittedSessionChanges(
  changes: SessionChangeSummary[],
  status: GitStatus | null,
  workspace: string | null,
): SessionChangeSummary[] {
  if (!status?.isRepo || !workspace) return changes;
  const truncated =
    (status.stagedCount ?? status.staged.length) > status.staged.length ||
    (status.unstagedCount ?? status.unstaged.length) > status.unstaged.length ||
    (status.conflictedCount ?? status.conflicted.length) > status.conflicted.length;
  if (truncated) return changes;

  // Windows 大小写不敏感；仓库根到会话 cwd 的相对前缀用于工作区是仓库子目录的情况
  const root = normalizePath(status.root ?? workspace).toLowerCase();
  const cwd = normalizePath(workspace).toLowerCase();
  const prefix = cwd.startsWith(root) ? cwd.slice(root.length).replace(/^\/+/, "") : "";
  const dirty = new Set(
    [...status.staged, ...status.unstaged, ...status.conflicted].map((entry) =>
      normalizePath(entry.path).toLowerCase(),
    ),
  );

  return changes.filter((change) => {
    const relative = normalizePath(change.path).toLowerCase();
    const fromRoot = prefix ? `${prefix}/${relative}` : relative;
    return dirty.has(fromRoot) || dirty.has(relative);
  });
}
