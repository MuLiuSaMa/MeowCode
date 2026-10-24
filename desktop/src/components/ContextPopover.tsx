import { useEffect, useRef, useState, type RefObject } from "react";
import { LuShrink, LuX } from "react-icons/lu";
import type { ContextUsage } from "../api";
import { formatTokenCount } from "./ContextMeter";
import "./ContextPopover.css";

/** 分类顺序 = 分段条与图例顺序，颜色在 CSS 里按 data-key 配 */
const CATEGORIES = [
  { key: "system", label: "系统提示词" },
  { key: "tools", label: "工具" },
  { key: "messages", label: "对话消息" },
] as const;

/** 百分比：一位小数，整数则省略 .0（28.5% / 50% / 0.3% / 0%） */
function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

/**
 * 上下文占用弹层：标题行 + 大百分比 + 分类分段条 + 图例 + 压缩入口。
 * 定位由 CSS 锚在 .mc-composer__ctxwrap（圆圈按钮）正上方居中——
 * 不量 rect、不监听 resize，窗口缩放 / 输入框长高都不会漂移。
 */
export function ContextPopover({
  usage,
  streaming,
  compacting,
  anchorRef,
  onCompact,
  onClose,
}: {
  usage: ContextUsage | null;
  /** 回合进行中不允许压缩 */
  streaming: boolean;
  /** 压缩进行中（compaction_started → completed） */
  compacting: boolean;
  anchorRef?: RefObject<HTMLElement | null>;
  onCompact: () => Promise<void>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target)) return;
      if (anchorRef?.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, anchorRef]);

  const contextWindow = usage?.contextWindow ?? null;
  const usedTokens = usage?.usedTokens ?? 0;
  const breakdown = usage?.breakdown ?? { system: 0, tools: 0, messages: 0 };
  const ratio = contextWindow ? Math.min(1, Math.max(0, usedTokens / contextWindow)) : 0;
  const level = contextWindow ? (ratio > 0.9 ? "high" : ratio > 0.7 ? "mid" : "") : "";
  /** 分段条基准：窗口与已用取大——超窗时整条铺满而不是溢出 */
  const barBase = Math.max(contextWindow ?? 0, usedTokens);
  const busy = compacting || pending;

  const handleCompact = async () => {
    setPending(true);
    try {
      await onCompact();
      onClose();
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mc-ctxpop" ref={ref} role="dialog" aria-label="上下文用量">
      <div className="mc-ctxpop__head">
        <span className="mc-ctxpop__title">上下文用量</span>
        <button type="button" className="mc-ctxpop__close" aria-label="关闭" onClick={onClose}>
          <LuX size={13} />
        </button>
      </div>

      <div className="mc-ctxpop__summary">
        <span className="mc-ctxpop__pct" data-level={level}>
          {contextWindow ? formatPercent(ratio * 100) : "—"}
        </span>
        <span className="mc-ctxpop__nums">
          已使用 <b>{formatTokenCount(usedTokens)}</b>
          {contextWindow ? ` / ${formatTokenCount(contextWindow)}` : " / 未设置窗口"}
        </span>
      </div>

      <div className="mc-ctxpop__bar" role="presentation">
        {CATEGORIES.map((category) => {
          const tokens = breakdown[category.key];
          if (barBase <= 0 || tokens <= 0) return null;
          return (
            <span
              key={category.key}
              className="mc-ctxpop__seg"
              data-key={category.key}
              style={{ width: `${Math.round((tokens / barBase) * 10000) / 100}%` }}
            />
          );
        })}
      </div>

      <ul className="mc-ctxpop__legend">
        {CATEGORIES.map((category) => {
          const tokens = breakdown[category.key];
          return (
            <li key={category.key} className="mc-ctxpop__row">
              <i className="mc-ctxpop__dot" data-key={category.key} aria-hidden />
              <span className="mc-ctxpop__label">{category.label}</span>
              <span className="mc-ctxpop__val">
                {contextWindow ? formatPercent((tokens / contextWindow) * 100) : formatTokenCount(tokens)}
              </span>
            </li>
          );
        })}
      </ul>

      <p className="mc-ctxpop__hint">
        压缩会把早期对话折叠成摘要，界面上的历史和会话文件都完整保留。
      </p>

      <button
        type="button"
        className="mc-ctxpop__compact"
        disabled={streaming || busy}
        onClick={() => void handleCompact()}
      >
        <LuShrink size={14} />
        {busy ? "正在压缩…" : "立即压缩上下文"}
      </button>
    </div>
  );
}
