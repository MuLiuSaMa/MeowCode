import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/Button";
import { Checkbox } from "./ui/Checkbox";
import { Dialog } from "./ui/Dialog";

/**
 * 关闭窗口确认（自绘，替代原生 MessageBox）。
 * closeAction=ask 时由主进程经 meow:close-request 唤起；
 * 选择经 meow:close-decision 回传主进程执行（托盘 / 退出 / 取消）。
 */
export function CloseConfirmDialog({
  open,
  onDecide,
}: {
  open: boolean;
  onDecide: (choice: "tray" | "quit" | "cancel", remember: boolean) => void;
}) {
  const [remember, setRemember] = useState(false);
  const { t } = useTranslation("shell");

  // 每次弹出都从「不记住」开始（与旧的系统对话框行为一致）
  useEffect(() => {
    if (open) setRemember(false);
  }, [open]);

  return (
    <Dialog open={open} onClose={() => onDecide("cancel", false)} labelledBy="mc-close-title">
      <span className="mc-dialog__title" id="mc-close-title">
        {t("closeDialog.title")}
      </span>
      <p className="mc-dialog__desc">{t("closeDialog.desc")}</p>

      <Checkbox
        className="mc-dialog__remember"
        checked={remember}
        onChange={setRemember}
        label={t("closeDialog.remember")}
      />

      <div className="mc-dialog__footer">
        <Button variant="ghost" onClick={() => onDecide("cancel", false)}>
          {t("closeDialog.cancel")}
        </Button>
        <Button variant="outline" onClick={() => onDecide("tray", remember)}>
          {t("closeDialog.tray")}
        </Button>
        <Button variant="primary" onClick={() => onDecide("quit", remember)}>
          {t("closeDialog.quit")}
        </Button>
      </div>
    </Dialog>
  );
}
