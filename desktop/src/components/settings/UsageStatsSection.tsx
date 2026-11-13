import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import i18n from "i18next";
import { Button } from "../ui/Button";
import "./UsageStatsSection.css";

type UsageStats = Awaited<ReturnType<typeof window.meow.usageStats>>;
type ActivityMode = "daily" | "weekly" | "cumulative";
type Range = "7" | "30";

const SERIES_COLORS = [
  "var(--accent)",
  "var(--success)",
  "var(--accent-violet)",
  "var(--danger)",
  "var(--warning)",
  "var(--fg-subtle)",
];
const MAX_SERIES = 4;
const MAX_MODELS = 6;
const WEEKS = 52;
const ACTIVITY_MODES: ActivityMode[] = ["daily", "weekly", "cumulative"];

function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  try {
    return new Intl.NumberFormat(i18n.language, {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  } catch {
    return String(value);
  }
}

function formatDayLabel(dateKey: string): string {
  const [, month, day] = dateKey.split("-").map(Number);
  if (i18n.language.startsWith("zh")) return `${month}月${day}日`;
  return `${month}/${day}`;
}

function formatMonthLabel(dateKey: string): string {
  const date = new Date(`${dateKey}T12:00:00`);
  try {
    return new Intl.DateTimeFormat(i18n.language, { month: "short" }).format(date);
  } catch {
    return dateKey.slice(5, 7);
  }
}

function localKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0%";
  if (value >= 10) return `${Math.round(value)}%`;
  return `${(Math.round(value * 10) / 10).toFixed(1)}%`;
}

function linePath(values: number[], max: number): string {
  const count = values.length;
  if (!count) return "";
  const x = (index: number) => (count === 1 ? 50 : (index / (count - 1)) * 100);
  const y = (value: number) => 38 - (max > 0 ? (value / max) * 34 : 0);
  let path = `M ${x(0)} ${y(values[0])}`;
  for (let index = 1; index < count; index += 1) {
    const fromX = x(index - 1);
    const fromY = y(values[index - 1]);
    const toX = x(index);
    const toY = y(values[index]);
    const middle = (fromX + toX) / 2;
    path += ` C ${middle} ${fromY}, ${middle} ${toY}, ${toX} ${toY}`;
  }
  return path;
}

/**
 * 设置 → 使用统计（对齐 ZCode 的口径与版式）：
 * 单卡五项指标、52 周 Token 活动热力图（每日/每周/累计）、
 * 按时间范围的多模型每日趋势线、模型用量环形图。
 */
