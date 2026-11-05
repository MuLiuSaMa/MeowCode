import { promises as fs } from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "./atomic-json.js";
import type { SessionEntry, SessionHeader } from "./types.js";

type SearchableEntry = Extract<SessionEntry, { type: "message" | "title" }>;

/**
 * 会话全文检索（零 LLM 依赖）。
 *
 * 设计（参考 codex / metis / ZCode 的纯本地检索，不用 FTS5 / embedding）：
 * - 每个会话 JSONL 对应一份「影子索引」sessions/.search/<fileName>.json，
 *   只收 user / assistant 的字符串正文（扁平化纯文本），用 size+mtimeMs 判定增量。
 * - 进程内 LRU 缓存热点会话的 docs；搜索 = 内存子串匹配 + 截窗片段。
 * - 片段只返回 {start,end} 偏移，由前端自行切段高亮，不拼 HTML。
 * - 本模块绝不 import provider/runtime，不产生模型调用，不写会话 JSONL。
 */

const INDEX_VERSION = 1;
const SEARCH_DIR = ".search";
const BUILD_CONCURRENCY = 6;
const MEMORY_MAX_CHARS = 12_000_000;
const MEMORY_MAX_ENTRIES = 200;
const DEFAULT_DOC_CHARS = 8_000;
const DEFAULT_SESSION_CHARS = 512_000;
const SNIPPET_RADIUS = 40;
const SNIPPET_MAX_CHARS = 140;
const SNIPPET_MERGE_GAP = 24;
const MAX_WINDOWS_PER_DOC = 2;
const MAX_SNIPPETS_PER_SESSION = 3;
const MAX_POSITIONS_PER_DOC = 200;

export const MAX_QUERY_CHARS = 200;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

export type SearchDoc = {
  /** JSONL 里 type:"message" 条目的序号，与 /session/messages 的 messages 下标严格一致 */
  messageIndex: number;
  role: "user" | "assistant";
  /** 已扁平化（换行折叠为单空格）的正文 */
  text: string;
  entryId?: string;
  timestamp?: string;
};

export type SearchSnippet = {
  text: string;
  /** 命中区间相对片段文本的偏移（前端据此切 <mark>，不信任 HTML） */
  ranges: Array<{ start: number; end: number }>;
  prefix: boolean;
  suffix: boolean;
  messageIndex: number;
  role: "user" | "assistant";
};

export type SessionSearchHit = {
  sessionId: string;
  filePath: string;
  title: string | null;
  cwd: string;
  createdAt: string;
  titleMatch: boolean;
  totalMatches: number;
  snippets: SearchSnippet[];
};

export type SearchResult = {
  query: string;
  hits: SessionSearchHit[];
  scanned: number;
  reindexed: number;
  truncated: boolean;
};

type CachedIndex = {
  size: number;
  mtimeMs: number;
  sessionId: string | null;
  cwd: string;
  createdAt: string;
  title: string | null;
  docs: SearchDoc[];
  truncatedDocs: number;
};

type ShadowFile = {
  version: number;
  size: number;
  mtimeMs: number;
  sessionId: string | null;
  cwd: string;
  createdAt: string;
  title: string | null;
  docs: SearchDoc[];
  truncatedDocs: number;
};

// ---- 进程内 LRU：Map 保持插入序，命中时 delete+set 刷新，超限淘汰最旧 ----

const memoryCache = new Map<string, CachedIndex>();
let memoryChars = 0;
// 在途影子写盘句柄：测试等待落盘完成再清理临时目录，避免 rm 撞上异步写
const pendingWrites = new Set<Promise<unknown>>();

function cachedChars(entry: CachedIndex): number {
  let total = 0;
  for (const doc of entry.docs) total += doc.text.length;
  return total;
}

function remember(indexPath: string, entry: CachedIndex): void {
  const existing = memoryCache.get(indexPath);
  if (existing) {
    memoryChars -= cachedChars(existing);
    memoryCache.delete(indexPath);
  }
  memoryCache.set(indexPath, entry);
  memoryChars += cachedChars(entry);
  while (memoryCache.size > 0 && (memoryCache.size > MEMORY_MAX_ENTRIES || memoryChars > MEMORY_MAX_CHARS)) {
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = memoryCache.get(oldestKey);
    memoryCache.delete(oldestKey);
    if (oldest) memoryChars -= cachedChars(oldest);
  }
}

function forget(indexPath: string): void {
  const existing = memoryCache.get(indexPath);
  if (existing) {
    memoryChars -= cachedChars(existing);
    memoryCache.delete(indexPath);
  }
}

