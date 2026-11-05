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
  /** learned = 自我学习写出来的（origin: learned），手写技能不带这个标记 */
  origin?: "learned";
  body: string;
};

/**
 * 发现 SKILL.md：`<root>/.meowcode/skills/<name>/SKILL.md`。
 * name 取 frontmatter，缺失时回退目录名；默认跳过缺 description 的条目
 * （索引注入用），技能选择器可传 allowMissingDescription 列出全部。
 * project 同名覆盖 user；手写技能优先于学习产物（roots 顺序决定）。
 */
export async function discoverSkills(
  roots: Array<{ dir: string; source: "project" | "user"; learned?: boolean }>,
  options?: { allowMissingDescription?: boolean; exclude?: Set<string> },
): Promise<SkillEntry[]> {
  const byName = new Map<string, SkillEntry>();
  for (const { dir, source, learned } of roots) {
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
        // 退役的学习技能不进索引；手写技能不会被 exclude 命中（名字来自账本）
        if (learned && meta.status === "retired") continue;
        const name = meta.name || entry.name;
        if (options?.exclude?.has(name)) continue;
        if (byName.has(name)) continue; // 先到先得
        byName.set(name, {
          name,
          description: meta.description ?? "",
          always: meta.always === "true",
          path: skillFile,
          source,
          ...(learned ? { origin: "learned" as const } : {}),
          body,
        });
      } catch {
        continue;
      }
    }
  }
  // locale 钉死为 en：技能索引进 system[1]，进程换语言重启后顺序漂移会让 system 前缀字节变化、缓存失效
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, "en"));
}

const MAX_ALWAYS_BODY_CHARS = 4_000;
/**
 * 索引段字符上限：学到的技能会让列表持续增长，没有上限的话
 * 迟早把 AGENTS.md 与记忆挤出 16k 预算。超出按名字截断并留标记。
 */
export const MAX_SKILL_INDEX_CHARS = 3_000;

/**
 * 生成注入 system 上下文的"可用技能"段：
 *  - 普通技能只留索引行（模型用 read_file 按需取全文，省 token）；
 *  - always: true 的技能全文内联（超长截断）。
 */
export function buildSkillIndexText(skills: SkillEntry[]): string | undefined {
  if (skills.length === 0) return undefined;
  const header = "Available skills (use read_file on the SKILL.md path for details):";
  const lines: string[] = [header];
  let used = header.length;
  let dropped = 0;
  for (const skill of skills) {
    const line = `- ${skill.name}: ${skill.description} (read ${skill.path} for details)`;
    // always 技能必须内联，正文不参与索引行预算，所以永远保留它的索引行
    if (used + line.length > MAX_SKILL_INDEX_CHARS && !skill.always) {
      dropped += 1;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (dropped) {
    lines.push(`- ... [${dropped} more skills omitted to fit the context budget]`);
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

export type SkillIndexDetail = {
  /** 注入 system 的索引文本；没有技能时为 undefined */
  text: string | undefined;
  /** 发现的技能数量（含 always 内联的） */
  count: number;
};

/**
 * 一次发现 + 生成索引文本与数量（给 instructions.ts 用）。
 *
 * 四个根按「手写优先」排序：项目手写 → 项目学习 → 用户手写 → 用户学习。
 * 同名先到先得，所以学习产物永远顶不掉人写的技能。
 */
export async function loadSkillIndexDetail(roots: {
  workspace: string;
  homeDir?: string;
  /** 退役技能名：不参与索引（学习层账本给出）。 */
  exclude?: Set<string>;
}): Promise<SkillIndexDetail> {
  const sources: Array<{ dir: string; source: "project" | "user"; learned?: boolean }> = [
    { dir: path.join(roots.workspace, ".meowcode", "skills"), source: "project" },
    {
      dir: path.join(roots.workspace, ".meowcode", "learning", "skills"),
      source: "project",
      learned: true,
    },
  ];
  if (roots.homeDir) {
    sources.push({ dir: path.join(roots.homeDir, ".meowcode", "skills"), source: "user" });
    sources.push({
      dir: path.join(roots.homeDir, ".meowcode", "learning", "skills"),
      source: "user",
      learned: true,
    });
  }
  const skills = await discoverSkills(
    sources,
    roots.exclude?.size ? { exclude: roots.exclude } : undefined,
  );
  return { text: buildSkillIndexText(skills), count: skills.length };
}

/** 一次发现 + 生成索引文本（默认只注入索引行，供 instructions.ts 合并） */
export async function loadSkillIndex(roots: {
  workspace: string;
  homeDir?: string;
  exclude?: Set<string>;
}): Promise<string | undefined> {
  return (await loadSkillIndexDetail(roots)).text;
}
