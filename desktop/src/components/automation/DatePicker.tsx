import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { LuCalendar, LuChevronLeft, LuChevronRight } from "react-icons/lu";

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 周一开头的星期标题（Intl 自动本地化，无需词条） */
function weekdayLabels(locale: string): string[] {
  // 2026-11-02 是周一：用固定基准周生成「一 ~ 日」七个标签
  const base = new Date(2026, 10, 2);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(d);
  });
}

/** 某月的月历格子（周一开头，补齐到整周，空白为 null） */
function monthGrid(year: number, month: number): Array<number | null> {
  const offset = (new Date(year, month, 1).getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const cells: Array<number | null> = Array.from({ length: offset }, () => null);
  for (let d = 1; d <= days; d += 1) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

/**
 * 应用风格的日期选择：按钮 + 月历浮层（替代原生 <input type="date"> 的日历弹层）。
 * value 为本地 "YYYY-MM-DD"；月标题/星期标签走 Intl 随界面语言本地化。
 */
export function DatePicker({
  value,
  onChange,
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  ariaLabel?: string;
}) {
  const { t, i18n } = useTranslation("automation");
  const [open, setOpen] = useState(false);
  /** 浮层里正在浏览的年月（选值不改它，跨月浏览不被打断） */
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const initial = parsed ? new Date(Number(parsed[1]), Number(parsed[2]) - 1, 1) : new Date();
  const [view, setView] = useState({ year: initial.getFullYear(), month: initial.getMonth() });
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties | null>(null);

  // 打开时以当前值（或今天）重置浏览月份，并按按钮位置定位浮层
  useEffect(() => {
    if (!open) return;
    const p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    const base = p ? new Date(Number(p[1]), Number(p[2]) - 1, 1) : new Date();
    setView({ year: base.getFullYear(), month: base.getMonth() });
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const below = window.innerHeight - rect.bottom;
      setMenuStyle({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 292)),
        top: below > 340 ? rect.bottom + 6 : undefined,
        bottom: below > 340 ? undefined : window.innerHeight - rect.top + 6,
      });
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      // 菜单可能挂在 dialog 元素上（不在 rootRef 子树内），要一起豁免
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, value]);

  const grid = monthGrid(view.year, view.month);
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
  const monthTitle = new Intl.DateTimeFormat(i18n.language, {
    year: "numeric",
    month: "long",
  }).format(new Date(view.year, view.month, 1));

  const shiftMonth = (delta: number) => {
    setView((prev) => {
      const next = new Date(prev.year, prev.month + delta, 1);
      return { year: next.getFullYear(), month: next.getMonth() };
    });
  };

  return (
    <div className="mc-datepicker" ref={rootRef}>
      <button
        type="button"
        ref={buttonRef}
        className="mc-datepicker__button"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span>{value || "—"}</span>
        <LuCalendar size={14} />
      </button>
      {open
        ? createPortal(
            <div ref={menuRef} className="mc-datepicker__menu" style={menuStyle ?? undefined} role="dialog">
              <div className="mc-datepicker__head">
                <button
                  type="button"
                  className="mc-datepicker__nav"
                  aria-label="−1"
                  onClick={() => shiftMonth(-1)}
                >
                  <LuChevronLeft size={15} />
                </button>
                <span className="mc-datepicker__month">{monthTitle}</span>
                <button
                  type="button"
                  className="mc-datepicker__nav"
                  aria-label="+1"
                  onClick={() => shiftMonth(1)}
                >
                  <LuChevronRight size={15} />
                </button>
              </div>
              <div className="mc-datepicker__grid">
                {weekdayLabels(i18n.language).map((label) => (
                  <span className="mc-datepicker__wd" key={label}>
                    {label}
                  </span>
                ))}
                {grid.map((day, index) => {
                  if (day === null) return <span key={`e${index}`} />;
                  const iso = `${view.year}-${pad2(view.month + 1)}-${pad2(day)}`;
                  return (
                    <button
                      type="button"
                      key={iso}
                      className="mc-datepicker__day"
                      data-selected={iso === value}
                      data-today={iso === todayIso}
                      onClick={() => {
                        onChange(iso);
                        setOpen(false);
                      }}
                    >
                      {day}
                    </button>
                  );
                })}
              </div>
              <div className="mc-datepicker__foot">
                <button
                  type="button"
                  className="mc-datepicker__today"
                  onClick={() => {
                    onChange(todayIso);
                    setOpen(false);
                  }}
                >
                  {t("form.today")}
                </button>
              </div>
            </div>,
            // 原生 <dialog> 打开时处于 top layer，portal 到 body 会被压在弹窗底下：
            // 检测到组件位于 dialog 内时改挂到该 dialog 元素上（与 CustomSelect 同一解法）。
            (rootRef.current?.closest("dialog") as HTMLElement | null) ?? document.body,
          )
        : null}
    </div>
  );
}
