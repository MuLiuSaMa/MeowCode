/**
 * 学习产物的存储层。
 *
 * 目录布局（project = <workspace>/.meowcode/learning/，user = ~/.meowcode/learning/）：
 *
 *   profile.json        结构化用户模型（traits + 置信度 + 状态）
 *   guidelines.json     带 trigger 的项目经验
 *   ledger.json         效果账本（helped/hurt + 每日调用配额）
 *   journal.jsonl       审计（apply / rollback / retire / reject）
 *   outcomes.jsonl      回合经验，滚动 500 条
 *   state.json          水位（哪些会话已整理过）
 *   skills/<name>/SKILL.md     学到的技能
 *   proposals/<name>.md        工作流建议（纯文本，永不执行）
 *   history/<kind>/<name>/<rev>.md   覆盖前的原文快照，回滚用
 *
 * 纪律与 memory.ts 一致：索引/账本都是派生缓存，单文件才是真相源；
 * 任何一次读失败都退化成默认值，学习层出问题绝不能阻断对话。
 */
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { readJsonFile, writeJsonAtomic, writeTextAtomic } from "../atomic-json.js";
import { parseMarkdownFrontmatter } from "../../plugins/frontmatter.js";
import {
  assertPathInside,
  checkLearningContent,
  clipText,
  isValidLearningName,
  looksLikeLossyUpdate,
} from "./guard.js";
import {
  DEFAULT_DAILY_CALL_BUDGET,
  MAX_OUTCOME_RECORDS,
  PROMOTE_HELPED,
  RETIRE_HURT,
  adaptationId,
  isRetiredStatus,
  type Guideline,
  type GuidelineTrigger,
  type GuidelinesFile,
  type JournalEntry,
  type LedgerEntry,
  type LedgerFile,
  type LearningKind,
  type LearningOp,
  type LearningScope,
  type LearningStateFile,
  type LearningStatus,
  type ProfileFile,
  type TraitDimension,
  type TurnOutcomeRecord,
  type UserTrait,
} from "./types.js";

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

const PROFILE_FILE = "profile.json";
const GUIDELINES_FILE = "guidelines.json";
const LEDGER_FILE = "ledger.json";
const JOURNAL_FILE = "journal.jsonl";
const OUTCOMES_FILE = "outcomes.jsonl";
const STATE_FILE = "state.json";
const SKILLS_DIR = "skills";
const PROPOSALS_DIR = "proposals";
const HISTORY_DIR = "history";

/** 学习根目录。scope 决定跨项目还是本工作区。 */
export function learningRootFor(
  scope: LearningScope,
  workspace: string,
  homeDir?: string,
): string {
  if (scope === "user") {
    return path.join(homeDir ?? os.homedir(), ".meowcode", "learning");
  }
  return path.join(workspace, ".meowcode", "learning");
}

/** 同时拿到两层根目录。 */
export function learningRoots(
  workspace: string,
  homeDir?: string,
): Record<LearningScope, string> {
  return {
    user: learningRootFor("user", workspace, homeDir),
    project: learningRootFor("project", workspace, homeDir),
  };
}

function skillPath(root: string, name: string): string {
  const file = path.join(root, SKILLS_DIR, name, "SKILL.md");
  assertPathInside(root, file);
  return file;
}

