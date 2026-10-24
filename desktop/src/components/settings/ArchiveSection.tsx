import { LuArchive, LuArchiveRestore } from "react-icons/lu";
import type { SessionSummary } from "../../api";
import { baseName } from "../../util";
import { FieldRow, Section } from "../ui/Section";
import { Button } from "../ui/Button";

function formatWhen(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || !value) return "";
  return date.toLocaleString();
}

/**
 * 归档分区：列出已归档的会话，可恢复回聊天列表。
 * 会话文件本身不动 —— 归档只是 settings.json 里的路径列表。
 */
export function ArchiveSection({
  sessions,
  archivedSessions,
  onUnarchive,
}: {
  sessions: SessionSummary[];
  archivedSessions: string[];
  onUnarchive: (filePath: string) => void;
}) {
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
        title="归档"
        description="归档的会话不出现在聊天列表里，随时可以恢复。在聊天列表里把鼠标悬停到某条会话上，点右侧的归档图标即可归档。"
      >
        <div className="mc-archivelist">
          {archived.length === 0 ? (
            <p className="mc-archivelist__empty">
              <LuArchive size={16} />
              暂无归档会话
            </p>
          ) : (
            archived.map((item) => (
              <FieldRow
                key={item.filePath}
                label={item.title || `会话 · ${formatWhen(item.createdAt) || "未知时间"}`}
                hint={item.cwd === item.filePath ? item.filePath : baseName(item.cwd)}
              >
                <Button variant="outline" size="sm" icon={<LuArchiveRestore size={13} />} onClick={() => onUnarchive(item.filePath)}>
                  恢复
                </Button>
              </FieldRow>
            ))
          )}
        </div>
      </Section>
    </div>
  );
}
