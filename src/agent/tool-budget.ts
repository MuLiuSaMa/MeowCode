/**
 * 工具输出的 token 预算裁剪。
 *
 * 统计口径与 context.estimateTokens 一致：CJK 1 字 ≈ 1 token，其余 4 字符 ≈ 1 token。
 * 工具输出按字符配预算时，中文会被放大 4 倍；Codex 默认按 10KB bytes 截断并保留头尾，
 * 这里用 token 口径做同一件事，避免中文仓库把单次读取撑到几万 token。
 */

const CJK_RANGES: Array<[number, number]> = [
  [0x1100, 0x11ff],
  [0x3000, 0x30ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xac00, 0xd7af],
  [0xf900, 0xfaff],
  [0xff00, 0xffef],
];

function isCjkUnit(code: number): boolean {
  return CJK_RANGES.some(([start, end]) => code >= start && code <= end);
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** 前缀最多保留多少字符；surrogate pair 不劈开 */
function headIndexByTokens(text: string, budget: number): number {
  if (budget <= 0) return 0;
  let used = 0;
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    const cost = isCjkUnit(code) ? 1 : 0.25;
    if (used + cost > budget) break;
    used += cost;
    index += 1;
  }
  if (index > 0 && index < text.length && isLowSurrogate(text.charCodeAt(index))) index -= 1;
  return index;
}

/** 后缀从哪个字符开始；surrogate pair 不劈开 */
function tailIndexByTokens(text: string, budget: number): number {
  if (budget <= 0) return text.length;
  let used = 0;
  let index = text.length;
  while (index > 0) {
    const code = text.charCodeAt(index - 1);
    const cost = isCjkUnit(code) ? 1 : 0.25;
    if (used + cost > budget) break;
    used += cost;
    index -= 1;
  }
  if (index > 0 && index < text.length && isLowSurrogate(text.charCodeAt(index))) index -= 1;
  return index;
}

function approxTokens(text: string): number {
  let total = 0;
  for (let index = 0; index < text.length; index += 1) {
    total += isCjkUnit(text.charCodeAt(index)) ? 1 : 0.25;
  }
  return total;
}

/** 只取前缀/后缀，不追加省略标记（调用方自己拼提示） */
export function sliceHeadToTokens(text: string, maxTokens: number): string {
  return text.slice(0, headIndexByTokens(text, maxTokens));
}

export function sliceTailToTokens(text: string, maxTokens: number): string {
  return text.slice(tailIndexByTokens(text, maxTokens));
}

export type TokenTruncation = {
  text: string;
  truncated: boolean;
  /**
   * 正文原本的 token 估算（未截断时等于正文本身）。
   *
   * 只报「省了多少」不够：模型无法判断该不该翻页重读。带上原始总量后，
   * 「4k 里的 3.9k」与「80k 里的 76k」是两种完全不同的决策
   * （codex 的 exec 结果同样带 original_token_count）。
   */
  originalTokens: number;
  omittedTokens: number;
};

/**
 * 头尾各留一部分，中间用省略标记连接。
 * headRatio 默认 0.5；0 = 只留尾，1 = 只留头。
 */
export function truncateToTokens(
  text: string,
  maxTokens: number,
  options: {
    headRatio?: number;
    /** 自定义省略标记（不要带前后换行，函数会补） */
    note?: (omittedTokens: number, originalTokens: number) => string;
  } = {},
): TokenTruncation {
  const total = approxTokens(text);
  if (total <= maxTokens) return { text, truncated: false, originalTokens: total, omittedTokens: 0 };

  const headRatio = Math.min(1, Math.max(0, options.headRatio ?? 0.5));
  // 给省略标记留 8% 余量，避免截完仍超预算
  const contentBudget = Math.max(0, maxTokens - Math.max(8, Math.ceil(maxTokens * 0.08)));
  const headBudget = Math.floor(contentBudget * headRatio);
  const tailBudget = contentBudget - headBudget;
  const head = text.slice(0, headIndexByTokens(text, headBudget));
  const tail = text.slice(tailIndexByTokens(text, tailBudget));
  const omitted = Math.max(1, Math.round(total - approxTokens(head) - approxTokens(tail)));
  const note = options.note?.(omitted, total) ?? `... [truncated ${omitted} of ${total} tokens]`;
  return {
    text: `${head}\n${note}\n${tail}`,
    truncated: true,
    originalTokens: total,
    omittedTokens: omitted,
  };
}