export function searchIndexPath(sessionsDir: string, fileName: string): string {
  return path.join(sessionsDir, SEARCH_DIR, `${fileName}.json`);
}

/** 清空进程内影子索引缓存（测试/调试用；磁盘影子不受影响）。 */
export function dropSearchMemoryCache(): void {
  memoryCache.clear();
  memoryChars = 0;
}

/** 影子索引文件名是否安全（只允许由 resolveSessionFile 放行的顶层 .jsonl 派生） */
function isSafeSessionFileName(fileName: string): boolean {
  return fileName.endsWith(".jsonl") && !fileName.includes("/") && !fileName.includes("\\") && fileName !== ".jsonl";
}

/** 删除某会话的影子索引（内存 + 磁盘）；删除会话 / 强制重建时调用。 */
export async function invalidateSearchIndex(sessionsDir: string, fileName: string): Promise<void> {
  if (!isSafeSessionFileName(fileName)) return;
  forget(searchIndexPath(sessionsDir, fileName));
  await fs.unlink(searchIndexPath(sessionsDir, fileName)).catch(() => undefined);
}

/**
 * 文本扁平化：换行与连续空白折叠为单空格。
 * 折叠在「写入索引时」一次性完成，检索端不再改写文本，保证偏移稳定。
 */
export function flattenForSearch(text: string): string {
  // 控制字符（含 \r \n \t 与 C0 区）一律折叠成空格，属于刻意的清洗行为
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u001F]+/g, " ").replace(/\s+/g, " ").trim();
}

function isPrintableText(text: string): boolean {
  return typeof text === "string" && text.length > 0;
}

/**
 * 从 JSONL 行数组提取可检索文档。
 * 关键约定：messageIndex 按 type:"message" 条目连续自增（tool/system 也占号），
 * 与 /session/messages 返回的 messagesForClient 下标严格对齐，跳转锚点依赖这一点。
 */
export function extractSearchDocs(
  lines: readonly string[],
  limits: { docChars?: number; sessionChars?: number; maxDocs?: number } = {},
): { header: SessionHeader | null; title: string | null; docs: SearchDoc[]; truncatedDocs: number } {
  const docChars = limits.docChars ?? DEFAULT_DOC_CHARS;
  const sessionChars = limits.sessionChars ?? DEFAULT_SESSION_CHARS;
  const maxDocs = limits.maxDocs ?? Number.POSITIVE_INFINITY;

  let header: SessionHeader | null = null;
  try {
    const parsed = JSON.parse(lines[0] ?? "") as SessionHeader;
    if (parsed?.type === "session") header = parsed;
  } catch {
    return { header: null, title: null, docs: [], truncatedDocs: 0 };
  }
  if (!header) return { header: null, title: null, docs: [], truncatedDocs: 0 };

  let title: string | null = null;
  const docs: SearchDoc[] = [];
  let messageIndex = -1;
  let usedChars = 0;
  let truncatedDocs = 0;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    let entry: SearchableEntry;
    try {
      entry = JSON.parse(line) as SearchableEntry;
    } catch {
      continue; // 撕裂/坏行：与 parseSessionSummary 同策略，静默跳过
    }
    if (entry.type === "title") {
      if (isPrintableText(entry.title)) title = entry.title;
      continue;
    }
    if (entry.type !== "message") continue;

    // 先自增再过滤：tool/system/content:null 的 message 条目也占号
    messageIndex += 1;
    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const content = entry.message?.content;
    if (typeof content !== "string" || !content.trim()) continue;
    if (docs.length >= maxDocs || usedChars >= sessionChars) {
      truncatedDocs += 1;
      continue;
    }

    const flat = flattenForSearch(content);
    if (!flat) continue;
    const text = flat.slice(0, docChars);
    if (flat.length > docChars) truncatedDocs += 1;
    usedChars += text.length;
    docs.push({
      messageIndex,
      role,
      text,
      ...(entry.id ? { entryId: entry.id } : {}),
      ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
    });
  }

  return { header, title, docs, truncatedDocs };
}

// ---- 大小写折叠：折叠改变长度（如土耳其 İ）时退化为原样匹配，保证偏移可靠 ----

function foldPair(text: string, query: string): { haystack: string; needle: string } {
  const foldedText = text.toLowerCase();
  const foldedQuery = query.toLowerCase();
  if (foldedText.length === text.length && foldedQuery.length === query.length) {
    return { haystack: foldedText, needle: foldedQuery };
  }
  return { haystack: text, needle: query };
}

type WindowMatch = { start: number; end: number };

