import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { writeTextAtomic } from "./atomic-json.js";

/**
 * 跨会话持久记忆（Claude Code auto-memory 模式）：
 * - MEMORY.md 索引（一行一条 `- [name](name.md) — 一句话钩子`）会话启动时注入指令块；
 * - 每条事实一个 `<name>.md` 文件（frontmatter: description / created / type），模型按需 memory_read。
 * - 双层范围：user = `~/.meowcode/memory/`（跨项目），project = `<workspace>/.meowcode/memory/`。
 * 索引只是派生缓存：单事实文件里的 frontmatter 才是 description 的真相源，
 * 手工编辑/未登记索引的文件会在 listMemories 里并入，不会丢。
 */

export type MemoryScope = "user" | "project";

/** 记忆分类（ZCode 同款分类学）：蒸馏提示与设置 UI 都按它组织。 */
export type MemoryType = "user" | "feedback" | "project" | "reference";

export const MEMORY_TYPES: readonly MemoryType[] = ["user", "feedback", "project", "reference"];

export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value);
}

export type MemoryEntry = {
  name: string;
  description: string;
};

export type MemoryItem = {
  name: string;
  description: string;
  /** frontmatter 里的创建日期（YYYY-MM-DD）；缺 frontmatter 时为 null */
  created: string | null;
  /** 文件 mtime（ISO）；文件丢失时为 null */
  mtime: string | null;
};

export type MemoryRecord = MemoryEntry & {
  created: string | null;
  /** 文件原文（含 frontmatter），模型/UI 编辑都以它为准 */
  raw: string;
};

export const MEMORY_INDEX_NAME = "MEMORY.md";

/** 记忆名：小写 kebab-case，1-64 字符，不能首尾连字符。 */
const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

/** Windows 文件系统大小写不敏感：name "memory" 会撞 MEMORY.md，必须拒绝。 */
export function isValidMemoryName(name: string): boolean {
  return NAME_PATTERN.test(name) && name.toLowerCase() !== "memory";
}

export function memoryDirFor(scope: MemoryScope, workspace: string, homeDir?: string): string {
  if (scope === "user") {
    return path.join(homeDir ?? os.homedir(), ".meowcode", "memory");
  }
  return path.join(workspace, ".meowcode", "memory");
}

export function memoryFilePath(dir: string, name: string): string {
  return path.join(dir, `${name}.md`);
}

// ---------------------------------------------------------------------------
// 索引解析与维护
// ---------------------------------------------------------------------------

const INDEX_LINE_PATTERNS: RegExp[] = [
  // 规范格式：- [name](name.md) — description（方括号文本仅展示用，名字取链接目标）
  /^[-*]\s*\[[^\]]*\]\(([a-z0-9][a-z0-9-]*)\.md\)\s*(?:—\s*(.*))?$/,
  // 手写格式：- name — description（分隔符必须有，否则正文歧义）
  /^[-*]\s*([a-z0-9][a-z0-9-]*)(?:\.md)?\s+—\s+(.*)$/,
];

/** 解析单行索引；非条目行（标题、注释、空行）返回 null，重写索引时原样保留。 */
export function parseMemoryIndexLine(line: string): MemoryEntry | null {
  const trimmed = line.trim();
  for (const pattern of INDEX_LINE_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) return { name: match[1], description: (match[2] ?? "").trim() };
  }
  return null;
}

export function parseMemoryIndex(text: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const entry = parseMemoryIndexLine(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

export function renderIndexEntry(entry: MemoryEntry): string {
  const description = entry.description.trim();
  return description
    ? `- [${entry.name}](${entry.name}.md) — ${description}`
    : `- [${entry.name}](${entry.name}.md)`;
}

async function readTextIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * 索引条目列表（不读单事实文件）：索引行优先，目录里未登记的 *.md 并入尾部。
 * 索引与文件系统都不可用时返回空数组——记忆缺失不应阻断对话。
 */
export async function listMemories(dir: string): Promise<MemoryEntry[]> {
  const entries: MemoryEntry[] = [];
  const seen = new Set<string>();
  const indexText = await readTextIfExists(path.join(dir, MEMORY_INDEX_NAME));
  if (indexText) {
    for (const entry of parseMemoryIndex(indexText)) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      entries.push(entry);
    }
  }
  let files: string[] = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return entries;
  }
  for (const file of files.sort()) {
    const lower = file.toLowerCase();
    if (!lower.endsWith(".md") || lower === MEMORY_INDEX_NAME.toLowerCase()) continue;
    const name = file.slice(0, -3);
    if (seen.has(name) || !isValidMemoryName(name)) continue;
    seen.add(name);
    entries.push({ name, description: "" });
  }
  return entries;
}

