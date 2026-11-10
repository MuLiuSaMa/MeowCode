/**
 * PDF 文本抽取（本地文本层，最省 token 的一条路）。
 *
 * 为什么不用服务商原生 document：Anthropic 按页计 1.5–3k token，一份 20 页
 * 的报告就是 3–6 万 token；本地抽文本层只需 ~0.25 token/字符，同一份文件常常
 * 便宜两个数量级。只有**扫描件**（几乎没有文本层）才回退到原文件上传。
 *
 * 三条约束：
 *  - 单次最多 20 页、4k tokens（对齐 read_file 的输出预算），超出给续读提示；
 *  - 结果按 sha256 + 页范围缓存到 `.meowcode/cache/pdf/`，二次读取不再解析；
 *  - pdfjs 只在真正读 PDF 时动态 import（legacy 构建，Node 侧 fake worker）。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "./atomic-json.js";
import { estimateTokens } from "./context.js";
import { sliceHeadToTokens } from "./tool-budget.js";

/** 单次最多抽多少页 */
export const MAX_PDF_PAGES = 20;
/** 单次输出 token 预算（与工具输出口径一致） */
export const PDF_TOKENS_PER_CALL = 4_000;
/** 单页 token 上限：超长页（整本排版成单页的报表）按页截断，保其余页 */
export const PDF_TOKENS_PER_PAGE = 1_200;
/** 扫描件判据：抽到的页平均字符数低于这个值，就认为没有可用文本层 */
export const SCANNED_CHARS_PER_PAGE = 50;
/** 单页少于这个字符数视为空页（页眉/页码噪声），直接跳过 */
const EMPTY_PAGE_CHARS = 20;
/** 文件体积上限：再大就不适合整份读进内存解析了 */
export const MAX_PDF_BYTES = 64 * 1024 * 1024;

export type PdfPage = { page: number; text: string };

export type PdfStats = {
  /** 文档总页数 */
  pages: number;
  /** 本次抽取到的字符总数 */
  chars: number;
  /** 抽到的页里有多少页几乎没内容 */
  emptyPages: number;
  /** 参与统计的页数（空页也算：扫描件正是"每页都空"） */
  countedPages: number;
};

/** 抽取结果（不含协议层的 document 回退，那由调用方决定）。 */
export type PdfTextResult =
  | {
      ok: true;
      output: string;
      /** 扫描件：几乎没有文本层，值得改用原生 document */
      scanned: boolean;
      stats: PdfStats;
      /** 命中磁盘缓存，没有重新解析 */
      cached: boolean;
    }
  | { ok: false; output: string; scanned: false; cached?: boolean };

/** 最小文档抽象：便于测试注入假 loader，也隔离 pdfjs 的类型。 */
export type PdfDocumentLike = {
  pageCount: number;
  /** 1-based 页号；返回该页的纯文本 */
  pageText(page: number): Promise<string>;
};

export type PdfLoader = (data: Uint8Array) => Promise<PdfDocumentLike>;

/** 扫描件判据：平均每页字符数低于阈值。 */
export function isScanned(stats: PdfStats): boolean {
  if (stats.countedPages <= 0) return true;
  return stats.chars / stats.countedPages < SCANNED_CHARS_PER_PAGE;
}

/**
 * 解析页范围表达式："1-5" / "3" / "1-3,7"。
 * 未给时取前 MAX_PDF_PAGES 页；超出文档末尾的页号静默丢弃（用户不可能知道总页数）。
 * `cap` 是本条表达式允许的页数上限 —— 缓存键的预解析要先放宽容纳 "1-30"
 * （真文档可能只有 5 页），真正抽取时再按 MAX_PDF_PAGES 卡一次。
 */
