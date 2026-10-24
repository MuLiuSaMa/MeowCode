import { promises as fs } from "node:fs";

/**
 * 文本文件的编码与行尾边界。
 *
 * 关键约束：read_file 按行切分后用 "\n" 拼回，模型看到的永远是 LF 文本；
 * 而 Windows 上的源文件常是 CRLF。若按原文精确匹配 oldString，任何跨行编辑都会失败。
 *
 * 匹配策略（从严格到宽松，命中即停）：
 *   exact              → 原文精确子串
 *   line-ending        → 只放宽换行处的 \r
 *   line-number-prefix → 剥掉 "123: " 行号前缀（read_file 的显示前缀常被模型抄进 oldString）
 *   rstrip             → 忽略行尾空白
 *   trim               → 忽略行首尾空白（等效于允许整体缩进变化）
 *   unicode            → 弯引号/长破折号/NBSP 归一后再比
 *
 * 无论命中哪一级，**替换始终落在原文的真实偏移上**，绝不把归一化后的文本写回：
 * 否则会把弯引号"修正"成直引号，制造出用户没要求的 diff。
 */

const BOM = "\uFEFF";
const BINARY_SNIFF_BYTES = 4096;

/** 单个文本文件的处理上限；读工具只取头部，写与编辑超过即拒绝整文件改写。 */
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;

export type LineEnding = "\r\n" | "\n";

export function detectLineEnding(content: string): LineEnding {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/** 把内容的所有换行统一成指定行尾。 */
export function forceLineEnding(content: string, ending: LineEnding): string {
  const lf = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return ending === "\r\n" ? lf.replace(/\n/g, "\r\n") : lf;
}

export function withBom(content: string, bom: boolean): string {
  return bom ? `${BOM}${content}` : content;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// 匹配层级
// ---------------------------------------------------------------------------

export type EditLevel =
  | "exact"
  | "line-ending"
  | "line-number-prefix"
  | "rstrip"
  | "trim"
  | "unicode";

const LEVEL_ORDER: EditLevel[] = [
  "exact",
  "line-ending",
  "line-number-prefix",
  "rstrip",
  "trim",
  "unicode",
];

/** 回执里告诉模型"这次是靠容错匹配上的"，便于它下次写得更准。 */
export const LEVEL_LABEL: Record<EditLevel, string> = {
  exact: "exact match",
  "line-ending": "line endings normalized",
  "line-number-prefix": "line-number prefix stripped",
  rstrip: "trailing whitespace ignored",
  trim: "indentation ignored",
  unicode: "quotes/dashes normalized",
};

export type LocatedText = { start: number; end: number; ending: LineEnding; level: EditLevel };

/** 命中处的行尾：取该行真实的 \n 前一个字符，避免整文件行尾不一致时误判。 */
function endingAt(content: string, offset: number): LineEnding {
  const newline = content.indexOf("\n", offset);
  if (newline === -1) return detectLineEnding(content);
  return newline > 0 && content[newline - 1] === "\r" ? "\r\n" : "\n";
}

function normalizeUnicode(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2015]/g, "-")
    .replace(/\u00A0/g, " ")
    .replace(/\u2026/g, "...");
}

type SourceLine = { text: string; start: number; textEnd: number; lineEnd: number };

/** 按行切分并保留每行在原文中的偏移；行尾 \r 不计入 text。 */
function splitLinesWithOffsets(content: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf("\n", start);
    if (newline === -1) {
      const text = content.slice(start).replace(/\r$/, "");
      lines.push({ text, start, textEnd: start + text.length, lineEnd: content.length });
      break;
    }
    const textEnd = newline > start && content[newline - 1] === "\r" ? newline - 1 : newline;
    lines.push({ text: content.slice(start, textEnd), start, textEnd, lineEnd: newline + 1 });
    start = newline + 1;
  }
  return lines;
}

function splitNeedle(needle: string): { lines: string[]; trailingNewline: boolean } {
  const lf = needle.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trailingNewline = lf.endsWith("\n");
  return {
    lines: (trailingNewline ? lf.slice(0, -1) : lf).split("\n"),
    trailingNewline,
  };
}

function lineKey(level: EditLevel, line: string): string {
  switch (level) {
    case "line-number-prefix":
      return line.replace(/^\s*\d+:\s?/, "").replace(/[ \t]+$/, "");
    case "rstrip":
      return line.replace(/[ \t]+$/, "");
    case "trim":
      return line.trim();
    case "unicode":
      return normalizeUnicode(line).trim();
    default:
      return line;
  }
}

