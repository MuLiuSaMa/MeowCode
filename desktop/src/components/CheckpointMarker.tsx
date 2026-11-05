import { useTranslation } from "react-i18next";
import { LuHistory } from "react-icons/lu";
import type { TimelineCheckpoint } from "../api";
import { formatClock } from "../i18n/format";
import "./CheckpointMarker.css";

/**
 * 会话检查点分隔线：作为时间线条目显示在检查点位置，后续对话排在它下面。
 * 手动检查点走这里；自动检查点（每个用户回合一条）挂在自己的 user 气泡上，
 * 不画分隔线。「恢复」支持三种模式：对话与代码 / 仅对话 / 仅代码（预览后执行）。
 */
export function CheckpointMarker({
  item,
  onRestore,
  onRewind,
}: {
  item: TimelineCheckpoint;
  /** 仅回滚对话（旧行为：截断分支出新会话，不碰文件） */
  onRestore?: (checkpointId: string) => void;
  /** 预览式回滚：mode 决定对话与代码的取舍，先出预览对话框再执行 */
  onRewind?: (checkpointId: string, mode: "both" | "code") => void;
}) {
  const { t } = useTranslation("chat");
  const time = new Date(item.timestamp);
  const timeText = Number.isNaN(time.getTime()) ? "" : formatClock(time);
  const files = item.fileChanges.length;
  const canRewindCode = item.hasSnapshot !== false;
  return (
    <div className="mc-checkpoint" role="group" title={item.label ?? undefined}>
      <span className="mc-checkpoint__rule" aria-hidden="true" />
      <LuHistory size={13} className="mc-checkpoint__icon" aria-hidden="true" />
      <span className="mc-checkpoint__text">
        {item.label || (item.auto ? t("checkpoint.auto") : t("checkpoint.manual"))}
        {files > 0 ? ` · ${t("checkpoint.fileChanges", { count: files })}` : ""}
        {timeText ? ` · ${timeText}` : ""}
      </span>
      {canRewindCode && onRewind ? (
        <button
          type="button"
          className="mc-checkpoint__restore"
          onClick={() => onRewind(item.id, "both")}
        >
          {t("checkpoint.rewindBoth")}
        </button>
      ) : null}
      {canRewindCode && onRewind ? (
        <button
          type="button"
          className="mc-checkpoint__restore mc-checkpoint__restore--secondary"
          onClick={() => onRewind(item.id, "code")}
        >
          {t("checkpoint.rewindCode")}
        </button>
      ) : null}
      {onRestore ? (
        <button
          type="button"
          className="mc-checkpoint__restore mc-checkpoint__restore--secondary"
          title={canRewindCode ? undefined : t("checkpoint.noSnapshot")}
          onClick={() => onRestore(item.id)}
        >
          {t("checkpoint.rewindConversation")}
        </button>
      ) : null}
      <span className="mc-checkpoint__rule" aria-hidden="true" />
    </div>
  );
}