export function parsePageRange(
  spec: string | undefined,
  totalPages: number,
  cap = MAX_PDF_PAGES,
): { ok: true; pages: number[] } | { ok: false; error: string } {
  const limit = Math.max(1, totalPages);
  const raw = (spec ?? "").trim();
  if (!raw) {
    return { ok: true, pages: rangeOf(1, Math.min(limit, Math.min(cap, MAX_PDF_PAGES))) };
  }
  const pages = new Set<number>();
  for (const token of raw.split(",")) {
    const part = token.trim();
    if (!part) continue;
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!match) {
      return { ok: false, error: `invalid page range "${part}" (use "1-5", "3" or "1-3,7")` };
    }
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (start < 1 || end < start) {
      return { ok: false, error: `invalid page range "${part}"` };
    }
    for (let page = start; page <= Math.min(end, limit); page += 1) {
      pages.add(page);
      if (pages.size > cap) {
        return { ok: false, error: `at most ${MAX_PDF_PAGES} pages per read` };
      }
    }
  }
  if (!pages.size) return { ok: false, error: `no page in "${raw}" exists (document has ${limit})` };
  return { ok: true, pages: [...pages].sort((a, b) => a - b) };
}

function rangeOf(start: number, end: number): number[] {
  const pages: number[] = [];
  for (let page = start; page <= end; page += 1) pages.push(page);
  return pages;
}

/**
 * 渲染成给模型的文本：`[page N]` 分段 + 头部的总览行 + 尾部的续读提示。
 * 页序按请求顺序输出（1-3,7 就是 1,2,3,7），不重排成全文顺序 —— 用户要的就是这个子集。
 */
export function renderPdfText(input: {
  name: string;
  stats: PdfStats;
  requested: number[];
  pages: PdfPage[];
  /** 单次 token 预算，默认 PDF_TOKENS_PER_CALL */
  budget?: number;
  /** 单页 token 上限，默认 PDF_TOKENS_PER_PAGE */
  pageBudget?: number;
}): { text: string; truncatedPages: number; omittedPages: number } {
  const budget = input.budget ?? PDF_TOKENS_PER_CALL;
  const pageBudget = input.pageBudget ?? PDF_TOKENS_PER_PAGE;
  const shown: string[] = [];
  let used = 0;
  let truncatedPages = 0;
  let omittedPages = 0;

  for (const page of input.pages) {
    const text = page.text.trim();
    if (!text) {
      // 空页只留一行标记：让模型知道这一页确实没有文本，而不是被吞掉
      const line = `[page ${page.page}] (no extractable text)`;
      if (used + estimateTokens(line) > budget) {
        omittedPages += 1;
        continue;
      }
      shown.push(line);
      used += estimateTokens(line);
      continue;
    }
    const head = `[page ${page.page}]`;
    const textTokens = estimateTokens(text);
    if (used + estimateTokens(head) + textTokens > budget) {
      const room = budget - used - estimateTokens(head) - 20;
      if (room <= 80) {
        omittedPages += 1;
        continue;
      }
      const kept = sliceHeadToTokens(text, Math.min(room, pageBudget));
      shown.push(`${head}\n${kept}\n... [page truncated by output budget]`);
      used = budget;
      truncatedPages += 1;
      continue;
    }
    if (textTokens > pageBudget) {
      const kept = sliceHeadToTokens(text, pageBudget);
      shown.push(`${head}\n${kept}\n... [page truncated at ${pageBudget} tokens]`);
      used += estimateTokens(head) + pageBudget;
      truncatedPages += 1;
      continue;
    }
    shown.push(`${head}\n${text}`);
    used += estimateTokens(head) + textTokens;
  }

  const requested = input.requested.length
    ? input.requested
    : input.pages.map((page) => page.page);
  const first = requested[0] ?? 1;
  const last = requested.at(-1) ?? first;
  const head = input.stats.pages
    ? `PDF: ${input.name} (${input.stats.pages} pages, ${input.stats.chars} chars extracted from here, showing ${first}-${last})`
    : `PDF: ${input.name}`;
  const notes: string[] = [];
  if (last < input.stats.pages) {
    notes.push(
      `... [${input.stats.pages - last} more pages; call read_file again with pages="${last + 1}-${Math.min(
        input.stats.pages,
        last + MAX_PDF_PAGES,
      )}" to continue]`,
    );
  }
  if (omittedPages) notes.push(`... [${omittedPages} page(s) omitted: output budget exhausted]`);
  return { text: [head, ...shown, ...notes].join("\n"), truncatedPages, omittedPages };
}

