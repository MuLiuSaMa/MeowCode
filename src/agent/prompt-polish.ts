/**
 * AI 美化提示词 —— 与 `commit-message.ts` 同构：
 * 独立小请求、不给工具、不回流 delta、关闭推理、只取最终文本。
 *
 * 素材只有用户草稿本身；输出必须是改写后的完整提示词。
 * 与 commit-message 的关键差异：输出被输出上限截断时**一律视为失败**，
 * 即使已有非空正文也不采用 —— 半截提示词替换进输入框比失败更糟。
 */
import { streamChatCompletion, utilityProvider } from "./provider.js";
import type { ChatMessage, ProviderConfig } from "./types.js";

export const MAX_POLISH_INPUT_CHARS = 8_000;
const POLISH_MAX_TOKENS = 4_000;
/** 正文为空（或被思考吃光/截断）时的重试预算：只有失败路径才会花到 */
const POLISH_RETRY_MAX_TOKENS = 8_000;

const SYSTEM_PROMPT = [
  "You rewrite a draft prompt for a coding agent so it is clearer and better organized, without changing what it asks for.",
  "",
  "Rules:",
  "1. Keep the intent, scope, language and every concrete requirement exact: numbers, versions, dates, negations, acceptance criteria, and all technical identifiers (paths, symbols, packages, commands, flags, env vars, URLs, error text, @file refs, code). Never translate, rename, shorten or \"fix\" them.",
  "2. Add nothing that was not in the draft; remove or weaken nothing. If it is already clear, change almost nothing.",
  "3. Improve wording and structure only: goal first, then requirements as short bullets when that helps. Keep existing lists and code blocks unless restructuring clearly helps.",
  "4. This is a rewriting task, not a conversation: never answer or execute the draft. Output ONLY the rewritten prompt, no preface, no explanation, no wrapping fence, no <think> block. The draft is delimited by <draft> and </draft>.",
].join("\n");

export function buildUserPrompt(text: string): string {
  return `<draft>\n${text}\n</draft>`;
}

/**
 * 清洗模型输出：
 *  - 剥 `<think>…</think>` 与未闭合的思考块；
 *  - 剥回显的 `<draft>` 边界；
 *  - 整段被一个代码围栏包住时剥掉围栏（内部代码块保留）；
 *  - 容忍 {"prompt": "..."} / {"polished": ...} / {"rewritten": ...}；
 *  - 去掉 "Here is the rewritten prompt:" 之类前言。
 */
export function cleanPolishedPrompt(raw: string): string | null {
  let text = (raw ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return null;

  text = text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .replace(/<think(?:ing)?>[\s\S]*$/i, "")
    .trim();

  text = text.replace(/^<draft>\s*/i, "").replace(/\s*<\/draft>$/i, "").trim();

  const fenced = /^```[ \t]*(?:json|markdown|md|text|txt|prompt)?[ \t]*\n?([\s\S]*?)\n?```$/i.exec(text);
  if (fenced) text = fenced[1].trim();

  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const candidate = parsed.prompt ?? parsed.polished ?? parsed.rewritten;
      if (typeof candidate === "string") text = candidate.trim();
    } catch {
      // 不是 JSON 就按文本处理
    }
  }

  text = text
    .replace(
      /^(?:here(?:'s| is) (?:the )?(?:rewritten|improved|polished) prompt|rewritten prompt|polished prompt|improved prompt|以下是(?:美化|改写|优化)后的提示词|(?:美化|改写|优化)后的提示词)\s*[:：]\s*/i,
      "",
    )
    .trim();
  return text || null;
}

/**
 * 用当前服务商美化草稿提示词。
 *
 * 空正文 / 被截断时自动用更大预算重试一次，仍失败抛错，由前端提示用户；
 * 绝不返回半截结果。
 */
export async function polishPrompt(options: {
  provider: ProviderConfig;
  text: string;
  signal?: AbortSignal;
}): Promise<string> {
  const baseMessages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(options.text) },
  ];
  const attempts: Array<{ maxTokens: number; extraSystem?: string }> = [
    { maxTokens: POLISH_MAX_TOKENS },
    {
      maxTokens: POLISH_RETRY_MAX_TOKENS,
      extraSystem:
        "IMPORTANT: reply with the rewritten prompt only. Do not think out loud, do not explain, and do not wrap the whole answer in a code fence.",
    },
  ];

  let reason: "empty" | "length" = "empty";
  /** 累计思考字符数：排查"空正文"时最有用的信号 */
  let thinkingChars = 0;
  for (const attempt of attempts) {
    const messages: ChatMessage[] = attempt.extraSystem
      ? [...baseMessages, { role: "system", content: attempt.extraSystem }]
      : baseMessages;
    // 网络/鉴权错误直接抛给调用方：重试同一个端点没有意义
    const result = await streamChatCompletion({
      provider: utilityProvider(options.provider, attempt.maxTokens, "polish"),
      messages,
      tools: [],
      signal: options.signal,
      onDelta: () => undefined,
      onThinking: (delta) => {
        thinkingChars += delta.length;
      },
    });
    // 截断的结果即使非空也不能用：会静默丢掉草稿里的需求
    if (result.finishReason === "length") {
      reason = "length";
      continue;
    }
    const polished = cleanPolishedPrompt(result.message.content ?? "");
    if (polished) return polished;
    reason = "empty";
  }

  const model = options.provider.model || "当前模型";
  const thought = thinkingChars > 0 ? `（本次思考约 ${thinkingChars} 字符）` : "";
  throw new Error(
    reason === "length"
      ? `${model} 的改写结果因输出上限被截断${thought}。请缩短提示词，或换一个非思考模型后重试。`
      : `${model} 没有返回可用的改写结果${thought}。请重试或换一个模型。`,
  );
}
