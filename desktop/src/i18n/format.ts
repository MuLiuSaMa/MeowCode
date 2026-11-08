import i18n from "i18next";
import { currentLanguage } from "./index";

/** 数字一律按当前语种格式化：俄语用空格分组、印地语走 lakh 分组，都交给 Intl，不做特判。 */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(currentLanguage(), options).format(value);
}

/** 运行耗时文案：<1s / X.X 秒 / X 分 X 秒。子 Agent 工具行与回合耗时信息条共用。 */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return i18n.t("shell:taskRow.durationUnderSecond");
  const seconds = ms / 1_000;
  if (seconds < 60) {
    return i18n.t("shell:taskRow.durationSeconds", {
      value: formatNumber(seconds, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    });
  }
  const minutes = Math.floor(seconds / 60);
  return i18n.t("shell:taskRow.durationMinutes", {
    minutes: formatNumber(minutes),
    seconds: formatNumber(Math.round(seconds % 60)),
  });
}

function toMs(value: number | Date): number {
  return value instanceof Date ? value.getTime() : value;
}

/** 短日期，如 2026/10/30。 */
export function formatDate(value: number | Date, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(
    currentLanguage(),
    options ?? { year: "numeric", month: "2-digit", day: "2-digit" },
  ).format(toMs(value));
}

/** 日期 + 时间，用于提交详情、会话创建时间这类需要精确到分的地方。 */
export function formatDateTime(value: number | Date): string {
  return new Intl.DateTimeFormat(currentLanguage(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(toMs(value));
}

/** 只有钟点，如 14:05。 */
export function formatClock(value: number | Date): string {
  return new Intl.DateTimeFormat(currentLanguage(), {
    hour: "2-digit",
    minute: "2-digit",
  }).format(toMs(value));
}

/**
 * 会话列表右侧的紧凑时间：今天给钟点（14:05），昨天给「昨天」（走 Intl 自带说法），
 * 今年内给月/日（11/01），跨年才补年份。列表行放不下完整日期时间，按"越近越精确"取。
 */
export function formatSessionStamp(value: number | Date): string {
  const ms = toMs(value);
  if (!ms || Number.isNaN(ms)) return "";
  const now = new Date();
  const then = new Date(ms);
  const startOfDay = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  // 按日历天算差值：23:59 到次日 00:01 只差 2 分钟，但属于「昨天」
  const dayDiff = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);

  if (dayDiff <= 0) return formatClock(ms);
  if (dayDiff === 1) {
    return new Intl.RelativeTimeFormat(currentLanguage(), { numeric: "auto" }).format(-1, "day");
  }
  if (then.getFullYear() === now.getFullYear()) {
    return new Intl.DateTimeFormat(currentLanguage(), { month: "2-digit", day: "2-digit" }).format(
      ms,
    );
  }
  return new Intl.DateTimeFormat(currentLanguage(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ms);
}

type RelativeUnit = Intl.RelativeTimeFormatUnit;

const UNITS: Array<{ unit: RelativeUnit; seconds: number }> = [
  { unit: "year", seconds: 365 * 86_400 },
  { unit: "month", seconds: 30 * 86_400 },
  { unit: "day", seconds: 86_400 },
  { unit: "hour", seconds: 3_600 },
  { unit: "minute", seconds: 60 },
];

/**
 * 相对时间。45 秒内走「刚刚」特例，超过一个月退回绝对日期——
 * 「45 天前」这种表述对翻找旧提交没有帮助。
 */
export function formatRelative(value: number | Date): string {
  const ms = toMs(value);
  if (!ms || Number.isNaN(ms)) return "";
  const seconds = (Date.now() - ms) / 1000;
  if (seconds < 45) return i18n.t("common:justNow");

  const formatter = new Intl.RelativeTimeFormat(currentLanguage(), { numeric: "always" });
  const future = seconds < 0;
  const elapsed = Math.abs(seconds);
  for (const { unit, seconds: size } of UNITS) {
    if (elapsed >= size || unit === "minute") {
      return formatter.format(Math.round((future ? 1 : -1) * (elapsed / size)), unit);
    }
  }
  return formatDate(ms);
}