type CacheEntry = {
  version: 1;
  pageCount: number;
  /** 只缓存抽过的页，避免每次重算整本 */
  pages: PdfPage[];
};

function cacheDir(workspace: string): string {
  return path.join(workspace, ".meowcode", "cache", "pdf");
}

function cacheKey(sha: string, pages: number[]): string {
  const first = pages[0] ?? 1;
  const last = pages.at(-1) ?? 1;
  return `${sha}-${first}-${last}.json`;
}

async function sha256Of(file: string): Promise<{ sha: string; size: number }> {
  const data = await fs.readFile(file);
  return { sha: createHash("sha256").update(data).digest("hex"), size: data.length };
}

/**
 * 默认 loader：pdfjs legacy 构建（Node 下 fake worker，不需要 worker 文件）。
 * 用动态 import + 字符串变量，绕开 TS 对深层子路径的类型解析：
 * pdfjs 的类型声明挂在 `pdfjs-dist` 顶层，`legacy/build/pdf.mjs` 没有独立 d.ts。
 */
const defaultLoader: PdfLoader = async (data) => {
  const specifier = "pdfjs-dist/legacy/build/pdf.mjs";
  const pdfjs = (await import(specifier)) as unknown as {
    getDocument(options: Record<string, unknown>): {
      promise: Promise<{
        numPages: number;
        getPage(page: number): Promise<{
          getTextContent(): Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }>;
        }>;
      }>;
    };
  };
  const doc = await pdfjs.getDocument({
    // 复制一份：pdfjs 会转移 buffer 的所有权，调用方之后还要拿原字节做 document 回退
    data: new Uint8Array(data),
    // 不做字体/求值相关的高开销初始化：只要文本层
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: true,
    verbosity: 0,
  }).promise;
  return {
    pageCount: doc.numPages,
    async pageText(page: number) {
      const target = await doc.getPage(page);
      const content = await target.getTextContent();
      const parts: string[] = [];
      for (const item of content.items) {
        if (typeof item.str !== "string") continue;
        parts.push(item.str);
        if (item.hasEOL) parts.push("\n");
      }
      return parts.join("");
    },
  };
};

