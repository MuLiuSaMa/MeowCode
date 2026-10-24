import { LuGitCommitHorizontal } from "react-icons/lu";
import type { GitCommit } from "../../api";
import "./git.css";

function relativeTime(seconds: number): string {
  if (!seconds) return "";
  const diff = Date.now() / 1000 - seconds;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 30 * 86_400) return `${Math.floor(diff / 86_400)} 天前`;
  return new Date(seconds * 1000).toLocaleDateString();
}

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
  if (!commits.length) {
    return (
      <div className="mc-git__placeholder">
        <LuGitCommitHorizontal size={16} />
        {loading ? "正在读取提交历史…" : "还没有提交"}
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
            <span>{relativeTime(commit.time)}</span>
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
          {loading ? "加载中…" : "加载更多"}
        </button>
      ) : null}
    </div>
  );
}
