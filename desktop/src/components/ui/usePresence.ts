import { useEffect, useRef, useState } from "react";

type Presence = {
  /** 元素是否还留在 DOM 里：退场动画播放期间仍为 true */
  mounted: boolean;
  /** 是否处于展开态；挂载后下一帧才置 true，让入场过渡从收起态开始 */
  open: boolean;
};

/**
 * 给条件渲染的浮层补上退场过渡：visible=false 后先播完 exitMs 再卸载，
 * 否则元素瞬间从 DOM 消失，CSS 过渡根本来不及跑。
 *
 * 入场同理：先以收起态挂载，下一帧再置 open——同一帧从收起态改到展开态
 * 浏览器会合并成一次样式计算，没有起点可插值，动画同样不会播。
 */
export function usePresence(visible: boolean, exitMs: number): Presence {
  const [mounted, setMounted] = useState(visible);
  const [open, setOpen] = useState(false);
  const frameRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (visible) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setMounted(true);
      if (frameRef.current === null && !open) {
        frameRef.current = window.requestAnimationFrame(() => {
          frameRef.current = null;
          setOpen(true);
        });
      }
      return;
    }
    setOpen(false);
    if (!mounted) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setMounted(false);
    }, exitMs);
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [visible, mounted, open, exitMs]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    },
    [],
  );

  return { mounted, open };
}
