import { useState } from "react";
import { LuArchive, LuArchiveRestore, LuTrash2 } from "react-icons/lu";
import { useTranslation } from "react-i18next";
import type { SessionSummary } from "../../api";
import { formatDateTime } from "../../i18n/format";
import { baseName } from "../../util";
import { FieldRow, Section } from "../ui/Section";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";

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
 * （走 /sessions/delete，和聊天列表里的删除同一条链路）—— 所以删除走确认弹窗。
 *
 * 注意：归档列表里可能有「旧数据目录」的路径（换过 userData 之后），那些文件
 * 早就不在了；删除时由上层把这类条目直接从列表里摘掉，不让它永远卡在这。
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
  const [pending, setPending] = useState<{ filePath: string; name: string } | "all" | null>(null);

  const archived = archivedSessions.map((filePath) => {
    const session = sessions.find((item) => item.filePath === filePath);
    return {
      filePath,
      title: session?.title ?? null,
      cwd: session?.cwd ?? filePath,
      createdAt: session?.createdAt ?? "",
    };
  });

  const pendingItem = pending && pending !== "all" ? pending : null;

  return (
    <div className="mc-settings__inner">
      <Section
        title={t("archive.section")}
        description={t("archive.desc")}
        action={
          archived.length ? (
            <Button
              size="sm"
              variant="outline"
              icon={<LuTrash2 size={13} />}
              onClick={() => setPending("all")}
            >
              {t("archive.deleteAll")}
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
              const name =
                item.title ||
                t("archive.item", {
                  when: formatWhen(item.createdAt) || t("archive.unknownTime"),
                });
              return (
                <FieldRow
                  key={item.filePath}
                  label={name}
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
                    variant="ghost"
                    size="sm"
                    aria-label={t("archive.deleteAria", { name })}
                    onClick={() => setPending({ filePath: item.filePath, name })}
                  >
                    <LuTrash2 size={13} />
                  </Button>
                </FieldRow>
              );
            })
          )}
        </div>
      </Section>

      <ConfirmDialog
        open={pending !== null}
        title={pending === "all" ? t("confirm.clearTitle") : t("confirm.deleteTitle")}
        message={
          pending === "all"
            ? t("confirm.clearMessage")
            : t("confirm.deleteMessage", { name: pendingItem?.name ?? "" })
        }
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const target = pending;
          setPending(null);
          if (target === "all") onDeleteAll();
          else if (target) onDelete(target.filePath);
        }}
      />
    </div>
  );
}
