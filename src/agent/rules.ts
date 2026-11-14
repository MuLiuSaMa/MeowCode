import { promises as fs } from "node:fs";
import path from "node:path";
import { writeTextAtomic } from "./atomic-json.js";
import { estimateTokens } from "./context.js";
import { sliceHeadToTokens } from "./tool-budget.js";
import { resolveWithinWorkspace } from "./paths.js";

/**
 * 项目规则：工作区 `.meowcode/rules/<name>.md`，每个文件一条规则。
 * 与 AGENTS.md 的区别是规则由设置页显式创建/编辑，注入时带独立标题与预算。
 */
export const RULES_DIR = path.join(".meowcode", "rules");
export const MAX_RULE_NAME_LENGTH = 64;
export const MAX_RULE_BYTES = 64 * 1024;
/**
 * 规则注入指令的预算按 **token** 计（字符口径对中文放大 4 倍，见 instructions.ts）。
 * 单条默认 1500、总量 3000 token：规则由设置页显式创建，不该悄悄吃掉 AGENTS.md 的预算。
 */
const MAX_RULES_PROMPT_TOKENS = 3_000;
const MAX_RULE_PROMPT_TOKENS = 1_500;

const RULE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export type RuleSummary = {
  name: string;
  /** 第一个 Markdown 标题；没有标题时用文件名 */
  title: string;
  size: number;
  /** 文件 mtime（ISO）；文件丢失时为 null */
  mtime: string | null;
};

export type RuleRecord = {
  name: string;
  content: string;
  mtime: string | null;
};

export function isValidRuleName(name: string): boolean {
  return RULE_NAME_PATTERN.test(name) && name.length <= MAX_RULE_NAME_LENGTH;
}

export function rulesDirFor(workspace: string): string {
  return path.join(workspace, RULES_DIR);
}

function ruleTitle(name: string, content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line.trim());
    if (match) return match[1].slice(0, 120);
  }
  return name;
}

async function ruleFilePath(workspace: string, name: string): Promise<string> {
  return resolveWithinWorkspace(workspace, path.join(RULES_DIR, `${name}.md`));
}

/** 列出项目规则；只收常规 `.md` 文件，符号链接一律跳过。 */
export async function listRules(workspace: string): Promise<RuleSummary[]> {
  // 目录本身可能是工作区外的 junction：先过 realpath 边界，再列目录
  const dir = await resolveWithinWorkspace(workspace, RULES_DIR).catch(() => null);
  if (!dir) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const rules: RuleSummary[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const name = entry.name.slice(0, -3);
    if (!isValidRuleName(name)) continue;
    const file = path.join(dir, entry.name);
    const info = await fs.stat(file).catch(() => null);
    if (!info?.isFile()) continue;
    const content = await fs.readFile(file, "utf8").catch(() => "");
    rules.push({
      name,
      title: ruleTitle(name, content),
      size: info.size,
      mtime: info.mtime.toISOString(),
    });
  }
  return rules.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readRule(workspace: string, name: string): Promise<RuleRecord | null> {
  if (!isValidRuleName(name)) return null;
  const file = await ruleFilePath(workspace, name);
  const info = await fs.stat(file).catch(() => null);
  if (!info?.isFile()) return null;
  const content = await fs.readFile(file, "utf8").catch(() => null);
  if (content === null) return null;
  return { name, content, mtime: info.mtime.toISOString() };
}

export async function writeRule(
  workspace: string,
  name: string,
  content: string,
): Promise<void> {
  if (!isValidRuleName(name)) {
    throw new Error("Rule names are lowercase kebab-case (letters, digits, hyphens).");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_RULE_BYTES) {
    throw new Error(`Rule content is limited to ${Math.floor(MAX_RULE_BYTES / 1024)} KB.`);
  }
  const file = await ruleFilePath(workspace, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeTextAtomic(file, content.endsWith("\n") ? content : `${content}\n`);
}

export async function deleteRule(workspace: string, name: string): Promise<boolean> {
  if (!isValidRuleName(name)) return false;
  const file = await ruleFilePath(workspace, name);
  try {
    await fs.unlink(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** 规则文件 frontmatter（#8）：`---` 包裹的 YAML 子集，只认这四个键。 */
export type RuleFrontmatter = {
  /** 注入排序（大者优先）；缺省 0，同值按文件名排序 */
  priority: number;
  /** false = 本条规则不注入（保留在磁盘，列表里仍可见） */
  enabled: boolean;
  /** 本条规则的 token 预算；缺省 MAX_RULE_PROMPT_TOKENS */
  budget: number | null;
};

const EMPTY_FRONTMATTER: RuleFrontmatter = { priority: 0, enabled: true, budget: null };

/**
 * 解析规则文件头部的 frontmatter。刻意只认 `key: value` 一层的最小子集：
 * 这些文件是用户在设置页手写的，上 YAML 解析器是给注入链路引依赖。
 * 解析失败 = 当作没有 frontmatter，原文照常注入（不能因为格式把规则弄丢）。
 */
export function parseRuleFrontmatter(content: string): RuleFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) return EMPTY_FRONTMATTER;
  const result: RuleFrontmatter = { ...EMPTY_FRONTMATTER };
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z_-]+)\s*:\s*(.*?)\s*$/.exec(line.trim());
    if (!pair) continue;
    const [, key, raw] = pair;
    if (key === "priority") {
      const value = Number(raw);
      if (Number.isFinite(value)) result.priority = Math.floor(value);
    } else if (key === "enabled") {
      result.enabled = raw.toLowerCase() !== "false";
    } else if (key === "budget") {
      const value = Number(raw);
      if (Number.isFinite(value) && value > 0) result.budget = Math.floor(value);
    }
  }
  return result;
}

/** 剥掉 frontmatter，正文给模型看。 */
export function stripRuleFrontmatter(content: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content);
  return match ? content.slice(match[0].length).trim() : content.trim();
}

/** 把规则拼进系统指令：frontmatter 排序/开关/预算，正文 token 封顶。 */
export async function loadRulesForInstructions(workspace: string): Promise<string | undefined> {
  const summaries = await listRules(workspace).catch(() => []);
  if (!summaries.length) return undefined;
  const records: Array<{ name: string; frontmatter: RuleFrontmatter; content: string }> = [];
  for (const summary of summaries) {
    const record = await readRule(workspace, summary.name).catch(() => null);
    if (!record?.content.trim()) continue;
    const frontmatter = parseRuleFrontmatter(record.content);
    if (!frontmatter.enabled) continue;
    records.push({ name: summary.name, frontmatter, content: stripRuleFrontmatter(record.content) });
  }
  if (!records.length) return undefined;
  // priority 大者在前；同值保持文件名序（listRules 已排好，sort 是稳定排序）
  records.sort((a, b) => b.frontmatter.priority - a.frontmatter.priority);
  const blocks: string[] = [];
  let used = 0;
  for (const record of records) {
    const budget = record.frontmatter.budget ?? MAX_RULE_PROMPT_TOKENS;
    let content = record.content;
    if (estimateTokens(content) > budget) {
      content = `${sliceHeadToTokens(content, budget)}\n... [rule truncated]`;
    }
    const block = `### ${record.name}\n${content}`;
    if (used + estimateTokens(block) > MAX_RULES_PROMPT_TOKENS) {
      blocks.push("... [more project rules omitted to fit the context budget]");
      break;
    }
    blocks.push(block);
    used += estimateTokens(block);
  }
  if (!blocks.length) return undefined;
  return [
    "Project rules (follow these unless they conflict with tool approval or safety rules):",
    "",
    blocks.join("\n\n"),
  ].join("\n");
}
