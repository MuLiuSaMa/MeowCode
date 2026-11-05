import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MEMORY_INDEX_NAME,
  clearMemories,
  deleteMemory,
  isValidMemoryName,
  listMemories,
  listMemoryItems,
  loadMemorySection,
  memoryDirFor,
  parseMemoryFile,
  parseMemoryIndexLine,
  readMemory,
  renderIndexEntry,
  saveMemory,
  writeMemoryFile,
} from "./memory";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length) {
    await rm(tempRoots.pop()!, { recursive: true, force: true });
  }
});

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function readIndex(dir: string): Promise<string> {
  return (await import("node:fs/promises")).readFile(path.join(dir, MEMORY_INDEX_NAME), "utf8");
}

describe("isValidMemoryName", () => {
  it("accepts lowercase kebab-case names", () => {
    expect(isValidMemoryName("docker-cli")).toBe(true);
    expect(isValidMemoryName("a")).toBe(true);
    expect(isValidMemoryName("build2")).toBe(true);
  });

  it("rejects unsafe or colliding names", () => {
    expect(isValidMemoryName("Memory")).toBe(false); // Windows 上撞 MEMORY.md
    expect(isValidMemoryName("memory")).toBe(false);
    expect(isValidMemoryName("../evil")).toBe(false);
    expect(isValidMemoryName("a/b")).toBe(false);
    expect(isValidMemoryName("UPPER")).toBe(false);
    expect(isValidMemoryName("-abc")).toBe(false);
    expect(isValidMemoryName("abc-")).toBe(false);
    expect(isValidMemoryName("")).toBe(false);
    expect(isValidMemoryName(`${"x".repeat(65)}`)).toBe(false);
  });
});

describe("index lines", () => {
  it("parses canonical and hand-written entry lines", () => {
    expect(parseMemoryIndexLine("- [docker-cli](docker-cli.md) — Docker 常用命令")).toEqual({
      name: "docker-cli",
      description: "Docker 常用命令",
    });
    expect(parseMemoryIndexLine("- docker-cli — Docker 常用命令")).toEqual({
      name: "docker-cli",
      description: "Docker 常用命令",
    });
    expect(parseMemoryIndexLine("- [x](docker-cli.md)")).toEqual({
      name: "docker-cli",
      description: "",
    });
    expect(parseMemoryIndexLine("# Memory index")).toBeNull();
    expect(parseMemoryIndexLine("")).toBeNull();
  });

  it("renders without description when it is empty", () => {
    expect(renderIndexEntry({ name: "a", description: "" })).toBe("- [a](a.md)");
  });
});

describe("parseMemoryFile", () => {
  it("extracts frontmatter fields", () => {
    const fields = parseMemoryFile(
      "---\ndescription: 用户偏好 pnpm\ncreated: 2026-10-25\n---\n正文内容",
    );
    expect(fields.description).toBe("用户偏好 pnpm");
    expect(fields.created).toBe("2026-10-25");
    expect(fields.type).toBeNull();
  });

  it("parses the optional type field and ignores invalid values", () => {
    expect(parseMemoryFile("---\ndescription: x\ntype: feedback\ncreated: 2026-10-31\n---\nbody")).toEqual({
      description: "x",
      created: "2026-10-31",
      type: "feedback",
    });
    expect(parseMemoryFile("---\ntype: nonsense\n---\nbody").type).toBeNull();
  });

  it("handles quoted values, CRLF and missing frontmatter", () => {
    expect(
      parseMemoryFile('---\r\ndescription: "a: b"\r\ncreated: 2026-01-01\r\n---\r\nbody'),
    ).toEqual({ description: "a: b", created: "2026-01-01", type: null });
    expect(parseMemoryFile("just body")).toEqual({ description: null, created: null, type: null });
  });
});

