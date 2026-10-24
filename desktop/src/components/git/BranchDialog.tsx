import { useEffect, useState } from "react";
import { LuCheck, LuGitBranch } from "react-icons/lu";
import { Dialog } from "../ui/Dialog";
import type { GitView } from "../../git/useGitView";
import "./git.css";

/**
 * 分支对话框：搜索已有分支 + 切换（可选丢弃本地改动 / 贮藏）+ 新建。
 * 列表在打开时拉取一次（分支变动不频繁，切换成功后会由 useGitView 重新拉）。
 */
export function BranchDialog({
  open,
  git,
  onClose,
}: {
  open: boolean;
  git: GitView;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState("");
  const [force, setForce] = useState(false);
  const [stash, setStash] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setNewName("");
    setForce(false);
    setStash(false);
    void git.loadBranches();
    // 只在打开时拉一次：git 对象每次渲染都是新的，不能进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? git.branches.filter((branch) => branch.name.toLowerCase().includes(needle))
    : git.branches;
  const busy = git.busy !== null;

  const create = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    await git.createBranch(name);
    setNewName("");
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} className="mc-gitdlg mc-gitdlg--branch">
      <h2 className="mc-gitdlg__title">切换分支</h2>
      <label className="mc-gitdlg__search">
        <input
          value={query}
          placeholder="搜索分支"
          onChange={(event) => setQuery(event.target.value)}
          autoFocus
        />
      </label>
      <div className="mc-gitdlg__branchlist" role="listbox" aria-label="分支列表">
        {git.branchesLoading && !git.branches.length ? (
          <p className="mc-gitdlg__empty">正在读取分支…</p>
        ) : filtered.length === 0 ? (
          <p className="mc-gitdlg__empty">没有匹配的分支</p>
        ) : (
          filtered.map((branch) => (
            <button
              key={branch.name}
              type="button"
              role="option"
              aria-selected={branch.current}
              className="mc-gitdlg__branchrow"
              data-current={branch.current}
              disabled={busy}
              onClick={() => {
                if (branch.current) {
                  onClose();
                  return;
                }
                void git.switchBranch({
                  name: branch.name,
                  force,
                  stash,
                });
                onClose();
              }}
            >
              <LuGitBranch size={13} />
              <span className="mc-gitdlg__branchname">{branch.name}</span>
              {branch.upstream ? (
                <span className="mc-gitdlg__upstream">{branch.upstream}</span>
              ) : null}
              <code className="mc-mono mc-gitdlg__sha">{branch.sha}</code>
              {branch.current ? <LuCheck size={13} /> : null}
            </button>
          ))
        )}
      </div>

      <div className="mc-gitdlg__options">
        <label className="mc-gitdlg__check">
          <input type="checkbox" checked={stash} onChange={(event) => setStash(event.target.checked)} />
          切换前贮藏本地改动
        </label>
        <label className="mc-gitdlg__check" data-danger={force ? "true" : undefined}>
          <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} />
          强制切换（丢弃未提交的改动）
        </label>
      </div>

      <div className="mc-gitdlg__newbranch">
        <input
          value={newName}
          placeholder="基于当前 HEAD 新建分支，如 feature/login"
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void create();
          }}
        />
        <button type="button" className="mc-git__commitbtn" disabled={!newName.trim() || busy} onClick={() => void create()}>
          新建并切换
        </button>
      </div>

      <div className="mc-gitdlg__actions">
        <button type="button" className="mc-gitdlg__cancel" onClick={onClose}>
          关闭
        </button>
      </div>
    </Dialog>
  );
}
