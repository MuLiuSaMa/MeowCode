import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LuTriangleAlert } from "react-icons/lu";
import type { RewindFileAction, RewindPlan } from "../api";
import { Checkbox } from "./ui/Checkbox";
import "./RewindDialog.css";

/**
 * 回滚预览对话框：文件按卡片展示（文件名 + 增删行数），
 * 冲突文件需要显式勾选覆盖；确认后由 App 重新预览并执行。
 */
export function RewindDialog({
  plan,
  busy,
  onConfirm,
  onCancel,
}: {
  plan: RewindPlan;
  /** 执行中：禁用按钮防双击 */
  busy?: boolean;
  onConfirm: (options: { force: boolean; keepNewFiles: boolean }) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("chat");
  const [keepNewFiles, setKeepNewFiles] = useState(false);
  const [force, setForce] = useState(false);

  const restores = plan.files.filter((file) => file.action === "restore");
  const deletes = plan.files.filter((file) => file.action === "delete");
  const conflicts = plan.files.filter((file) => file.conflict);
  const others = plan.files.filter((file) => file.action === "unchanged");
  const conversationOnly = plan.mode === "conversation";
  const confirmDisabled = busy || (plan.requiresForce && !force);

  return (
    <div className="mc-rewind__backdrop" role="dialog" aria-modal="true">
      <div className="mc-rewind">
        <header className="mc-rewind__header">
          <h2 className="mc-rewind__title">
            {t("checkpoint.rewindDialogTitle", {
              label:
                plan.checkpoint.label ||
                new Date(plan.checkpoint.timestamp).toLocaleString(),
            })}
          </h2>
        </header>

        {!conversationOnly ? (
          <div className="mc-rewind__groups">
            {restores.length > 0 ? (
              <FileCardGroup
                title={t("checkpoint.groupRestore", { count: restores.length })}
                files={restores}
              />
            ) : null}
            {deletes.length > 0 ? (
              <div className="mc-rewind__group">
                <FileCardGroup
                  title={t("checkpoint.groupDelete", { count: deletes.length })}
                  files={deletes}
                />
                <Checkbox
                  className="mc-rewind__check"
                  checked={keepNewFiles}
                  onChange={setKeepNewFiles}
                  label={t("checkpoint.keepNewFiles")}
                />
              </div>
            ) : null}
            {conflicts.length > 0 ? (
              <div className="mc-rewind__group mc-rewind__group--conflict">
                <FileCardGroup
                  title={t("checkpoint.groupConflict", { count: conflicts.length })}
                  files={conflicts}
                />
                <Checkbox
                  className="mc-rewind__check"
                  checked={force}
                  onChange={setForce}
                  label={t("checkpoint.overwriteExternal")}
                  danger={force}
                />
              </div>
            ) : null}
            {others.length > 0 ? (
              <FileCardGroup
                title={t("checkpoint.groupUnchanged", { count: others.length })}
                files={others}
              />
            ) : null}
          </div>
        ) : (
          <p className="mc-rewind__note">{t("checkpoint.conversationOnlyNote")}</p>
        )}

        {plan.warnings.length > 0 ? (
          <div className="mc-rewind__warnings">
            {plan.warnings.map((warning) => (
              <p key={warning} className="mc-rewind__warning">
                <LuTriangleAlert size={13} aria-hidden="true" /> {warning}
              </p>
            ))}
          </div>
        ) : null}

        <footer className="mc-rewind__footer">
          <button type="button" className="mc-rewind__button" onClick={onCancel}>
            {t("checkpoint.cancel")}
          </button>
          <button
            type="button"
            className="mc-rewind__button mc-rewind__button--primary"
            disabled={confirmDisabled}
            onClick={() => onConfirm({ force, keepNewFiles })}
          >
            {t("checkpoint.confirmRewind")}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** 文件卡片组：每张卡片 = 文件名 + 增删行数（+绿 / -红），删除/跳过/无变化给状态徽标。 */
function FileCardGroup({ title, files }: { title: string; files: RewindFileAction[] }) {
  const { t } = useTranslation("chat");
  return (
    <div className="mc-rewind__group">
      <h3 className="mc-rewind__grouptitle">{title}</h3>
      <div className="mc-rewind__cards">
        {files.slice(0, 50).map((file) => (
          <div key={file.path} className="mc-rewind__card">
            <span className="mc-rewind__filepath" title={file.path}>
              {file.path}
            </span>
            <span className="mc-rewind__stats">
              {file.action === "restore" && file.added ? (
                <span className="mc-rewind__stat mc-rewind__stat--add">+{file.added}</span>
              ) : null}
              {file.action === "restore" && file.removed ? (
                <span className="mc-rewind__stat mc-rewind__stat--del">-{file.removed}</span>
              ) : null}
              {file.action === "delete" ? (
                <span className="mc-rewind__stat mc-rewind__stat--del">
                  {t("checkpoint.cardDeleted")}
                </span>
              ) : null}
              {file.action === "unchanged" && file.skipped === "too_large" ? (
                <span className="mc-rewind__stat mc-rewind__stat--muted">
                  {t("checkpoint.skippedTooLarge")}
                </span>
              ) : null}
              {file.action === "unchanged" && !file.skipped ? (
                <span className="mc-rewind__stat mc-rewind__stat--muted">
                  {t("checkpoint.cardUnchanged")}
                </span>
              ) : null}
            </span>
          </div>
        ))}
        {files.length > 50 ? (
          <div className="mc-rewind__card">
            <span className="mc-rewind__filepath">…</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
