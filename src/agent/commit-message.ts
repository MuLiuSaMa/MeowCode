/**
 * AI 生成 commit message —— 与 `title-generator.ts` 完全同构：
 * 独立小请求、不给工具、不回流 delta、关闭推理、只取最终文本。
 *
 * 素材（都来自已暂存的内容）：
 *  - 最近 10 条 subject：让模型学到仓库的提交语气（中文/英文、是否带 scope）；
 *  - `--cached --stat` 前 40 行：文件清单与改动规模；
 *  - patch 摘要（≤3,000 tokens、单文件 ≤800、≤20 个文件）：真正的改动内容。
 *
 * 输出必须是**一条** commit message：首行 subject ≤72 字符，空行后可选正文。
 * 模型爱包 ``` 围栏或输出 JSON，`cleanCommitMessage` 全部容忍。
 */
import { estimateTokens } from "./context.js";
import { streamChatCompletion, utilityProvider } from "./provider.js";
import { sliceHeadToTokens } from "./tool-budget.js";
import type { ChatMessage, ProviderConfig } from "./types.js";

const MAX_PATCH_TOKENS = 3_000;
const MAX_FILE_PATCH_TOKENS = 800;
const MAX_FILES = 20;
const MAX_STAT_LINES = 40;
const MAX_RECENT_SUBJECTS = 10;
const MAX_SUBJECT_CHARS = 72;
const MAX_MESSAGE_CHARS = 2_000;
/**
 * 输出预算。
 *
 * 400 太低：思考型模型（GLM / Qwen / DeepSeek 的 thinking 变体）在没显式关闭
 * 思考时会把预算全用在 reasoning_content 上，正文一个字符都不剩 —— 表现就是
 * "AI 生成失败：Commit message generation returned empty output"。给足预算 +
 * 一次加倍的自动重试，才能既不为此多花钱、又不在思考模型上直接失败。
 */
const COMMIT_MAX_TOKENS = 1_200;
/** 正文为空（或被思考吃光）时的重试预算：给足思考 + 正文，只有失败路径才会花到 */
const RETRY_MAX_TOKENS = 8_000;

/** 噪音文件：不参与生成（lock 文件、构建产物、压缩产物） */
const NOISE_PATTERN =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|composer\.lock)$|\.(lock|min\.js|min\.css|map)$|(^|\/)(dist|build|node_modules|out|\.next)\//i;

const SYSTEM_PROMPT = [
  "You write ONE git commit message for the staged changes below.",
  "Follow these rules strictly:",
  "1. First line: imperative subject, at most 72 characters, no trailing period.",
  "2. Prefer Conventional Commits style (feat/fix/refactor/docs/test/chore(scope): summary) ONLY if the recent commits show that style; otherwise match their tone and language.",
  "3. Match the language of the recent commit subjects (Chinese repo -> Chinese message).",
  "4. If the change is non-trivial, add a blank line then 1-4 short bullet lines (prefix \"- \").",
  "5. Output the raw message only: no code fences, no JSON, no explanations, no markdown headings.",
].join("\n");

export type CommitContext = {
  /** 最近提交的 subject（新→旧） */
  recentSubjects: string[];
  /** `git diff --cached --stat` 的原文 */
  statText?: string;
  /** `git diff --cached -U1` 的原文（未过滤） */
  patchText?: string;
};

/** 按文件切 patch 并过滤噪音文件；超出预算时逐个截断。 */
export function summarizePatch(patchText: string | undefined): string {
  if (!patchText) return "";
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of patchText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current.length) blocks.push(current.join("\n"));
      current = [line];
      continue;
    }
    if (current.length) current.push(line);
  }
  if (current.length) blocks.push(current.join("\n"));

  const kept: string[] = [];
  let used = 0;
  for (const block of blocks) {
    if (kept.length >= MAX_FILES) break;
    const header = block.split("\n")[0] ?? "";
    const file = header.replace(/^diff --git a\/.* b\//, "");
    if (NOISE_PATTERN.test(file)) continue;
    const trimmed =
      estimateTokens(block) > MAX_FILE_PATCH_TOKENS
        ? `${sliceHeadToTokens(block, MAX_FILE_PATCH_TOKENS)}\n... [truncated]`
        : block;
    if (used + estimateTokens(trimmed) > MAX_PATCH_TOKENS) break;
    kept.push(trimmed);
    used += estimateTokens(trimmed);
  }
  if (!kept.length) return "";
  const omitted = blocks.length - kept.length;
  return `${kept.join("\n")}${omitted > 0 ? `\n... [${omitted} more file(s) not shown]` : ""}`;
}

function summarizeStat(statText: string | undefined): string {
  if (!statText) return "";
  const lines = statText.split("\n").filter((line) => line.trim());
  const kept = lines.filter((line) => !NOISE_PATTERN.test(line)).slice(0, MAX_STAT_LINES);
  return kept.join("\n");
}

