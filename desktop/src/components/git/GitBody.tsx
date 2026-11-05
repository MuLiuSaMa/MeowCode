import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuChevronLeft, LuGitBranch, LuRotateCw } from "react-icons/lu";
import { SegmentedControl } from "../ui/SegmentedControl";
import type { GitView } from "../../git/useGitView";
import { formatDateTime } from "../../i18n/format";
import { CommitBox } from "./CommitBox";
import { ConfirmDialog } from "./ConfirmDialog";
import { DiffView } from "./DiffView";
import { GitRepoHint, describeUpstream } from "./GitNav";
import { HistoryList } from "./HistoryList";
import "./git.css";

type GitTab = "changes" | "history";

/** 提交详情：元信息 + 文件清单 + 整次提交的 patch。 */
function CommitDetail({ git, onBack }: { git: GitView; onBack: () => void }) {
  const { t } = useTranslation("git");
  const detail = git.commitDetail;
  return (
    <div className="mc-git__detail">
      <div className="mc-git__detailhead">
        <button type="button" className="mc-git__backbtn" onClick={onBack} title={t("detail.backTitle")}>
          <LuChevronLeft size={14} /> {t("action.back")}
        </button>
        {detail ? (
          <>
            <h3 className="mc-git__detailsubject">{detail.commit.subject}</h3>
            <div className="mc-git__detailmeta">
              <code className="mc-mono">{detail.commit.short}</code>
              <span>{detail.commit.author}</span>
              <span>{formatDateTime(detail.commit.time * 1000)}</span>
              {detail.commit.parents.length > 1 ? <span>{t("detail.mergeCommit")}</span> : null}
            </div>
            {detail.commit.body ? <pre className="mc-git__detailbody">{detail.commit.body}</pre> : null}
            <div className="mc-git__detailfiles">
              {detail.files.map((file) => (
                <code key={`${file.path}:${file.origPath ?? ""}`} className="mc-git__detailfile">
                  {file.origPath ? `${file.origPath} → ${file.path}` : file.path}
                </code>
              ))}
              {detail.fileCount > detail.files.length ? (
                <code className="mc-git__detailfile" data-more="true">
                  {t("detail.moreFiles", { count: detail.fileCount - detail.files.length })}
                </code>
              ) : null}
            </div>
          </>
        ) : (
          <span className="mc-git__commitmeta">{t("detail.loading")}</span>
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
          emptyHint={t("diff.emptyCommit")}
        />
      </div>
    </div>
  );
}

/**
 * Git 管理主区：头部（变更/历史切换、分支、刷新）+ 提交框 + diff / 历史 / 提交详情。
 * 根节点自己撑满可用高度，diff 区内部滚动。
 */
export function GitBody({ git, onOpenBranches }: { git: GitView; onOpenBranches: () => void }) {
  const { t } = useTranslation("git");
  const [tab, setTab] = useState<GitTab>("changes");
  /** 推送确认：normal = 普通推送；force1/force2 = 强制推送的两道确认 */
  const [pushAsk, setPushAsk] = useState<null | "normal" | "force1" | "force2">(null);

  const status = git.status;
  const isRepo = status?.isRepo === true;
  const detached = status?.detached === true;
  const canPush = isRepo && Boolean(status?.branch) && git.busy === null;
  const canPull = isRepo && Boolean(status?.upstream) && git.busy === null;
  /** 标签在组件内查表，切语言才会跟着刷新 */
  const tabs = useMemo<Array<{ value: GitTab; label: string }>>(
    () => [
      { value: "changes", label: t("tab.changes") },
      { value: "history", label: t("tab.history") },
    ],
    [t],
  );

  return (
    <div className="mc-git__body">
      <header className="mc-git__head">
        <SegmentedControl<GitTab>
          value={tab}
          options={tabs}
          onChange={(next) => {
            setTab(next);
            if (next === "changes") git.clearSelection();
          }}
          ariaLabel={t("nav.viewAria")}
        />
        {isRepo ? (
          <>
            <button
              type="button"
              className="mc-git__branchpill"
              onClick={onOpenBranches}
              title={describeUpstream(status, t)}
            >
              <LuGitBranch size={12} />
              {detached ? "detached HEAD" : status?.branch}
              {status?.ahead ? <span className="mc-git__aheadbehind">↑{status.ahead}</span> : null}
              {status?.behind ? <span className="mc-git__aheadbehind">↓{status.behind}</span> : null}
            </button>
            <span className="mc-git__headspacer" />
            <span className="mc-git__upstream">{describeUpstream(status, t)}</span>
            <button
              type="button"
              className="mc-git__iconbtn"
              title={t("action.push")}
              aria-label={t("action.push")}
              disabled={!canPush}
              onClick={() => setPushAsk("normal")}
            >
              {t("action.push")}
            </button>
            {status?.upstream ? (
              <button
                type="button"
                className="mc-git__iconbtn"
                data-danger="true"
                title={t("push.forceTitle")}
                disabled={!canPush}
                onClick={() => setPushAsk("force1")}
              >
                {t("action.forcePush")}
              </button>
            ) : null}
            <button
              type="button"
              className="mc-git__iconbtn"
              title={t("pull.title")}
              disabled={!canPull}
              onClick={() => void git.pull()}
            >
              {t("action.pull")}
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="mc-git__iconbtn"
          title={t("action.refresh")}
          aria-label={t("action.refresh")}
          onClick={() => void git.refresh()}
        >
          <LuRotateCw size={13} />
        </button>
      </header>

      {git.error ? (
        <div className="mc-git__error" role="alert">
          <span>{git.error}</span>
          <button type="button" className="mc-git__errorx" onClick={git.clearError} aria-label={t("error.close")}>
            ×
          </button>
        </div>
      ) : null}

      {!isRepo ? (
        <div className="mc-git__fullplace">
          <GitRepoHint reason={status?.reason} />
          <p className="mc-git__placehint">
            {t("workspace.label")} <code className="mc-mono">{git.workspace ?? t("workspace.none")}</code>
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
                  ? t("diff.preparing")
                  : t("diff.selectFileHint")
              }
            />
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pushAsk === "normal"}
        title={t("action.push")}
        message={
          status?.upstream
            ? t("push.message", { branch: status.branch, upstream: status.upstream })
            : t("push.messageNew", { branch: status?.branch ?? "" })
        }
        confirmLabel={t("action.push")}
        busy={git.busy === "push"}
        onCancel={() => setPushAsk(null)}
        onConfirm={() => {
          setPushAsk(null);
          void git.push();
        }}
      />
      <ConfirmDialog
        open={pushAsk === "force1"}
        title={t("push.forceStep1")}
        message={t("push.forceWarning")}
        confirmLabel={t("push.continue")}
        danger
        onCancel={() => setPushAsk(null)}
        onConfirm={() => setPushAsk("force2")}
      />
      <ConfirmDialog
        open={pushAsk === "force2"}
        title={t("push.forceStep2")}
        message={t("push.forceConfirm", {
          branch: status?.branch ?? "",
          upstream: status?.upstream ?? t("upstream.short"),
        })}
        confirmLabel={t("action.forcePush")}
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
