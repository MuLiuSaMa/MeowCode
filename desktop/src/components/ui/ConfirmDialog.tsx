import { useTranslation } from "react-i18next";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  /** 说明文字；不传就只显示标题（清空类动作够用） */
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 危险动作用红色确认按钮 */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * 统一确认弹窗：所有"删了就回不来"的动作都走这里。
 *
 * 换掉的是原先那套「点一次变成确认文案、4 秒内再点一次」的二次确认 ——
 * 按钮从图标变成文字会改变宽度，列表右侧那一列小按钮的命中区跟着漂，
 * 第二次点击经常落空，看起来就像「点了没反应」。
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = true,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation("settings");
  return (
    <Dialog open={open} onClose={onCancel}>
      <h2 className="mc-dialog__title">{title}</h2>
      {message ? <p className="mc-dialog__desc">{message}</p> : null}
      <div className="mc-dialog__footer">
        <Button onClick={onCancel}>{cancelLabel ?? t("actions.cancel")}</Button>
        <Button variant={danger ? "danger" : "primary"} onClick={onConfirm}>
          {confirmLabel ?? t("actions.confirmDelete")}
        </Button>
      </div>
    </Dialog>
  );
}