/** 只读页数，不抽正文：给 prompt 附件的 token 估算用；解析失败返回 undefined。 */
export async function readPdfPageCount(
  data: Uint8Array,
  loader: PdfLoader = defaultLoader,
): Promise<number | undefined> {
  if (data.byteLength > MAX_PDF_BYTES) return undefined;
  try {
    const doc = await loader(data);
    return doc.pageCount > 0 ? doc.pageCount : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 读一个 PDF 的文本层。
 *
 * `pages` 是用户/模型给的页范围表达式；缓存键 = sha256 + 首末页，
 * 因此同一个文件的同一段页第二次读会直接命中（不再 import pdfjs）。
 */
export async function readPdfText(options: {
  file: string;
  name: string;
  pages?: string;
  /** 缓存根（通常是工作区）；缺省不落缓存 */
  workspace?: string;
  /** 测试注入用 */
  loader?: PdfLoader;
  /** 测试注入用：跳过真实文件读取 */
  data?: Uint8Array;
}): Promise<PdfTextResult> {
  const { file, name } = options;
  let data = options.data;
  let sha = "";
  try {
    if (!data) {
      const stat = await fs.stat(file);
      if (!stat.isFile()) return { ok: false, output: `File not found: ${name}`, scanned: false };
      if (stat.size > MAX_PDF_BYTES) {
        return {
          ok: false,
          output: `PDF ${name} is ${(stat.size / (1024 * 1024)).toFixed(1)}MB, above the ${
            MAX_PDF_BYTES / (1024 * 1024)
          }MB limit for text extraction. Read a page range with a PDF tool instead.`,
          scanned: false,
        };
      }
      const hash = await sha256Of(file);
      sha = hash.sha;
      data = new Uint8Array(await fs.readFile(file));
    } else {
      sha = createHash("sha256").update(data).digest("hex");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, output: `Could not read ${name}: ${message}`, scanned: false };
  }

  const loader = options.loader ?? defaultLoader;
  const dir = options.workspace ? cacheDir(options.workspace) : undefined;

  // 先用「请求范围」算缓存键；未给范围时按默认前 N 页（pageCount 未知也能算）。
  // 预解析放宽页数上限：此时还不知道总页数，pages="1-30" 可能只是 5 页的文档。
  const preliminary = parsePageRange(options.pages, Number.MAX_SAFE_INTEGER, 10_000);
  if (!preliminary.ok) {
    return { ok: false, output: preliminary.error, scanned: false };
  }
  const key = dir ? cacheKey(sha, preliminary.pages) : "";
  const cachePath = dir ? path.join(dir, key) : "";

  let entry: CacheEntry | undefined;
  if (cachePath) {
    entry = await readJsonFile<CacheEntry>(cachePath).catch(() => undefined);
    if (entry && entry.version !== 1) entry = undefined;
  }

  let pageCount = entry?.pageCount ?? 0;
  let pages = entry?.pages ?? [];
  const cached = Boolean(entry);

  if (!entry) {
    let doc: PdfDocumentLike;
    try {
      doc = await loader(data!);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        output: `Could not parse ${name} as PDF: ${message}`,
        scanned: false,
      };
    }
    pageCount = doc.pageCount;
    const resolved = parsePageRange(options.pages, pageCount);
    if (!resolved.ok) return { ok: false, output: resolved.error, scanned: false };
    const wanted = resolved.pages.slice(0, MAX_PDF_PAGES);
    const collected: PdfPage[] = [];
    for (const page of wanted) {
      try {
        collected.push({ page, text: await doc.pageText(page) });
      } catch {
        // 单页解析失败不影响其余页：标记空页，模型能看到这里有缺口
        collected.push({ page, text: "" });
      }
      // 页范围可能因 totalPages 变小而收缩：键也要跟着变
    }
    pages = collected;
    entry = { version: 1, pageCount, pages };
    if (cachePath) {
      // 缓存写失败不影响本次读取（缓存只是加速）
      await writeJsonAtomic(cachePath, entry).catch(() => undefined);
    }
  }

  const chars = pages.reduce((sum, page) => sum + page.text.trim().length, 0);
  const emptyPages = pages.filter((page) => page.text.trim().length < EMPTY_PAGE_CHARS).length;
  const stats: PdfStats = {
    pages: pageCount,
    chars,
    emptyPages,
    countedPages: pages.length,
  };
  const rendered = renderPdfText({
    name,
    stats,
    requested: pages.map((page) => page.page),
    pages,
  });
  const scanned = isScanned(stats);
  const scannedNote = scanned
    ? "\n[Note: this PDF has almost no text layer — it looks like a scan. If the model supports PDF input, the original file can be attached instead of text.]"
    : "";
  return {
    ok: true,
    output: `${rendered.text}${scannedNote}`,
    scanned,
    stats,
    cached,
  };
}

/** 读整个文件成 base64（扫描件回退成原生 document 时用）。 */
export async function readPdfBase64(file: string): Promise<string | undefined> {
  try {
    const data = await fs.readFile(file);
    return data.toString("base64");
  } catch {
    return undefined;
  }
}

/** 缓存目录路径（测试断言用）。 */
export function pdfCacheDir(workspace: string): string {
  return cacheDir(workspace);
}