function buildDocSnippets(doc: SearchDoc, query: string): { snippets: SearchSnippet[]; matches: number } {
  const { haystack, needle } = foldPair(doc.text, query);
  if (!needle) return { snippets: [], matches: 0 };

  const positions: number[] = [];
  let from = 0;
  for (;;) {
    const found = haystack.indexOf(needle, from);
    if (found < 0) break;
    positions.push(found);
    from = found + needle.length;
    if (positions.length >= MAX_POSITIONS_PER_DOC) break; // 工作量上限：超出部分不计入
  }
  if (positions.length === 0) return { snippets: [], matches: 0 };

  // 相邻命中合并成窗口，重叠或间隔极近的命中共享一个片段
  const windows: WindowMatch[] = [];
  for (const position of positions) {
    const start = Math.max(0, position - SNIPPET_RADIUS);
    const end = Math.min(doc.text.length, position + needle.length + SNIPPET_RADIUS);
    const last = windows[windows.length - 1];
    if (last && position - last.end <= SNIPPET_MERGE_GAP) {
      last.end = Math.max(last.end, end);
    } else {
      windows.push({ start, end });
    }
  }

  const budget = Math.max(SNIPPET_MAX_CHARS, needle.length + SNIPPET_RADIUS);
  const snippets: SearchSnippet[] = [];
  for (const window of windows.slice(0, MAX_WINDOWS_PER_DOC)) {
    let start = window.start;
    let end = window.end;
    if (end - start > budget) {
      const firstMatch = positions.find((p) => p >= start && p < end) ?? start;
      start = Math.max(window.start, firstMatch - SNIPPET_RADIUS);
      end = Math.min(window.end, start + budget);
      start = Math.max(window.start, end - budget);
    }
    const ranges = positions
      .filter((p) => p >= start && p < end)
      .map((p) => ({ start: p - start, end: p - start + needle.length }));
    if (ranges.length === 0) continue;
    snippets.push({
      text: doc.text.slice(start, end),
      ranges,
      prefix: start > 0,
      suffix: end < doc.text.length,
      messageIndex: doc.messageIndex,
      role: doc.role,
    });
  }
  return { snippets, matches: positions.length };
}

function matchTitle(title: string | null, query: string): boolean {
  if (!title) return false;
  const { haystack, needle } = foldPair(title, query);
  return haystack.includes(needle);
}

