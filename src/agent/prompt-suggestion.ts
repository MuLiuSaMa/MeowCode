/**
 * 下一句输入建议：回合结束后用最近几条对话预测用户下一句。
 * 提示词与过滤规则参考 cc-haha 的 promptSuggestion（只保留可移植的文本规则）。
 */

export const SUGGESTION_SYSTEM_PROMPT = `You are a next-input predictor for a coding-assistant chat. You are NOT the assistant and you do NOT answer the conversation.

Task: read the recent transcript and predict the exact message the user would type next.

Rules:
- User voice only; never "I'll", "let me", "here's".
- One short line, 2–12 words (or one short line in Chinese/Japanese/Korean), in the language the user writes in.
- Be specific: "run the tests" beats "continue".
- No quotes, labels, lists, explanations, or thinking.
- If the next step is unclear or unsafe, reply with an empty line.

Reply with ONLY the predicted message.`;

export const SUGGESTION_USER_PROMPT = "What would the user type next? Reply with only their next message.";

const MAX_CHARS = 100;
const MAX_WORDS = 12;
/** 中日韩按字符计：一个词约 2–4 字，12 词的上限折算成 80 字（建议行最多两行） */
const MAX_CJK_CHARS = 80;
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g;

/** 模型常见的解释/元话语：这些不是用户会输入的内容。 */
const META =
  /suggestion mode|predict what|the user (?:would|might|will)|next (?:input|prompt)|user would type|用户(?:可能|会|刚|下一句|说)|下一句(?:建议|可能|输入)|根据(?:上下文|对话)|结合(?:上下文|对话)|建议你(?:可以|试试)|以下是|可能(?:会)?说|你可以让我|让我帮你|需要我帮|我可以帮|如果你愿意|希望(?:这些|以上|这)|对你有帮助|如果需要|随时告诉我|祝你|仅供参考|hope (?:this|that) helps|let me know|feel free|if you (?:need|want)|good luck/i;
const ASSISTANT_PREFIX =
  /^(let me|i'll|i will|i can|i would|i think|here's|here is|我会|我来|我将|让我|好的|当然|没问题|以下是)/i;
const EVALUATIVE =
  /thanks|thank you|looks good|sounds good|that works|nice|great|perfect|谢谢|感谢|看起来不错|太好了/i;

/** 去掉模型偶尔包上的标签、代码围栏、引号和「建议：」前缀。 */
export function cleanSuggestionCandidate(text: string): string {
  return text
    .trim()
    .replace(/^```[a-zA-Z]*\s*/g, "")
    .replace(/```/g, "")
    .replace(/^<(suggestion|response|output|answer|result)>([\s\S]*)<\/\1>$/i, "$2")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(
      /^\s*(suggested\s+(response|reply|input|prompt)|suggestion|response|reply|answer|output|result|建议|回复|答案|输出|结果)\s*[:：]\s*/i,
      "",
    )
    .replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, "")
    .trim();
}

function wordCount(text: string): number {
  return text
    .replace(CJK, " ")
    .split(/\s+/)
    .filter(Boolean).length;
}

function lengthOk(text: string): boolean {
  const cjk = text.match(CJK)?.length ?? 0;
  if (cjk > 0) return text.length >= 2 && text.length <= MAX_CJK_CHARS;
  const words = wordCount(text);
  return words >= 2 && words <= MAX_WORDS;
}

/** 只允许一句：问句直接丢弃；域名/版本号里的点不算句子分隔。 */
function singleSentence(text: string): boolean {
  if (/[?？]/.test(text)) return false;
  const body = text.replace(/[。！!]+$/, "").replace(/\.+$/, "");
  if (/[。！!]/.test(body)) return false;
  return !/\.\s/.test(body);
}

function validSuggestion(text: string): boolean {
  if (!text || text.length > MAX_CHARS) return false;
  if (/[\n\r]/.test(text)) return false;
  if (/[`*#]|^\s*[-•]/.test(text)) return false;
  if (META.test(text)) return false;
  if (ASSISTANT_PREFIX.test(text)) return false;
  if (/^(suggestion|response|answer|建议|回复|答案)\s*[:：]/i.test(text)) return false;
  if (/silence|no suggestion|nothing to suggest|保持沉默|暂无建议|没有建议/i.test(text)) {
    return false;
  }
  if (EVALUATIVE.test(text)) return false;
  if (text.startsWith("/")) return true;
  return singleSentence(text) && lengthOk(text);
}

function stripLinePrefix(line: string): string {
  return line
    .replace(/^\s*(?:[-*•]|\d+[.)、])\s+/, "")
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^\s*>\s?/, "")
    .trim();
}

function parseSuggestionJson(text: string): string | null {
  const unfenced = text.replace(/^```[a-zA-Z]*\s*/g, "").replace(/```/g, "").trim();
  if (!unfenced.startsWith("{") && !unfenced.startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(unfenced);
    if (Array.isArray(parsed)) {
      const first = parsed.find((item): item is string => typeof item === "string");
      return first ?? null;
    }
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of ["suggestion", "text", "prompt", "input"]) {
        if (typeof record[key] === "string") return record[key] as string;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * 返回可直接展示的建议；空/不安全/像助手自述的文本一律丢弃。
 * 模型偶尔会先解释再给建议（甚至输出列表/JSON），这里逐层提取候选，
 * 而不是因为整段不合格就把建议一起丢掉。
 */
export function usableSuggestion(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;

  const fromJson = parseSuggestionJson(text);
  if (fromJson) {
    const cleaned = cleanSuggestionCandidate(fromJson);
    if (validSuggestion(cleaned)) return cleaned;
  }

  const direct = cleanSuggestionCandidate(text);
  if (validSuggestion(direct)) return direct;

  const lines = text
    .split(/\r?\n/)
    .map(stripLinePrefix)
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    const cleaned = cleanSuggestionCandidate(line);
    if (validSuggestion(cleaned)) return cleaned;
  }

  const quoted = [...text.matchAll(/[“"「『]([^”"」』\n]{2,120})[”"」』]/g)]
    .map((match) => match[1].trim())
    .filter(Boolean)
    .reverse();
  for (const quote of quoted) {
    const cleaned = cleanSuggestionCandidate(quote);
    if (validSuggestion(cleaned)) return cleaned;
  }

  return null;
}
