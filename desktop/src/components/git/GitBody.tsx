import { useState } from "react";
import { LuChevronLeft, LuGitBranch, LuRotateCw } from "react-icons/lu";
import { SegmentedControl } from "../ui/SegmentedControl";
import type { GitView } from "../../git/useGitView";
import { CommitBox } from "./CommitBox";
import { ConfirmDialog } from "./ConfirmDialog";
import { DiffView } from "./DiffView";
import { GitRepoHint, describeUpstream } from "./GitNav";
import { HistoryList } from "./HistoryList";
import "./git.css";

type GitTab = "changes" | "history";

/** 提交详情：元信息 + 文件清单 + 整次提交的 patch。 */
function CommitDetail({ git, onBack }: { git: GitView; onBack: () => void }) {
  const detail = git.commitDetail;
  return (
    <div className="mc-git__detail">
      <div className="mc-git__detailhead">
        <button type="button" className="mc-git__backbtn" onClick={onBack} title="返回列表">
          <LuChevronLeft size={14} /> 返回
        </button>
        {detail ? (
          <>
            <h3 className="mc-git__detailsubject">{detail.commit.subject}</h3>
            <div className="mc-git__detailmeta">
              <code className="mc-mono">{detail.commit.short}</code>
              <span>{detail.commit.author}</span>
              <span>{new Date(detail.commit.time * 1000).toLocaleString()}</span>
              {detail.commit.parents.length > 1 ? <span>合并提交</span> : null}
            </div>
            {detail.commit.body ? <pre className="mc-git__detailbody">{detail.commit.body}</pre> : null}
            <div className="mc-git__detailfiles">
              {detail.files.map((file) => (
                <code key={`${file.path}:${file.origPath ?? ""}`} className="mc-git__detailfile">
                  {file.origPath ? `${file.origPath} → ${file.path}` : file.path}
                </code>
              ))}
            </div>
          </>
        ) : (
          <span className="mc-git__commitmeta">正在读取提交详情…</span>
        )}
      </div>
      <div className="mc-git__detaildiff">
        <DiffView
          loading={git.diffLoading && !detail}
          diff={
            detail
              ? {
                  patch: detail.patch,
                  binary: false,
                  truncated: detail.truncated,
                  added: 0,
                  removed: 0,
                }
              : null
          }
          emptyHint="这次提交没有可显示的改动"
        />
      </div>
    </div>
  );
}

/**
 * 源码管理主区：头部（变更/历史切换、分支、刷新）+ 提交框 + diff / 历史 / 提交详情。
 * 根节点自己撑满可用高度，diff 区内部滚动。
 */
