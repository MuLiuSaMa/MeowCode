import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_PDF_PAGES,
  isScanned,
  parsePageRange,
  readPdfPageCount,
  readPdfText,
  renderPdfText,
  type PdfDocumentLike,
  type PdfLoader,
} from "./pdf.js";

/** 构造一个最小但合法的 PDF（Helvetica，一页一行文本），用于跑真实的 pdfjs 抽取。 */
function buildPdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const kids = pages.map((_, index) => `${4 + index * 2} 0 R`);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((text, index) => {
    const contentId = 5 + index * 2;
    objects[4 + index * 2] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let index = 1; index < objects.length; index += 1) {
    offsets[index] = Buffer.byteLength(out, "latin1");
    out += `${index} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let index = 1; index < objects.length; index += 1) {
    out += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meowcode-pdf-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** 假 loader：每页返回固定文本，并记录被调用次数（缓存命中后不应再调用）。 */
function fakeLoader(pages: string[]): PdfLoader & { calls: number } {
  const loader = (async () => {
    loader.calls += 1;
    return {
      pageCount: pages.length,
      pageText: async (page: number) => pages[page - 1] ?? "",
    } satisfies PdfDocumentLike;
  }) as PdfLoader & { calls: number };
  loader.calls = 0;
  return loader;
}

describe("parsePageRange", () => {
  it("defaults to the first 20 pages", () => {
    expect(parsePageRange(undefined, 100)).toEqual({
      ok: true,
      pages: Array.from({ length: MAX_PDF_PAGES }, (_, index) => index + 1),
    });
    expect(parsePageRange(undefined, 3)).toEqual({ ok: true, pages: [1, 2, 3] });
  });

  it("understands single pages, ranges and lists", () => {
    expect(parsePageRange("3", 10)).toEqual({ ok: true, pages: [3] });
    expect(parsePageRange("1-5", 10)).toEqual({ ok: true, pages: [1, 2, 3, 4, 5] });
    expect(parsePageRange("1-3,7", 10)).toEqual({ ok: true, pages: [1, 2, 3, 7] });
    // 重复页去重并排序
    expect(parsePageRange("2,1-2", 10)).toEqual({ ok: true, pages: [1, 2] });
  });

  it("clamps to the document length", () => {
    expect(parsePageRange("8-20", 10)).toEqual({ ok: true, pages: [8, 9, 10] });
  });

  it("rejects garbage and oversized requests", () => {
    expect(parsePageRange("abc", 10).ok).toBe(false);
    expect(parsePageRange("5-1", 10).ok).toBe(false);
    expect(parsePageRange("1-30", 100).ok).toBe(false);
    expect(parsePageRange("99", 10).ok).toBe(false);
  });
});

describe("readPdfPageCount", () => {
  it("只读页数，不请求正文", async () => {
    const loader = fakeLoader(["one", "two", "three"]);
    expect(await readPdfPageCount(new Uint8Array([1, 2, 3]), loader)).toBe(3);
    expect(loader.calls).toBe(1);
  });

  it("解析失败时返回 undefined", async () => {
    const loader = (async () => {
      throw new Error("broken");
    }) as PdfLoader;
    expect(await readPdfPageCount(new Uint8Array([1]), loader)).toBeUndefined();
  });
});

describe("renderPdfText", () => {
  it("marks every page and adds a continuation hint", () => {
    const result = renderPdfText({
      name: "r.pdf",
      stats: { pages: 12, chars: 40, emptyPages: 0, countedPages: 2 },
      requested: [1, 2],
      pages: [
        { page: 1, text: "alpha" },
        { page: 2, text: "beta" },
      ],
    });
    expect(result.text).toContain("PDF: r.pdf (12 pages");
    expect(result.text).toContain("[page 1]\nalpha");
    expect(result.text).toContain("[page 2]\nbeta");
    expect(result.text).toContain('pages="3-12"');
  });

  it("marks empty pages instead of silently dropping them", () => {
    const result = renderPdfText({
      name: "s.pdf",
      stats: { pages: 1, chars: 0, emptyPages: 1, countedPages: 1 },
      requested: [1],
      pages: [{ page: 1, text: "   " }],
    });
    expect(result.text).toContain("[page 1] (no extractable text)");
  });

  it("truncates long pages at the per-page budget", () => {
    const result = renderPdfText({
      name: "t.pdf",
      stats: { pages: 1, chars: 50, emptyPages: 0, countedPages: 1 },
      requested: [1],
      pages: [{ page: 1, text: "x".repeat(50) }],
      pageBudget: 5,
    });
    expect(result.text).toContain("[page truncated at 5 tokens]");
    expect(result.truncatedPages).toBe(1);
  });
});

describe("isScanned", () => {
  it("treats a nearly empty text layer as a scan", () => {
    expect(isScanned({ pages: 10, chars: 40, emptyPages: 9, countedPages: 10 })).toBe(true);
    expect(isScanned({ pages: 10, chars: 4000, emptyPages: 0, countedPages: 10 })).toBe(false);
    expect(isScanned({ pages: 0, chars: 0, emptyPages: 0, countedPages: 0 })).toBe(true);
  });
});

describe("readPdfText", () => {
  it("extracts real text through pdfjs with page markers", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "sample.pdf");
    // 每页给足字符：扫描件判据是"平均每页 < 50 字符"，短样本会被误判成扫描件
    const page1 = "Hello page one. " + "alpha ".repeat(20);
    const page2 = "Second page text here. " + "beta ".repeat(20);
    await fs.writeFile(file, buildPdf([page1, page2]));

    const result = await readPdfText({ file, name: "sample.pdf", workspace: dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scanned).toBe(false);
    expect(result.stats.pages).toBe(2);
    // pdfjs 会按文本项重新排版（行尾空白被裁掉），只断言稳定的前缀
    expect(result.output).toContain("[page 1]\nHello page one. alpha alpha");
    expect(result.output).toContain("[page 2]\nSecond page text here. beta beta");
    expect(result.cached).toBe(false);
  });

  it("honours a page range", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "sample.pdf");
    await fs.writeFile(file, buildPdf(["one", "two", "three"]));

    const result = await readPdfText({ file, name: "sample.pdf", pages: "3", workspace: dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toContain("[page 3]\nthree");
    expect(result.output).not.toContain("[page 1]");
  });

  it("caps the first read at 20 pages and points at the rest", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "long.pdf");
    await fs.writeFile(file, buildPdf(Array.from({ length: 25 }, (_, index) => `page ${index + 1}`)));

    const result = await readPdfText({ file, name: "long.pdf", workspace: dir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stats.pages).toBe(25);
    expect(result.output).toContain("[page 20]");
    expect(result.output).not.toContain("[page 21]");
    expect(result.output).toContain('pages="21-25"');
  });

  it("serves the second read from the on-disk cache without parsing again", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "cached.pdf");
    await fs.writeFile(file, buildPdf(["cached page"]));
    const loader = fakeLoader(["cached page"]);

    const first = await readPdfText({ file, name: "cached.pdf", workspace: dir, loader });
    const second = await readPdfText({ file, name: "cached.pdf", workspace: dir, loader });
    expect(first.ok && first.cached).toBe(false);
    expect(second.ok && second.cached).toBe(true);
    expect(loader.calls).toBe(1);
    expect(second.ok && second.output).toContain("[page 1]\ncached page");
  });

  it("flags a scanned PDF when the text layer is empty", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "scan.pdf");
    await fs.writeFile(file, buildPdf(["", "", ""]));
    const result = await readPdfText({ file, name: "scan.pdf", workspace: dir, loader: fakeLoader(["", "", ""]) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scanned).toBe(true);
    expect(result.output).toContain("no text layer");
  });

  it("returns an actionable error for a broken file", async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, "broken.pdf");
    await fs.writeFile(file, "not a pdf at all");
    const result = await readPdfText({
      file,
      name: "broken.pdf",
      workspace: dir,
      loader: async () => {
        throw new Error("Invalid PDF structure");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Could not parse broken.pdf");
  });
});
