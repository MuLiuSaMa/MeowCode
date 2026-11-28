import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { TimelineMessage } from "../api";
import { BAND_COUNT, subscribeAudioLevel } from "../audio-level";
import { formatNumber } from "../i18n/format";
import { parseUserMessage } from "../user-references";
import "./MessageNavigator.css";

/** 浏览条预览文案：正文首行优先，命令 / 附件 / 引用 / 图片依次兜底 */
function previewOf(message: TimelineMessage, t: TFunction): string {
  const parsed = parseUserMessage(message.content);
  const bodyLine = parsed.body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (bodyLine) return bodyLine;
  if (parsed.command) return `/${parsed.command.command}`;
  if (parsed.attachments.length) return parsed.attachments[0].name;
  if (parsed.chips.length) return parsed.chips[0].name;
  if (message.images?.length) return t("messageNav.images", { count: message.images.length });
  return t("messageNav.noText");
}

/**
 * 对话浏览条：贴在消息流右缘的细刻度条，每格对应当前会话里的一条用户消息。
 * 悬停时展开成带序号和摘要的面板，点按平滑滚动到对应消息；
 * 少于两条用户消息时由父组件直接不渲染。
 */
export function MessageNavigator({
  scrollRef,
  messages,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  messages: TimelineMessage[];
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const { t } = useTranslation("shell");
  /** 律动电平直接写每根刻度的 CSS 变量，每帧一次，不经过 React 渲染 */
  const navRef = useRef<HTMLElement | null>(null);
  /** 当前刻度元素列表：消息增删时刷新，频段按刻度序均摊映射 */
  const ticksRef = useRef<HTMLElement[]>([]);
  const topsRef = useRef<number[]>([]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  /** 滚动高亮合帧：每个 scroll 事件都 O(n) 遍历会拖慢滚动 */
  const scrollRaf = useRef(0);
  /** 流式期间内容每 50ms 变一次，全量测量最多每 200ms 跑一轮 */
  const lastMeasureAt = useRef(0);

  const previews = useMemo(() => messages.map((message) => previewOf(message, t)), [messages, t]);

  /** 锚点（data-nl-key）在滚动内容里的纵向偏移；找不到锚点记 +∞ 排在最后 */
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const base = el.scrollTop - el.getBoundingClientRect().top;
    topsRef.current = messagesRef.current.map((message) => {
      const anchor = el.querySelector<HTMLElement>(
        `[data-nl-key="${CSS.escape(message.key)}"]`,
      );
      return anchor ? base + anchor.getBoundingClientRect().top : Number.POSITIVE_INFINITY;
    });
  }, [scrollRef]);

  /** 视口中线最后扫过的那条用户消息算「当前」；贴底时直接取最后一条 */
  const updateActive = useCallback(() => {
    const el = scrollRef.current;
    const tops = topsRef.current;
    if (!el || tops.length === 0) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
    let active = 0;
    const line = el.scrollTop + el.clientHeight * 0.5;
    for (let i = 0; i < tops.length; i++) {
      if (tops[i] <= line) active = i;
    }
    if (atBottom) active = tops.length - 1;
    if (!Number.isFinite(tops[active])) {
      active = Math.max(
        tops.findIndex((top) => Number.isFinite(top)),
        0,
      );
    }
    setActiveIndex((prev) => (prev === active ? prev : active));
  }, [scrollRef]);

  // 消息增删后重新测量（流式输出引起的高度变化走下面的 ResizeObserver）
  useLayoutEffect(() => {
    lastMeasureAt.current = performance.now();
    measure();
    updateActive();
  }, [messages, measure, updateActive]);

  // 滚动跟随高亮；内容高度变化（流式输出、窗口缩放）时重测
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (scrollRaf.current) return;
      scrollRaf.current = requestAnimationFrame(() => {
        scrollRaf.current = 0;
        updateActive();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const content = el.firstElementChild instanceof HTMLElement ? el.firstElementChild : el;
    let raf = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        // 流式输出只改变尾部高度，历史用户消息位置不变，位置缓存仍然有效；
        // 全量测量按 200ms 节流，避免每批增量都强制一轮布局。
        const now = performance.now();
        if (now - lastMeasureAt.current >= 200) {
          lastMeasureAt.current = now;
          measure();
        }
        updateActive();
      });
    });
    observer.observe(content);
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
      cancelAnimationFrame(raf);
      if (scrollRaf.current) cancelAnimationFrame(scrollRaf.current);
    };
  }, [scrollRef, measure, updateActive]);

  const jumpTo = useCallback(
    (key: string) => {
      const el = scrollRef.current;
      const anchor = el?.querySelector<HTMLElement>(`[data-nl-key="${CSS.escape(key)}"]`);
      if (!el || !anchor) return;
      // 只滚消息流自己：scrollIntoView 会连带滚动 overflow:hidden 的祖先（聊天面板会被带偏）
      const top = anchor.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      el.scrollTo({ top, behavior: "smooth" });
    },
    [scrollRef],
  );

  // 律动：把 24 个频段按刻度序均摊映射（刻度少时跨频段采样），逐帧写宽度变量
  useEffect(() => {
    ticksRef.current = navRef.current
      ? Array.from(navRef.current.querySelectorAll<HTMLElement>(".mc-nav__tick"))
      : [];
  }, [messages]);

  // 随声音律动：订阅共享采集的频段（设置里开着且有采集时才回调），
  // 每根刻度一根一根变长变短跳动；用户偏好减弱动效时整条保持原样
  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    return subscribeAudioLevel(
      (bands) => {
        const ticks = ticksRef.current;
        const count = ticks.length;
        for (let i = 0; i < count; i++) {
          const band =
            count === 1 ? BAND_COUNT >> 1 : Math.round((i * (BAND_COUNT - 1)) / (count - 1));
          ticks[i].style.setProperty("--tick-level", bands[band].toFixed(3));
        }
      },
      (active) => {
        if (active) {
          el.setAttribute("data-pulse", "true");
        } else {
          el.removeAttribute("data-pulse");
          for (const tick of ticksRef.current) tick.style.removeProperty("--tick-level");
        }
      },
    );
  }, []);

  return (
    <nav ref={navRef} className="mc-nav" aria-label={t("messageNav.aria")}>
      <div className="mc-nav__list">
        {messages.map((message, index) => (
          <button
            key={message.key}
            type="button"
            className="mc-nav__item"
            data-active={index === activeIndex}
            onClick={() => jumpTo(message.key)}
            title={t("messageNav.itemTitle", {
              index: formatNumber(index + 1),
              preview: previews[index],
            })}
          >
            <span className="mc-nav__meta">
              <span className="mc-nav__index" aria-hidden="true">
                {index + 1}
              </span>
              <span className="mc-nav__label">{previews[index]}</span>
            </span>
            <span className="mc-nav__tick" aria-hidden="true" />
          </button>
        ))}
      </div>
    </nav>
  );
}