/** 带文件元数据的完整列表（管理 UI 用）；单个文件读失败不拖垮整表。 */
export async function listMemoryItems(dir: string): Promise<MemoryItem[]> {
  const entries = await listMemories(dir);
  const items: MemoryItem[] = [];
  for (const entry of entries) {
    const file = memoryFilePath(dir, entry.name);
    try {
      const [raw, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
      const fields = parseMemoryFile(raw);
      items.push({
        name: entry.name,
        description: fields.description ?? entry.description,
        created: fields.created,
        mtime: stat.mtime.toISOString(),
      });
    } catch {
      items.push({ name: entry.name, description: entry.description, created: null, mtime: null });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// 单事实文件
// ---------------------------------------------------------------------------

export type MemoryFileFields = {
  description: string | null;
  created: string | null;
  type: MemoryType | null;
};

/** 解析 frontmatter 里的 description / created / type；没有 frontmatter 就全为 null。 */
export function parseMemoryFile(raw: string): MemoryFileFields {
  if (!raw.startsWith("---")) return { description: null, created: null, type: null };
  const lines = raw.split(/\r?\n/);
  const fields: MemoryFileFields = { description: null, created: null, type: null };
  // 第 0 行是开头 ---，扫描到闭合 --- 为止；body 里的 --- 不参与
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "---") return fields;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (key !== "description" && key !== "created" && key !== "type") continue;
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key === "description") fields.description = value;
    else if (key === "created") fields.created = value;
    else if (isMemoryType(value)) fields.type = value;
  }
  return fields;
}

export async function readMemory(dir: string, name: string): Promise<MemoryRecord | null> {
  if (!isValidMemoryName(name)) return null;
  const raw = await readTextIfExists(memoryFilePath(dir, name));
  if (raw === null) return null;
  const fields = parseMemoryFile(raw);
  return { name, description: fields.description ?? "", created: fields.created, raw };
}

/** 首行 description 折叠成单行（索引行不能断行）。 */
function singleLineDescription(description: string): string {
  return description.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * 写入单事实文件原文并同步索引（description 以 frontmatter 为准）。
 * 无 frontmatter 的原文也允许写（管理 UI 手工编辑），索引条目不带描述。
 */
export async function writeMemoryFile(dir: string, name: string, raw: string): Promise<void> {
  if (!isValidMemoryName(name)) {
    throw new Error(
      `Invalid memory name "${name}": use lowercase kebab-case (letters, digits, hyphens), up to 64 characters.`,
    );
  }
  await fs.mkdir(dir, { recursive: true });
  await writeTextAtomic(memoryFilePath(dir, name), raw.endsWith("\n") ? raw : `${raw}\n`);
  const fields = parseMemoryFile(raw);
  const description = fields.description ? singleLineDescription(fields.description) : "";
  await upsertIndexEntry(dir, name, description);
}

/** 模型工具路径：由结构化字段拼装文件（覆盖时保留原 created 日期）。 */
export async function saveMemory(
  dir: string,
  name: string,
  input: { description: string; content: string; type?: MemoryType },
): Promise<{ existed: boolean }> {
  const existing = await readMemory(dir, name);
  const created = existing?.created ?? new Date().toISOString().slice(0, 10);
  const description = singleLineDescription(input.description);
  // type 覆盖时以新值为准；未给则保留旧值（手工补的类型不被一次更新抹掉）
  const previous = existing ? parseMemoryFile(existing.raw).type : null;
  const type = input.type ?? previous;
  const headerLines = ["---"];
  if (description) headerLines.push(`description: ${description}`);
  if (type) headerLines.push(`type: ${type}`);
  headerLines.push(`created: ${created}`, "---", "");
  const body = input.content.replace(/\s+$/, "");
  await writeMemoryFile(dir, name, `${headerLines.join("\n")}${body}\n`);
  return { existed: existing !== null };
}

/** 删除文件并清掉索引行；两者都不存在返回 false。 */
export async function deleteMemory(dir: string, name: string): Promise<boolean> {
  if (!isValidMemoryName(name)) return false;
  let removed = false;
  try {
    await fs.unlink(memoryFilePath(dir, name));
    removed = true;
  } catch {
    // 文件不存在也要继续清索引
  }
  const indexChanged = await removeIndexEntry(dir, name);
  return removed || indexChanged;
}

/**
 * 清空一层记忆：删除索引与本层所有可识别的记忆文件。
 * 只处理 listMemories 能识别的条目，避免误删目录里的其它文件。
 */
export async function clearMemories(dir: string): Promise<number> {
  const entries = await listMemories(dir);
  for (const entry of entries) {
    try {
      await fs.unlink(memoryFilePath(dir, entry.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  try {
    await fs.unlink(path.join(dir, MEMORY_INDEX_NAME));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return entries.length;
}

// ---------------------------------------------------------------------------
// MEMORY.md 重写（保留非条目行；同名多行去重为一行）
// ---------------------------------------------------------------------------

async function upsertIndexEntry(dir: string, name: string, description: string): Promise<void> {
  const indexPath = path.join(dir, MEMORY_INDEX_NAME);
  const existing = (await readTextIfExists(indexPath)) ?? "";
  const line = renderIndexEntry({ name, description });
  const out: string[] = [];
  let replaced = false;
  for (const line_ of existing.split(/\r?\n/)) {
    const entry = parseMemoryIndexLine(line_);
    if (entry?.name === name) {
      if (!replaced) {
        out.push(line);
        replaced = true;
      }
      continue;
    }
    out.push(line_);
  }
  if (!replaced) out.push(line);
  await writeTextAtomic(indexPath, `${out.join("\n").replace(/\n+$/, "")}\n`);
}

async function removeIndexEntry(dir: string, name: string): Promise<boolean> {
  const indexPath = path.join(dir, MEMORY_INDEX_NAME);
  const existing = await readTextIfExists(indexPath);
  if (existing === null) return false;
  const out: string[] = [];
  let removed = false;
  for (const line of existing.split(/\r?\n/)) {
    const entry = parseMemoryIndexLine(line);
    if (entry?.name === name) {
      removed = true;
      continue;
    }
    out.push(line);
  }
  if (!removed) return false;
  await writeTextAtomic(indexPath, `${out.join("\n").replace(/\n+$/, "")}\n`);
  return true;
}

// ---------------------------------------------------------------------------
// 会话启动注入
// ---------------------------------------------------------------------------

/** 每层索引的注入预算：记忆索引不该挤占 AGENTS.md 的指令空间。 */
const MAX_MEMORY_SECTION_CHARS_PER_SCOPE = 2_000;

/**
 * 使用准则（ZCode 同款分类学）。关键不只是"怎么存"，更是"什么时候存"：
 * 每类触发条件都要给模型可辨认的信号，feedback 还要显式提醒"安静的确认"——
 * 纠错容易被注意到，被默认接受的不寻常做法同样值得记。
 */
const MEMORY_GUIDE = [
  "Long-term memories persist across sessions. Only this index is loaded here — read an entry in full with memory_read(scope, name).",
  'Scopes: "user" = cross-project, "project" = this workspace.',
  "Save proactively with memory_write the moment you learn something reusable — do not ask first. What to save:",
  "- user: who the user is — role, expertise, preferences, workflows.",
  '- feedback: corrections ("don\'t do X") and quiet confirmations (an unusual approach accepted without pushback); include why.',
  "- project: decisions, goals and constraints not derivable from the code or git history; convert relative dates to absolute.",
  "- reference: external resources (URLs, dashboards, tickets) and their purpose.",
  "One fact per file; check the index first and update an existing entry instead of duplicating; delete wrong or outdated entries with memory_delete.",
  "Never store secrets, what the repo already records, or details that only matter to the current conversation.",
].join(" ");

/**
 * 组装注入 system 指令块的记忆段：两层索引 + 使用准则。
 * 永远返回段落（ZCode 同款）：索引为空时只注入准则，让冷启动的模型也知道
 * 可以主动存记忆——此前空目录时整段缺席，模型唯一的提示是埋在工具表里的
 * 一句 memory_write 描述，这是"模型从不主动写记忆"的主因。
 */
export async function loadMemorySection(workspace: string, homeDir?: string): Promise<string> {
  const scopes: Array<{ label: string; dir: string }> = [
    { label: "User memory (cross-project)", dir: memoryDirFor("user", workspace, homeDir) },
    { label: "Project memory (this workspace)", dir: memoryDirFor("project", workspace) },
  ];
  const parts: string[] = [];
  for (const { label, dir } of scopes) {
    const entries = await listMemories(dir).catch(() => [] as MemoryEntry[]);
    if (!entries.length) continue;
    let text = `### ${label}\n${entries.map(renderIndexEntry).join("\n")}`;
    if (text.length > MAX_MEMORY_SECTION_CHARS_PER_SCOPE) {
      text = `${text.slice(0, MAX_MEMORY_SECTION_CHARS_PER_SCOPE)}\n... [memory index truncated]`;
    }
    parts.push(text);
  }
  if (!parts.length) return `## Memory\n\n${MEMORY_GUIDE}`;
  return `## Memory\n\n${MEMORY_GUIDE}\n\n${parts.join("\n\n")}`;
}
