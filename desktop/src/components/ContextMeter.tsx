import type { RefObject } from "react";
import type { ContextUsage } from "../api";
import "./ContextMeter.css";

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** 12345 → "12.3k"；用于悬浮提示与弹层明细。 */
export function formatTokenCount(value: number): string {
  if (value >= 1000) {
    const k = value / 1000;
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  }
  return String(value);
}

/**
 * 输入框底栏的上下文占用圆圈：环形进度按 usedTokens / contextWindow 绘制，
 * ≤70% 常规灰、>70% 强调色、>90% 危险色；未设置窗口时是空心灰圈。
 */
export function ContextMeter({
  usage,
  buttonRef,
  onClick,
}: {
  usage: ContextUsage | null;
  buttonRef?: RefObject<HTMLButtonElement | null>;
  onClick?: () => void;
}) {
  const ratio = usage?.contextWindow
    ? Math.min(1, Math.max(0, usage.usedTokens / usage.contextWindow))
    : 0;
  const level = ratio > 0.9 ? "danger" : ratio > 0.7 ? "warn" : "idle";
  const title = usage?.contextWindow
    ? `上下文 ${formatTokenCount(usage.usedTokens)} / ${formatTokenCount(usage.contextWindow)}（${Math.round(ratio * 100)}%）`
    : "未设置上下文窗口";

  return (
    <button
      ref={buttonRef}
      type="button"
      className="mc-ctxmeter"
      data-level={level}
      title={title}
      aria-label="上下文占用"
      onClick={onClick}
    >
      <svg viewBox="0 0 18 18" width={16} height={16} aria-hidden>
        <circle className="mc-ctxmeter__track" cx="9" cy="9" r={RADIUS} />
        <circle
          className="mc-ctxmeter__fill"
          cx="9"
          cy="9"
          r={RADIUS}
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - ratio)}
          transform="rotate(-90 9 9)"
        />
      </svg>
    </button>
  );
}
