import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionSummary } from "../../api";
import { formatDateTime } from "../../i18n/format";
import { formatBytes } from "../mail/mail-meta";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { FieldRow } from "../ui/Section";
import "./StorageSection.css";

type StorageUsage = Awaited<ReturnType<typeof window.meow.storageUsage>>;

const CATEGORY_COLORS: Record<keyof StorageUsage["categories"], string> = {
  chats: "var(--accent)",
  subagents: "var(--accent-violet)",
  archived: "var(--warning)",
  worktrees: "var(--success)",
  other: "var(--fg-subtlest)",
};

const CATEGORY_ORDER: Array<keyof StorageUsage["categories"]> = [
  "chats",
  "subagents",
  "archived",
  "worktrees",
  "other",
];

/**
 * 存储分区：本机占用总览 + 清理旧聊天 / 管理工作树 / 归档管理入口。
 * 占用由主进程按目录归类统计；归档只是设置里的路径列表，文件仍在 sessions 下。
 */
export function StorageSection({
  sessions,
  archivedSessions,
  onDeleteSessions,
  onOpenSection,
}: {
  sessions: SessionSummary[];
  archivedSessions: string[];
  onDeleteSessions: (filePaths: string[]) => Promise<string[]>;
  onOpenSection: (section: "worktree" | "archive") => void;
}) {
  const { t } = useTranslation("settings");
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [cleanOpen, setCleanOpen] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback((force = false) => {
    setLoading(true);
    void window.meow
      .storageUsage(force)
      .then((result) => setUsage(result))
      .catch(() => setUsage(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    },
    [],
  );

  /** 旧聊天：有消息、未归档，按创建时间从旧到新 */
  const cleanSessions = useMemo(() => {
    const archived = new Set(archivedSessions);
    return sessions
      .filter((item) => item.messageCount > 0 && !archived.has(item.filePath))
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [sessions, archivedSessions]);

  const total = usage?.total ?? 0;

  const armDelete = (filePath: string) => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    if (confirming === filePath) {
      setConfirming(null);
      void onDeleteSessions([filePath]).then((deleted) => {
        if (deleted.length) refresh(true);
      });
      return;
    }
    setConfirming(filePath);
    confirmTimer.current = setTimeout(() => setConfirming(null), 4000);
  };

  const closeClean = () => {
    setConfirming(null);
    setCleanOpen(false);
  };

  return (
    <div className="mc-settings__inner">
      <section className="mc-storage">
        <header className="mc-storage__head">
          <h2 className="mc-section__title">{t("storage.device")}</h2>
          <p className="mc-section__desc">{t("storage.deviceDesc")}</p>
        </header>

        <div className="mc-storage__sumrow">
          <span className="mc-storage__total">
            {t("storage.used", { size: usage ? formatBytes(total) : "…" })}
          </span>
          <Button size="sm" disabled={loading} onClick={() => refresh(true)}>
            {t("storage.refresh")}
          </Button>
        </div>

        <div className="mc-storage__bar" role="img" aria-label={t("storage.barAria")}>
          {usage
            ? CATEGORY_ORDER.map((key) =>
                usage.categories[key] > 0 ? (
                  <span
                    key={key}
                    className="mc-storage__seg"
                    style={{ flexGrow: usage.categories[key], background: CATEGORY_COLORS[key] }}
                  />
                ) : null,
              )
            : null}
        </div>

        <ul className="mc-storage__legend">
          {CATEGORY_ORDER.map((key) => (
            <li key={key} className="mc-storage__legenditem">
              <span className="mc-storage__legendlabel">
                <span className="mc-storage__dot" style={{ background: CATEGORY_COLORS[key] }} />
                {t(`storage.categories.${key}`)}
              </span>
              <span className="mc-storage__value">
                {usage ? formatBytes(usage.categories[key]) : "…"}
              </span>
            </li>
          ))}
        </ul>

        <p className="mc-storage__path" title={usage?.path}>
          {usage?.path ?? ""}
        </p>
      </section>

      <div className="mc-storage__card">
        <FieldRow label={t("storage.clean.title")} hint={t("storage.clean.hint")}>
          <Button
            size="sm"
            onClick={() => {
              setConfirming(null);
              setCleanOpen(true);
            }}
          >
            {t("storage.clean.action")}
          </Button>
        </FieldRow>
      </div>

      <div className="mc-storage__card">
        <FieldRow label={t("storage.worktrees.title")} hint={t("storage.worktrees.hint")}>
          <Button size="sm" onClick={() => onOpenSection("worktree")}>
            {t("storage.worktrees.action")}
          </Button>
        </FieldRow>
        <FieldRow label={t("storage.archived.title")} hint={t("storage.archived.hint")}>
          <Button size="sm" onClick={() => onOpenSection("archive")}>
            {t("storage.archived.action")}
          </Button>
        </FieldRow>
      </div>

      <Dialog open={cleanOpen} onClose={closeClean} labelledBy="mc-storage-clean-title">
        <span className="mc-dialog__title" id="mc-storage-clean-title">
          {t("storage.clean.dialogTitle")}
        </span>
        <p className="mc-dialog__desc">{t("storage.clean.dialogDesc")}</p>
        <div className="mc-storage__cleanlist">
          {cleanSessions.length === 0 ? (
            <p className="mc-storage__empty">{t("storage.clean.empty")}</p>
          ) : (
            cleanSessions.map((item) => (
              <div className="mc-storage__cleanrow" key={item.filePath}>
                <div className="mc-storage__cleantext">
                  <span className="mc-storage__cleantitle mc-truncate">
                    {item.title || t("storage.clean.untitled")}
                  </span>
                  <span className="mc-storage__cleandate">
                    {formatDateTime(new Date(item.createdAt))}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant={confirming === item.filePath ? "danger" : "ghost"}
                  onClick={() => armDelete(item.filePath)}
                >
                  {confirming === item.filePath
                    ? t("storage.clean.confirm")
                    : t("storage.clean.delete")}
                </Button>
              </div>
            ))
          )}
        </div>
        <div className="mc-dialog__footer">
          <Button onClick={closeClean}>{t("storage.clean.close")}</Button>
        </div>
      </Dialog>
    </div>
  );
}
