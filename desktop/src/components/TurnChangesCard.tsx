import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LuChevronDown, LuFilePen } from "react-icons/lu";
import type { TimelineTurnChanges } from "../api";
import "./TurnChangesCard.css";

/** 默认收起时展示的文件数（对齐 Claude Code 的三行） */
const COLLAPSED_ROWS = 3;

/**
 * 回合结束时插在对话末尾的编辑汇总卡片：本轮改了哪些文件、各增删多少行。
 * 「撤销」回滚到本回合起始检查点（仅代码，对话保留）；「审阅」打开右侧审阅页签。
 * 没有文件改动的回合不会产生这张卡片。
 */
export function TurnChangesCard({
  item,
  onUndo,
  onReview,
}: {
  item: TimelineTurnChanges;
  /** 撤销本轮文件改动（预览对话框确认后执行） */
  onUndo?: (checkpointId: string, mode: "code") => void;
  /** 打开右侧「审阅」页签 */
  onReview?: () => void;
}) {
  const { t } = useTranslation("chat");
  const [expanded, setExpanded] = useState(false);
  const files = item.files;
  if (!files.length) return null;

  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  const visible = expanded ? files : files.slice(0, COLLAPSED_ROWS);
  const hiddenCount = files.length - visible.length;
  // 快照被关掉 / 旧会话没打点：回滚代码不可用，按钮置灰而不是藏起来（保留可发现性）
  const canUndo = Boolean(item.checkpointId) && item.canRewind !== false;

  return (
    <section
      className="mc-turnchanges"
      aria-label={t("turnChanges.title", { count: files.length })}
    >
      <header className="mc-turnchanges__head">
        <span className="mc-turnchanges__icon" aria-hidden="true">
          <LuFilePen size={16} />
        </span>
        <div className="mc-turnchanges__heading">
          <span className="mc-turnchanges__title">
            {t("turnChanges.title", { count: files.length })}
          </span>
          <span className="mc-turnchanges__stats">
            {added > 0 ? <span className="mc-turnchanges__add">+{added}</span> : null}
            {removed > 0 ? <span className="mc-turnchanges__del">-{removed}</span> : null}
          </span>
        </div>
        <div className="mc-turnchanges__actions">
          <button
            type="button"
            className="mc-turnchanges__action"
            disabled={!canUndo}
            title={canUndo ? t("turnChanges.undoHint") : t("turnChanges.undoUnavailable")}
            onClick={() => {
              if (canUndo && item.checkpointId) onUndo?.(item.checkpointId, "code");
            }}
          >
            {t("turnChanges.undo")}
          </button>
          <button
            type="button"
            className="mc-turnchanges__action mc-turnchanges__action--solid"
            onClick={() => onReview?.()}
          >
            {t("turnChanges.review")}
          </button>
        </div>
      </header>

      <ul className="mc-turnchanges__list">
        {visible.map((file) => (
          <li className="mc-turnchanges__row" key={file.path}>
            <span className="mc-turnchanges__path" title={file.path}>
              {file.path}
            </span>
            <span className="mc-turnchanges__delta">
              {file.added > 0 ? (
                <span className="mc-turnchanges__add">+{file.added}</span>
              ) : null}
              {file.removed > 0 ? (
                <span className="mc-turnchanges__del">-{file.removed}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>

      {files.length > COLLAPSED_ROWS ? (
        <button
          type="button"
          className="mc-turnchanges__more"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <LuChevronDown size={13} className="mc-turnchanges__chevron" data-open={expanded} />
          {expanded
            ? t("turnChanges.collapse")
            : t("turnChanges.showMore", { count: hiddenCount })}
        </button>
      ) : null}
    </section>
  );
}
