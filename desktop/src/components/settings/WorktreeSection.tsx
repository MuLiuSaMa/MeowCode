import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuFolderOpen } from "react-icons/lu";
import type { SessionSummary } from "../../api";
import { formatDateTime } from "../../i18n/format";
import { Button } from "../ui/Button";
import { CustomSelect } from "../ui/CustomSelect";
import { FieldRow, Section } from "../ui/Section";
import { IconButton } from "../ui/IconButton";
import { Toggle } from "../ui/Toggle";
import "./WorktreeSection.css";

const WORKTREE_KEEP_OPTIONS = [5, 10, 15, 20, 30] as const;

type WorktreeList = Awaited<ReturnType<typeof window.meow.worktreesList>>;

export function WorktreeSection({
  fetchUpstream,
  onFetchUpstreamChange,
  autoCleanup,
  onAutoCleanupChange,
  maxKeep,
  onMaxKeepChange,
  root,
  onRootChange,
  confirmDelete,
  onConfirmDeleteChange,
  sessions,
  onToast,
}: {
  fetchUpstream: boolean;
  onFetchUpstreamChange: (value: boolean) => void;
  autoCleanup: boolean;
  onAutoCleanupChange: (value: boolean) => void;
  maxKeep: number;
  onMaxKeepChange: (value: number) => void;
  /** 自定义根目录；空串 = 默认位置 */
  root: string;
  onRootChange: (value: string) => void;
  /** 手动删除托管工作树前是否二次确认 */
  confirmDelete: boolean;
  onConfirmDeleteChange: (value: boolean) => void;
  /** 会话列表：里面引用的工作树不允许手动删除 */
  sessions: SessionSummary[];
  onToast: (text: string) => void;
}) {
  const { t } = useTranslation("settings");
  /** 本地草稿：失焦/回车才落盘，避免每敲一个字符写一次设置 */
  const [rootInput, setRootInput] = useState(root);
  const [managed, setManaged] = useState<WorktreeList | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setRootInput(root);
  }, [root]);

  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    },
    [],
  );

  const refresh = useCallback(() => {
    setLoading(true);
    void window.meow
      .worktreesList()
      .then((result) => setManaged(result))
      .catch(() => setManaged(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const referenced = useMemo(
    () =>
      new Set(
        sessions
          .map((item) => item.worktree?.path)
          .filter((item): item is string => Boolean(item)),
      ),
    [sessions],
  );

  const items = useMemo(
    () => (managed ? [...managed.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : []),
    [managed],
  );

  const commitRoot = () => {
    const next = rootInput.trim();
    if (next !== root.trim()) onRootChange(next);
  };

  /** 先落盘再打开：输入框里刚改的路径也按新值开 */
  const openRootFolder = () => {
    commitRoot();
    const target = rootInput.trim() || managed?.defaultRoot || "";
    if (!target) return;
    void window.meow.openPath(target).then((error) => {
      if (error) onToast(error);
    });
  };

  const remove = (itemPath: string) => {
    if (deleting) return;
    if (confirmDelete && confirming !== itemPath) {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      setConfirming(itemPath);
      confirmTimer.current = setTimeout(() => setConfirming(null), 4000);
      return;
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirming(null);
    setDeleting(itemPath);
    void window.meow
      .worktreeDelete(itemPath, [...referenced])
      .then((error) => {
        if (error) onToast(error);
        refresh();
      })
      .catch((error) => onToast(error instanceof Error ? error.message : String(error)))
      .finally(() => setDeleting(null));
  };

  return (
    <div className="mc-settings__inner">
      <Section title={t("worktree.create.section")}>
        <FieldRow label={t("worktree.root.label")} hint={t("worktree.root.hint")}>
          <div className="mc-wtroot">
            <input
              className="mc-fieldrow__input"
              value={rootInput}
              placeholder={managed?.defaultRoot ?? ""}
              spellCheck={false}
              aria-label={t("worktree.root.label")}
              onChange={(event) => setRootInput(event.target.value)}
              onBlur={commitRoot}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                commitRoot();
                event.currentTarget.blur();
              }}
            />
            <IconButton
              size="sm"
              label={t("worktree.root.open")}
              onClick={openRootFolder}
            >
              <LuFolderOpen size={14} />
            </IconButton>
          </div>
        </FieldRow>
        <FieldRow label={t("worktree.fetch.label")} hint={t("worktree.fetch.hint")}>
          <Toggle
            checked={fetchUpstream}
            onChange={onFetchUpstreamChange}
            label={t("worktree.fetch.label")}
          />
        </FieldRow>
        <FieldRow label={t("worktree.cleanup.label")} hint={t("worktree.cleanup.hint")}>
          <Toggle
            checked={autoCleanup}
            onChange={onAutoCleanupChange}
            label={t("worktree.cleanup.label")}
          />
        </FieldRow>
        <FieldRow label={t("worktree.maxKeep.label")} hint={t("worktree.maxKeep.hint")}>
          <CustomSelect
            value={String(maxKeep)}
            options={WORKTREE_KEEP_OPTIONS.map((value) => ({
              value: String(value),
              label: String(value),
            }))}
            onChange={(value) => onMaxKeepChange(Number(value))}
            ariaLabel={t("worktree.maxKeep.label")}
            disabled={!autoCleanup}
          />
        </FieldRow>
        <FieldRow label={t("worktree.confirmDelete.label")}>
          <Toggle
            checked={confirmDelete}
            onChange={onConfirmDeleteChange}
            label={t("worktree.confirmDelete.label")}
          />
        </FieldRow>
      </Section>

      <Section
        title={t("worktree.managed.title")}
        action={
          <Button size="sm" onClick={refresh} disabled={loading}>
            {t("worktree.managed.refresh")}
          </Button>
        }
      >
        <div className="mc-wtlist">
          {items.length === 0 ? (
            <p className="mc-wtlist__empty">
              {loading ? t("worktree.managed.loading") : t("worktree.managed.empty")}
            </p>
          ) : (
            items.map((item) => {
              const inUse = referenced.has(item.path);
              return (
                <div className="mc-wtlist__row" key={item.path}>
                  <div className="mc-wtlist__text">
                    <span className="mc-wtlist__name mc-truncate" title={item.path}>
                      {item.name}
                    </span>
                    <span className="mc-wtlist__meta">
                      {formatDateTime(new Date(item.createdAt))}
                      {inUse ? ` · ${t("worktree.managed.inUse")}` : ""}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant={confirming === item.path ? "danger" : "ghost"}
                    disabled={inUse || deleting === item.path}
                    onClick={() => remove(item.path)}
                  >
                    {confirming === item.path
                      ? t("worktree.managed.confirm")
                      : t("worktree.managed.delete")}
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </Section>
    </div>
  );
}
