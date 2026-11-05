/**
 * 学习器：把一回合（或一整个会话）的对话压成结构化的学习产出。
 *
 * 与 memory-extraction.ts 完全同构 —— 独立小请求、不给工具、不回流 delta、
 * 双档预算重试（思考型模型会把预算烧在 reasoning 上，正文为空时用更大预算再试一次）。
 * 区别只在产出词表：那边是「记忆操作」，这里是「用户模型 / 项目经验 / 技能 / 建议」。
 *
 * 两条提示词刻意分开：
 *  - 回合复盘负责「发现」：这一回合里有什么值得留下来；
 *  - 空闲整理负责「收敛」：合并近义经验、剪掉噪音、把反复成功的流程蒸成技能。
 * 混成一条的话，模型每回合都在重写整份知识库，成本和抖动都受不了。
 */
import { streamChatCompletion, utilityProvider } from "../provider.js";
import type { ChatMessage, ProviderConfig, TokenUsage } from "../types.js";
import { clipText, isValidLearningName, isValidTriggerRegex, redactSecrets } from "./guard.js";
import {
  MAX_GUIDELINE_CHARS,
  MAX_OPS_PER_BATCH,
  MAX_SKILL_CONTENT_CHARS,
  MAX_TRAIT_CHARS,
  TRAIT_DIMENSIONS,
  type GuidelineTrigger,
  type GuidelinesFile,
  type LearningOp,
  type LearningScope,
  type ProfileFile,
  type TraitDimension,
} from "./types.js";
import type { LearningSignal } from "./signals.js";

/** 单次输入预算（字符近似 token 的 4 倍）。 */
const MAX_TRANSCRIPT_CHARS = 24_000;

/** 低预算先试；思考型模型会把正文烧空，用大预算再来一次。 */
const LEARNING_MAX_TOKENS = 2_500;
const RETRY_MAX_TOKENS = 8_000;

/** 现有知识库摘要，喂给模型做去重判断。 */
export type ExistingKnowledge = {
  profile: ProfileFile;
  guidelines: GuidelinesFile;
  skills: Array<{ name: string; description: string; status: string }>;
  maxSkills: number;
};

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------

const SHARED_RULES = `Hard rules:
1. Only these ops: "profile" | "guideline" | "skill" | "proposal". Never emit code, tool
   definitions, hooks, or configuration files.
2. NEVER mention or modify: update_plan, ask_user, spawn_agent, approvalMode, approval_required,
   harness.json, workflow.json, settings.json, providers.json, mcp.json, MEOWCODE_* env vars,
   verification gates, receipts, or anything that skips/bypasses verification.
   Violating this rejects the whole item.
3. CHECK THE EXISTING LISTS FIRST. If an item already covers this signal, UPDATE IT IN PLACE
   using its exact name/id. Never create a near-duplicate under a variant name.
4. A concrete reusable procedure (commands, flags, script order) MUST be a "skill".
   A "guideline" is only for repo-wide conventions or tool restrictions, and MUST carry a
   trigger. Never emit both a skill and a guideline for the same task.
5. Skills are at capacity when the count reaches the cap. To add one at capacity you MUST set
   "replaces" to an existing skill name that is still tentative and has not helped yet.
6. Copy commands EXACTLY as they succeeded, every flag included. Never write placeholders like
   "[ran command]". If you cannot reproduce the exact command, emit nothing for it.
7. No secrets, no file contents, nothing AGENTS.md or git history already records.
8. Return [] when nothing generalizes. Do not invent items to justify the call.`;

const OP_SCHEMA = `Output schema — a JSON array of objects:
[
  {"op":"profile","scope":"user"|"project","dimension":"communication"|"rigor"|"autonomy"|"coding_style"|"toolchain"|"domain","statement":"one sentence, self-contained","userStated":true|false},
  {"op":"guideline","scope":"...","id":"optional existing id","text":"the rule, <=300 chars","trigger":{"command"|"error"|"keyword"|"regex"|"filePattern":"one or more"}},
  {"op":"skill","scope":"...","name":"kebab-case","description":"when to use it, in the user's own words","content":"SKILL.md body with ## When / ## Commands","replaces":"optional existing skill name"},
  {"op":"proposal","scope":"...","name":"kebab-case","content":"a workflow change the user might want"}
]`;

