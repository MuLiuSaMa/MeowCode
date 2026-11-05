import { promises as fs } from "node:fs";
import path from "node:path";
import { writeTextAtomic } from "./atomic-json.js";
import { resolveWithinWorkspace } from "./paths.js";

/**
 * 项目规则：工作区 `.meowcode/rules/<name>.md`，每个文件一条规则。
 * 与 AGENTS.md 的区别是规则由设置页显式创建/编辑，注入时带独立标题与预算。
 */
export const RULES_DIR = path.join(".meowcode", "rules");
export const MAX_RULE_NAME_LENGTH = 64;
export const MAX_RULE_BYTES = 64 * 1024;
/** 规则注入指令的字符预算：不和 AGENTS.md / 技能索引抢满 16k 总预算 */
const MAX_RULES_PROMPT_CHARS = 12_000;
const MAX_RULE_PROMPT_CHARS = 6_000;

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

/** 把规则拼进系统指令；按文件名排序，单条 6k、总量 12k 字符封顶。 */
export async function loadRulesForInstructions(workspace: string): Promise<string | undefined> {
  const summaries = await listRules(workspace).catch(() => []);
  if (!summaries.length) return undefined;
  const blocks: string[] = [];
  let used = 0;
  for (const summary of summaries) {
    const record = await readRule(workspace, summary.name).catch(() => null);
    if (!record?.content.trim()) continue;
    let content = record.content.trim();
    if (content.length > MAX_RULE_PROMPT_CHARS) {
      content = `${content.slice(0, MAX_RULE_PROMPT_CHARS)}\n... [rule truncated]`;
    }
    const block = `### ${summary.name}\n${content}`;
    if (used + block.length > MAX_RULES_PROMPT_CHARS) {
      blocks.push("... [more project rules omitted to fit the context budget]");
      break;
    }
    blocks.push(block);
    used += block.length;
  }
  if (!blocks.length) return undefined;
  return [
    "Project rules (follow these unless they conflict with tool approval or safety rules):",
    "",
    blocks.join("\n\n"),
  ].join("\n");
}
