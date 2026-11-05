/**
 * 召回层。
 *
 * 与 metis 的差异（见方案 D1）：MeowCode 的 system[1] 是会话级快照
 * （runtime.ts:6468 的 refreshInstructions 每会话只读一次），每回合改写它
 * 会让整段 prompt cache 作废。所以：
 *
 *  - 用户模型（profile）进 system[1]：它稳定、短、每会话变一次就够了；
 *  - 带 trigger 的项目经验走回合内召回，用 appendContextNote 追加到历史尾部，
 *    只追加前缀不变，缓存安全；
 *  - 技能不在这里召回 —— 技能索引本来就在 system[1] 里常驻，
 *    模型看到索引自己 read_file 取全文，比任何关键词匹配器都准。
 */
import type { Guideline, ProfileFile, UserTrait } from "./types.js";

/** 回合内召回预算：3 条 / 600 字符，够提示一次，不至于挤占对话。 */
export const MAX_RECALL_ITEMS = 3;
export const MAX_RECALL_CHARS = 600;

/** system[1] 里用户模型段的预算。 */
export const MAX_PROFILE_SECTION_CHARS = 1_200;

/** 召回匹配用的上下文：用户这句话 + 本回合的命令与错误。 */
export type RecallContext = {
  text: string;
  commands: string[];
  errors: string[];
};

// ---------------------------------------------------------------------------
// 用户模型段（system[1]）
// ---------------------------------------------------------------------------

const STATUS_ORDER: Record<string, number> = { active: 0, tentative: 1, retired: 2 };

/**
 * 把 profile 渲染成 system 指令段。
 * 固定加一句仲裁规则：学到的偏好永远低于 AGENTS.md 与项目规则，
 * 否则模型会在两者冲突时不知道该听谁的。
 */
export function buildLearnedPreferencesSection(profile: ProfileFile): string | undefined {
  const traits = profile.traits
    .filter((trait) => trait.status !== "retired")
    .sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9))
    .slice(0, 12);
  if (!traits.length) return undefined;

  const lines = [
    "## Learned preferences",
    "",
    "These were learned from past sessions. AGENTS.md and project rules win on conflict.",
  ];
  let used = lines.join("\n").length;
  for (const trait of traits) {
    const line = `- ${trait.statement}`;
    if (used + line.length > MAX_PROFILE_SECTION_CHARS) {
      lines.push("- ... [more preferences omitted]");
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

/** 设置页展示用：按维度分组，附置信度。 */
export function summarizeTraits(traits: UserTrait[]): Array<{ dimension: string; items: UserTrait[] }> {
  const groups = new Map<string, UserTrait[]>();
  for (const trait of traits) {
    if (trait.status === "retired") continue;
    const list = groups.get(trait.dimension) ?? [];
    list.push(trait);
    groups.set(trait.dimension, list);
  }
  return [...groups.entries()].map(([dimension, items]) => ({ dimension, items }));
}

// ---------------------------------------------------------------------------
// trigger 匹配
// ---------------------------------------------------------------------------

/** 极简 glob → 正则：只支持 * 与 **，够 filePattern 用。 */
export function globToRegExp(pattern: string): RegExp | null {
  const trimmed = pattern.trim();
  if (!trimmed) return null;
  const escaped = trimmed
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/\\\\]*")
    .replace(/\u0000/g, ".*");
  try {
    return new RegExp(escaped, "i");
  } catch {
    return null;
  }
}

function matchesTrigger(guideline: Guideline, context: RecallContext): boolean {
  const trigger = guideline.trigger;
  const text = context.text;

  if (trigger.command) {
    const needle = trigger.command.toLowerCase();
    if (context.commands.some((command) => command.toLowerCase().includes(needle))) return true;
    if (text.toLowerCase().includes(needle)) return true;
  }
  if (trigger.error) {
    const needle = trigger.error.toLowerCase();
    if (context.errors.some((error) => error.toLowerCase().includes(needle))) return true;
    if (text.toLowerCase().includes(needle)) return true;
  }
  if (trigger.keyword && text.includes(trigger.keyword)) return true;
  if (trigger.regex) {
    try {
      if (new RegExp(trigger.regex, "i").test(text)) return true;
    } catch {
      // 坏正则不该每回合抛错：写入时已校验，这里只做兜底
    }
  }
  if (trigger.filePattern) {
    const pattern = globToRegExp(trigger.filePattern);
    if (pattern) {
      // 提示词里提到文件时按 glob 比对；没有显式路径就看文本里是否出现模式主干
      const candidates = text.match(/[\w./\\-]+\.[A-Za-z0-9]+/g) ?? [];
      if (candidates.some((candidate) => pattern.test(candidate))) return true;
      const stem = trigger.filePattern.replace(/\*\*?|\//g, "").replace(/^\*/, "");
      if (stem && text.includes(stem.replace(/^\./, ""))) return true;
    }
  }
  return false;
}

/**
 * 按 trigger 命中经验，按置信度降序取前 N 条，超预算的截断。
 * 纯字符串匹配，零 token —— 这是「每回合都能跑」的前提。
 */
export function matchGuidelines(items: Guideline[], context: RecallContext): Guideline[] {
  const matched = items
    .filter((item) => item.status !== "retired")
    .filter((item) => matchesTrigger(item, context))
    .sort((a, b) => b.confidence - a.confidence);
  const kept: Guideline[] = [];
  let used = 0;
  for (const item of matched) {
    if (kept.length >= MAX_RECALL_ITEMS) break;
    if (used + item.text.length > MAX_RECALL_CHARS) continue;
    kept.push(item);
    used += item.text.length + 2;
  }
  return kept;
}

/** 渲染回合内召回注记；没有命中返回 undefined（调用方就不追加了）。 */
export function buildRecallNote(guidelines: Guideline[]): string | undefined {
  if (!guidelines.length) return undefined;
  return [
    "[learning] Relevant lessons from past sessions (apply unless they conflict with project rules):",
    ...guidelines.map((item) => `- ${item.text}`),
    "Do not narrate this note to the user.",
  ].join("\n");
}

/** 学完之后的提示：让模型知道知识库变了，不用它复述。 */
export function formatLearningNotice(input: {
  applied: string[];
  rejected: Array<{ id: string; reason: string }>;
}): string | undefined {
  const lines: string[] = [];
  if (input.applied.length) {
    lines.push(`learned ${input.applied.join(", ")}`);
  }
  if (!lines.length) return undefined;
  return [
    `[learning] Background learning updated the knowledge base: ${lines.join("; ")}.`,
    "New skills appear in the skill index from the next session; guidelines are recalled by trigger.",
    "Do not narrate this notice to the user.",
  ].join(" ");
}

/** 召回结果的稳定指纹：同一批命中不重复注入，避免每回合复述同一句话。 */
export function recallKey(guidelines: Guideline[]): string {
  return guidelines
    .map((item) => item.id)
    .sort()
    .join(",");
}