const TURN_SYSTEM_PROMPT = `You are MeowCode's turn learning pass. One conversation turn just finished.
Decide what deserves to persist across sessions. Reply with ONLY a JSON array — no prose, no fences.

${OP_SCHEMA}

${SHARED_RULES}

What each kind is for:
- profile: stable facts about THIS USER — communication style, how much rigor they want, how much
  autonomy they grant, coding style, toolchain preferences, domain vocabulary.
- guideline: a rule that applies to THIS REPOSITORY regardless of the task. Must be triggerable.
- skill: a procedure you would repeat for the same kind of request. This is where exact commands
  and recovery steps go.
- proposal: at most one, and only when the turn revealed a workflow worth changing.`;

const IDLE_SYSTEM_PROMPT = `You are MeowCode's session consolidation pass. A whole finished session is below.
Your job is NOT to discover new things — the per-turn pass already did that. Your job is to
merge, prune, and promote.

${OP_SCHEMA}

${SHARED_RULES}

Consolidation duties:
- Merge near-duplicate guidelines into one canonical item, keeping the sharper wording.
- Distill at most 2 skills, and only from procedures that actually succeeded more than once.
- Mark a trait or guideline that this session contradicted as retired by re-emitting it with
  the same id/statement and noting the contradiction in the reason. Do not invent replacements.
- Emit at most 1 proposal.
- Do not repeat what the per-turn pass already stored.`;

export function systemPromptFor(mode: "turn" | "idle"): string {
  return mode === "idle" ? IDLE_SYSTEM_PROMPT : TURN_SYSTEM_PROMPT;
}

// ---------------------------------------------------------------------------
// 用户消息
// ---------------------------------------------------------------------------

function describeTrigger(trigger: GuidelineTrigger): string {
  return Object.entries(trigger)
    .filter(([, value]) => typeof value === "string" && value)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");
}

export function buildLearningUserPrompt(input: {
  transcript: string;
  signals: LearningSignal[];
  existing: ExistingKnowledge;
  today: string;
}): string {
  const sections: string[] = [`Today's date: ${input.today}`];

  const traits = input.existing.profile.traits.filter((trait) => trait.status !== "retired");
  sections.push(
    traits.length
      ? `Existing profile traits (update these instead of duplicating):\n${traits
          .map((trait) => `- [${trait.dimension}] ${trait.statement} (${trait.status}, ${trait.confidence.toFixed(2)})`)
          .join("\n")}`
      : "Existing profile traits: none yet.",
  );

  const guidelines = input.existing.guidelines.items.filter((item) => item.status !== "retired");
  sections.push(
    guidelines.length
      ? `Existing guidelines (reuse the id to update):\n${guidelines
          .map((item) => `- ${item.id} — ${item.text} [${describeTrigger(item.trigger)}]`)
          .join("\n")}`
      : "Existing guidelines: none yet.",
  );

  const skills = input.existing.skills;
  sections.push(
    skills.length
      ? `Existing learned skills (${skills.length}/${input.existing.maxSkills}):\n${skills
          .map((skill) => `- ${skill.name} (${skill.status}) — ${skill.description}`)
          .join("\n")}`
      : `Existing learned skills: none yet (0/${input.existing.maxSkills}).`,
  );

  if (input.signals.length) {
    sections.push(`Turn signals:\n${JSON.stringify(input.signals, null, 2)}`);
  }
  sections.push(`Conversation:\n\n${input.transcript}`);
  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// 产出清洗
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asScope(value: unknown): LearningScope | null {
  return value === "user" || value === "project" ? value : null;
}

function asString(value: unknown, max: number): string {
  return typeof value === "string" ? clipText(value, max) : "";
}

/** 触发条件至少要有一个人可判定的字段；正则必须能编译。 */
export function normalizeTrigger(value: unknown): GuidelineTrigger | null {
  const record = asRecord(value);
  if (!record) return null;
  const trigger: GuidelineTrigger = {};
  for (const key of ["command", "error", "keyword", "filePattern"] as const) {
    const text = asString(record[key], 120);
    if (text) trigger[key] = text;
  }
  const regex = asString(record.regex, 120);
  if (regex && isValidTriggerRegex(regex)) trigger.regex = regex;
  return Object.keys(trigger).length ? trigger : null;
}

function normalizeOp(item: unknown): LearningOp | null {
  const record = asRecord(item);
  if (!record) return null;
  const scope = asScope(record.scope);
  if (!scope) return null;
  const reason = asString(record.reason, 200) || undefined;

  switch (record.op) {
    case "profile": {
      const dimension = record.dimension;
      if (!TRAIT_DIMENSIONS.includes(dimension as TraitDimension)) return null;
      const raw = asString(record.statement, MAX_TRAIT_CHARS);
      if (!raw) return null;
      const statement = redactSecrets(raw).text;
      return {
        op: "profile",
        scope,
        dimension: dimension as TraitDimension,
        statement,
        ...(record.userStated === true ? { userStated: true } : {}),
        ...(reason ? { reason } : {}),
      };
    }
    case "guideline": {
      const text = redactSecrets(asString(record.text, MAX_GUIDELINE_CHARS)).text;
      if (!text) return null;
      const trigger = normalizeTrigger(record.trigger);
      // 没有触发条件的「经验」会变成每回合都注入的噪音，直接丢弃
      if (!trigger) return null;
      const id = asString(record.id, 32);
      return {
        op: "guideline",
        scope,
        ...(id ? { id } : {}),
        text,
        trigger,
        ...(reason ? { reason } : {}),
      };
    }
    case "skill": {
      const name = asString(record.name, 64);
      if (!isValidLearningName(name)) return null;
      const description = redactSecrets(asString(record.description, 200)).text;
      if (!description) return null;
      const content = redactSecrets(asString(record.content, MAX_SKILL_CONTENT_CHARS)).text;
      if (!content) return null;
      const replaces = asString(record.replaces, 64);
      return {
        op: "skill",
        scope,
        name,
        description,
        content,
        ...(replaces && isValidLearningName(replaces) ? { replaces } : {}),
        ...(reason ? { reason } : {}),
      };
    }
    case "proposal": {
      const name = asString(record.name, 64);
      if (!isValidLearningName(name)) return null;
      const content = redactSecrets(asString(record.content, 4_000)).text;
      if (!content) return null;
      return { op: "proposal", scope, name, content, ...(reason ? { reason } : {}) };
    }
    default:
      return null;
  }
}

/**
 * 清洗模型产出：剥思考块与围栏 → JSON.parse → 逐条白名单校验。
 * 非法条目直接丢弃（不抛错）：学习是后台增强，一条坏数据不该拖垮其余。
 */
export function cleanLearningOps(raw: string): LearningOp[] {
  let text = (raw ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return [];
  text = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "").trim();
  const fenced = /^```[ \t]*(?:json)?[ \t]*\n?([\s\S]*?)\n?```$/i.exec(text);
  if (fenced) text = fenced[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { ops?: unknown }).ops)
      ? (parsed as { ops: unknown[] }).ops
      : [];
  const ops: LearningOp[] = [];
  for (const item of list) {
    const op = normalizeOp(item);
    if (op) ops.push(op);
    if (ops.length >= MAX_OPS_PER_BATCH) break;
  }
  return ops;
}

