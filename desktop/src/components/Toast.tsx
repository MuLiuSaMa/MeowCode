import { useEffect, useRef, useState } from "react";
import "./Toast.css";

/** 通知上的操作按钮（如「撤销回滚」） */
type ToastAction = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
};

/**
 * 全局弹窗：窗口顶部居中的一条提示。
 * 默认几秒后自动收起；传 action / dismissible 时给出操作按钮与关闭入口
 * （如「已回滚，可撤销」），并用 duration 延长停留时间。
 */
export function Toast({
  text,
  onDone,
  action,
  dismissible = false,
  closeLabel,
  duration = 2200,
}: {
  text: string;
  /** 收起后由父级移除（自动消失或用户点关闭后触发） */
  onDone: () => void;
  action?: ToastAction;
  /** 显示右侧关闭按钮 */
  dismissible?: boolean;
  closeLabel?: string;
  /** 自动收起前的停留时长（毫秒）；带操作按钮的通知给更长时间 */
  duration?: number;
}) {
  const [leaving, setLeaving] = useState(false);
  const leaveTimerRef = useRef<number | null>(null);

  // 停留一段时间后先播放收起动画，动画结束再从父级移除
  useEffect(() => {
    const hide = window.setTimeout(() => setLeaving(true), duration);
    const done = window.setTimeout(onDone, duration + 280);
    return () => {
      window.clearTimeout(hide);
      window.clearTimeout(done);
    };
  }, [onDone, duration]);

  useEffect(
    () => () => {
      if (leaveTimerRef.current !== null) window.clearTimeout(leaveTimerRef.current);
    },
    [],
  );

  const dismiss = () => {
    if (leaving) return;
    setLeaving(true);
    leaveTimerRef.current = window.setTimeout(onDone, 240);
  };

  const interactive = Boolean(action || dismissible);

  return (
    <div
      className={[
        "mc-toast",
        leaving ? "mc-toast--leaving" : "",
        interactive ? "mc-toast--interactive" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="status"
    >
      <span className="mc-toast__text">{text}</span>
      {action ? (
        <button
          type="button"
          className="mc-toast__action"
          disabled={action.disabled}
          onClick={action.onClick}
        >
          {action.label}
        </button>
      ) : null}
      {dismissible ? (
        <button
          type="button"
          className="mc-toast__close"
          aria-label={closeLabel}
          onClick={dismiss}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}