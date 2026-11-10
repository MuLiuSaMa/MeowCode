/**
 * 回合后记忆蒸馏（ZCode scheduleProjectMemoryExtraction 同款思路）：
 * 每个正常完成的回合结束后，把游标以来的对话增量喂给一次独立小请求，
 * 让它产出结构化的记忆写/删操作 —— 模型回合内不主动存记忆也能沉淀长期事实。
 *
 * 与 commit-message.ts / title-generator.ts 完全同构：
 * 独立小请求、不给工具、不回流 delta、剥离推理强度、双档预算重试（思考型
 * 模型会把预算烧在 reasoning 上，正文为空时用更大预算再试一次）。
 *
 * 安全边界：产出只经 cleanExtractionOps 白名单校验（scope 枚举 + isValidMemoryName +
 * 长度截断 + 条数上限），落盘走 memory.ts 既有 saveMemory/deleteMemory，
 * 蒸馏请求本身没有任何工具，不存在越权写文件的面。
 */
import { streamChatCompletion, utilityProvider } from "./provider.js";
import {
  deleteMemory,
  isMemoryType,
  isValidMemoryName,
  listMemories,
  memoryDirFor,
  saveMemory,
  type MemoryScope,
  type MemoryType,
} from "./memory.js";
import { estimateTokens } from "./context.js";
import type { ChatMessage, ProviderConfig, TokenUsage, ToolCall } from "./types.js";

// ---- 预算 ----

const MAX_TRANSCRIPT_TOKENS = 8_000;
/** 每 3 个完成回合蒸馏一次；单回合增量很大时提前触发。 */
export const MEMORY_DISTILL_TURN_INTERVAL = 3;
export const MEMORY_DISTILL_MIN_TOKENS = 4_000;

export function shouldExtractMemory(input: {
  pendingTurns: number;
  transcriptTokens: number;
}): boolean {
  return (
    input.pendingTurns >= MEMORY_DISTILL_TURN_INTERVAL ||
    input.transcriptTokens >= MEMORY_DISTILL_MIN_TOKENS
  );
}
const MAX_USER_CHARS = 4_000;
const MAX_ASSISTANT_CHARS = 2_000;
const MAX_TOOL_ARGS_CHARS = 200;
const MAX_TOOL_RESULT_CHARS = 300;
/** 单次蒸馏最多落多少条操作：写满 8 条说明素材里全是噪音，不如留着下次 */
const MAX_OPS = 8;
const MAX_DESCRIPTION_CHARS = 200;
const MAX_CONTENT_CHARS = 4_000;
/**
 * 输出预算：几条记忆的 description + content 足够。
 * 重试档给足思考空间（见 commit-message.ts 的思考模型空正文教训）。
 */
const EXTRACTION_MAX_TOKENS = 2_500;
const RETRY_MAX_TOKENS = 8_000;

// ---- 蒸馏操作 ----

export type MemoryOp =
  | {
      op: "write";
      scope: MemoryScope;
      name: string;
      description: string;
      content: string;
      type?: MemoryType;
    }
  | { op: "delete"; scope: MemoryScope; name: string };

export type MemoryManifestEntry = {
  scope: MemoryScope;
  name: string;
  description: string;
};

export type MemoryApplyResult = {
  /** 新建的条目（覆盖前不存在） */
  written: string[];
  /** 更新的条目（覆盖前已存在） */
  updated: string[];
  /** 实际删掉的条目 */
  deleted: string[];
};

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

// ---- 会话增量序列化 ----

/** 合成前缀的用户消息（请求级注入，如 [memory] 通知）不进蒸馏素材，防自喂养循环。 */
function isSyntheticUserMessage(text: string): boolean {
  return text.startsWith("[memory]") || text.startsWith("[workflow]");
}

/**
 * 把游标之后的消息序列化成带角色标注的纯文本。
 * user 全文保真（蒸馏的主要素材），assistant 正文保分析结论，工具调用压成
 * 一行（工具结果里多是文件内容，真正的"用户偏好/项目决策"很少在那里）。
 * 超预算从最旧开始丢，保最新的对话。
 */
export function serializeMessages(messages: ChatMessage[]): string {
  const blocks: string[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const lines: string[] = [];
    if (message.role === "user") {
      if (typeof message.content !== "string" || !message.content.trim()) continue;
      if (isSyntheticUserMessage(message.content.trim())) continue;
      lines.push(`USER: ${clip(message.content, MAX_USER_CHARS)}`);
    } else if (message.role === "assistant") {
      if (typeof message.content === "string" && message.content.trim()) {
        lines.push(`ASSISTANT: ${clip(message.content, MAX_ASSISTANT_CHARS)}`);
      }
      for (const call of message.tool_calls ?? []) {
        lines.push(`- called ${toolCallLabel(call)}`);
      }
      if (!lines.length) continue;
    } else if (message.role === "tool") {
      lines.push(`- result(${message.name ?? "tool"}): ${clip(message.content, MAX_TOOL_RESULT_CHARS)}`);
    } else {
      // system / native_compaction：载体消息，不含可蒸馏素材
      continue;
    }
    const block = lines.join("\n");
    if (used + estimateTokens(block) > MAX_TRANSCRIPT_TOKENS) break;
    blocks.unshift(block);
    used += estimateTokens(block) + 2;
  }
  return blocks.join("\n\n");
}

