import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuArrowUpRight, LuCheck, LuGitBranch, LuLoaderCircle, LuSearch } from "react-icons/lu";
import { gitBranches, gitSwitchBranch, type GitBranch } from "../api";
import "./BranchMenu.css";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** 工作区有未提交改动时 git 会拒绝切换：这类报错给一个「贮藏后切换」的出口 */
const looksDirty = (message: string) =>
  /local changes|would be overwritten|commit your changes|stash/i.test(message);

/**
 * 分支切换弹层（贴在分支胶囊上方）：搜索 + 本仓库分支列表（当前项打勾）+ 打开源码管理。
 * 列表每次打开拉一次；切换成功靠服务端广播的 git_changed 让外层刷新分支名。
 */
export function BranchMenu({
  onClose,
  onOpenGit,
}: {
  onClose: () => void;
  onOpenGit?: () => void;
}) {
  const { t } = useTranslation("composer");
  const [query, setQuery] = useState("");
  /** null = 还在读 */
  const [branches, setBranches] = useState<GitBranch[] | null>(null);
  /** 正在切换的分支名：切换期间整列禁用，避免连点 */
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ name: string; message: string } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target)) return;
      // 分支胶囊自己负责开关，别在这里重复关
      if ((event.target as HTMLElement).closest?.(".mc-composer__branch")) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await gitBranches();
        if (!cancelled) setBranches(result.branches);
      } catch (err) {
        if (cancelled) return;
        setBranches([]);
        setFailure({ name: "", message: errorText(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const switchTo = async (name: string, stash = false) => {
    if (busy) return;
    setBusy(name);
    setFailure(null);
    try {
      await gitSwitchBranch({ name, ...(stash ? { stash: true } : {}) });
      onClose();
    } catch (err) {
      setFailure({ name, message: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const needle = query.trim().toLowerCase();
  const filtered = useMemo(
    () => (branches ?? []).filter((branch) => !needle || branch.name.toLowerCase().includes(needle)),
    [branches, needle],
  );

  return (
    <div className="mc-branchmenu" ref={ref}>
      <label className="mc-branchmenu__search">
        <LuSearch size={13} />
        <input
          value={query}
          placeholder={t("branch.search")}
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          autoFocus
        />
      </label>
      <div className="mc-branchmenu__sep" />
      <div className="mc-branchmenu__list" role="listbox" aria-label={t("branch.listAria")}>
        {branches === null ? (
          <p className="mc-branchmenu__empty">{t("branch.loading")}</p>
        ) : filtered.length === 0 ? (
          <p className="mc-branchmenu__empty">
            {needle ? t("branch.noMatch") : t("branch.empty")}
          </p>
        ) : (
          filtered.map((branch) => (
            <button
              key={branch.name}
              type="button"
              role="option"
              aria-selected={branch.current}
              className="mc-branchmenu__item"
              data-current={branch.current ? "true" : "false"}
              data-busy={busy === branch.name ? "true" : "false"}
              aria-busy={busy === branch.name}
              disabled={busy !== null}
              title={[branch.name, branch.sha, branch.upstream].filter(Boolean).join(" · ")}
              onClick={() => {
                if (branch.current) {
                  onClose();
                  return;
                }
                void switchTo(branch.name);
              }}
            >
              {busy === branch.name ? (
                <LuLoaderCircle size={13} className="mc-branchmenu__spin" />
              ) : (
                <LuGitBranch size={13} />
              )}
              <span className="mc-branchmenu__name">{branch.name}</span>
              {branch.current ? <LuCheck size={13} className="mc-branchmenu__check" /> : null}
            </button>
          ))
        )}
      </div>

      {failure ? (
        <div className="mc-branchmenu__error" role="alert">
          <span className="mc-branchmenu__errtext">{failure.message}</span>
          {failure.name && looksDirty(failure.message) ? (
            <button
              type="button"
              className="mc-branchmenu__fix"
              disabled={busy !== null}
              onClick={() => void switchTo(failure.name, true)}
            >
              {t("branch.stashSwitch")}
            </button>
          ) : null}
        </div>
      ) : null}

      {onOpenGit ? (
        <>
          <div className="mc-branchmenu__sep" />
          <button
            type="button"
            className="mc-branchmenu__item"
            onClick={() => {
              onClose();
              onOpenGit();
            }}
          >
            <LuArrowUpRight size={13} />
            <span className="mc-branchmenu__name">{t("branch.openGit")}</span>
          </button>
        </>
      ) : null}
    </div>
  );
}