describe("saveMemory / readMemory / deleteMemory", () => {
  it("creates the file and registers the index entry", async () => {
    const dir = await makeDir("meowcode-memory-");
    const result = await saveMemory(dir, "docker-cli", {
      description: "Docker 常用命令",
      content: "用户偏好 docker compose 而不是裸 docker run。",
      type: "user",
    });
    expect(result.existed).toBe(false);

    const record = await readMemory(dir, "docker-cli");
    expect(record).not.toBeNull();
    expect(record!.description).toBe("Docker 常用命令");
    expect(record!.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(parseMemoryFile(record!.raw).type).toBe("user");
    expect(record!.raw).toContain("docker compose");

    const index = await readIndex(dir);
    expect(index).toContain("- [docker-cli](docker-cli.md) — Docker 常用命令");
    expect(await listMemories(dir)).toEqual([
      { name: "docker-cli", description: "Docker 常用命令" },
    ]);
  });

  it("keeps the previous type when an update omits it", async () => {
    const dir = await makeDir("meowcode-memory-");
    await saveMemory(dir, "pnpm", { description: "首选 pnpm", content: "v1", type: "feedback" });
    await saveMemory(dir, "pnpm", { description: "包管理器首选 pnpm", content: "v2" });
    const record = await readMemory(dir, "pnpm");
    expect(parseMemoryFile(record!.raw).type).toBe("feedback");
  });

  it("overwrites in place, dedupes index lines and keeps the original created date", async () => {
    const dir = await makeDir("meowcode-memory-");
    await saveMemory(dir, "pnpm", { description: "首选 pnpm", content: "v1" });
    const first = await readMemory(dir, "pnpm");

    const result = await saveMemory(dir, "pnpm", { description: "包管理器首选 pnpm", content: "v2" });
    expect(result.existed).toBe(true);

    const second = await readMemory(dir, "pnpm");
    expect(second!.raw).toContain("v2");
    expect(second!.created).toBe(first!.created);
    const index = await readIndex(dir);
    expect(index).toContain("- [pnpm](pnpm.md) — 包管理器首选 pnpm");
    expect(index).not.toContain("— 首选 pnpm");
    expect((index.match(/\[pnpm\]/g) ?? []).length).toBe(1);
  });

  it("deletes the file and the index entry", async () => {
    const dir = await makeDir("meowcode-memory-");
    await saveMemory(dir, "gone", { description: "d", content: "c" });
    expect(await deleteMemory(dir, "gone")).toBe(true);
    expect(await readMemory(dir, "gone")).toBeNull();
    expect(await readIndex(dir)).not.toContain("[gone]");
    expect(await deleteMemory(dir, "gone")).toBe(false);
  });

  it("clears every memory and the index but keeps unrelated files", async () => {
    const dir = await makeDir("meowcode-memory-");
    await saveMemory(dir, "alpha", { description: "a", content: "a" });
    await saveMemory(dir, "beta", { description: "b", content: "b" });
    await writeFile(path.join(dir, "notes.txt"), "keep");

    expect(await clearMemories(dir)).toBe(2);
    expect(await listMemories(dir)).toEqual([]);
    await expect(readIndex(dir)).rejects.toThrow();
    expect(await readFile(path.join(dir, "notes.txt"), "utf8")).toBe("keep");
  });

  it("rejects invalid names", async () => {
    const dir = await makeDir("meowcode-memory-");
    await expect(
      saveMemory(dir, "../evil", { description: "d", content: "c" }),
    ).rejects.toThrow(/Invalid memory name/);
    await expect(writeMemoryFile(dir, "Memory", "raw")).rejects.toThrow(/Invalid memory name/);
  });
});

describe("index maintenance edge cases", () => {
  it("merges unindexed hand-dropped files and preserves non-entry lines", async () => {
    const dir = await makeDir("meowcode-memory-");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, MEMORY_INDEX_NAME),
      "# My memories\n\n- [indexed](indexed.md) — 已登记\n\n手写备注行。\n",
    );
    await writeFile(path.join(dir, "indexed.md"), "body");
    await writeFile(path.join(dir, "handwritten.md"), "hand body");

    const entries = await listMemories(dir);
    expect(entries.map((entry) => entry.name)).toEqual(["indexed", "handwritten"]);
    expect(entries[1].description).toBe("");

    // 覆盖已登记条目：非条目行原样保留，条目行原位替换
    await saveMemory(dir, "handwritten", { description: "补登记", content: "hand body v2" });
    const index = await readIndex(dir);
    expect(index).toContain("# My memories");
    expect(index).toContain("手写备注行。");
    expect(index).toContain("- [handwritten](handwritten.md) — 补登记");
    expect(index.indexOf("[indexed]")).toBeLessThan(index.indexOf("[handwritten]"));
  });

  it("collapses multi-line descriptions in the index entry", async () => {
    const dir = await makeDir("meowcode-memory-");
    await saveMemory(dir, "multiline", {
      description: "第一行\n第二行",
      content: "body",
    });
    const index = await readIndex(dir);
    expect(index).toContain("- [multiline](multiline.md) — 第一行 第二行");
  });
});

