import { promises as fs } from "node:fs";
import path from "node:path";
import { parseMarkdownFrontmatter } from "./frontmatter.js";

export type SkillEntry = {
  name: string;
  description: string;
  /** true 则全文内联进 system 上下文（默认只注入索引行，模型按需 read_file） */
  always: boolean;
  path: string;
  source: "project" | "user";
  body: string;
};

/**
 * 发现 SKILL.md：`<root>/.meowcode/skills/<name>/SKILL.md`。
 * name 取 frontmatter，缺失时回退目录名；默认跳过缺 description 的条目
 * （索引注入用），技能选择器可传 allowMissingDescription 列出全部。
 * project 同名覆盖 user。
 */
export async function discoverSkills(
  roots: Array<{ dir: string; source: "project" | "user" }>,
  options?: { allowMissingDescription?: boolean },
): Promise<SkillEntry[]> {
  const byName = new Map<string, SkillEntry>();
  for (const { dir, source } of roots) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(dir, entry.name, "SKILL.md");
      try {
        const raw = await fs.readFile(skillFile, "utf8");
        const { meta, body } = parseMarkdownFrontmatter(raw);
        if (!meta.description && !options?.allowMissingDescription) continue; // 无描述的技能没有索引价值，跳过
        const name = meta.name || entry.name;
        if (byName.has(name)) continue; // project 先扫 → 先到先得
        byName.set(name, {
          name,
          description: meta.description ?? "",
          always: meta.always === "true",
          path: skillFile,
          source,
          body,
        });
      } catch {
        continue;
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const MAX_ALWAYS_BODY_CHARS = 4_000;

/**
 * 生成注入 system 上下文的"可用技能"段：
 *  - 普通技能只留索引行（模型用 read_file 按需取全文，省 token）；
 *  - always: true 的技能全文内联（超长截断）。
 */
export function buildSkillIndexText(skills: SkillEntry[]): string | undefined {
  if (skills.length === 0) return undefined;
  const lines: string[] = ["Available skills (use read_file on the SKILL.md path for details):"];
  for (const skill of skills) {
    lines.push(`- ${skill.name}: ${skill.description} (read ${skill.path} for details)`);
  }
  const inlined = skills.filter((skill) => skill.always && skill.body);
  if (inlined.length > 0) {
    lines.push("", "Skill details (always-on):");
    for (const skill of inlined) {
      let body = skill.body;
      if (body.length > MAX_ALWAYS_BODY_CHARS) {
        body = `${body.slice(0, MAX_ALWAYS_BODY_CHARS)}\n... [skill "${skill.name}" truncated]`;
      }
      lines.push("", `## Skill: ${skill.name}`, body);
    }
  }
  return lines.join("\n");
}

/** 一次发现 + 生成索引文本（给 instructions.ts 用） */
export async function loadSkillIndex(roots: {
  workspace: string;
  homeDir?: string;
}): Promise<string | undefined> {
  const sources: Array<{ dir: string; source: "project" | "user" }> = [
    { dir: path.join(roots.workspace, ".meowcode", "skills"), source: "project" },
  ];
  if (roots.homeDir) {
    sources.push({ dir: path.join(roots.homeDir, ".meowcode", "skills"), source: "user" });
  }
  return buildSkillIndexText(await discoverSkills(sources));
}
