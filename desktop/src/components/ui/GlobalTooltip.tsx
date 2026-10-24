import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./GlobalTooltip.css";

/** 悬停多久后弹出（原生 tooltip 约 1s，这里稍快一点） */
const SHOW_DELAY = 380;
/** 气泡与元素、与窗口边缘的间距 */
const GAP = 10;
const MARGIN = 8;

type TipState = {
  text: string;
  /** 触发元素的位置（视口坐标）；元素不可见时回退到鼠标点 */
  rect: DOMRect | null;
  point: { x: number; y: number };
};

/**
 * 全局自绘 tooltip：接管应用里所有 `title` 属性（含 React 动态渲染出来的）。
 *
 * 做法：指针移入带 title 的元素时，把 title 暂存到 `data-mc-tip` 并**移除 title**，
 * 否则原生提示框会同时弹出来；MutationObserver 盯着后续被写回的 title 继续剥离。
 * 定位贴着元素：默认在下方居中，下方放不下就翻到上方，左右按视口夹紧。
 */
export function GlobalTooltip() {
  const [tip, setTip] = useState<TipState | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const hostRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    /** 把 title 搬到 data-mc-tip，返回可显示的文本 */
    const takeTitle = (el: HTMLElement): string | null => {
      const raw = el.getAttribute("title");
      if (raw && raw.trim()) {
        el.setAttribute("data-mc-tip", raw);
        el.removeAttribute("title");
      }
      const text = el.getAttribute("data-mc-tip");
      return text && text.trim() ? text : null;
    };

    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const hide = () => {
      clearTimer();
      hostRef.current = null;
      setTip(null);
      setPos(null);
    };

    const onPointerOver = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      const host = target?.closest?.("[title], [data-mc-tip]") as HTMLElement | null;
      if (!host || host === hostRef.current) return;
      const text = takeTitle(host);
      if (!text) return;
      clearTimer();
      hostRef.current = host;
      // 元素的视口矩形在弹出时再取一次（延迟期间可能滚动过）
      const point = { x: event.clientX, y: event.clientY };
      timerRef.current = window.setTimeout(() => {
        setPos(null);
        setTip({ text, rect: host.getBoundingClientRect(), point });
      }, SHOW_DELAY);
    };

    const onPointerOut = (event: PointerEvent) => {
      const host = (event.target as HTMLElement | null)?.closest?.("[data-mc-tip]");
      if (!host) return;
      const related = event.relatedTarget as Node | null;
      if (related && host.contains(related)) return;
      hide();
    };

    // React 每次重渲染都会把 title 写回 DOM，这里持续剥离，保证永远不弹原生提示
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type !== "attributes" || record.attributeName !== "title") continue;
        const el = record.target as HTMLElement;
        const raw = el.getAttribute("title");
        if (raw && raw.trim()) {
          el.setAttribute("data-mc-tip", raw);
          el.removeAttribute("title");
        }
      }
    });
    observer.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["title"],
    });

    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointerout", onPointerOut, true);
    // 滚动、拖拽、失焦时立刻收起，避免气泡悬在原地
    document.addEventListener("scroll", hide, true);
    document.addEventListener("pointerdown", hide, true);
    window.addEventListener("blur", hide);

    /**
     * 链接地址气泡：Chromium 在鼠标悬停 <a href> 时会在窗口左下角画出目标地址。
     * 这里在悬停期间把 href 暂存到 data-mc-href（按下鼠标前立刻恢复），
     * 所以只是不弹地址，点击、文字选择、图片拖拽都不受影响。
     */
    const stripped = new Set<HTMLAnchorElement>();
    const restore = (anchor: HTMLAnchorElement) => {
      const href = anchor.dataset.mcHref;
      if (href) anchor.setAttribute("href", href);
      delete anchor.dataset.mcHref;
      stripped.delete(anchor);
    };
    const restoreAll = () => {
      for (const anchor of [...stripped]) restore(anchor);
    };
    const onOverLink = (event: PointerEvent) => {
      if (event.buttons) return;
      const anchor = (event.target as HTMLElement | null)?.closest?.(
        "a[href]",
      ) as HTMLAnchorElement | null;
      if (!anchor || stripped.has(anchor)) return;
      const href = anchor.getAttribute("href");
      // 页内锚点不触发地址气泡，别动它
      if (!href || href.startsWith("#")) return;
      anchor.dataset.mcHref = href;
      anchor.removeAttribute("href");
      stripped.add(anchor);
    };
    const onOutLink = (event: PointerEvent) => {
      const anchor = (event.target as HTMLElement | null)?.closest?.(
        "a[data-mc-href]",
      ) as HTMLAnchorElement | null;
      if (anchor) restore(anchor);
    };
    document.addEventListener("pointerover", onOverLink, true);
    document.addEventListener("pointerout", onOutLink, true);
    document.addEventListener("pointerdown", restoreAll, true);
    document.addEventListener("mousedown", restoreAll, true);

    return () => {
      observer.disconnect();
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointerout", onPointerOut, true);
      document.removeEventListener("scroll", hide, true);
      document.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("blur", hide);
      document.removeEventListener("pointerover", onOverLink, true);
      document.removeEventListener("pointerout", onOutLink, true);
      document.removeEventListener("pointerdown", restoreAll, true);
      document.removeEventListener("mousedown", restoreAll, true);
      clearTimer();
    };
  }, []);

  /** 拿到气泡真实尺寸后再定位：下方居中 → 放不下翻上方 → 左右夹紧 */
  useLayoutEffect(() => {
    if (!tip) return;
    const el = tipRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    let left: number;
    let top: number;
    if (tip.rect && (tip.rect.width > 0 || tip.rect.height > 0)) {
      const rect = tip.rect;
      left = rect.left + rect.width / 2 - width / 2;
      top = rect.bottom + GAP;
      if (top + height > window.innerHeight - MARGIN) top = rect.top - GAP - height;
    } else {
      left = tip.point.x + 12;
      top = tip.point.y + 16;
    }
    left = Math.min(Math.max(MARGIN, left), Math.max(MARGIN, window.innerWidth - width - MARGIN));
    top = Math.min(Math.max(MARGIN, top), Math.max(MARGIN, window.innerHeight - height - MARGIN));
    setPos({ left, top });
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div
      ref={tipRef}
      className="mc-tip"
      data-ready={pos ? "true" : "false"}
      style={pos ? { left: pos.left, top: pos.top } : undefined}
      role="tooltip"
    >
      {tip.text}
    </div>,
    document.body,
  );
}
