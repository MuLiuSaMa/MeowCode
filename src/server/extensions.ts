import { promises as fs } from "node:fs";
import path from "node:path";
import { builtinMeta } from "../plugins/builtin-meta.js";
import { parseMarkdownFrontmatter } from "../plugins/frontmatter.js";
import type { ExtensionHost } from "../plugins/types.js";
import { writeManualMarkerFile } from "./marketplace.js";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_NAME = 80;
const MAX_DESCRIPTION = 200;
const MAX_SKILL_BODY = 20_000;
const MAX_PLUGIN_CODE = 200_000;

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n") : "";
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** target 必须严格位于 root 之内（防 `..` / 盘符逃逸；Windows 路径大小写不敏感也安全）。 */
function within(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * AI 自建技能/插件的宿主实现：内置创作插件只负责调工具，落盘、标记与热更新全在这里。
 * 技能写到 ~/.meowcode/skills/<id>/SKILL.md，插件写到 ~/.meowcode/plugins/<id>.ts，
 * 两者都写 manual 标记（「我的」可见、可卸载）。覆盖只允许针对本机制创建的产物。
 */
export function createExtensionHost(options: {
  homeDir: string;
  /** 技能落盘后刷新所有存活 runtime 的 instructions（下一轮可索引到） */
  onSkillCreated: () => void;
  /** 插件落盘后重载插件系统，返回该 id 的加载结果 */
  onPluginsChanged: (id: string) => Promise<{ toolNames?: string[]; error?: string }>;
}): ExtensionHost {
  const root = path.join(options.homeDir, ".meowcode");
  const skillsDir = path.join(root, "skills");
  const pluginsDir = path.join(root, "plugins");
  const markerDir = path.join(root, ".marketplace");

  const idError = (id: string): string | null =>
    ID_PATTERN.test(id)
      ? null
      : "id 只能用小写字母、数字和连字符，长度 1-64，且不能以连字符开头";

  /** 已存在时是否允许覆盖：必须是本机制建的（有 manual 标记且没有市场安装标记）。 */
  const canOverwrite = async (type: "skill" | "plugin", id: string): Promise<boolean> =>
    (await exists(path.join(markerDir, `manual-${type}-${id}.json`))) &&
    !(await exists(path.join(markerDir, `${type}-${id}.json`)));

  return {
    async createSkill(input) {
      const id = typeof input.id === "string" ? input.id.trim() : "";
      const idErr = idError(id);
      if (idErr) return { ok: false, stage: "validate", error: idErr };
      const name = oneLine(text(input.name)).slice(0, MAX_NAME) || id;
      const description = oneLine(text(input.description));
      const body = text(input.body).trim();
      if (!description) {
        return { ok: false, stage: "validate", error: "description 必填：用一句话说明何时该用这个技能" };
      }
      if (description.length > MAX_DESCRIPTION) {
        return { ok: false, stage: "validate", error: `description 过长（最多 ${MAX_DESCRIPTION} 字符）` };
      }
      if (!body) return { ok: false, stage: "validate", error: "body 必填：技能正文（Markdown）" };
      if (body.length > MAX_SKILL_BODY) {
        return { ok: false, stage: "validate", error: `技能正文过长（最多 ${MAX_SKILL_BODY} 字符）` };
      }
      const dir = path.join(skillsDir, id);
      if (!within(skillsDir, dir)) return { ok: false, stage: "validate", error: "非法技能 id" };
      const file = path.join(dir, "SKILL.md");
      const existed = await exists(dir);
      if (existed && !(await canOverwrite("skill", id))) {
        return { ok: false, stage: "validate", error: `技能 ${id} 已存在且不是 AI 创建的，拒绝覆盖` };
      }
      const backup = existed ? await fs.readFile(file, "utf8").catch(() => null) : null;
      const content = [
        "---",
        `name: ${name}`,
        `description: ${description}`,
        ...(input.always ? ['always: "true"'] : []),
        "---",
        "",
        body,
        "",
      ].join("\n");
      const parsed = parseMarkdownFrontmatter(content);
      if (parsed.meta.name !== name || parsed.meta.description !== description) {
        return {
          ok: false,
          stage: "validate",
          error: "名称/介绍含有无法写入 frontmatter 的字符（引号或换行）",
        };
      }
      try {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(file, content, "utf8");
        await writeManualMarkerFile(options.homeDir, { type: "skill", id, target: `skills/${id}` });
      } catch (error) {
        if (backup == null) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        else await fs.writeFile(file, backup, "utf8").catch(() => undefined);
        return { ok: false, stage: "write", error: `写入技能失败：${errorMessage(error)}` };
      }
      options.onSkillCreated();
      return { ok: true, id, path: file };
    },

    async createPlugin(input) {
      const id = typeof input.id === "string" ? input.id.trim() : "";
      const idErr = idError(id);
      if (idErr) return { ok: false, stage: "validate", error: idErr };
      const name = oneLine(text(input.name)).slice(0, MAX_NAME);
      const description = oneLine(text(input.description)).slice(0, MAX_DESCRIPTION);
      const code = text(input.code).trim();
      if (!name) return { ok: false, stage: "validate", error: "name 必填：插件的中文显示名" };
      if (!description) return { ok: false, stage: "validate", error: "description 必填：一句话介绍" };
      if (!code) return { ok: false, stage: "validate", error: "code 必填：插件源码" };
      if (code.length > MAX_PLUGIN_CODE) {
        return { ok: false, stage: "validate", error: `插件代码过长（最多 ${MAX_PLUGIN_CODE} 字符）` };
      }
      if (!/\bexport\s+default\b/.test(code)) {
        return {
          ok: false,
          stage: "validate",
          error: "插件必须用 `export default (api) => { ... }` 导出工厂函数",
        };
      }
      if (builtinMeta(id)) {
        return { ok: false, stage: "validate", error: `插件 id ${id} 是内置插件，不能覆盖` };
      }
      const file = path.join(pluginsDir, `${id}.ts`);
      if (!within(pluginsDir, file)) return { ok: false, stage: "validate", error: "非法插件 id" };
      const existed = await exists(file);
      if (existed && !(await canOverwrite("plugin", id))) {
        return { ok: false, stage: "validate", error: `插件 ${id} 已存在且不是 AI 创建的，拒绝覆盖` };
      }
      const backup = existed ? await fs.readFile(file, "utf8").catch(() => null) : null;
      const content = [
        `// @meowcode name: ${name}`,
        `// @meowcode description: ${description}`,
        code,
        "",
      ].join("\n");
      try {
        await fs.mkdir(pluginsDir, { recursive: true });
        await fs.writeFile(file, content, "utf8");
      } catch (error) {
        if (backup == null) await fs.rm(file, { force: true }).catch(() => undefined);
        else await fs.writeFile(file, backup, "utf8").catch(() => undefined);
        return { ok: false, stage: "write", error: `写入插件失败：${errorMessage(error)}` };
      }
      let refresh: { toolNames?: string[]; error?: string };
      try {
        refresh = await options.onPluginsChanged(id);
      } catch (error) {
        refresh = { error: errorMessage(error) };
      }
      if (refresh.error) {
        // 加载失败：还原旧文件并再重载一次，让插件系统回到可用状态，错误交给 AI 修正
        if (backup == null) await fs.rm(file, { force: true }).catch(() => undefined);
        else await fs.writeFile(file, backup, "utf8").catch(() => undefined);
        await options.onPluginsChanged(id).catch(() => undefined);
        return { ok: false, stage: "reload", error: `插件加载失败：${refresh.error}` };
      }
      try {
        await writeManualMarkerFile(options.homeDir, {
          type: "plugin",
          id,
          target: `plugins/${id}.ts`,
        });
      } catch (error) {
        return {
          ok: true,
          id,
          path: file,
          ...(refresh.toolNames?.length ? { toolNames: refresh.toolNames } : {}),
          error: `已创建，但写入「我的」标记失败：${errorMessage(error)}`,
        };
      }
      return {
        ok: true,
        id,
        path: file,
        ...(refresh.toolNames?.length ? { toolNames: refresh.toolNames } : {}),
      };
    },
  };
}
