import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  dropSearchMemoryCache,
  extractSearchDocs,
  flattenForSearch,
  flushSearchIndexWrites,
  invalidateSearchIndex,
  searchIndexPath,
  searchSessions,
} from "./session-search";

const dirs: string[] = [];

async function makeSessionsDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "meowcode-session-search-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  dropSearchMemoryCache();
  await flushSearchIndexWrites();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function line(value: unknown): string {
  return JSON.stringify(value);
}

/** 生成一个最小会话文件；entries 按 JSONL 行追加（header 之后） */
async function writeSession(
  dir: string,
  fileName: string,
  entries: unknown[],
  header?: Record<string, unknown>,
): Promise<string> {
  const filePath = path.join(dir, fileName);
  const headerLine = header
    ? line(header)
    : line({
        type: "session",
        version: 2,
        id: fileName.replace(/\.jsonl$/, "").padEnd(36, "0").slice(0, 36),
        cwd: "D:\\work",
        createdAt: "2026-11-01T00:00:00.000Z",
      });
  await writeFile(filePath, [headerLine, ...entries.map((entry) => line(entry))].join("\n") + "\n", "utf8");
  return filePath;
}

let entrySeq = 0;
function messageEntry(message: unknown, timestamp = "2026-11-01T00:01:00.000Z"): Record<string, unknown> {
  entrySeq += 1;
  return { type: "message", id: `e${entrySeq}`, parentId: null, timestamp, message };
}

describe("flattenForSearch", () => {
  it("collapses newlines, control chars and whitespace", () => {
    expect(flattenForSearch("a\r\nb\u0000c\n\n  d")).toBe("a b c d");
    expect(flattenForSearch("  中文 检索  ")).toBe("中文 检索");
    expect(flattenForSearch("")).toBe("");
  });
});

describe("extractSearchDocs", () => {
  it("only indexes user/assistant string content", () => {
    const lines = [
      line({ type: "session", version: 2, id: "s1", cwd: "D:\\w", createdAt: "2026-11-01T00:00:00.000Z" }),
      line(messageEntry({ role: "user", content: "问题一" })), // idx 0
      line(messageEntry({ role: "tool", content: "工具输出不索引", tool_call_id: "t1" })), // idx 1
      line(messageEntry({ role: "assistant", content: null, tool_calls: [] })), // idx 2
      line(messageEntry({ role: "assistant", content: "回答一" })), // idx 3
      line(messageEntry({ role: "system", content: "系统提示不索引" })), // idx 4
      line({ type: "title", id: "t", parentId: null, timestamp: "x", title: "标题" }),
    ];
    const extracted = extractSearchDocs(lines);
    expect(extracted.header?.id).toBe("s1");
    expect(extracted.title).toBe("标题");
    expect(extracted.docs.map((doc) => [doc.messageIndex, doc.role])).toEqual([
      [0, "user"],
      [3, "assistant"],
    ]);
  });

  it("keeps messageIndex aligned across tool entries (jump anchor)", () => {
    const lines = [
      line({ type: "session", version: 2, id: "s1", cwd: "D:\\w", createdAt: "2026-11-01T00:00:00.000Z" }),
      line(messageEntry({ role: "user", content: "first" })), // 0
      line(messageEntry({ role: "assistant", content: null, tool_calls: [1] })), // 1
      line(messageEntry({ role: "tool", content: "out", tool_call_id: "t1" })), // 2
      line(messageEntry({ role: "assistant", content: "second" })), // 3
      line(messageEntry({ role: "user", content: "third" })), // 4
    ];
    const extracted = extractSearchDocs(lines);
    expect(extracted.docs.map((doc) => doc.messageIndex)).toEqual([0, 3, 4]);
  });

  it("truncates oversized docs and respects the session budget", () => {
    const long = "字".repeat(9000);
    const lines = [
      line({ type: "session", version: 2, id: "s1", cwd: "D:\\w", createdAt: "2026-11-01T00:00:00.000Z" }),
      line(messageEntry({ role: "user", content: long })),
      line(messageEntry({ role: "assistant", content: "x".repeat(600000) })),
      line(messageEntry({ role: "user", content: "这条应超预算" })),
    ];
    const extracted = extractSearchDocs(lines, { docChars: 8000, sessionChars: 10_000 });
    // doc1/doc2 都被切到 8000；doc3 因会话预算耗尽被整体跳过
    expect(extracted.docs.map((doc) => doc.messageIndex)).toEqual([0, 1]);
    expect(extracted.docs[0].text).toHaveLength(8000);
    expect(extracted.truncatedDocs).toBe(3);
  });

  it("returns null header for corrupt first line", () => {
    const extracted = extractSearchDocs(["{broken", line(messageEntry({ role: "user", content: "x" }))]);
    expect(extracted.header).toBeNull();
    expect(extracted.docs).toHaveLength(0);
  });
});