// ---------------------------------------------------------------------------
// 模型调用
// ---------------------------------------------------------------------------

/**
 * 用辅助通道生成学习产出。两次尝试：低预算失败（思考占满正文）再用高预算。
 * 全部失败抛错，由调用方（runtime 的后台调度）静默吞掉 —— 学习失败不影响对话。
 */
export async function generateLearningOps(options: {
  provider: ProviderConfig;
  mode: "turn" | "idle";
  transcript: string;
  signals: LearningSignal[];
  existing: ExistingKnowledge;
  today: string;
  signal?: AbortSignal;
  onUsage?: (usage: TokenUsage) => void;
}): Promise<LearningOp[]> {
  const transcript = options.transcript.slice(-MAX_TRANSCRIPT_CHARS);
  const baseMessages: ChatMessage[] = [
    { role: "system", content: systemPromptFor(options.mode) },
    {
      role: "user",
      content: buildLearningUserPrompt({
        transcript,
        signals: options.signals,
        existing: options.existing,
        today: options.today,
      }),
    },
  ];
  const attempts: Array<{ maxTokens: number; extraSystem?: string }> = [
    { maxTokens: LEARNING_MAX_TOKENS },
    {
      maxTokens: RETRY_MAX_TOKENS,
      extraSystem:
        "IMPORTANT: reply with the JSON array only. Do not think out loud, do not explain, do not use code fences.",
    },
  ];
  for (const attempt of attempts) {
    const messages: ChatMessage[] = attempt.extraSystem
      ? [...baseMessages, { role: "system", content: attempt.extraSystem }]
      : baseMessages;
    const result = await streamChatCompletion({
      provider: utilityProvider(options.provider, attempt.maxTokens, "learning"),
      messages,
      tools: [],
      signal: options.signal,
      onDelta: () => undefined,
      onUsage: options.onUsage,
    });
    const ops = cleanLearningOps(result.message.content ?? "");
    // 空数组是合法产出（这回合确实没有可学的），直接返回
    if (result.finishReason !== "length" || ops.length) return ops;
  }
  return [];
}