describe("listMemoryItems", () => {
  it("adds file metadata and survives a broken entry", async () => {
    const dir = await makeDir("meowcode-memory-");
    await saveMemory(dir, "ok", { description: "desc", content: "body" });
    // 索引里登记一个没有对应文件的条目
    await writeFile(
      path.join(dir, MEMORY_INDEX_NAME),
      "- [ghost](ghost.md) — 幽灵条目\n- [ok](ok.md) — desc\n",
    );
    const items = await listMemoryItems(dir);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ name: "ghost", description: "幽灵条目", mtime: null });
    expect(items[1]).toMatchObject({ name: "ok", created: expect.any(String) });
    expect(items[1].mtime).not.toBeNull();
  });
});

describe("loadMemorySection", () => {
  it("still injects the guide when no memories exist (cold start)", async () => {
    const workspace = await makeDir("meowcode-memory-ws-");
    const home = await makeDir("meowcode-memory-home-");
    const section = await loadMemorySection(workspace, home);
    expect(section).toContain("## Memory");
    expect(section).toContain("memory_write");
    // 空目录不注入索引小节
    expect(section).not.toContain("### User memory");
  });

  it("injects both scopes with the guide", async () => {
    const workspace = await makeDir("meowcode-memory-ws-");
    const home = await makeDir("meowcode-memory-home-");
    await saveMemory(memoryDirFor("user", workspace, home), "user-pref", {
      description: "用户级偏好",
      content: "body",
    });
    await saveMemory(memoryDirFor("project", workspace, home), "project-fact", {
      description: "项目级事实",
      content: "body",
    });

    const section = await loadMemorySection(workspace, home);
    expect(section).toContain("## Memory");
    expect(section).toContain("memory_write");
    expect(section).toContain("### User memory (cross-project)");
    expect(section).toContain("[user-pref](user-pref.md) — 用户级偏好");
    expect(section).toContain("### Project memory (this workspace)");
    expect(section).toContain("[project-fact](project-fact.md) — 项目级事实");
    // 用户级在前：跨项目偏好更通用
    expect(section!.indexOf("User memory")).toBeLessThan(section!.indexOf("Project memory"));
  });

  it("truncates an oversized scope index", async () => {
    const workspace = await makeDir("meowcode-memory-ws-");
    const home = await makeDir("meowcode-memory-home-");
    const dir = memoryDirFor("user", workspace, home);
    for (let index = 0; index < 15; index += 1) {
      await saveMemory(dir, `memory-${index}`, {
        description: `${index}-${"x".repeat(150)}`,
        content: "body",
      });
    }
    const section = await loadMemorySection(workspace, home);
    expect(section).toContain("[memory index truncated]");
  });
});