export function UsageStatsSection() {
  const { t } = useTranslation("settings");
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState<Range>("7");
  const [activityMode, setActivityMode] = useState<ActivityMode>("daily");
  /** 折线图悬停：最近的日期下标 + 指针在容器内的位置（用于点位与浮层） */
  const [hover, setHover] = useState<{
    index: number;
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);

  const refresh = useCallback((force = false) => {
    setLoading(true);
    void window.meow
      .usageStats(force)
      .then((result) => setStats(result))
      .catch(() => setStats(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const formatDuration = useCallback(
    (ms: number): string => {
      if (!Number.isFinite(ms) || ms <= 0) return "—";
      const minutes = Math.max(1, Math.round(ms / 60_000));
      const days = Math.floor(minutes / 1440);
      if (days >= 1) return `${days} ${t("usage.units.days")}`;
      const hours = Math.floor(minutes / 60);
      if (hours > 0) {
        return `${hours} ${t("usage.units.hours")} ${minutes % 60} ${t("usage.units.minutes")}`;
      }
      return `${minutes} ${t("usage.units.minutes")}`;
    },
    [t],
  );

  /** 52 周热力图：每周 7 天，周日为第一行 */
  const weeks = useMemo(() => {
    if (!stats) return [];
    const byDate = new Map(stats.activity.map((item) => [item.date, item.tokens]));
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const currentSunday = new Date(today);
    currentSunday.setDate(today.getDate() - today.getDay());
    const start = new Date(currentSunday);
    start.setDate(currentSunday.getDate() - (WEEKS - 1) * 7);
    let cumulative = 0;
    const result = [];
    for (let week = 0; week < WEEKS; week += 1) {
      const days = [];
      let total = 0;
      for (let day = 0; day < 7; day += 1) {
        const date = new Date(start);
        date.setDate(start.getDate() + week * 7 + day);
        const key = localKey(date);
        const tokens = byDate.get(key) || 0;
        total += tokens;
        days.push({ date: key, tokens, future: date > today });
      }
      cumulative += total;
      result.push({ start: days[0].date, end: days[6].date, days, total, cumulative });
    }
    return result;
  }, [stats]);

  const activityValue = useCallback(
    (week: (typeof weeks)[number]) => {
      if (activityMode === "weekly") return week.total;
      if (activityMode === "cumulative") return week.cumulative;
      return 0;
    },
    [activityMode],
  );

  const activityThresholds = useMemo(() => {
    if (!weeks.length) return [0, 0, 0];
    const values =
      activityMode === "daily"
        ? weeks.flatMap((week) => week.days.map((day) => day.tokens))
        : weeks.map((week) => activityValue(week));
    const nonZero = values.filter((value) => value > 0).sort((a, b) => a - b);
    if (!nonZero.length) return [0, 0, 0];
    return [0.25, 0.5, 0.75].map(
      (quantile) => nonZero[Math.min(nonZero.length - 1, Math.floor(quantile * nonZero.length))],
    );
  }, [weeks, activityMode, activityValue]);

  const levelOf = (value: number): number => {
    if (value <= 0) return 0;
    if (value <= activityThresholds[0]) return 1;
    if (value <= activityThresholds[1]) return 2;
    if (value <= activityThresholds[2]) return 3;
    return 4;
  };

  /** 月份标签锚在每月 1 日所在列，最多 12 个 */
  const monthLabels = useMemo(() => {
    const labels = new Map<number, string>();
    weeks.forEach((week, index) => {
      for (const day of week.days) {
        if (day.date.endsWith("-01")) labels.set(index, formatMonthLabel(day.date));
      }
    });
    return new Map([...labels.entries()].slice(-12));
  }, [weeks]);

  const rangeDays = useMemo(
    () => (stats ? stats.daily.slice(-Number(range)) : []),
    [stats, range],
  );

  const series = useMemo(() => {
    if (!stats) return [];
    return stats.models
      .slice(0, MAX_SERIES)
      .map((item, index) => ({
        model: item.model,
        color: SERIES_COLORS[index % SERIES_COLORS.length],
        values: rangeDays.map(
          (day) => day.models.find((entry) => entry.model === item.model)?.tokens ?? 0,
        ),
      }))
      .filter((item) => item.values.some((value) => value > 0));
  }, [stats, rangeDays]);

  const seriesMax = Math.max(1, ...series.flatMap((item) => item.values));

  const handleChartMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    const count = rangeDays.length;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!count || rect.width <= 0) return;
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    setHover({
      index: Math.round(fraction * (count - 1)),
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
    });
  };

  const axisIndexes = useMemo(() => {
    const count = rangeDays.length;
    if (count <= 7) return rangeDays.map((_, index) => index);
    const step = Math.max(1, Math.round((count - 1) / 6));
    const indexes = [];
    for (let index = 0; index < count; index += step) indexes.push(index);
    if (indexes[indexes.length - 1] !== count - 1) indexes.push(count - 1);
    return indexes;
  }, [rangeDays]);

  const modelSlices = useMemo(() => {
    if (!stats) return [];
    const top = stats.models
      .slice(0, MAX_MODELS)
      .map((item, index) => ({
        ...item,
        color: SERIES_COLORS[index % SERIES_COLORS.length],
      }));
    const rest = stats.models.slice(MAX_MODELS);
    if (rest.length) {
      top.push({
        model: t("usage.models.other"),
        tokens: rest.reduce((sum, item) => sum + item.tokens, 0),
        color: "var(--fg-subtlest)",
      });
    }
    return top;
  }, [stats, t]);
  const modelTotal = Math.max(1, modelSlices.reduce((sum, item) => sum + item.tokens, 0));

  const metrics = stats
    ? [
        { label: t("usage.metrics.total"), value: formatTokens(stats.totalTokens) },
        { label: t("usage.metrics.peak"), value: formatTokens(stats.peakDailyTokens) },
        { label: t("usage.metrics.longestChat"), value: formatDuration(stats.longestChatMs) },
        { label: t("usage.metrics.currentStreak"), value: formatDuration(stats.streakDays * 86_400_000) },
        { label: t("usage.metrics.maxStreak"), value: formatDuration(stats.longestStreakDays * 86_400_000) },
      ]
    : [];

  const hasUsage = Boolean(stats && stats.totalTokens > 0);

  return (
    <div className="mc-settings__inner">
      <header className="mc-usage__pagehead">
        <h1 className="mc-usage__title">{t("usage.section")}</h1>
        <span className="mc-usage__badge">{t("usage.badge")}</span>
        <Button
          className="mc-usage__refresh"
          size="sm"
          disabled={loading}
          onClick={() => refresh(true)}
        >
          {t("usage.refresh")}
        </Button>
      </header>

      {!hasUsage ? (
        <p className="mc-usage__empty">{loading ? t("usage.loading") : t("usage.empty")}</p>
      ) : (
        <>
          <section className="mc-usage__metrics" aria-label={t("usage.section")}>
            {metrics.map((metric) => (
              <div className="mc-usage__metric" key={metric.label}>
                <span className="mc-usage__metricvalue">{metric.value}</span>
                <span className="mc-usage__metriclabel">{metric.label}</span>
              </div>
            ))}
          </section>

          <section className="mc-usage__panel">
            <header className="mc-usage__panelhead">
              <h2 className="mc-usage__paneltitle">{t("usage.activity.title")}</h2>
              <div className="mc-usage__tabs" role="tablist" aria-label={t("usage.activity.title")}>
                {ACTIVITY_MODES.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="tab"
                    aria-selected={activityMode === mode}
                    data-active={activityMode === mode}
                    className="mc-usage__tab"
                    onClick={() => setActivityMode(mode)}
                  >
                    {t(`usage.activity.${mode}`)}
                  </button>
                ))}
              </div>
            </header>
            <div className="mc-usage__heat" data-mode={activityMode}>
              {weeks.map((week) => {
                const weekValue = activityValue(week);
                const weekTitle =
                  activityMode === "daily"
                    ? undefined
                    : `${week.start} – ${week.end} · ${formatTokens(weekValue)}`;
                return (
                  <div className="mc-usage__heatcol" key={week.start} title={weekTitle}>
                    {week.days.map((day) => {
                      const value = activityMode === "daily" ? day.tokens : weekValue;
                      return (
                        <span
                          key={day.date}
                          className="mc-usage__heatcell"
                          data-level={levelOf(value)}
                          data-future={day.future || undefined}
                          title={
                            activityMode === "daily"
                              ? `${day.date} · ${formatTokens(day.tokens)}`
                              : weekTitle
                          }
                        />
                      );
                    })}
                  </div>
                );
              })}
            </div>
            <div className="mc-usage__months" aria-hidden>
              {weeks.map((week, index) => (
                <span key={week.start}>{monthLabels.get(index) ?? ""}</span>
              ))}
            </div>
          </section>

          <div className="mc-usage__rangebar">
            <span className="mc-usage__rangelabel">{t("usage.range.label")}</span>
            <div className="mc-usage__tabs" role="tablist" aria-label={t("usage.range.label")}>
              {(["7", "30"] as Range[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={range === value}
                  data-active={range === value}
                  className="mc-usage__tab"
                  onClick={() => setRange(value)}
                >
                  {t(value === "7" ? "usage.range.d7" : "usage.range.d30")}
                </button>
              ))}
            </div>
          </div>

          <section className="mc-usage__panel">
            <header className="mc-usage__panelhead">
              <h2 className="mc-usage__paneltitle">{t("usage.trend.title")}</h2>
            </header>
            {/* key={range}：切换时间范围时整块淡入，避免折线瞬变 */}
            <div className="mc-usage__trendbody" key={range}>
              <div className="mc-usage__legend">
                {series.map((item) => (
                  <span className="mc-usage__legendtag" key={item.model}>
                    <span className="mc-usage__dot" style={{ background: item.color }} />
                    <span className="mc-truncate" title={item.model}>
                      {item.model === "unknown" ? t("usage.unknownModel") : item.model}
                    </span>
                  </span>
                ))}
              </div>
              <div
                className="mc-usage__chart"
                onMouseMove={handleChartMove}
                onMouseLeave={() => setHover(null)}
              >
                <svg
                  viewBox="0 0 100 40"
                  preserveAspectRatio="none"
                  role="img"
                  aria-label={t("usage.trend.title")}
                >
                  {[4, 15, 26, 37].map((y) => (
                    <line
                      key={y}
                      x1="0"
                      x2="100"
                      y1={y}
                      y2={y}
                      stroke="var(--border)"
                      strokeDasharray="1 2"
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                  {series.map((item) => (
                    <path
                      key={item.model}
                      d={linePath(item.values, seriesMax)}
                      fill="none"
                      stroke={item.color}
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                </svg>
                {hover ? (
                  <span
                    className="mc-usage__hoverline"
                    style={{
                      left: `${
                        rangeDays.length <= 1
                          ? 50
                          : (hover.index / (rangeDays.length - 1)) * 100
                      }%`,
                    }}
                  />
                ) : null}
                {hover
                  ? series.map((item) => {
                      const value = item.values[hover.index] ?? 0;
                      if (value <= 0) return null;
                      const left =
                        rangeDays.length <= 1
                          ? 50
                          : (hover.index / (rangeDays.length - 1)) * 100;
                      const top = ((38 - (value / seriesMax) * 34) / 40) * 100;
                      return (
                        <span
                          key={item.model}
                          className="mc-usage__hoverdot"
                          style={{ left: `${left}%`, top: `${top}%`, background: item.color }}
                        />
                      );
                    })
                  : null}
                {hover && rangeDays[hover.index] ? (
                  <div
                    className="mc-usage__tooltip"
                    style={{
                      left: Math.min(Math.max(8, hover.x + 12), Math.max(8, hover.width - 200)),
                      top: Math.min(hover.y + 14, Math.max(8, hover.height - 96)),
                    }}
                  >
                    <span className="mc-usage__tooltipdate">
                      {formatDayLabel(rangeDays[hover.index].date)}
                    </span>
                    {series.map((item) => {
                      const value = item.values[hover.index] ?? 0;
                      if (value <= 0) return null;
                      return (
                        <div className="mc-usage__tooltiprow" key={item.model}>
                          <span className="mc-usage__dot" style={{ background: item.color }} />
                          <span className="mc-usage__tooltipname mc-truncate" title={item.model}>
                            {item.model === "unknown" ? t("usage.unknownModel") : item.model}
                          </span>
                          <span className="mc-usage__tooltipvalue">
                            {formatTokens(value)} {t("usage.units.tokens")}
                          </span>
                        </div>
                      );
                    })}
                    {series.every((item) => (item.values[hover.index] ?? 0) <= 0) ? (
                      <div className="mc-usage__tooltiprow">
                        <span className="mc-usage__tooltipvalue">
                          {formatTokens(0)} {t("usage.units.tokens")}
                        </span>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div className="mc-usage__xaxis">
                {axisIndexes.map((index) => (
                  <span key={rangeDays[index]?.date ?? index}>
                    {rangeDays[index] ? formatDayLabel(rangeDays[index].date) : ""}
                  </span>
                ))}
              </div>
            </div>
          </section>

          <section className="mc-usage__panel">
            <header className="mc-usage__panelhead">
              <h2 className="mc-usage__paneltitle">{t("usage.models.title")}</h2>
            </header>
            <div className="mc-usage__donutwrap">
              <svg
                className="mc-usage__donut"
                viewBox="0 0 160 160"
                role="img"
                aria-label={t("usage.models.title")}
              >
                <circle
                  cx="80"
                  cy="80"
                  r="62"
                  fill="none"
                  stroke="var(--surface-hover)"
                  strokeWidth="22"
                />
                {modelSlices.map((slice, index) => {
                  const start = modelSlices
                    .slice(0, index)
                    .reduce((sum, item) => sum + (item.tokens / modelTotal) * 100, 0);
                  const percent = (slice.tokens / modelTotal) * 100;
                  const dash = Math.max(0.4, percent - 0.6);
                  return (
                    <circle
                      key={slice.model}
                      cx="80"
                      cy="80"
                      r="62"
                      fill="none"
                      stroke={slice.color}
                      strokeWidth="22"
                      pathLength={100}
                      strokeDasharray={`${dash} ${100 - dash}`}
                      strokeDashoffset={-start}
                      transform="rotate(-90 80 80)"
                    />
                  );
                })}
                <text x="80" y="77" textAnchor="middle" className="mc-usage__donutvalue">
                  {formatTokens(stats?.totalTokens ?? 0)}
                </text>
                <text x="80" y="95" textAnchor="middle" className="mc-usage__donutunit">
                  {t("usage.units.tokens")}
                </text>
              </svg>
              <ul className="mc-usage__modellist">
                {modelSlices.map((slice) => (
                  <li className="mc-usage__modelrow" key={slice.model}>
                    <div className="mc-usage__modelmain">
                      <span className="mc-usage__dot" style={{ background: slice.color }} />
                      <span className="mc-usage__modelname mc-truncate" title={slice.model}>
                        {slice.model}
                      </span>
                      <span className="mc-usage__percent">
                        {formatPercent((slice.tokens / modelTotal) * 100)}
                      </span>
                    </div>
                    <span className="mc-usage__modeltokens">
                      {formatTokens(slice.tokens)} {t("usage.units.tokens")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
