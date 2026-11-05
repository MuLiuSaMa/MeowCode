import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { ContextUsage } from "../api";
import { formatNumber } from "../i18n/format";
import "./ContextMeter.css";

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** 12345 → "12.3k"；用于悬浮提示与弹层明细。数字分组交给当前语种。 */
export function formatTokenCount(value: number): string {
  if (value >= 1000) {
    const k = value / 1000;
    return `${formatNumber(k, { maximumFractionDigits: k >= 100 ? 0 : 1 })}k`;
  }
  return formatNumber(value);
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
  const { t } = useTranslation("shell");
  const ratio = usage?.contextWindow
    ? Math.min(1, Math.max(0, usage.usedTokens / usage.contextWindow))
    : 0;
  const level = ratio > 0.9 ? "danger" : ratio > 0.7 ? "warn" : "idle";
  const title = usage?.contextWindow
    ? t("contextMeter.usage", {
        used: formatTokenCount(usage.usedTokens),
        window: formatTokenCount(usage.contextWindow),
        percent: formatNumber(Math.round(ratio * 100)),
      })
    : t("contextMeter.noWindow");

  return (
    <button
      ref={buttonRef}
      type="button"
      className="mc-ctxmeter"
      data-level={level}
      title={title}
      aria-label={t("contextMeter.aria")}
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
