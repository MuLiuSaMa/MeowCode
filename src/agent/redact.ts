import { createHash } from "node:crypto";

/**
 * 日志脱敏：落盘的任何字段都先过这里。
 * 密钥形态按常见前缀拦截；键名命中敏感词的整字段替换；URL 查询串里的 key/token 抹掉。
 */
const SECRET_KEY_PATTERN =
  /(api[_-]?key|apikey|authorization|auth|token|secret|password|passwd|cookie|credential|private[_-]?key|access[_-]?key)/i;

const TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]"],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[REDACTED]"],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\b(xox[baprs]-[A-Za-z0-9-]{8,})\b/g, "[REDACTED_SLACK_TOKEN]"],
  [/\b(AKIA[0-9A-Z]{16})\b/g, "[REDACTED_AWS_KEY]"],
  [/([?&](?:key|api_key|apikey|token|access_token|secret)=)[^&\s#]+/gi, "$1[REDACTED]"],
];

export function redactText(text: string): string {
  let result = text;
  for (const [pattern, replacement] of TEXT_PATTERNS) result = result.replace(pattern, replacement);
  return result;
}

/** 深拷贝并脱敏；命中敏感键名的值整体替换，避免嵌套对象漏网。 */
export function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return redactValue(value) as Record<string, unknown>;
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : redactValue(item, depth + 1);
  }
  return out;
}

/** 模型输入/命令正文默认只记长度与摘要，正文本身不落盘。 */
export function describeContent(text: string): { chars: number; sha256: string } {
  return {
    chars: text.length,
    sha256: createHash("sha256").update(text).digest("hex").slice(0, 16),
  };
}
