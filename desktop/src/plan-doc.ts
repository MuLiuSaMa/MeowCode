/**
 * 计划文档路径识别：计划模式只允许写 plans/，这里与后端的门控范围保持一致。
 */

export const PLAN_WRITE_TOOLS = new Set(["write_file", "edit_file", "multi_edit"]);

/** 从工具参数里取 plans/ 下的目标路径（工作区相对）；不在 plans/ 内返回 null。 */
export function planDocPathOf(tool: string, input: unknown): string | null {
  if (!PLAN_WRITE_TOOLS.has(tool)) return null;
  const args = (input ?? {}) as Record<string, unknown>;
  const raw: string[] = [];
  if (typeof args.path === "string") raw.push(args.path);
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      const value = (edit as Record<string, unknown> | null)?.path;
      if (typeof value === "string") raw.push(value);
    }
  }
  if (!raw.length) return null;
  const normalized = raw.map((item) => item.replace(/\\/g, "/").replace(/^\.\//, ""));
  // 绝对路径交给后端事件（plan_documented 会带相对路径），这里只处理 plans/ 前缀
  const inPlans = normalized.every(
    (item) => item.startsWith("plans/") && !item.split("/").includes(".."),
  );
  return inPlans ? normalized[0] : null;
}
