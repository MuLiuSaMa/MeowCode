/**
 * 敏感文件保护插件（适配自 metis-main examples/extensions/protected-paths.ts）
 *
 * 阻止 write_file / edit_file / multi_edit 触碰敏感路径（.env、.git、node_modules 等）。
 * 可用 /protect 查看清单，/protect add <片段> 追加。
 */
import type { PluginFactory } from "meowcode";

const WRITE_TOOLS = new Set(["write_file", "edit_file", "multi_edit"]);
const DEFAULT_PROTECTED = [".env", ".git/", "node_modules/", ".meowcode/", "id_rsa"];

const factory: PluginFactory = (api) => {
  const protectedPaths: string[] = [...DEFAULT_PROTECTED];

  api.on("tool_call", (event) => {
    if (!WRITE_TOOLS.has(event.tool)) return;
    const input = event.input as { path?: unknown; edits?: unknown };
    const paths: string[] = [];
    if (typeof input.path === "string") paths.push(input.path);
    if (Array.isArray(input.edits)) {
      for (const edit of input.edits) {
        const p = (edit as { path?: unknown })?.path;
        if (typeof p === "string") paths.push(p);
      }
    }
    for (const target of paths) {
      const hit = protectedPaths.find((fragment) => target.includes(fragment));
      if (hit) {
        return {
          block: true,
          reason: `路径 "${target}" 受保护（命中规则 "${hit}"）。用 /protect remove "${hit}" 可解除。`,
        };
      }
    }
  });

  api.registerCommand({
    name: "protect",
    description: "查看/管理受保护路径：/protect、/protect add <片段>、/protect remove <片段>",
    run: (args) => {
      const [action, value] = args.trim().split(/\s+/);
      if (action === "add" && value) {
        if (!protectedPaths.includes(value)) protectedPaths.push(value);
        return `已追加保护规则：${value}`;
      }
      if (action === "remove" && value) {
        const index = protectedPaths.indexOf(value);
        if (index >= 0) protectedPaths.splice(index, 1);
        return `已移除保护规则：${value}`;
      }
      return `当前保护规则：\n${protectedPaths.map((p) => `- ${p}`).join("\n")}`;
    },
  });

  api.logger.info("protected-paths loaded（敏感路径保护）");
};

export default factory;
