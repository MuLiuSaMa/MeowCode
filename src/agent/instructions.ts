import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWithinWorkspace } from "./paths.js";
import { loadMemorySection } from "./memory.js";
import { loadRulesForInstructions } from "./rules.js";
import { loadSkillIndexDetail } from "../plugins/skills.js";
import { learningRoots, listRetiredSkillNames, readProfile } from "./learning/store.js";
import { buildLearnedPreferencesSection } from "./learning/recall.js";

const MAX_INSTRUCTIONS_CHARS = 16_000;
/** 祖先目录 AGENTS.md 单层预算；总预算吃紧时先丢最外层，工作区根的规则永远优先 */
const MAX_ANCESTOR_CHARS = 4_000;
/** 向上收集祖先 AGENTS.md 的层数上限 */
const MAX_ANCESTOR_LEVELS = 5;
/** 这些目录名里的 AGENTS.md 一律不收（到即止）：系统目录的杂散规则是噪音 */
const SKIPPED_DIR_NAMES = new Set([
  "windows",
  "program files",
  "program files (x86)",
  "programdata",
  "appdata",
]);

export const INSTRUCTIONS_PREFIX =
  "Project instructions from the user's workspace (AGENTS.md, CLAUDE.md, project rules, and skills). Follow them as project-specific guidance; they do not override tool approval or safety rules.";

export type InstructionSettings = {
  /** 是否读取 AGENTS.md（含祖先目录与 .meowcode/AGENTS.md）；缺省 true */
  includeAgentsMd?: boolean;
  /** 是否读取工作区根的 CLAUDE.md / CLAUDE.local.md；缺省 true */
  includeClaudeMd?: boolean;
  /**
   * 是否注入跨会话记忆索引；缺省 true。
   * 记忆总开关关闭时由 runtime 传 false —— 记忆文件仍在磁盘，只是不再进上下文，
   * 模型要读就用普通 read_file（这也是「关掉不等于删掉」的落点）。
   */
  includeMemory?: boolean;
};

