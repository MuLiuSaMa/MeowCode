import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuCheck, LuGitBranch, LuLoaderCircle } from "react-icons/lu";
import { Checkbox } from "../ui/Checkbox";
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
  const { t } = useTranslation("git");
  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState("");
  const [force, setForce] = useState(false);
  const [stash, setStash] = useState(false);
  /** 正在切换的分支名：切完再关对话框，期间那一行显示转圈 */
  const [pending, setPending] = useState<string | null>(null);

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

  const switchTo = async (name: string) => {
    if (busy || pending) return;
    setPending(name);
    try {
      await git.switchBranch({ name, force, stash });
    } finally {
      setPending(null);
      onClose();
    }
  };

  const create = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    await git.createBranch(name);
    setNewName("");
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} className="mc-gitdlg mc-gitdlg--branch">
      <h2 className="mc-gitdlg__title">{t("branch.switch")}</h2>
      <label className="mc-gitdlg__search">
        <input
          value={query}
          placeholder={t("branch.search")}
          onChange={(event) => setQuery(event.target.value)}
          autoFocus
        />
      </label>
      <div className="mc-gitdlg__branchlist" role="listbox" aria-label={t("branch.listAria")}>
        {git.branchesLoading && !git.branches.length ? (
          <p className="mc-gitdlg__empty">{t("branch.loading")}</p>
        ) : filtered.length === 0 ? (
          <p className="mc-gitdlg__empty">{t("branch.noMatch")}</p>
        ) : (
          filtered.map((branch) => (
            <button
              key={branch.name}
              type="button"
              role="option"
              aria-selected={branch.current}
              className="mc-gitdlg__branchrow"
              data-current={branch.current}
              data-busy={pending === branch.name ? "true" : "false"}
              aria-busy={pending === branch.name}
              disabled={busy || pending !== null}
              onClick={() => {
                if (branch.current) {
                  onClose();
                  return;
                }
                void switchTo(branch.name);
              }}
            >
              {pending === branch.name ? (
                <LuLoaderCircle size={13} className="mc-gitdlg__spin" />
              ) : (
                <LuGitBranch size={13} />
              )}
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
        <Checkbox
          className="mc-gitdlg__check"
          checked={stash}
          onChange={setStash}
          label={t("branch.stash")}
        />
        <Checkbox
          className="mc-gitdlg__check"
          checked={force}
          onChange={setForce}
          label={t("branch.force")}
          danger={force}
        />
      </div>

      <div className="mc-gitdlg__newbranch">
        <input
          value={newName}
          placeholder={t("branch.newPlaceholder")}
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void create();
          }}
        />
        <button type="button" className="mc-git__commitbtn" disabled={!newName.trim() || busy} onClick={() => void create()}>
          {t("branch.create")}
        </button>
      </div>

      <div className="mc-gitdlg__actions">
        <button type="button" className="mc-gitdlg__cancel" onClick={onClose}>
          {t("branch.close")}
        </button>
      </div>
    </Dialog>
  );
}
