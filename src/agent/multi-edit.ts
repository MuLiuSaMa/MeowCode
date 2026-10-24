/**
 * multi_edit 参数解析：同时支持两种形态
 *   { path, edits: [{ oldString, newString, replaceAll? }] }   ← 单文件（旧形态，保持兼容）
 *   { edits: [{ path, oldString, newString, replaceAll? }] }   ← 跨文件（新形态）
 *
 * 同一文件的多条编辑按出现顺序归入一组；不同文件按首次出现顺序排列。
 * 解析放在独立模块里：tools / diff / runtime 三处都要用同一套规则，
 * 不能各写一份（审批预览与真实执行必须看到同一个分组）。
 */

export type MultiEditItem = {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
};

export type MultiEditGroup = {
  path: string;
  edits: MultiEditItem[];
};

/** 返回分组，或一句可以直接回给模型的错误。 */
export function readMultiEditGroups(input: unknown): MultiEditGroup[] | string {
  const args = (input ?? {}) as Record<string, unknown>;
  const fallback = String(args.path ?? "").trim();
  const raw = Array.isArray(args.edits) ? args.edits : [];
  if (!raw.length) {
    return 'edits must be a non-empty array of { oldString, newString } (optionally path per edit).';
  }
  const groups: MultiEditGroup[] = [];
  const byPath = new Map<string, MultiEditGroup>();
  for (let index = 0; index < raw.length; index += 1) {
    const edit = (raw[index] ?? {}) as Record<string, unknown>;
    const path = String(edit.path ?? fallback).trim();
    if (!path) {
      return `edit #${index + 1} is missing "path" (give a top-level path or a path on every edit).`;
    }
    const oldString = String(edit.oldString ?? "");
    if (!oldString) {
      return `edit #${index + 1} is missing "oldString".`;
    }
    const item: MultiEditItem = {
      oldString,
      newString: String(edit.newString ?? ""),
      replaceAll: Boolean(edit.replaceAll),
    };
    const existing = byPath.get(path);
    if (existing) {
      existing.edits.push(item);
    } else {
      const group: MultiEditGroup = { path, edits: [item] };
      byPath.set(path, group);
      groups.push(group);
    }
  }
  return groups;
}

/** 涉及的所有路径（保持首次出现顺序）；参数非法时返回空数组。 */
export function multiEditPaths(input: unknown): string[] {
  const groups = readMultiEditGroups(input);
  if (typeof groups === "string") return [];
  return groups.map((group) => group.path);
}
