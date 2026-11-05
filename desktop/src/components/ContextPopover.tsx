import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { LuShrink, LuX } from "react-icons/lu";
import type { CacheDiagnostics, ContextUsage } from "../api";
import { formatTokenCount } from "./ContextMeter";
import "./ContextPopover.css";

/** 服务端 classifyCache 的状态 → 文案键 */
const CACHE_STATE_LABEL_KEYS: Record<NonNullable<CacheDiagnostics["lastState"]>, string> = {
  warm: "ctx.cache.stateWarm",
  cold: "ctx.cache.stateCold",
  evicted: "ctx.cache.stateEvicted",
  unsupported: "ctx.cache.stateUnsupported",
  unknown: "ctx.cache.stateUnknown",
};

/** 已知原因 → 文案键；未收录的原因回退原样展示（服务端新增枚举时 UI 不用追） */
const CACHE_REASON_LABEL_KEYS: Record<string, string> = {
  prefix_changed: "ctx.cache.reasonPrefixChanged",
  first_request: "ctx.cache.reasonFirstRequest",
  idle_exceeded_ttl: "ctx.cache.reasonIdleExceededTtl",
  not_reported: "ctx.cache.reasonNotReported",
  below_cache_granularity: "ctx.cache.reasonBelowGranularity",
  cache_miss: "ctx.cache.reasonCacheMiss",
};

/** 来源顺序 = 分段条与列表顺序，颜色在 CSS 里按 data-key 配（文案在组件内查表） */
const CATEGORY_KEYS = [
  { key: "system", labelKey: "ctx.categories.system" },
  { key: "tools", labelKey: "ctx.categories.tools" },
  { key: "skills", labelKey: "ctx.categories.skills" },
  { key: "messages", labelKey: "ctx.categories.messages" },
  { key: "other", labelKey: "ctx.categories.other" },
] as const;

/** 百分比：一位小数；非零但不足 1% 显示 <1%，整数省略 .0 */
function formatPercent(value: number): string {
  if (value > 0 && value < 1) return "<1%";
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
  cache,
  anchorRef,
  onCompact,
  onClose,
}: {
  usage: ContextUsage | null;
  /** 回合进行中不允许压缩 */
  streaming: boolean;
  /** 压缩进行中（compaction_started → completed） */
  compacting: boolean;
  /** 前缀缓存诊断（最近一轮读/写、状态原因、疑似失配计数）；缺省不显示缓存行 */
  cache?: CacheDiagnostics | null;
  anchorRef?: RefObject<HTMLElement | null>;
  onCompact: () => Promise<void>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState(false);
  const { t } = useTranslation("composer");

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
  // 老服务端只回三项来源：缺的键补 0，避免算出 NaN 宽度
  const breakdown = {
    system: usage?.breakdown?.system ?? 0,
    tools: usage?.breakdown?.tools ?? 0,
    skills: usage?.breakdown?.skills ?? 0,
    messages: usage?.breakdown?.messages ?? 0,
    other: usage?.breakdown?.other ?? 0,
  };
  const skillCount = usage?.skillCount ?? 0;
  // 技能与「其他」没有内容时不占一行：0% 的来源只会稀释信息
  const categories = CATEGORY_KEYS.filter((category) => {
    if (category.key === "skills") return skillCount > 0;
    if (category.key === "other") return breakdown.other > 0;
    return true;
  });
  const labelFor = (category: (typeof CATEGORY_KEYS)[number]) =>
    category.key === "skills"
      ? t("ctx.categories.skills", { count: skillCount })
      : t(category.labelKey);
  // 缓存诊断行：有最终样本才显示（老服务端/首问前 = null）
  const cacheStateKey = cache?.lastState ? CACHE_STATE_LABEL_KEYS[cache.lastState] : null;
  const cacheReasonText = cache?.lastReason
    ? cache.lastReason in CACHE_REASON_LABEL_KEYS
      ? t(CACHE_REASON_LABEL_KEYS[cache.lastReason])
      : cache.lastReason
    : null;
  const cacheRound =
    cache?.lastRound && (cache.lastRound.read != null || cache.lastRound.write != null)
      ? t("ctx.cache.round", {
          read: formatTokenCount(cache.lastRound.read ?? 0),
          write: formatTokenCount(cache.lastRound.write ?? 0),
        })
      : null;
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
    <div className="mc-ctxpop" ref={ref} role="dialog" aria-label={t("ctx.title")}>
      <div className="mc-ctxpop__head">
        <span className="mc-ctxpop__title">{t("ctx.title")}</span>
        <button
          type="button"
          className="mc-ctxpop__close"
          aria-label={t("ctx.close")}
          onClick={onClose}
        >
          <LuX size={13} />
        </button>
      </div>

      <div className="mc-ctxpop__summary">
        <span className="mc-ctxpop__pct" data-level={level}>
          {contextWindow ? formatPercent(ratio * 100) : "—"}
        </span>
        <span className="mc-ctxpop__nums">
          {t("ctx.used")} <b>{formatTokenCount(usedTokens)}</b>
          {contextWindow
            ? ` / ${formatTokenCount(contextWindow)}`
            : ` / ${t("ctx.windowUnset")}`}
        </span>
      </div>

      <div className="mc-ctxpop__bar" role="presentation">
        {categories.map((category) => {
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
        {categories.map((category) => {
          const tokens = breakdown[category.key];
          return (
            <li key={category.key} className="mc-ctxpop__row">
              <i className="mc-ctxpop__dot" data-key={category.key} aria-hidden />
              <span className="mc-ctxpop__label">{labelFor(category)}</span>
              <span className="mc-ctxpop__val">
                {contextWindow ? formatPercent((tokens / contextWindow) * 100) : formatTokenCount(tokens)}
              </span>
            </li>
          );
        })}
        {cacheStateKey ? (
          <li className="mc-ctxpop__row" title={cacheReasonText ?? undefined}>
            <i className="mc-ctxpop__dot" data-key="cache" aria-hidden />
            <span className="mc-ctxpop__label">{t("ctx.cache.stateLabel")}</span>
            <span className="mc-ctxpop__val">{t(cacheStateKey)}</span>
          </li>
        ) : null}
        {cacheRound ? (
          <li className="mc-ctxpop__row">
            <i className="mc-ctxpop__dot" data-key="cache" aria-hidden />
            <span className="mc-ctxpop__label">{t("ctx.cache.roundLabel")}</span>
            <span className="mc-ctxpop__val">{cacheRound}</span>
          </li>
        ) : null}
        {cache && cache.busts > 0 ? (
          <li
            className="mc-ctxpop__row"
            data-warn="true"
            title={
              cache.lastBustDrop
                ? t("ctx.cache.bustTitle", { drop: formatTokenCount(cache.lastBustDrop) })
                : undefined
            }
          >
            <i className="mc-ctxpop__dot" data-key="warn" aria-hidden />
            <span className="mc-ctxpop__label">{t("ctx.cache.busts")}</span>
            <span className="mc-ctxpop__val">{cache.busts}</span>
          </li>
        ) : null}
      </ul>

      <p className="mc-ctxpop__hint">{t("ctx.hint")}</p>

      <button
        type="button"
        className="mc-ctxpop__compact"
        disabled={streaming || busy}
        onClick={() => void handleCompact()}
      >
        <LuShrink size={14} />
        {busy ? t("ctx.compacting") : t("ctx.compact")}
      </button>
    </div>
  );
}