export function GitBody({ git, onOpenBranches }: { git: GitView; onOpenBranches: () => void }) {
  const [tab, setTab] = useState<GitTab>("changes");
  /** 推送确认：normal = 普通推送；force1/force2 = 强制推送的两道确认 */
  const [pushAsk, setPushAsk] = useState<null | "normal" | "force1" | "force2">(null);

  const status = git.status;
  const isRepo = status?.isRepo === true;
  const detached = status?.detached === true;
  const canPush = isRepo && Boolean(status?.branch) && git.busy === null;
  const canPull = isRepo && Boolean(status?.upstream) && git.busy === null;

  return (
    <div className="mc-git__body">
      <header className="mc-git__head">
        <SegmentedControl<GitTab>
          value={tab}
          options={[
            { value: "changes", label: "变更" },
            { value: "history", label: "历史" },
          ]}
          onChange={(next) => {
            setTab(next);
            if (next === "changes") git.clearSelection();
          }}
          ariaLabel="源码管理视图"
        />
        {isRepo ? (
          <>
            <button
              type="button"
              className="mc-git__branchpill"
              onClick={onOpenBranches}
              title={describeUpstream(status)}
            >
              <LuGitBranch size={12} />
              {detached ? "detached HEAD" : status?.branch}
              {status?.ahead ? <span className="mc-git__aheadbehind">↑{status.ahead}</span> : null}
              {status?.behind ? <span className="mc-git__aheadbehind">↓{status.behind}</span> : null}
            </button>
            <span className="mc-git__headspacer" />
            <span className="mc-git__upstream">{describeUpstream(status)}</span>
            <button
              type="button"
              className="mc-git__iconbtn"
              title="推送"
              aria-label="推送"
              disabled={!canPush}
              onClick={() => setPushAsk("normal")}
            >
              推送
            </button>
            {status?.upstream ? (
              <button
                type="button"
                className="mc-git__iconbtn"
                data-danger="true"
                title="强制推送（--force-with-lease，需两次确认）"
                disabled={!canPush}
                onClick={() => setPushAsk("force1")}
              >
                强制推送
              </button>
            ) : null}
            <button
              type="button"
              className="mc-git__iconbtn"
              title="拉取（--ff-only）"
              disabled={!canPull}
              onClick={() => void git.pull()}
            >
              拉取
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="mc-git__iconbtn"
          title="刷新"
          aria-label="刷新"
          onClick={() => void git.refresh()}
        >
          <LuRotateCw size={13} />
        </button>
      </header>

      {git.error ? (
        <div className="mc-git__error" role="alert">
          <span>{git.error}</span>
          <button type="button" className="mc-git__errorx" onClick={git.clearError} aria-label="关闭">
            ×
          </button>
        </div>
      ) : null}

      {!isRepo ? (
        <div className="mc-git__fullplace">
          <GitRepoHint reason={status?.reason} />
          <p className="mc-git__placehint">
            工作区：<code className="mc-mono">{git.workspace ?? "未选择"}</code>
          </p>
        </div>
      ) : git.selection?.kind === "commit" ? (
        <CommitDetail git={git} onBack={git.clearSelection} />
      ) : tab === "history" ? (
        <div className="mc-git__historywrap">
          <HistoryList
            commits={git.commits}
            loading={git.logLoading}
            hasMore={git.hasMore}
            onSelect={git.selectCommit}
            onLoadMore={() => void git.loadMoreCommits()}
          />
        </div>
      ) : (
        <div className="mc-git__changes">
          <CommitBox git={git} />
          <div className="mc-git__diffwrap">
            <DiffView
              diff={git.diff}
              loading={git.diffLoading}
              emptyHint={
                git.selection?.kind === "file"
                  ? "正在准备 diff…"
                  : "在左侧选择文件查看改动（已暂存/未暂存分开显示）"
              }
            />
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pushAsk === "normal"}
        title="推送"
        message={
          status?.upstream
            ? `把 ${status.branch} 推送到 ${status.upstream}。`
            : `把 ${status?.branch ?? ""} 推送到 origin 并设置上游分支。`
        }
        confirmLabel="推送"
        busy={git.busy === "push"}
        onCancel={() => setPushAsk(null)}
        onConfirm={() => {
          setPushAsk(null);
          void git.push();
        }}
      />
      <ConfirmDialog
        open={pushAsk === "force1"}
        title="强制推送（1/2）"
        message="强制推送会用本地历史覆盖远端可能已有的提交（--force-with-lease 仅在远端未被他人更新时生效）。这通常不可逆。"
        confirmLabel="继续"
        danger
        onCancel={() => setPushAsk(null)}
        onConfirm={() => setPushAsk("force2")}
      />
      <ConfirmDialog
        open={pushAsk === "force2"}
        title="强制推送（2/2）"
        message={`确认用本地 ${status?.branch ?? ""} 覆盖远端 ${status?.upstream ?? "上游"}？`}
        confirmLabel="强制推送"
        danger
        busy={git.busy === "push"}
        onCancel={() => setPushAsk(null)}
        onConfirm={() => {
          setPushAsk(null);
          void git.push({ force: true });
        }}
      />
    </div>
  );
}
