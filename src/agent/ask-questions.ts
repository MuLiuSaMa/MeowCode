/**
 * ask_user 题目的归一化（纯函数）。
 *
 * 工具 schema 声明 `options: string[]`，但模型常按「卡片」直觉写成
 * `[{ label, description }]`。早期实现直接 `String(option)`，于是选项、答案
 * 双双向用户和模型暴露成 `[object Object]`（一次真实会话里模型收到这个字面量
 * 后还反问「回答没传回来？」）。这里统一拍平成「文本 + 等长描述」。
 */

import type { AskUserQuestion } from "./types.js";

/** 选项里可能是文本的键（有 label 时 label 才是给人看的） */
const LABEL_KEYS = ["label", "text", "title", "value", "option", "name"] as const;
/** 选项里可能是补充说明的键 */
const DESC_KEYS = ["description", "detail", "hint", "desc", "note", "explanation"] as const;

function firstText(
  record: Record<string, unknown>,
  keys: readonly string[],
  limit: number,
): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, limit);
    if (typeof value === "number") return String(value);
  }
  return "";
}

/**
 * 选项的显示文本：字符串/数字直接用，对象按 label→text→title→value 取第一个非空。
 * 取不到返回空串，绝不退化成 `[object Object]`。
 */
export function askOptionLabel(raw: unknown, limit = 120): string {
  if (typeof raw === "string") return raw.trim().slice(0, limit);
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  return firstText(raw as Record<string, unknown>, LABEL_KEYS, limit);
}

/** 选项的补充说明：只有对象形态才有（纯字符串选项没有描述）。 */
export function askOptionDescription(raw: unknown, limit = 200): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  return firstText(raw as Record<string, unknown>, DESC_KEYS, limit);
}

/**
 * 归一化工具参数为题目列表：最多 4 题、每题最多 4 个选项。
 * 取不到文本的选项整条丢掉——宁可少一个选项，也不给用户看占位符。
 * 同时兼容旧的单题写法 `{ question, options }`。
 */
export function normalizeAskQuestions(raw: {
  questions?: unknown;
  question?: unknown;
  options?: unknown;
}): AskUserQuestion[] {
  const list: unknown[] = Array.isArray(raw.questions)
    ? raw.questions.slice(0, 4)
    : typeof raw.question === "string" && raw.question.trim()
      ? [raw]
      : [];
  return list.flatMap((item) => {
    const record = (item ?? {}) as { question?: unknown; options?: unknown };
    const question =
      typeof record.question === "string" ? record.question.trim().slice(0, 500) : "";
    if (!question) return [];
    const options: string[] = [];
    const descriptions: string[] = [];
    for (const option of Array.isArray(record.options) ? record.options.slice(0, 4) : []) {
      const label = askOptionLabel(option);
      if (!label) continue;
      options.push(label);
      descriptions.push(askOptionDescription(option));
    }
    return [
      {
        question,
        options,
        ...(descriptions.some(Boolean) ? { descriptions } : {}),
      },
    ];
  });
}
