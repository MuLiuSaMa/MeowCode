import type { TFunction } from "i18next";
import type { Automation } from "../../api";

/** cwd 的展示名（路径最后一段），行描述里不摆完整路径 */
export function baseName(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

/** 通用时间展示：相对今天才加日期，更早的带年份 */
export function formatDateTime(iso: string | null | undefined, locale = "zh-CN"): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const format = new Intl.DateTimeFormat(locale, {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return format.format(date);
}

/** 调度字段 → 一句人话（行描述 / 详情用） */
export function describeSchedule(automation: Automation, t: TFunction): string {
  switch (automation.kind) {
    case "interval": {
      const minutes = automation.intervalMinutes ?? 1;
      if (minutes >= 60 && minutes % 60 === 0) {
        return t("schedule.hours", { hours: minutes / 60 });
      }
      return t("schedule.interval", { minutes });
    }
    case "daily":
      return t("schedule.daily", { time: automation.time ?? "" });
    case "weekly":
      return t("schedule.weekly", {
        weekday: t(`weekday.${automation.weekday ?? 0}`),
        time: automation.time ?? "",
      });
    case "monthly":
      return t("schedule.monthly", { day: automation.dayOfMonth ?? 1, time: automation.time ?? "" });
    case "cron":
      return t("schedule.cron", { expr: automation.cron ?? "" });
    case "once":
      return t("schedule.once", { time: formatDateTime(automation.onceAt) });
    default:
      return "—";
  }
}

/** datetime-local 输入框的本地值（YYYY-MM-DDTHH:mm） */
export function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