function proposalPath(root: string, name: string): string {
  const file = path.join(root, PROPOSALS_DIR, `${name}.md`);
  assertPathInside(root, file);
  return file;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 文本归一化：用于按陈述/正文匹配「是不是同一条经验」。 */
function normalizeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s`"'“”‘’、，。；：！？,.;:!?()[\]{}]+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// profile.json
// ---------------------------------------------------------------------------

/**
 * 空默认值必须是工厂函数，不能是共享常量：
 * `{ ...EMPTY }` 只浅拷贝，items/traits 数组仍是同一个引用，
 * 一次 push 就会把「空默认值」本身改掉，让别的 scope 读到不该有的条目。
 */
function emptyProfile(): ProfileFile {
  return { version: 1, traits: [], updatedAt: "" };
}

export async function readProfile(root: string): Promise<ProfileFile> {
  const parsed = await readJsonFile<ProfileFile>(path.join(root, PROFILE_FILE)).catch(() => undefined);
  if (!parsed || !Array.isArray(parsed.traits)) return emptyProfile();
  return { version: 1, traits: parsed.traits, updatedAt: parsed.updatedAt ?? "" };
}

export async function writeProfile(root: string, profile: ProfileFile): Promise<void> {
  await writeJsonAtomic(
    path.join(root, PROFILE_FILE),
    { ...profile, version: 1, updatedAt: new Date().toISOString() },
    { pretty: true },
  );
}

/**
 * 特征合并：按 (dimension, 归一化 statement) 匹配。
 * 命中就抬置信度、追加证据；没命中就新增一条 tentative。
 * 不覆盖其他维度的既有特征 —— 学习器一次只该改它观察到的那一条。
 */
export async function mergeTraits(
  root: string,
  incoming: Array<{ dimension: TraitDimension; statement: string; userStated?: boolean; evidence?: string }>,
): Promise<{ added: string[]; updated: string[] }> {
  const profile = await readProfile(root);
  const added: string[] = [];
  const updated: string[] = [];
  for (const item of incoming) {
    const statement = clipText(item.statement, 200);
    if (!statement) continue;
    const key = normalizeKey(statement);
    const existing = profile.traits.find(
      (trait) => trait.dimension === item.dimension && normalizeKey(trait.statement) === key,
    );
    if (existing) {
      existing.confidence = Math.min(0.95, existing.confidence + 0.1);
      existing.lastConfirmed = today();
      if (item.userStated) {
        existing.userStated = true;
        existing.confidence = 0.95;
      }
      if (item.evidence && !existing.evidence.includes(item.evidence)) {
        existing.evidence.push(item.evidence);
        if (existing.evidence.length > 6) existing.evidence.shift();
      }
      if (existing.status === "tentative" && existing.confidence >= 0.7) existing.status = "active";
      updated.push(statement);
      continue;
    }
    profile.traits.push({
      dimension: item.dimension,
      statement,
      confidence: item.userStated ? 0.95 : 0.4,
      evidence: item.evidence ? [item.evidence] : [],
      lastConfirmed: today(),
      status: item.userStated ? "active" : "tentative",
      ...(item.userStated ? { userStated: true } : {}),
    });
    added.push(statement);
  }
  if (added.length || updated.length) await writeProfile(root, profile);
  return { added, updated };
}

// ---------------------------------------------------------------------------
// guidelines.json
// ---------------------------------------------------------------------------

function emptyGuidelines(): GuidelinesFile {
  return { version: 1, items: [], updatedAt: "" };
}

export async function readGuidelines(root: string): Promise<GuidelinesFile> {
  const parsed = await readJsonFile<GuidelinesFile>(path.join(root, GUIDELINES_FILE)).catch(
    () => undefined,
  );
  if (!parsed || !Array.isArray(parsed.items)) return emptyGuidelines();
  return { version: 1, items: parsed.items, updatedAt: parsed.updatedAt ?? "" };
}

export async function writeGuidelines(root: string, file: GuidelinesFile): Promise<void> {
  await writeJsonAtomic(
    path.join(root, GUIDELINES_FILE),
    { ...file, version: 1, updatedAt: new Date().toISOString() },
    { pretty: true },
  );
}

/** 内容哈希做 id：同一条经验重写后 id 不变，账本才能续上。 */
function hashId(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36).padStart(6, "0").slice(0, 8);
}

export function guidelineId(text: string): string {
  return hashId(normalizeKey(text));
}

export async function mergeGuidelines(
  root: string,
  incoming: Array<{ id?: string; text: string; trigger: GuidelineTrigger }>,
): Promise<{ added: string[]; updated: string[] }> {
  const file = await readGuidelines(root);
  const added: string[] = [];
  const updated: string[] = [];
  for (const item of incoming) {
    const text = clipText(item.text, 300);
    if (!text) continue;
    const key = normalizeKey(text);
    const existing = file.items.find(
      (entry) => (item.id && entry.id === item.id) || normalizeKey(entry.text) === key,
    );
    if (existing) {
      existing.text = text;
      existing.trigger = item.trigger;
      existing.confidence = Math.min(0.95, existing.confidence + 0.1);
      // 曾被判退役的经验再次被观察到：说明当初退役可能误伤，回到 tentative 重新考察
      if (existing.status === "retired") existing.status = "tentative";
      updated.push(text);
      continue;
    }
    file.items.push({
      id: item.id || guidelineId(text),
      text,
      trigger: item.trigger,
      status: "tentative",
      confidence: 0.4,
      created: today(),
    });
    added.push(text);
  }
  if (added.length || updated.length) await writeGuidelines(root, file);
  return { added, updated };
}

// ---------------------------------------------------------------------------
// 技能
// ---------------------------------------------------------------------------

export type LearnedSkill = {
  name: string;
  description: string;
  status: LearningStatus;
  created: string;
  revision: number;
  evidence: number;
  /** 正文（不含 frontmatter）。 */
  body: string;
  path: string;
};

/** 列出学习根下的全部技能；坏文件跳过（学习层不该因一条烂数据整体失效）。 */
export async function listLearnedSkills(root: string): Promise<LearnedSkill[]> {
  const dir = path.join(root, SKILLS_DIR);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const skills: LearnedSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidLearningName(entry.name)) continue;
    const file = path.join(dir, entry.name, "SKILL.md");
    try {
      const raw = await fs.readFile(file, "utf8");
      const { meta, body } = parseMarkdownFrontmatter(raw);
      if (!meta.description) continue; // 无描述的技能没有索引价值
      skills.push({
        name: meta.name || entry.name,
        description: meta.description,
        status: (meta.status as LearningStatus) || "tentative",
        created: meta.created ?? "",
        revision: Number(meta.revision ?? "1") || 1,
        evidence: Number(meta.evidence ?? "1") || 1,
        body,
        path: file,
      });
    } catch {
      continue;
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name, "en"));
}

export async function readLearnedSkill(root: string, name: string): Promise<LearnedSkill | null> {
  if (!isValidLearningName(name)) return null;
  const file = skillPath(root, name);
  try {
    const raw = await fs.readFile(file, "utf8");
    const { meta, body } = parseMarkdownFrontmatter(raw);
    return {
      name: meta.name || name,
      description: meta.description ?? "",
      status: (meta.status as LearningStatus) || "tentative",
      created: meta.created ?? "",
      revision: Number(meta.revision ?? "1") || 1,
      evidence: Number(meta.evidence ?? "1") || 1,
      body,
      path: file,
    };
  } catch {
    return null;
  }
}

/** 覆盖前把原文存进 history/，回滚就靠它。 */
async function snapshot(root: string, kind: LearningKind, name: string, revision: number, text: string): Promise<string> {
  const dir = path.join(root, HISTORY_DIR, kind, name);
  assertPathInside(root, dir);
  await fs.mkdir(dir, { recursive: true });
  const id = `${revision}`;
  await writeTextAtomic(path.join(dir, `${id}.md`), text);
  return id;
}

function renderSkillFile(input: {
  name: string;
  description: string;
  status: LearningStatus;
  created: string;
  revision: number;
  evidence: number;
  body: string;
}): string {
  const lines = [
    "---",
    `name: ${input.name}`,
    `description: ${input.description.replace(/\s+/g, " ").trim()}`,
    "origin: learned",
    `status: ${input.status}`,
    `created: ${input.created}`,
    `revision: ${input.revision}`,
    `evidence: ${input.evidence}`,
    "---",
    "",
    input.body.replace(/\s+$/, ""),
  ];
  return `${lines.join("\n")}\n`;
}

export type WriteSkillResult =
  | { written: true; snapshotId?: string; revision: number }
  | { written: false; reason: string };

/**
 * 写入/更新一个学习技能。
 * 更新时保留 created，revision 自增，evidence 累加；正文明显变短且丢参数则拒绝。
 */
export async function writeLearnedSkill(
  root: string,
  input: {
    name: string;
    description: string;
    content: string;
    scope: LearningScope;
    actor: "learner" | "model";
  },
): Promise<WriteSkillResult> {
  if (!isValidLearningName(input.name)) return { written: false, reason: "invalid name" };
  const description = clipText(input.description, 200);
  if (!description) return { written: false, reason: "missing description" };
  const contentError = checkLearningContent(input.content, "skill");
  if (contentError) return { written: false, reason: contentError };

  const file = skillPath(root, input.name);
  const existing = await readLearnedSkill(root, input.name);
  if (existing && isRetiredStatus(existing.status)) {
    // 退役是评估器的判决：学习器不能自己翻案，只能由用户在设置页重新激活
    return { written: false, reason: "skill is retired; ask the user to reactivate it" };
  }
  if (existing && looksLikeLossyUpdate(existing.body, input.content)) {
    await appendJournal(root, {
      action: "reject",
      scope: input.scope,
      kind: "skill",
      name: input.name,
      revision: existing.revision,
      actor: input.actor,
      reason: "lossy update: shorter content dropped command flags",
    }).catch(() => undefined);
    return { written: false, reason: "lossy update dropped command flags" };
  }

  const revision = (existing?.revision ?? 0) + 1;
  let snapshotId: string | undefined;
  if (existing) {
    const raw = await fs.readFile(file, "utf8").catch(() => null);
    if (raw) snapshotId = await snapshot(root, "skill", input.name, existing.revision, raw);
  }
  const text = renderSkillFile({
    name: input.name,
    description,
    status: existing?.status ?? "tentative",
    created: existing?.created || today(),
    revision,
    evidence: (existing?.evidence ?? 0) + 1,
    body: input.content,
  });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeTextAtomic(file, text);
  return { written: true, revision, ...(snapshotId ? { snapshotId } : {}) };
}

/** 退役：改 frontmatter 状态，文件保留（支持人工审查与重新激活）。 */
export async function setSkillStatus(
  root: string,
  name: string,
  status: LearningStatus,
): Promise<boolean> {
  const skill = await readLearnedSkill(root, name);
  if (!skill) return false;
  const text = renderSkillFile({
    name: skill.name,
    description: skill.description,
    status,
    created: skill.created,
    revision: skill.revision,
    evidence: skill.evidence,
    body: skill.body,
  });
  await writeTextAtomic(skillPath(root, name), text);
  return true;
}

/** 回滚到上一版：从 history/ 取 revision-1 的原文写回。 */
export async function rollbackSkill(root: string, name: string): Promise<boolean> {
  const skill = await readLearnedSkill(root, name);
  if (!skill || skill.revision <= 1) return false;
  const previous = path.join(root, HISTORY_DIR, "skill", name, `${skill.revision - 1}.md`);
  const raw = await fs.readFile(previous, "utf8").catch(() => null);
  if (!raw) return false;
  await writeTextAtomic(skillPath(root, name), raw);
  return true;
}

/** 删除技能（用户显式操作）。 */
export async function deleteLearnedSkill(root: string, name: string): Promise<boolean> {
  if (!isValidLearningName(name)) return false;
  const dir = path.join(root, SKILLS_DIR, name);
  assertPathInside(root, dir);
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

/**
 * 清空一个学习根下的全部产物（设置页「清除所有学到的」，不可撤销）。
 *
 * 刻意逐个列举而不是 `rm -rf root`：只删我们自己写的东西，
 * 未来往这个目录里放别的文件时不会被误伤；每一项都过路径断言。
 */
export async function clearLearningRoot(root: string): Promise<void> {
  const entries = [
    PROFILE_FILE,
    GUIDELINES_FILE,
    LEDGER_FILE,
    JOURNAL_FILE,
    OUTCOMES_FILE,
    STATE_FILE,
    SKILLS_DIR,
    PROPOSALS_DIR,
    HISTORY_DIR,
  ];
  for (const entry of entries) {
    const target = path.join(root, entry);
    assertPathInside(root, target);
    await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// proposals
// ---------------------------------------------------------------------------

export async function writeProposal(root: string, name: string, content: string): Promise<boolean> {
  if (!isValidLearningName(name)) return false;
  const text = clipText(content, 4_000);
  if (!text) return false;
  const file = proposalPath(root, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeTextAtomic(file, `${text}\n`);
  return true;
}

// ---------------------------------------------------------------------------
// ledger.json
// ---------------------------------------------------------------------------

function emptyLedger(): LedgerFile {
  return { version: 1, updatedAt: "", perAdaptation: {}, dailyCalls: { date: "", count: 0 } };
}

export async function readLedger(root: string): Promise<LedgerFile> {
  const parsed = await readJsonFile<LedgerFile>(path.join(root, LEDGER_FILE)).catch(() => undefined);
  if (!parsed || typeof parsed.perAdaptation !== "object") return emptyLedger();
  return {
    version: 1,
    updatedAt: parsed.updatedAt ?? "",
    perAdaptation: parsed.perAdaptation ?? {},
    dailyCalls: parsed.dailyCalls ?? { date: "", count: 0 },
  };
}

export async function writeLedger(root: string, ledger: LedgerFile): Promise<void> {
  await writeJsonAtomic(
    path.join(root, LEDGER_FILE),
    { ...ledger, version: 1, updatedAt: new Date().toISOString() },
    { pretty: true },
  );
}

function emptyEntry(): LedgerEntry {
  return { helped: 0, hurt: 0, applied: 0, status: "tentative", revision: 1, lastOutcomeAt: "" };
}

/**
 * 归因一次召回效果，并按阈值晋升/退役。
 * 返回值里的 promoted/retired 用于让调用方写 journal 与刷新技能状态。
 *
 * 账本是权威、frontmatter 是投影：状态变化后同步写回技能文件，
 * 否则设置页与召回过滤会看到一个永远不会转正/退役的「僵尸试用期」。
 */
export async function recordEffect(
  root: string,
  ids: string[],
  effect: "helped" | "hurt",
): Promise<{ promoted: string[]; retired: string[] }> {
  const promoted: string[] = [];
  const retired: string[] = [];
  if (!ids.length) return { promoted, retired };
  const ledger = await readLedger(root);
  const now = new Date().toISOString();
  for (const id of ids) {
    const entry = ledger.perAdaptation[id] ?? emptyEntry();
    entry.applied += 1;
    entry.lastOutcomeAt = now;
    if (effect === "helped") {
      entry.helped += 1;
      if (entry.status !== "retired" && entry.helped >= PROMOTE_HELPED && entry.hurt === 0) {
        entry.status = "active";
        promoted.push(id);
      }
    } else {
      entry.hurt += 1;
      if (entry.status !== "retired" && entry.hurt >= RETIRE_HURT) {
        entry.status = "retired";
        retired.push(id);
      }
    }
    ledger.perAdaptation[id] = entry;
  }
  await writeLedger(root, ledger);
  for (const id of promoted) await syncSkillStatus(root, id, "active");
  for (const id of retired) await syncSkillStatus(root, id, "retired");
  return { promoted, retired };
}

/** 账本 id -> 技能文件状态投影；非技能 id 直接跳过。 */
async function syncSkillStatus(
  root: string,
  id: string,
  status: LearningStatus,
): Promise<void> {
  const parts = id.split(":");
  if (parts.length < 3 || parts[1] !== "skill") return;
  const name = parts.slice(2).join(":");
  await setSkillStatus(root, name, status).catch(() => undefined);
}

/** 记一次「被召回但未归因」的应用次数。 */
export async function recordApplied(root: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const ledger = await readLedger(root);
  for (const id of ids) {
    const entry = ledger.perAdaptation[id] ?? emptyEntry();
    entry.applied += 1;
    ledger.perAdaptation[id] = entry;
  }
  await writeLedger(root, ledger);
}

/** 每日调用配额：跨进程重启守住预算，超限返回 false。 */
export async function consumeDailyBudget(
  root: string,
  budget = DEFAULT_DAILY_CALL_BUDGET,
): Promise<boolean> {
  if (!Number.isFinite(budget) || budget <= 0) return true; // 0/负数视为不限
  const ledger = await readLedger(root);
  const day = today();
  if (ledger.dailyCalls.date !== day) ledger.dailyCalls = { date: day, count: 0 };
  if (ledger.dailyCalls.count >= budget) return false;
  ledger.dailyCalls.count += 1;
  await writeLedger(root, ledger);
  return true;
}

/** 读两层账本，汇总出「该被召回跳过」的技能名。 */
export async function listRetiredSkillNames(
  workspace: string,
  homeDir?: string,
): Promise<Set<string>> {
  const retired = new Set<string>();
  const roots = learningRoots(workspace, homeDir);
  for (const scope of ["user", "project"] as const) {
    const skills = await listLearnedSkills(roots[scope]).catch(() => []);
    for (const skill of skills) {
      if (isRetiredStatus(skill.status)) retired.add(skill.name);
    }
    const ledger = await readLedger(roots[scope]).catch(() => emptyLedger());
    for (const [id, entry] of Object.entries(ledger.perAdaptation)) {
      if (!isRetiredStatus(entry.status)) continue;
      const parts = id.split(":");
      if (parts[1] === "skill" && parts[2]) retired.add(parts.slice(2).join(":"));
    }
  }
  return retired;
}

// ---------------------------------------------------------------------------
// journal.jsonl
// ---------------------------------------------------------------------------

export async function appendJournal(
  root: string,
  entry: Omit<JournalEntry, "id" | "ts">,
): Promise<void> {
  const file = path.join(root, JOURNAL_FILE);
  const record: JournalEntry = { id: randomUUID().slice(0, 8), ts: new Date().toISOString(), ...entry };
  await fs.mkdir(root, { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
}

export async function readJournal(root: string, limit = 100): Promise<JournalEntry[]> {
  try {
    const text = await fs.readFile(path.join(root, JOURNAL_FILE), "utf8");
    const lines = text.split("\n").filter((line) => line.trim());
    return lines
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line) as JournalEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is JournalEntry => entry !== null)
      .reverse();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// outcomes.jsonl
// ---------------------------------------------------------------------------

export async function appendOutcome(root: string, record: TurnOutcomeRecord): Promise<void> {
  const file = path.join(root, OUTCOMES_FILE);
  const existing = await readOutcomes(root, MAX_OUTCOME_RECORDS * 2);
  existing.push(record);
  const kept = existing.slice(-MAX_OUTCOME_RECORDS);
  await fs.mkdir(root, { recursive: true });
  await writeTextAtomic(file, `${kept.map((item) => JSON.stringify(item)).join("\n")}\n`);
}

export async function readOutcomes(root: string, limit = MAX_OUTCOME_RECORDS): Promise<TurnOutcomeRecord[]> {
  try {
    const text = await fs.readFile(path.join(root, OUTCOMES_FILE), "utf8");
    const records = text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as TurnOutcomeRecord;
        } catch {
          return null;
        }
      })
      .filter((record): record is TurnOutcomeRecord => record !== null);
    return records.slice(-limit);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// state.json
// ---------------------------------------------------------------------------

export async function readState(root: string): Promise<LearningStateFile> {
  const parsed = await readJsonFile<LearningStateFile>(path.join(root, STATE_FILE)).catch(
    () => undefined,
  );
  if (!parsed || typeof parsed.watermarks !== "object") {
    return { version: 1, lastIdleAt: 0, watermarks: {} };
  }
  return { version: 1, lastIdleAt: parsed.lastIdleAt ?? 0, watermarks: parsed.watermarks ?? {} };
}

export async function writeState(root: string, state: LearningStateFile): Promise<void> {
  await writeJsonAtomic(path.join(root, STATE_FILE), { ...state, version: 1 }, { pretty: true });
}

// ---------------------------------------------------------------------------
// 批量应用
// ---------------------------------------------------------------------------

export type ApplyContext = {
  workspace: string;
  homeDir?: string;
  maxSkills: number;
  actor: "learner" | "model";
  /** 手写技能名集合：同名时学习产物必须让路。 */
  handwrittenSkills?: Set<string>;
  /** 本轮回合摘要，写进 profile 的 evidence。 */
  evidence?: string;
};

export type ApplyResult = {
  applied: string[];
  rejected: Array<{ id: string; reason: string }>;
};

/**
 * 逐条应用学习产出。单条失败只记 rejected，不中断其余 ——
 * 学习是后台增强，一条坏数据不该让整批白跑。
 */
export async function applyLearningOps(
  ops: LearningOp[],
  context: ApplyContext,
): Promise<ApplyResult> {
  const result: ApplyResult = { applied: [], rejected: [] };
  const roots = learningRoots(context.workspace, context.homeDir);
  const handwritten = context.handwrittenSkills ?? new Set<string>();

  for (const op of ops) {
    const root = roots[op.scope];
    try {
      switch (op.op) {
        case "profile": {
          const merged = await mergeTraits(root, [
            {
              dimension: op.dimension,
              statement: op.statement,
              ...(op.userStated ? { userStated: true } : {}),
              ...(context.evidence ? { evidence: context.evidence } : {}),
            },
          ]);
          if (merged.added.length || merged.updated.length) {
            result.applied.push(`${op.scope}:profile:${merged.added[0] ?? merged.updated[0]}`);
          }
          break;
        }
        case "guideline": {
          const merged = await mergeGuidelines(root, [
            {
              ...(op.id ? { id: op.id } : {}),
              text: op.text,
              trigger: op.trigger,
            },
          ]);
          if (merged.added.length || merged.updated.length) {
            const text = merged.added[0] ?? merged.updated[0];
            result.applied.push(adaptationId(op.scope, "guideline", guidelineId(text)));
          }
          break;
        }
        case "skill": {
          if (handwritten.has(op.name)) {
            result.rejected.push({
              id: adaptationId(op.scope, "skill", op.name),
              reason: "name collides with a handwritten skill",
            });
            break;
          }
          const skills = await listLearnedSkills(root);
          const isNew = !skills.some((skill) => skill.name === op.name);
          if (isNew && skills.length >= context.maxSkills) {
            const target = op.replaces;
            if (!target) {
              result.rejected.push({
                id: adaptationId(op.scope, "skill", op.name),
                reason: `at capacity (${skills.length}/${context.maxSkills}); set "replaces" to retire an old skill`,
              });
              break;
            }
            const victim = skills.find((skill) => skill.name === target);
            if (!victim) {
              result.rejected.push({
                id: adaptationId(op.scope, "skill", op.name),
                reason: `replaces target "${target}" not found`,
              });
              break;
            }
            // 只允许替换试用期或还没帮上忙的技能，别让模型把高价值技能顶掉
            const ledger = await readLedger(root);
            const stats = ledger.perAdaptation[adaptationId(op.scope, "skill", target)];
            const expendable = victim.status !== "active" && (!stats || stats.helped === 0);
            if (!expendable) {
              result.rejected.push({
                id: adaptationId(op.scope, "skill", op.name),
                reason: `replaces target "${target}" has proven value; cannot retire it automatically`,
              });
              break;
            }
            await setSkillStatus(root, target, "retired");
            await appendJournal(root, {
              action: "retire",
              scope: op.scope,
              kind: "skill",
              name: target,
              revision: victim.revision,
              actor: context.actor,
              reason: `replaced by ${op.name} at capacity`,
            });
          }
          const written = await writeLearnedSkill(root, {
            name: op.name,
            description: op.description,
            content: op.content,
            scope: op.scope,
            actor: context.actor,
          });
          if (!written.written) {
            result.rejected.push({ id: adaptationId(op.scope, "skill", op.name), reason: written.reason });
            break;
          }
          await appendJournal(root, {
            action: "apply",
            scope: op.scope,
            kind: "skill",
            name: op.name,
            revision: written.revision,
            ...(written.snapshotId ? { snapshotId: written.snapshotId } : {}),
            actor: context.actor,
            ...(op.reason ? { reason: op.reason } : {}),
          });
          result.applied.push(adaptationId(op.scope, "skill", op.name));
          break;
        }
        case "proposal": {
          const ok = await writeProposal(root, op.name, op.content);
          if (!ok) {
            result.rejected.push({
              id: adaptationId(op.scope, "proposal", op.name),
              reason: "invalid name or empty content",
            });
            break;
          }
          await appendJournal(root, {
            action: "apply",
            scope: op.scope,
            kind: "proposal",
            name: op.name,
            revision: 1,
            actor: context.actor,
            ...(op.reason ? { reason: op.reason } : {}),
          });
          result.applied.push(adaptationId(op.scope, "proposal", op.name));
          break;
        }
        default:
          break;
      }
    } catch (error) {
      result.rejected.push({
        id: `${op.scope}:${op.op}`,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
