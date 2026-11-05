import { useEffect, useRef, useState } from "react";
import { LuArchive, LuArchiveRestore, LuTrash2 } from "react-icons/lu";
import { useTranslation } from "react-i18next";
import type { SessionSummary } from "../../api";
import { formatDateTime } from "../../i18n/format";
import { baseName } from "../../util";
import { FieldRow, Section } from "../ui/Section";
import { Button } from "../ui/Button";

function formatWhen(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return formatDateTime(date);
}

/**
 * 归档分区：列出已归档的会话。
 *
 * 归档本身只是 settings.json 里的路径列表，但这里的删除是**真的删文件**
 * （走 /sessions/delete，和聊天列表里的删除同一条链路）—— 所以两个动作都做二次确认，
 * 4 秒不点就复位，避免误触把会话记录抹掉。
 */
export function ArchiveSection({
  sessions,
  archivedSessions,
  onUnarchive,
  onDelete,
  onDeleteAll,
}: {
  sessions: SessionSummary[];
  archivedSessions: string[];
  onUnarchive: (filePath: string) => void;
  onDelete: (filePath: string) => void;
  onDeleteAll: () => void;
}) {
  const { t } = useTranslation("settings");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const arm = (key: string, apply: () => void) => {
    if (timer.current) clearTimeout(timer.current);
    // 同一个目标再点一次 = 确认；点别处则把确认移到新目标上
    const already = key === "__all__" ? confirmingAll : confirming === key;
    if (already) {
      setConfirming(null);
      setConfirmingAll(false);
      apply();
      return;
    }
    setConfirming(key === "__all__" ? null : key);
    setConfirmingAll(key === "__all__");
    timer.current = setTimeout(() => {
      setConfirming(null);
      setConfirmingAll(false);
    }, 4000);
  };

  const archived = archivedSessions.map((filePath) => {
    const session = sessions.find((item) => item.filePath === filePath);
    return {
      filePath,
      title: session?.title ?? null,
      cwd: session?.cwd ?? filePath,
      createdAt: session?.createdAt ?? "",
    };
  });

  return (
    <div className="mc-settings__inner">
      <Section
        title={t("archive.section")}
        description={t("archive.desc")}
        action={
          archived.length ? (
            <Button
              size="sm"
              variant={confirmingAll ? "danger" : "outline"}
              icon={<LuTrash2 size={13} />}
              onClick={() => arm("__all__", onDeleteAll)}
            >
              {confirmingAll ? t("archive.confirmDeleteAll") : t("archive.deleteAll")}
            </Button>
          ) : undefined
        }
      >
        <div className="mc-archivelist">
          {archived.length === 0 ? (
            <p className="mc-archivelist__empty">
              <LuArchive size={16} />
              {t("archive.empty")}
            </p>
          ) : (
            archived.map((item) => {
              const isConfirming = confirming === item.filePath;
              return (
                <FieldRow
                  key={item.filePath}
                  label={
                    item.title ||
                    t("archive.item", {
                      when: formatWhen(item.createdAt) || t("archive.unknownTime"),
                    })
                  }
                  hint={item.cwd === item.filePath ? item.filePath : baseName(item.cwd)}
                >
                  <Button
                    variant="outline"
                    size="sm"
                    icon={<LuArchiveRestore size={13} />}
                    onClick={() => onUnarchive(item.filePath)}
                  >
                    {t("actions.restore")}
                  </Button>
                  <Button
                    variant={isConfirming ? "danger" : "ghost"}
                    size="sm"
                    aria-label={
                      isConfirming
                        ? t("archive.confirmDeleteAria", { name: item.title ?? item.filePath })
                        : t("archive.deleteAria", { name: item.title ?? item.filePath })
                    }
                    onClick={() => arm(item.filePath, () => onDelete(item.filePath))}
                  >
                    {isConfirming ? t("archive.confirmDelete") : <LuTrash2 size={13} />}
                  </Button>
                </FieldRow>
              );
            })
          )}
        </div>
      </Section>
    </div>
  );
}
