/**
 * 数值型环境变量读取。
 *
 * 轮次预算与两个网络超时原本是写死的常量：要跑长任务只能改代码重新打包。
 * 这里提供统一的读取入口，默认值保持不变，只有显式设置环境变量时才生效。
 *
 * 约定：
 * - 只接受正数；未设置、空串、非数字、0 与负数一律回落默认值
 * - 小数向下取整，超过上限按上限截断
 */

/** Node 的 setTimeout 上限：超过 2^31-1 会被截断成立即触发。 */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * 读取正整数环境变量。
 *
 * @param name 环境变量名
 * @param fallback 未设置或非法时使用的默认值
 * @param max 上限，默认不限制；定时器类取值应传 {@link MAX_TIMER_MS}
 */
export function positiveIntFromEnv(
  name: string,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}