function samePath(a: string, b: string): boolean {
  try {
    const left = path.resolve(a);
    const right = path.resolve(b);
    if (process.platform === "win32") return left.toLowerCase() === right.toLowerCase();
    return left === right;
  } catch {
    return false;
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function loadIndexEntry(
  sessionsDir: string,
  fileName: string,
  stat: { size: number; mtimeMs: number },
): Promise<{ entry: CachedIndex | null; rebuilt: boolean }> {
  const indexPath = searchIndexPath(sessionsDir, fileName);

  const cached = memoryCache.get(indexPath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    // 刷新 LRU 顺序
    memoryCache.delete(indexPath);
    memoryCache.set(indexPath, cached);
    return { entry: cached, rebuilt: false };
  }

  // 磁盘影子命中：version/size/mtime 全部匹配才可信
  try {
    const shadow = await readJsonFile<ShadowFile>(indexPath);
    if (
      shadow &&
      shadow.version === INDEX_VERSION &&
      shadow.size === stat.size &&
      shadow.mtimeMs === stat.mtimeMs &&
      Array.isArray(shadow.docs)
    ) {
      const entry: CachedIndex = {
        size: shadow.size,
        mtimeMs: shadow.mtimeMs,
        sessionId: shadow.sessionId ?? null,
        cwd: shadow.cwd ?? "",
        createdAt: shadow.createdAt ?? "",
        title: shadow.title ?? null,
        docs: shadow.docs,
        truncatedDocs: shadow.truncatedDocs ?? 0,
      };
      remember(indexPath, entry);
      return { entry, rebuilt: false };
    }
  } catch {
    // 坏影子：当未命中重建
  }

  // 重建：整文件解析（坏行由 extractSearchDocs 静默跳过）
  let entry: CachedIndex;
  try {
    const content = await fs.readFile(path.join(sessionsDir, fileName), "utf8");
    const extracted = extractSearchDocs(content.split(/\r?\n/));
    if (!extracted.header) {
      // 坏会话文件：缓存空文档避免反复读盘，但绝不产生命中
      entry = {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        sessionId: null,
        cwd: "",
        createdAt: "",
        title: null,
        docs: [],
        truncatedDocs: 0,
      };
    } else {
      entry = {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        sessionId: extracted.header.id,
        cwd: extracted.header.cwd,
        createdAt: extracted.header.createdAt,
        title: extracted.title,
        docs: extracted.docs,
        truncatedDocs: extracted.truncatedDocs,
      };
    }
  } catch {
    return { entry: null, rebuilt: true };
  }

  remember(indexPath, entry);
  // 写盘失败只丢下次缓存，不影响本次检索
  const shadow: ShadowFile = { version: INDEX_VERSION, ...entry };
  const write = writeJsonAtomic(indexPath, shadow).catch(() => undefined);
  pendingWrites.add(write);
  void write.finally(() => pendingWrites.delete(write));
  return { entry, rebuilt: true };
}

/** 等待所有在途影子写盘结束（测试用：清理临时目录前调用，避免 ENOTEMPTY）。 */
export async function flushSearchIndexWrites(): Promise<void> {
  for (let guard = 0; guard < 100 && pendingWrites.size > 0; guard += 1) {
    await Promise.allSettled([...pendingWrites]);
  }
}

/** 孤儿影子清理：对应 .jsonl 已不存在的影子文件顺手删掉（尽力而为，不阻塞响应）。 */
function pruneOrphanShadows(sessionsDir: string, liveFiles: Set<string>): void {
  void (async () => {
    const searchDir = path.join(sessionsDir, SEARCH_DIR);
    const names = await fs.readdir(searchDir).catch(() => [] as string[]);
    await Promise.all(
      names
        .filter((name) => name.endsWith(".jsonl.json") && !liveFiles.has(name.slice(0, -".json".length)))
        .map((name) => fs.unlink(path.join(searchDir, name)).catch(() => undefined)),
    );
  })().catch(() => undefined);
}

export async function searchSessions(
  sessionsDir: string,
  query: string,
  options: { limit?: number; workspace?: string | null } = {},
): Promise<SearchResult> {
  const trimmed = query.trim().slice(0, MAX_QUERY_CHARS);
  const empty: SearchResult = { query: trimmed, hits: [], scanned: 0, reindexed: 0, truncated: false };
  if (!trimmed) return empty;

  let names: string[] = [];
  try {
    names = (await fs.readdir(sessionsDir)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return empty;
  }

  const stats = await Promise.all(
    names.map(async (name) => {
      try {
        const stat = await fs.stat(path.join(sessionsDir, name));
        return { name, size: stat.size, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  const files = stats.filter((item): item is { name: string; size: number; mtimeMs: number } => item !== null);

  let reindexed = 0;
  const entries = await mapWithConcurrency(files, BUILD_CONCURRENCY, async (file) => {
    const loaded = await loadIndexEntry(sessionsDir, file.name, { size: file.size, mtimeMs: file.mtimeMs });
    if (loaded.rebuilt) reindexed += 1;
    return { file, entry: loaded.entry };
  });

  const limit = options.limit && options.limit > 0 ? Math.min(Math.floor(options.limit), MAX_LIMIT) : DEFAULT_LIMIT;
  const workspace = options.workspace?.trim() || null;
  let truncated = false;
  const hits: SessionSearchHit[] = [];

  for (const { file, entry } of entries) {
    if (!entry || !entry.sessionId) continue;
    if (workspace && !samePath(entry.cwd, workspace)) continue;
    if (entry.truncatedDocs > 0) truncated = true;

    const titleMatch = matchTitle(entry.title, trimmed);
    let totalMatches = 0;
    const snippets: SearchSnippet[] = [];
    for (const doc of entry.docs) {
      const built = buildDocSnippets(doc, trimmed);
      totalMatches += built.matches;
      for (const snippet of built.snippets) {
        if (snippets.length >= MAX_SNIPPETS_PER_SESSION) break;
        snippets.push(snippet);
      }
      if (snippets.length >= MAX_SNIPPETS_PER_SESSION) break;
    }
    if (!titleMatch && snippets.length === 0) continue;

    hits.push({
      sessionId: entry.sessionId,
      filePath: path.join(sessionsDir, file.name),
      title: entry.title,
      cwd: entry.cwd,
      createdAt: entry.createdAt,
      titleMatch,
      totalMatches,
      snippets,
    });
  }

  hits.sort((a, b) => {
    if (a.titleMatch !== b.titleMatch) return a.titleMatch ? -1 : 1;
    if (b.totalMatches !== a.totalMatches) return b.totalMatches - a.totalMatches;
    if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
    return a.filePath.localeCompare(b.filePath);
  });

  pruneOrphanShadows(sessionsDir, new Set(files.map((file) => file.name)));

  return {
    query: trimmed,
    hits: hits.slice(0, limit),
    scanned: files.length,
    reindexed,
    truncated,
  };
}
