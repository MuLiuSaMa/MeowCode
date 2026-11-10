import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuArrowUpRight, LuX } from "react-icons/lu";
import { RiMegaphoneFill } from "react-icons/ri";
import { Dialog } from "./ui/Dialog";
import "./AnnouncementBar.css";

export type Announcement = {
  id: string;
  title: string;
  content: string;
  date: string;
  url: string;
};

/**
 * 标题栏内联公告（水平居中、小字号）：铃铛图标 + 一行截断文字 + 关闭按钮。
 * 点击文字弹窗看完整内容；× 交给主进程按公告 id 落盘（dev / 打包版共享，换新 id 才再出现）。
 * 数据由主进程拉取（notice.cjs）并通过 IPC 推送；没有公告时整段不渲染。
 */
export function AnnouncementBar() {
  const { t } = useTranslation("shell");
  const [notice, setNotice] = useState<Announcement | null>(null);
  const [open, setOpen] = useState(false);
  /** 按下起点与是否已进入窗口拖动：拖动抬手后的 click 不弹窗 */
  const dragRef = useRef<{ x: number; y: number; dragging: boolean } | null>(null);

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    dragRef.current = { x: event.clientX, y: event.clientY, dragging: false };
    // 捕获指针：拖到窗口外松手也能收到 pointerup，否则主进程会一直以为还在拖
    // （窗口就跟着光标跑，直到 60s 兜底）。这里不用系统移动循环，捕获不会打架。
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 捕获失败不影响拖动
    }
  };

  // 监听挂在 window 上：鼠标移出公告区域也能收到位移（不用指针捕获，避免抢系统的移动循环）
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.dragging) return;
      if (Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) > 4) {
        drag.dragging = true;
        void window.meow?.startWindowDrag?.();
      }
    };
    const onUp = () => {
      const drag = dragRef.current;
      if (!drag?.dragging) return;
      void window.meow?.endWindowDrag?.();
      // 刻意不清 dragRef：紧跟着的 click 要靠它判断「这是拖动，别弹窗」
    };
    /** 不会再有 click 的收尾路径（取消/失焦/隐藏）：结束拖动并复位 */
    const abort = () => {
      if (dragRef.current?.dragging) void window.meow?.endWindowDrag?.();
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", abort);
    // 拖到窗口外松手、或切走窗口时，pointerup 可能永远不到：失焦/隐藏兜底结束
    window.addEventListener("blur", abort);
    document.addEventListener("visibilitychange", abort);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", abort);
      window.removeEventListener("blur", abort);
      document.removeEventListener("visibilitychange", abort);
    };
  }, []);

  useEffect(() => {
    let live = true;
    void window.meow
      ?.getAnnouncement?.()
      .then((value) => {
        if (live) setNotice((value as Announcement | null) ?? null);
      })
      .catch(() => {});
    const off = window.meow?.onAnnouncement?.((value) => {
      setNotice((value as Announcement | null) ?? null);
      if (!value) setOpen(false);
    });
    return () => {
      live = false;
      off?.();
    };
  }, []);

  const dismiss = () => {
    if (notice) void window.meow?.dismissAnnouncement?.(notice.id);
    setNotice(null);
    setOpen(false);
  };

  if (!notice) return null;
  const oneLine = `${notice.title ? `${notice.title} · ` : ""}${notice.content}`.replace(/\s+/g, " ");

  return (
    <>
      <div className="mc-annbar">
        <button
          type="button"
          className="mc-annbar__main"
          title={oneLine}
          aria-label={t("announcement.label")}
          onPointerDown={onPointerDown}
          onClick={() => {
            const dragged = dragRef.current?.dragging;
            dragRef.current = null;
            if (!dragged) setOpen(true);
          }}
        >
          <RiMegaphoneFill size={12} className="mc-annbar__icon" aria-hidden="true" />
          <span className="mc-annbar__text">{oneLine}</span>
        </button>
        <button
          type="button"
          className="mc-annbar__close"
          aria-label={t("announcement.close")}
          title={t("announcement.close")}
          onClick={dismiss}
        >
          <LuX size={12} />
        </button>
      </div>
      <Dialog open={open} onClose={() => setOpen(false)} labelledBy="mc-annbar-title">
        <div className="mc-ann">
          <div className="mc-ann__head">
            <span className="mc-ann__badge" aria-hidden="true">
              <RiMegaphoneFill size={15} />
            </span>
            <div className="mc-ann__heading">
              <h2 id="mc-annbar-title" className="mc-ann__title">
                {notice.title || t("announcement.label")}
              </h2>
              {notice.date ? <span className="mc-ann__date">{notice.date}</span> : null}
            </div>
            <button
              type="button"
              className="mc-ann__close"
              aria-label={t("announcement.close")}
              title={t("announcement.close")}
              onClick={() => setOpen(false)}
            >
              <LuX size={15} />
            </button>
          </div>
          <p className="mc-ann__body">{notice.content}</p>
          {notice.url ? (
            <div className="mc-ann__foot">
              <button
                type="button"
                className="mc-ann__ok"
                onClick={() => {
                  void window.meow?.openExternal?.(notice.url);
                  setOpen(false);
                }}
              >
                {t("announcement.viewSite")}
                <LuArrowUpRight size={13} aria-hidden="true" />
              </button>
            </div>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}
