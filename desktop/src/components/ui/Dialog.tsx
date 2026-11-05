import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./Dialog.css";

export type DialogProps = {
  open: boolean;
  onClose: () => void;
  labelledBy?: string;
  children: ReactNode;
  className?: string;
};

/**
 * Minimal modal built on the native <dialog> element.
 * Gives us focus trapping, ESC handling, ::backdrop and background inertness
 * for free — no portal/focus-trap library required.
 */
export function Dialog({ open, onClose, labelledBy, children, className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  /** 按下起点是否在背板上：防止「面板内按下 → 拖出弹窗松开」被浏览器合成出 dialog 上的 click 而误关 */
  const pressOnBackdrop = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      try {
        el.showModal();
      } catch {
        /* already open */
      }
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  if (!open) return null;

  return createPortal(
    <dialog
      ref={ref}
      className={["mc-dialog", className ?? ""].filter(Boolean).join(" ")}
      aria-labelledby={labelledBy}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => {
        pressOnBackdrop.current = event.target === ref.current;
      }}
      onMouseUp={(event) => {
        if (event.target !== ref.current) pressOnBackdrop.current = false;
      }}
      onClick={(event) => {
        if (event.target === ref.current && pressOnBackdrop.current) {
          pressOnBackdrop.current = false;
          onClose();
        }
      }}
    >
      <div className="mc-dialog__panel">{children}</div>
    </dialog>,
    document.body,
  );
}