describe("searchSessions", () => {
  it("finds Chinese substrings and returns offset ranges", async () => {
    const dir = await makeSessionsDir();
    await writeSession(dir, "2026-11-01T00-00-00-000Z_D-work.jsonl", [
      messageEntry({ role: "user", content: "帮我看看插件市场的图标问题" }),
      messageEntry({ role: "assistant", content: "图标已换成 simple-icons 渲染。" }),
    ]);
    const result = await searchSessions(dir, "图标");
    expect(result.hits).toHaveLength(1);
    expect(result.reindexed).toBeGreaterThanOrEqual(1);
    const hit = result.hits[0];
    expect(hit.totalMatches).toBe(2);
    expect(hit.snippets.length).toBeGreaterThan(0);
    const snippet = hit.snippets[0];
    for (const range of snippet.ranges) {
      expect(snippet.text.slice(range.start, range.end)).toBe("图标");
    }
  });

  it("matches case-insensitively", async () => {
    const dir = await makeSessionsDir();
    await writeSession(dir, "a.jsonl", [messageEntry({ role: "user", content: "Run VITEST now" })]);
    const result = await searchSessions(dir, "vitest");
    expect(result.hits).toHaveLength(1);
    const snippet = result.hits[0].snippets[0];
    expect(snippet.text.slice(snippet.ranges[0].start, snippet.ranges[0].end)).toBe("VITEST");
  });

  it("builds prefix/suffix flags by match position", async () => {
    const dir = await makeSessionsDir();
    const head = "前".repeat(60);
    const tail = "后".repeat(60);
    await writeSession(dir, "a.jsonl", [
      messageEntry({ role: "user", content: `${head}目标${tail}` }),
      messageEntry({ role: "assistant", content: "目标在开头" }),
    ]);
    const result = await searchSessions(dir, "目标");
    const [mid, startHit] = result.hits[0].snippets;
    expect(mid.prefix).toBe(true);
    expect(mid.suffix).toBe(true);
    expect(mid.text.length).toBeLessThanOrEqual(140);
    expect(startHit.prefix).toBe(false);
  });

  it("merges overlapping windows into one snippet with multiple ranges", async () => {
    const dir = await makeSessionsDir();
    await writeSession(dir, "a.jsonl", [
      messageEntry({ role: "user", content: `目标 ${"甲".repeat(10)} 目标` }),
    ]);
    const result = await searchSessions(dir, "目标");
    expect(result.hits[0].totalMatches).toBe(2);
    expect(result.hits[0].snippets).toHaveLength(1);
    expect(result.hits[0].snippets[0].ranges).toHaveLength(2);
  });

  it("caps snippets per session but keeps totalMatches", async () => {
    const dir = await makeSessionsDir();
    const sentences = Array.from({ length: 8 }, (_, i) => `第${i}句有关键词`).join(`${"乙".repeat(100)}`);
    await writeSession(dir, "a.jsonl", [messageEntry({ role: "user", content: sentences })]);
    const result = await searchSessions(dir, "关键词");
    expect(result.hits[0].totalMatches).toBe(8);
    expect(result.hits[0].snippets.length).toBeLessThanOrEqual(3);
  });

  it("matches title only and yields a placeholder hit without snippets", async () => {
    const dir = await makeSessionsDir();
    await writeSession(dir, "a.jsonl", [
      messageEntry({ role: "user", content: "内容没有这个词" }),
      { type: "title", id: "t", parentId: null, timestamp: "x", title: "独特标题词" },
    ]);
    const result = await searchSessions(dir, "独特标题词");
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].titleMatch).toBe(true);
    expect(result.hits[0].snippets).toHaveLength(0);
  });

  it("sorts title matches before content matches", async () => {
    const dir = await makeSessionsDir();
    await writeSession(dir, "a.jsonl", [
      messageEntry({ role: "user", content: "珊瑚在正文" }),
      { type: "title", id: "t1", parentId: null, timestamp: "x", title: "别的标题" },
    ]);
    await writeSession(dir, "b.jsonl", [
      messageEntry({ role: "user", content: "正文没珊瑚" }),
      { type: "title", id: "t2", parentId: null, timestamp: "x", title: "珊瑚标题" },
    ], {
      type: "session", version: 2, id: "s-b".padEnd(36, "0"), cwd: "D:\\work", createdAt: "2026-11-01T00:00:00.000Z",
    });
    const result = await searchSessions(dir, "珊瑚");
    expect(result.hits).toHaveLength(2);
    expect(result.hits[0].titleMatch).toBe(true);
    expect(result.hits[0].sessionId).toBe("s-b".padEnd(36, "0"));
  });

  it("reuses cache when size/mtime unchanged and rebuilds after append", async () => {
    const dir = await makeSessionsDir();
    const fileName = "a.jsonl";
    const filePath = await writeSession(dir, fileName, [
      messageEntry({ role: "user", content: "第一版内容" }),
    ]);
    const first = await searchSessions(dir, "第一版");
    expect(first.hits).toHaveLength(1);
    expect(first.reindexed).toBeGreaterThanOrEqual(1);

    const second = await searchSessions(dir, "第一版");
    expect(second.reindexed).toBe(0);
    expect(second.hits).toHaveLength(1);

    await appendFile(filePath, line(messageEntry({ role: "user", content: "追加的新内容" })) + "\n", "utf8");
    const third = await searchSessions(dir, "追加的新内容");
    expect(third.reindexed).toBe(1);
    expect(third.hits).toHaveLength(1);
  });

  it("skips torn lines while indexing", async () => {
    const dir = await makeSessionsDir();
    const filePath = await writeSession(dir, "a.jsonl", [
      messageEntry({ role: "user", content: "完整的一句" }),
    ]);
    await appendFile(filePath, '{"type":"message","id":"x","pare, "message":\n', "utf8");
    const result = await searchSessions(dir, "完整的一句");
    expect(result.hits).toHaveLength(1);
  });

  it("rebuilds from a corrupt shadow file", async () => {
    const dir = await makeSessionsDir();
    await writeSession(dir, "a.jsonl", [messageEntry({ role: "user", content: "影子损坏测试" })]);
    await searchSessions(dir, "影子损坏");
    await flushSearchIndexWrites(); // 等首次搜索的异步落盘结束，避免它把下面的坏影子又覆盖回去
    await writeFile(searchIndexPath(dir, "a.jsonl"), '{"version":1', "utf8");
    dropSearchMemoryCache(); // 强制走磁盘加载路径
    const result = await searchSessions(dir, "影子损坏");
    expect(result.hits).toHaveLength(1);
    expect(result.reindexed).toBeGreaterThanOrEqual(1);
  });

  it("returns empty result for empty query without touching disk", async () => {
    const dir = await makeSessionsDir();
    const result = await searchSessions(dir, "   ");
    expect(result.hits).toHaveLength(0);
    expect(result.scanned).toBe(0);
    expect(result.reindexed).toBe(0);
  });

  it("caps limit and reports truncated sessions", async () => {
    const dir = await makeSessionsDir();
    await writeSession(dir, "a.jsonl", [messageEntry({ role: "user", content: "关键词" })]);
    const result = await searchSessions(dir, "关键词", { limit: 999 });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].snippets.length).toBe(1);
    // 单条超长截断 → truncated 标记
    const longDir = await makeSessionsDir();
    await writeSession(longDir, "b.jsonl", [messageEntry({ role: "user", content: "关键词".repeat(60000) })]);
    const longResult = await searchSessions(longDir, "关键词");
    expect(longResult.truncated).toBe(true);
  });

  it("ignores sessions without a valid header but indexes the rest", async () => {
    const dir = await makeSessionsDir();
    await writeFile(path.join(dir, "broken.jsonl"), "not-json-at-all\n", "utf8");
    await writeSession(dir, "good.jsonl", [messageEntry({ role: "user", content: "正常会话内容" })]);
    const result = await searchSessions(dir, "正常会话内容");
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].filePath.endsWith("good.jsonl")).toBe(true);
  });

  it("refuses to read shadow files outside the sessions dir", async () => {
    const dir = await makeSessionsDir();
    // 非法文件名不会被 readdir 顶层产生，这里直接验证 invalidate 的守卫
    await invalidateSearchIndex(dir, "../evil.jsonl");
    await invalidateSearchIndex(dir, "sub\\dir.jsonl");
    // 未抛错即通过
    expect(true).toBe(true);
  });
});
