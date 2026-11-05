import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { TimelineMessage } from "../api";
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
  const topsRef = useRef<number[]>([]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

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
    measure();
    updateActive();
  }, [messages, measure, updateActive]);

  // 滚动跟随高亮；内容高度变化（流式输出、窗口缩放）时重测
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => updateActive();
    el.addEventListener("scroll", onScroll, { passive: true });
    const content = el.firstElementChild instanceof HTMLElement ? el.firstElementChild : el;
    let raf = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        measure();
        updateActive();
      });
    });
    observer.observe(content);
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
      cancelAnimationFrame(raf);
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

  return (
    <nav className="mc-nav" aria-label={t("messageNav.aria")}>
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