/** 单行 oldString 只做"针"的变换再精确搜索：偏移天然可靠，也不会把半行片段误判成整行。 */
function singleLineCandidates(needle: string, level: EditLevel): string[] {
  switch (level) {
    case "rstrip":
      return [needle.replace(/[ \t]+$/, "")];
    case "line-number-prefix":
      return [needle.replace(/^\s*\d+:\s?/, "")];
    case "trim":
      return [needle.trim()];
    case "unicode":
      return [normalizeUnicode(needle)];
    default:
      return [needle];
  }
}

function searchLiteral(
  content: string,
  needle: string,
  level: EditLevel,
  limit: number,
): LocatedText[] {
  const hits: LocatedText[] = [];
  if (!needle) return hits;
  for (let at = content.indexOf(needle); at !== -1; at = content.indexOf(needle, at + needle.length)) {
    hits.push({ start: at, end: at + needle.length, ending: endingAt(content, at), level });
    if (hits.length >= limit) break;
  }
  return hits;
}

function searchFlexibleEol(content: string, needle: string, limit: number): LocatedText[] {
  const lf = needle.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const pattern = new RegExp(lf.split("\n").map(escapeRegExp).join("\\r?\\n"), "g");
  const hits: LocatedText[] = [];
  let match = pattern.exec(content);
  while (match) {
    if (match[0].length === 0) {
      pattern.lastIndex += 1;
    } else {
      hits.push({
        start: match.index,
        end: match.index + match[0].length,
        ending: endingAt(content, match.index),
        level: "line-ending",
      });
    }
    if (hits.length >= limit) break;
    match = pattern.exec(content);
  }
  return hits;
}

/**
 * 单行 oldString 的 Unicode 容错：把 ASCII 引号/破折号/空格扩成正则字符类，
 * 这样"文件里是弯引号、模型写直引号"也能命中，且命中位置仍是原文偏移。
 */
function unicodeFlexiblePattern(needle: string): RegExp {
  let pattern = "";
  for (const char of needle) {
    if (char === "'") pattern += "['\u2018\u2019\u201A\u201B\u2032]";
    else if (char === '"') pattern += '["\u201C\u201D\u201E\u201F\u2033]';
    else if (char === "-") pattern += "[-\u2013\u2014\u2015]";
    else if (char === " ") pattern += "[ \u00A0]";
    else pattern += escapeRegExp(char);
  }
  return new RegExp(pattern, "g");
}

function searchUnicodeFlexible(content: string, needle: string, limit: number): LocatedText[] {
  const pattern = unicodeFlexiblePattern(needle);
  const hits: LocatedText[] = [];
  let match = pattern.exec(content);
  while (match) {
    if (match[0].length === 0) {
      pattern.lastIndex += 1;
    } else {
      hits.push({
        start: match.index,
        end: match.index + match[0].length,
        ending: endingAt(content, match.index),
        level: "unicode",
      });
    }
    if (hits.length >= limit) break;
    match = pattern.exec(content);
  }
  return hits;
}