export function buildUserPrompt(context: CommitContext): string {
  const sections: string[] = [];
  const subjects = context.recentSubjects
    .map((subject) => subject.trim())
    .filter(Boolean)
    .slice(0, MAX_RECENT_SUBJECTS);
  if (subjects.length) {
    sections.push(`Recent commit subjects (newest first):\n${subjects.map((s) => `- ${s}`).join("\n")}`);
  }
  const stat = summarizeStat(context.statText);
  if (stat) sections.push(`Staged files (git diff --cached --stat):\n${stat}`);
  const patch = summarizePatch(context.patchText);
  if (patch) sections.push(`Staged patch:\n${patch}`);
  if (!stat && !patch) sections.push("(No staged diff was provided. Infer a sensible chore message.)");
  return sections.join("\n\n");
}

/**
 * 清洗模型输出：
 *  - 剥 `\u003cthink\u003e…\u003c/think\u003e` 与 ```json 围栏；
 *  - 容忍 {"message": "..."} / {"commit": "..."} 之类的 JSON；
 *  - subject 压到 72 字符，整体压到 2000 字符；
 *  - 清掉开头的 "commit message:" 之类前缀。
 */
export function cleanCommitMessage(raw: string): string | null {
  let text = (raw ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return null;
  // 思考块（DeepSeek/Claude 混在正文里的情况）
  text = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "").trim();
  // 围栏
  const fenced = /^```[ \t]*(?:json|text|gitcommit|markdown)?[ \t]*\n?([\s\S]*?)\n?```$/i.exec(text);
  if (fenced) text = fenced[1].trim();
  // JSON 形态
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const candidate = parsed.message ?? parsed.commit ?? parsed.subject;
      if (typeof candidate === "string") text = candidate.trim();
    } catch {
      // 不是 JSON 就按文本处理
    }
  }
  // 去掉 "Commit message:" / "提交信息：" 之类前缀
  text = text.replace(/^(?:commit message|message|提交信息|提交说明)\s*[:：]\s*/i, "").trim();
  if (!text) return null;

  const [first, ...rest] = text.split("\n");
  let subject = first.trim().replace(/^[-*]\s*/, "").replace(/[。.]$/, "");
  if (subject.length > MAX_SUBJECT_CHARS) subject = subject.slice(0, MAX_SUBJECT_CHARS).trim();
  if (!subject) return null;
  const bodyLines = rest
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .trim();
  const message = bodyLines ? `${subject}\n\n${bodyLines}` : subject;
  return message.slice(0, MAX_MESSAGE_CHARS);
}

/**
 * 用当前服务商生成 commit message。
 *
 * 失败抛错，由调用方降级为用户手写（文案只是加速器，不该阻塞提交流程）。
 * 但「空正文」不是真实的失败 —— 思考型模型会把预算全烧在 reasoning 上，
 * 所以这里自动用更大预算重试一次，并把原因写进错误文案，方便用户换模型。
 */
export async function generateCommitMessage(options: {
  provider: ProviderConfig;
  context: CommitContext;
  signal?: AbortSignal;
}): Promise<string> {
  const baseMessages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(options.context) },
  ];
  const attempts: Array<{ maxTokens: number; extraSystem?: string }> = [
    { maxTokens: COMMIT_MAX_TOKENS },
    {
      maxTokens: RETRY_MAX_TOKENS,
      extraSystem:
        "IMPORTANT: reply with the commit message only. Do not think out loud, do not explain, do not use code fences.",
    },
  ];

  let reason: "empty" | "length" = "empty";
  /** 累计思考字符数：排查"空正文"时最有用的信号 */
  let thinkingChars = 0;
  for (const attempt of attempts) {
    const messages: ChatMessage[] = attempt.extraSystem
      ? [
          ...baseMessages,
          { role: "system", content: attempt.extraSystem },
        ]
      : baseMessages;
    // 网络/鉴权错误直接抛给调用方：重试同一个端点没有意义
    const result = await streamChatCompletion({
      provider: utilityProvider(options.provider, attempt.maxTokens, "commit"),
      messages,
      tools: [],
      signal: options.signal,
      onDelta: () => undefined,
      onThinking: (delta) => {
        thinkingChars += delta.length;
      },
    });
    const message = cleanCommitMessage(result.message.content ?? "");
    if (message) return message;
    reason = result.finishReason === "length" ? "length" : "empty";
  }

  const model = options.provider.model || "当前模型";
  const thought = thinkingChars > 0 ? `（本次思考约 ${thinkingChars} 字符）` : "";
  throw new Error(
    reason === "length"
      ? `${model} 用 ${RETRY_MAX_TOKENS} token 的预算仍没产出正文${thought}：思考内容占满了输出。请换一个非思考模型，或在设置 → 模型里清空该模型的思考强度后重试。`
      : `${model} 没有返回可用的提交信息${thought}。请换一个模型重试，或直接手写。`,
  );
}
