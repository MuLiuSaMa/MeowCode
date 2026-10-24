import { useEffect, useState } from "react";
import { Button } from "./ui/Button";
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

  // 每次弹出都从「不记住」开始（与旧的系统对话框行为一致）
  useEffect(() => {
    if (open) setRemember(false);
  }, [open]);

  return (
    <Dialog open={open} onClose={() => onDecide("cancel", false)} labelledBy="mc-close-title">
      <span className="mc-dialog__title" id="mc-close-title">
        关闭窗口时，希望 MeowCode 如何表现？
      </span>
      <p className="mc-dialog__desc">MeowCode 会继续在后台运行，你可以从系统托盘重新打开。</p>

      <label className="mc-dialog__remember">
        <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
        记住我的选择（可在 设置 → 通用 中修改）
      </label>

      <div className="mc-dialog__footer">
        <Button variant="ghost" onClick={() => onDecide("cancel", false)}>
          取消
        </Button>
        <Button variant="outline" onClick={() => onDecide("tray", remember)}>
          缩小到托盘
        </Button>
        <Button variant="primary" onClick={() => onDecide("quit", remember)}>
          直接关闭
        </Button>
      </div>
    </Dialog>
  );
}
