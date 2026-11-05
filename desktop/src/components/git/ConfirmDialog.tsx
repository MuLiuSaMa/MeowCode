import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

/** 通用危险操作确认（丢弃 / 强制切换 / 强制推送）。 */
export function ConfirmDialog({
  open,
  title,
  message,
  detail,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  /** 追加的次要说明（如文件清单） */
  detail?: string;
  /** 缺省时用「确认」，调用方通常按动作给更具体的词 */
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("git");
  return (
    <Dialog open={open} onClose={onCancel} className="mc-gitdlg">
      <h2 className="mc-gitdlg__title">{title}</h2>
      <p className="mc-gitdlg__text">{message}</p>
      {detail ? <pre className="mc-gitdlg__detail">{detail}</pre> : null}
      <div className="mc-gitdlg__actions">
        <Button onClick={onCancel} disabled={busy}>
          {t("dialog.cancel")}
        </Button>
        <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} disabled={busy}>
          {busy ? t("dialog.processing") : (confirmLabel ?? t("dialog.confirm"))}
        </Button>
      </div>
    </Dialog>
  );
}