/** 多行 oldString 走"整行连续匹配"：只有整块行序列对得上才算命中，避免半行片段误配。 */
function searchLineRun(
  content: string,
  needle: string,
  level: EditLevel,
  limit: number,
): LocatedText[] {
  const haystack = splitLinesWithOffsets(content);
  const { lines: needleLines, trailingNewline } = splitNeedle(needle);
  if (!needleLines.length || needleLines.length > haystack.length) return [];
  const needleKeys = needleLines.map((line) => lineKey(level, line));
  const haystackKeys = haystack.map((line) => lineKey(level, line.text));
  const hits: LocatedText[] = [];
  for (let index = 0; index + needleKeys.length <= haystack.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < needleKeys.length; offset += 1) {
      if (haystackKeys[index + offset] !== needleKeys[offset]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    const first = haystack[index];
    const last = haystack[index + needleKeys.length - 1];
    hits.push({
      start: first.start,
      end: trailingNewline ? last.lineEnd : last.textEnd,
      ending: endingAt(content, first.start),
      level,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

/**
 * 返回 needle 在 content 中的命中位置（默认只取前两处，用于唯一性判断）。
 * 逐级放宽，某一级一旦命中就停：严格级别优先，保证"能精确匹配就绝不模糊匹配"。
 */
export function locateAll(
  content: string,
  needle: string,
  options: { levels?: EditLevel[]; limit?: number } = {},
): LocatedText[] {
  if (!needle) return [];
  const levels = options.levels ?? LEVEL_ORDER;
  const limit = options.limit ?? 2;
  const multiline = needle.includes("\n");
  for (const level of levels) {
    let hits: LocatedText[] = [];
    if (level === "exact") {
      hits = searchLiteral(content, needle, level, limit);
    } else if (level === "line-ending") {
      if (multiline) hits = searchFlexibleEol(content, needle, limit);
    } else if (multiline) {
      hits = searchLineRun(content, needle, level, limit);
    } else if (level === "unicode") {
      hits = searchUnicodeFlexible(content, needle, limit);
    } else {
      for (const candidate of singleLineCandidates(needle, level)) {
        if (!candidate || candidate === needle) continue;
        hits = searchLiteral(content, candidate, level, limit);
        if (hits.length) break;
      }
    }
    if (hits.length) return hits;
  }
  return [];
}

export type EditOutcome =
  | { ok: true; content: string; level: EditLevel; count: number }
  | { ok: false; reason: "not-found" | "not-unique"; positions: number[] };

/** 唯一替换；替换文本使用命中处的行尾，其余字节不动。replaceAll=true 时替换全部命中。 */
export function applyTextEdit(
  content: string,
  oldString: string,
  newString: string,
  options: { replaceAll?: boolean } = {},
): EditOutcome {
  const limit = options.replaceAll ? Number.MAX_SAFE_INTEGER : 2;
  const hits = locateAll(content, oldString, { limit });
  if (!hits.length) return { ok: false, reason: "not-found", positions: [] };
  if (!options.replaceAll && hits.length > 1) {
    return { ok: false, reason: "not-unique", positions: hits.map((hit) => hit.start) };
  }
  // 从后往前替换，前面的偏移才不会漂移
  let next = content;
  for (let index = hits.length - 1; index >= 0; index -= 1) {
    const hit = hits[index];
    next = next.slice(0, hit.start) + forceLineEnding(newString, hit.ending) + next.slice(hit.end);
  }
  return { ok: true, content: next, level: hits[0].level, count: hits.length };
}

/** 字符偏移 → 1 基行号（错误信息里给模型看）。 */
export function lineOfOffset(content: string, offset: number): number {
  let line = 1;
  const end = Math.min(Math.max(0, offset), content.length);
  for (let index = 0; index < end; index += 1) {
    if (content.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

export function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/** 非 UTF-8 返回 null，调用方必须拒绝而不是转码：转码会在写回时永久损坏原内容。 */
export function decodeUtf8Strict(buffer: Buffer): string | null {
  try {
    // ignoreBOM：保留 BOM 字符，交给调用方在写回时还原
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    return null;
  }
}

export type TextFile = {
  bom: boolean;
  ending: LineEnding;
  /** 不含 BOM 的文本 */
  content: string;
  /** headOnly 读到的字节数小于实际大小时为 true */
  oversized: boolean;
  size: number;
};

export type ReadTextOutcome =
  | { ok: true; file: TextFile }
  | { ok: false; reason: "missing" | "directory" | "binary" | "not-utf8" | "too-large"; size: number };

export type TextFileFailure = Extract<ReadTextOutcome, { ok: false }>;

/**
 * 按文本安全读取。headOnly=true 用于只展示头部的读工具：超出上限只截断不报错；
 * false 用于写/编辑路径：超过上限直接拒绝，避免整文件进内存后再截断。
 */
export async function readTextFile(file: string, options: { headOnly?: boolean } = {}): Promise<ReadTextOutcome> {
  const headOnly = Boolean(options.headOnly);
  let info;
  try {
    info = await fs.stat(file);
  } catch {
    return { ok: false, reason: "missing", size: 0 };
  }
  if (info.isDirectory()) return { ok: false, reason: "directory", size: info.size };
  if (!headOnly && info.size > MAX_TEXT_BYTES) return { ok: false, reason: "too-large", size: info.size };

  const length = Math.min(info.size, MAX_TEXT_BYTES + 1);
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  const handle = await fs.open(file, "r");
  try {
    const result = await handle.read(buffer, 0, length, 0);
    read = result.bytesRead;
  } finally {
    await handle.close();
  }
  const bytes = buffer.subarray(0, read);
  if (looksBinary(bytes)) return { ok: false, reason: "binary", size: info.size };
  const decoded = decodeUtf8Strict(bytes);
  if (decoded === null) return { ok: false, reason: "not-utf8", size: info.size };
  return {
    ok: true,
    file: {
      bom: decoded.startsWith(BOM),
      ending: detectLineEnding(decoded.startsWith(BOM) ? decoded.slice(1) : decoded),
      content: decoded.startsWith(BOM) ? decoded.slice(1) : decoded,
      oversized: info.size > read,
      size: info.size,
    },
  };
}

/** write_file 实际落盘的文本：沿用已存在文件的行尾与 BOM，新建文件按内容原样。 */
export function shapeForWrite(content: string, existing?: TextFile): string {
  if (!existing) return content;
  return withBom(forceLineEnding(content, existing.ending), existing.bom);
}
