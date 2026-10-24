/** 取路径最后一段（兼容 Windows 反斜杠）。 */
export function baseName(value: string): string {
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : value;
}

/**
 * 容量字符串 → 数字。支持 `256K` / `1M` 后缀。
 * 按 DSH 的约定：K = 1000，M = 1_000_000（**不是** 1024）。
 */
export function parseCapacity(input: string): number | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*([kKmM])?$/.exec(trimmed);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = match[2]?.toLowerCase();
  if (unit === "k") return Math.round(value * 1000);
  if (unit === "m") return Math.round(value * 1_000_000);
  return Math.round(value);
}

/** 数字 → 容量字符串（便于在输入框里回显）。 */
export function formatCapacity(value?: number): string {
  if (!value || value <= 0) return "";
  if (value >= 1_000_000 && value % 1_000_000 === 0) return `${value / 1_000_000}M`;
  if (value >= 1000 && value % 1000 === 0) return `${value / 1000}K`;
  return String(value);
}
