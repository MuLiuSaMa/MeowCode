import { useTranslation } from "react-i18next";
import { LuGitCommitHorizontal } from "react-icons/lu";
import type { GitCommit } from "../../api";
import { formatRelative } from "../../i18n/format";
import "./git.css";

/** 提交历史列表：点一行在右侧/上方看详情；底部「加载更多」分页。 */
export function HistoryList({
  commits,
  loading,
  hasMore,
  activeSha,
  onSelect,
  onLoadMore,
}: {
  commits: GitCommit[];
  loading: boolean;
  hasMore: boolean;
  activeSha?: string;
  onSelect: (sha: string) => void;
  onLoadMore: () => void;
}) {
  const { t } = useTranslation("git");
  if (!commits.length) {
    return (
      <div className="mc-git__placeholder">
        <LuGitCommitHorizontal size={16} />
        {loading ? t("history.loading") : t("history.empty")}
      </div>
    );
  }
  return (
    <div className="mc-git__history">
      {commits.map((commit) => (
        <button
          key={commit.sha}
          type="button"
          className="mc-git__commitrow"
          data-active={commit.sha === activeSha}
          title={commit.subject}
          onClick={() => onSelect(commit.sha)}
        >
          <span className="mc-git__commitsubject">{commit.subject}</span>
          <span className="mc-git__commitmeta">
            <code className="mc-mono">{commit.short}</code>
            <span>{commit.author}</span>
            {/* git log 的 time 是 unix 秒，formatRelative 收毫秒 */}
            <span>{formatRelative(commit.time * 1000)}</span>
          </span>
        </button>
      ))}
      {hasMore ? (
        <button
          type="button"
          className="mc-git__loadmore"
          disabled={loading}
          onClick={onLoadMore}
        >
          {loading ? t("history.loadingMore") : t("history.loadMore")}
        </button>
      ) : null}
    </div>
  );
}