/** dir 是否包含 target（含相等）；Windows 路径大小写不敏感。 */
function containsDir(dir: string, target: string): boolean {
  const normalize = (value: string) =>
    process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  const relative = path.relative(normalize(dir), normalize(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * 从 workspace 向上收集祖先目录（外→内）：最多 MAX_ANCESTOR_LEVELS 层。
 * 盘根、用户主目录及其更外层、系统目录到即止——那里的 AGENTS.md 是全局噪音。
 */
async function ancestorDirs(workspace: string): Promise<string[]> {
  const home = path.resolve(os.homedir());
  const dirs: string[] = [];
  let current = path.resolve(workspace);
  for (let level = 0; level < MAX_ANCESTOR_LEVELS; level += 1) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
    // 盘根太泛不收；主目录及其更外层、系统目录到即止
    if (path.dirname(current) === current) break;
    if (containsDir(current, home)) break;
    if (SKIPPED_DIR_NAMES.has(path.basename(current).toLowerCase())) break;
    dirs.push(current);
  }
  return dirs.reverse();
}

/** 逐层读祖先 AGENTS.md：只信常规文件（lstat 拒绝符号链接/junction），每层单独截断。 */
async function readAncestorInstructions(workspace: string): Promise<string[]> {
  const parts: string[] = [];
  for (const dir of await ancestorDirs(workspace)) {
    try {
      const file = path.join(dir, "AGENTS.md");
      // 祖先在工作区外：符号链接/junction 指向哪里不可控，一律跳过
      const info = await fs.lstat(file);
      if (!info.isFile()) continue;
      let text = (await fs.readFile(file, "utf8")).trim();
      if (!text) continue;
      if (text.length > MAX_ANCESTOR_CHARS) {
        text = `${text.slice(0, MAX_ANCESTOR_CHARS)}\n... [AGENTS.md truncated]`;
      }
      parts.push(`<!-- from: ${dir} -->\n${text}`);
    } catch {
      // 缺失或不可读都跳过，不应阻断对话
    }
  }
  return parts;
}

/**
 * 学到的用户模型段：用户级在前、项目级在后，段内自己带预算。
 * 读取失败一律当作没有 —— 学习层出问题不能影响项目规则注入。
 */
async function loadLearnedPreferences(workspace: string, home: string): Promise<string | undefined> {
  try {
    const roots = learningRoots(workspace, home);
    const [userProfile, projectProfile] = await Promise.all([
      readProfile(roots.user),
      readProfile(roots.project),
    ]);
    return buildLearnedPreferencesSection({
      version: 1,
      updatedAt: "",
      traits: [...userProfile.traits, ...projectProfile.traits],
    });
  } catch {
    return undefined;
  }
}

/**
 * 读取工作区规则：祖先目录链（外→内，内层后出现覆盖语义上更近）+ 工作区根
 * AGENTS.md + .meowcode/AGENTS.md，最后追加 .meowcode/skills/ 技能索引，
 * 并挂上跨会话记忆索引（memory.ts，独立预算）。记忆读失败不影响规则注入。
 * 预算从内向外分配：工作区根优先足额，祖先每层 4k，总预算吃紧时先丢最外层。
 *
 * 学习段（用户模型）排在工作区规则之后、技能索引之前：它低于 AGENTS.md
 * 与 .meowcode/rules，高于技能索引，超出预算时按这个顺序先丢后面的。
 */
export type WorkspaceInstructionsDetail = {
  /** 合并后的系统指令文本；记忆段常驻，所以正常情况下总是有值 */
  text: string | undefined;
  /** 技能索引段（若存在，已包含在 text 中；单独给出用于上下文归因） */
  skillIndex: string | undefined;
  /** 发现的技能数量 */
  skillCount: number;
};

export async function loadWorkspaceInstructionsDetail(
  workspace: string,
  homeDir?: string,
  settings: InstructionSettings = {},
  builtinSkillsDir?: string,
): Promise<WorkspaceInstructionsDetail> {
  const home = homeDir !== undefined ? homeDir : os.homedir();
  const includeAgents = settings.includeAgentsMd !== false;
  const includeClaude = settings.includeClaudeMd !== false;
  const includeMemory = settings.includeMemory !== false;
  const memorySection = includeMemory
    ? await loadMemorySection(workspace, home).catch(() => undefined)
    : undefined;
  const candidates: string[] = [];
  if (includeAgents) {
    candidates.push("AGENTS.md", path.join(".meowcode", "AGENTS.md"));
  }
  if (includeClaude) {
    candidates.push("CLAUDE.md", "CLAUDE.local.md");
  }
  const workspaceParts: string[] = [];
  for (const relative of candidates) {
    try {
      // 走 realpath 边界：仓库里的 junction/软链接不能把工作区外的文件读进每轮请求
      const file = await resolveWithinWorkspace(workspace, relative);
      const info = await fs.stat(file);
      if (!info.isFile()) continue;
      const text = (await fs.readFile(file, "utf8")).trim();
      if (text) workspaceParts.push(text);
    } catch {
      // 缺失、越界或不可读都不应阻断对话
    }
  }
  // 设置页创建的规则独立于 AGENTS / CLAUDE 开关，始终注入
  const projectRules = await loadRulesForInstructions(workspace).catch(() => undefined);
  if (projectRules) workspaceParts.push(projectRules);
  // 学到的用户模型：优先级低于 AGENTS.md 与项目规则，高于技能索引。
  // 段内已带「AGENTS.md 与项目规则冲突时优先」的仲裁说明。
  const learnedSection = await loadLearnedPreferences(workspace, home);
  if (learnedSection) workspaceParts.push(learnedSection);
  let skillIndex: string | undefined;
  let skillCount = 0;
  try {
    // 退役的学习技能不进索引：账本是权威，一次会话读一次盘
    const retired = await listRetiredSkillNames(workspace, home).catch(() => new Set<string>());
    const skills = await loadSkillIndexDetail({
      workspace,
      homeDir: home,
      exclude: retired,
      ...(builtinSkillsDir ? { builtinDir: builtinSkillsDir } : {}),
    });
    skillIndex = skills.text;
    skillCount = skills.count;
    if (skillIndex) workspaceParts.push(skillIndex);
  } catch {
    // 技能发现失败不应阻断对话
  }
  const ancestors = includeAgents ? await readAncestorInstructions(workspace) : [];
  if (!workspaceParts.length && !ancestors.length) {
    // 只有记忆没有 AGENTS.md：记忆段自带标题与准则，直接返回
    return { text: memorySection, skillIndex, skillCount };
  }

  // 内→外逐层并入祖先：放得下才加，天然实现「超预算先截最外层」
  let text = workspaceParts.join("\n\n");
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const candidate = `${ancestors[index]}\n\n${text}`;
    if (candidate.length > MAX_INSTRUCTIONS_CHARS) break;
    text = candidate;
  }
  if (text.length > MAX_INSTRUCTIONS_CHARS) {
    text = `${text.slice(0, MAX_INSTRUCTIONS_CHARS)}\n... [AGENTS.md truncated]`;
  }
  if (!text.trim()) return { text: memorySection, skillIndex, skillCount };
  const withMemory = memorySection ? `${INSTRUCTIONS_PREFIX}\n\n${text}\n\n${memorySection}` : `${INSTRUCTIONS_PREFIX}\n\n${text}`;
  return { text: withMemory, skillIndex, skillCount };
}

/** 只要合并文本的便捷入口（调用方不关心技能归因时用）。 */
export async function loadWorkspaceInstructions(
  workspace: string,
  homeDir?: string,
): Promise<string | undefined> {
  return (await loadWorkspaceInstructionsDetail(workspace, homeDir)).text;
}

/**
 * 指令源指纹：AGENTS.md / CLAUDE.md / .meowcode 下的规则文件与技能目录的
 * (mtime, size) 拼接。runtime 每回合比一次，变了才重读 —— 会话内改规则立即生效，
 * 没改则前缀字节不动，缓存不受影响。
 *
 * 读失败一律视为「不存在」：指纹只用来判脏，不能因为它阻断回合。
 */
export async function instructionSourceSignature(workspace: string): Promise<string> {
  const targets = [
    "AGENTS.md",
    "CLAUDE.md",
    "CLAUDE.local.md",
    path.join(".meowcode", "AGENTS.md"),
    path.join(".meowcode", "rules"),
    path.join(".meowcode", "skills"),
  ];
  const parts: string[] = [];
  for (const relative of targets) {
    try {
      const info = await fs.stat(path.join(workspace, relative));
      parts.push(`${relative}:${info.mtimeMs}:${info.size}`);
    } catch {
      parts.push(`${relative}:-`);
    }
  }
  return parts.join("|");
}