function toolCallLabel(call: ToolCall): string {
  const name = call.function?.name || "tool";
  let args = "";
  try {
    args = clip(call.function?.arguments ?? "", MAX_TOOL_ARGS_CHARS);
  } catch {
    args = "";
  }
  return args ? `${name}(${args})` : `${name}()`;
}

// ---- 提示词 ----

const EXTRACTION_SYSTEM_PROMPT = [
  "You are the memory extraction pass for a coding agent. Analyze the conversation excerpt below and decide what is worth keeping in long-term memory.",
  "Reply with ONLY a JSON object: {\"ops\": [...]} — no prose, no code fences.",
  "Each op is one of:",
  '- {"op":"write","scope":"user"|"project","name":"kebab-case-slug","type":"user"|"feedback"|"project"|"reference","description":"one line","content":"the fact, self-contained"}',
  '- {"op":"delete","scope":"user"|"project","name":"existing-slug"} (only for entries listed as existing that are wrong or outdated)',
  'Use {"ops":[]} when nothing is worth saving. Do not invent entries to justify the call.',
  "",
  "What to save (one fact per file):",
  "- user: who the user is — role, expertise, preferences, workflows.",
  '- feedback: corrections ("don\'t do X") and quiet confirmations (an unusual approach the user accepted without pushback); include why.',
  "- project: decisions, goals and constraints not derivable from the code or git history; convert relative dates to absolute.",
  "- reference: external resources (URLs, dashboards, tickets) and their purpose.",
  "",
  "What NOT to save: code structure, file paths, debugging recipes, anything the repo or git history already records, ephemeral task details, secrets.",
  "Check the existing-entries list first: update an existing entry (same name) instead of creating a duplicate.",
  "Scope: \"user\" for facts that apply across projects, \"project\" for facts specific to this workspace.",
  "content must be self-contained and concise — a future session reads it without this conversation.",
].join("\n");

export function buildExtractionUserPrompt(input: {
  transcript: string;
  manifest: MemoryManifestEntry[];
  today: string;
}): string {
  const sections: string[] = [`Today's date: ${input.today}`];
  if (input.manifest.length) {
    const lines = input.manifest.map(
      (entry) => `- [${entry.scope}] ${entry.name}${entry.description ? ` — ${entry.description}` : ""}`,
    );
    sections.push(`Existing memory entries (update these instead of duplicating):\n${lines.join("\n")}`);
  } else {
    sections.push("Existing memory entries: none yet.");
  }
  sections.push(`Conversation since the last extraction:\n\n${input.transcript}`);
  return sections.join("\n\n");
}

// ---- 产出清洗 ----

function clipOpString(value: unknown, max: number): string {
  return typeof value === "string" ? clip(value, max) : "";
}

/**
 * 清洗模型产出：剥思考块与围栏 → JSON.parse → 逐条白名单校验。
 * 非法条目直接丢弃（不抛错）：蒸馏是后台增强，一条坏数据不该拖垮其余。
 */
export function cleanExtractionOps(raw: string): MemoryOp[] {
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
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { ops?: unknown }).ops)
      ? (parsed as { ops: unknown[] }).ops
      : [];
  const ops: MemoryOp[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const scope = record.scope === "user" || record.scope === "project" ? record.scope : null;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!scope || !isValidMemoryName(name)) continue;
    if (record.op === "delete") {
      ops.push({ op: "delete", scope, name });
    } else if (record.op === "write") {
      const description = clipOpString(record.description, MAX_DESCRIPTION_CHARS);
      const content = clipOpString(record.content, MAX_CONTENT_CHARS);
      if (!content) continue;
      const type = isMemoryType(record.type) ? record.type : undefined;
      ops.push({
        op: "write",
        scope,
        name,
        ...(description ? { description } : { description: name }),
        content,
        ...(type ? { type } : {}),
      });
    }
    if (ops.length >= MAX_OPS) break;
  }
  return ops;
}

// ---- 模型调用 ----

/**
 * 用辅助通道生成蒸馏操作。两次尝试：低预算失败（思考占满正文）再用高预算。
 * 全部失败抛错，由调用方（runtime 的后台调度）静默吞掉 —— 蒸馏失败不影响对话。
 */
export async function generateMemoryOps(options: {
  provider: ProviderConfig;
  transcript: string;
  manifest: MemoryManifestEntry[];
  today: string;
  signal?: AbortSignal;
  onUsage?: (usage: TokenUsage) => void;
}): Promise<MemoryOp[]> {
  const baseMessages: ChatMessage[] = [
    { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
    { role: "user", content: buildExtractionUserPrompt(options) },
  ];
  const attempts: Array<{ maxTokens: number; extraSystem?: string }> = [
    { maxTokens: EXTRACTION_MAX_TOKENS },
    {
      maxTokens: RETRY_MAX_TOKENS,
      extraSystem:
        "IMPORTANT: reply with the JSON object only. Do not think out loud, do not explain, do not use code fences.",
    },
  ];
  for (const attempt of attempts) {
    const messages: ChatMessage[] = attempt.extraSystem
      ? [...baseMessages, { role: "system", content: attempt.extraSystem }]
      : baseMessages;
    const result = await streamChatCompletion({
      provider: utilityProvider(options.provider, attempt.maxTokens, "memory"),
      messages,
      tools: [],
      signal: options.signal,
      onDelta: () => undefined,
      onUsageFinal: options.onUsage,
    });
    const ops = cleanExtractionOps(result.message.content ?? "");
    // 空数组是合法产出（本段对话确实没有值得记的），直接返回
    if (result.finishReason !== "length" || ops.length) return ops;
  }
  return [];
}

// ---- 落盘 ----

/**
 * 把校验过的操作写入两层记忆目录。逐条独立执行：单条失败不影响其余。
 * 返回摘要供下一回合的 [memory] 通知使用。
 */
export async function applyMemoryOps(
  ops: MemoryOp[],
  workspace: string,
  homeDir?: string,
): Promise<MemoryApplyResult> {
  const result: MemoryApplyResult = { written: [], updated: [], deleted: [] };
  const dirFor = (scope: MemoryScope) => memoryDirFor(scope, workspace, homeDir);
  for (const op of ops) {
    try {
      if (op.op === "write") {
        const { existed } = await saveMemory(dirFor(op.scope), op.name, {
          description: op.description,
          content: op.content,
          ...(op.type ? { type: op.type } : {}),
        });
        (existed ? result.updated : result.written).push(`${op.name} (${op.scope})`);
      } else {
        const removed = await deleteMemory(dirFor(op.scope), op.name);
        if (removed) result.deleted.push(`${op.name} (${op.scope})`);
      }
    } catch {
      // 单条失败静默跳过：记忆缺失不应打扰对话
    }
  }
  return result;
}

// ---- 触发门槛与通知文案 ----

/** 游标之后模型直接写过/删过记忆时跳过蒸馏（ZCode direct-memory-write 同款）。 */
export function wroteMemoryDirectly(messages: ChatMessage[], sinceIndex: number): boolean {
  for (let index = Math.max(0, sinceIndex); index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    for (const call of message.tool_calls ?? []) {
      if (call.function?.name === "memory_write" || call.function?.name === "memory_delete") {
        return true;
      }
    }
  }
  return false;
}

/** 游标之后是否出现了新的真实用户消息（合成前缀不算）。 */
export function hasNewUserMessage(messages: ChatMessage[], sinceIndex: number): boolean {
  for (let index = Math.max(0, sinceIndex); index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    if (typeof message.content !== "string" || !message.content.trim()) continue;
    if (isSyntheticUserMessage(message.content.trim())) continue;
    return true;
  }
  return false;
}

/** 最后一条真实用户消息的下标（没有则 -1）：未知游标时以「最后一个用户回合」为增量。 */
export function lastRealUserMessageIndex(messages: ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    if (typeof message.content !== "string" || !message.content.trim()) continue;
    if (isSyntheticUserMessage(message.content.trim())) continue;
    return index;
  }
  return -1;
}

export function formatMemoryNotice(result: MemoryApplyResult): string | null {
  const lines: string[] = [];
  if (result.written.length) lines.push(`wrote ${result.written.join(", ")}`);
  if (result.updated.length) lines.push(`updated ${result.updated.join(", ")}`);
  if (result.deleted.length) lines.push(`deleted ${result.deleted.join(", ")}`);
  if (!lines.length) return null;
  return [
    `[memory] Background memory extraction updated your memory directory: ${lines.join("; ")}.`,
    "The Memory index in your system instructions is now stale — use memory_read(scope, name) for current contents.",
    "Do not narrate this notice to the user.",
  ].join(" ");
}

/** 供 runtime 计算游标增量：manifest 汇总两层现有记忆。 */
export async function collectManifest(
  workspace: string,
  homeDir?: string,
): Promise<MemoryManifestEntry[]> {
  const manifest: MemoryManifestEntry[] = [];
  for (const scope of ["user", "project"] as const) {
    const entries = await listMemories(memoryDirFor(scope, workspace, homeDir)).catch(
      () => [] as { name: string; description: string }[],
    );
    for (const entry of entries) {
      manifest.push({ scope, name: entry.name, description: entry.description });
    }
  }
  return manifest;
}
