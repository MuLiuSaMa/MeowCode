import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_TEXT_BYTES,
  applyTextEdit,
  detectLineEnding,
  forceLineEnding,
  locateAll,
  readTextFile,
  shapeForWrite,
} from "./edit-content";

describe("applyTextEdit", () => {
  it("matches an LF oldString inside a CRLF file and keeps the file CRLF", () => {
    const outcome = applyTextEdit("alpha\r\nbeta\r\ngamma\r\n", "beta\ngamma", "BETA\nGAMMA");
    expect(outcome).toMatchObject({
      ok: true,
      content: "alpha\r\nBETA\r\nGAMMA\r\n",
      level: "line-ending",
      count: 1,
    });
  });

  it("leaves every byte outside the matched span untouched", () => {
    const source = "line1\r\nline2\r\nline3\r\n";
    const outcome = applyTextEdit(source, "line2", "CHANGED");
    expect(outcome.ok && outcome.content).toBe("line1\r\nCHANGED\r\nline3\r\n");
  });

  it("keeps a mixed-ending file byte-identical outside the matched span", () => {
    const source = "a\nb\r\nc\n";
    // "a\nb" 原文里就存在：精确命中时按调用方自己的行尾替换，不改动其它行
    const exact = applyTextEdit(source, "a\nb", "A\nB");
    expect(exact.ok && exact.content).toBe("A\nB\r\nc\n");
    // 需要放宽行尾时，用命中处的行尾渲染新内容
    const flexed = applyTextEdit(source, "b\nc", "B\nC");
    expect(flexed.ok && flexed.content).toBe("a\nB\r\nC\n");
  });

  it("refuses ambiguous matches", () => {
    const outcome = applyTextEdit("x\r\ny\r\nx\r\ny\r\n", "x\ny", "z");
    expect(outcome).toMatchObject({ ok: false, reason: "not-unique" });
    expect(outcome.ok === false && outcome.positions).toHaveLength(2);
  });

  it("does not fuzzy-match other whitespace", () => {
    expect(applyTextEdit("tab\there\n", "tab here", "x")).toMatchObject({
      ok: false,
      reason: "not-found",
    });
    expect(applyTextEdit("a  b\n", "a b", "x")).toMatchObject({ ok: false, reason: "not-found" });
  });

  it("escapes regex metacharacters in the search text", () => {
    const outcome = applyTextEdit("call(a, b)\r\nnext\r\n", "call(a, b)\nnext", "done");
    expect(outcome.ok && outcome.content).toBe("done\r\n");
  });

  it("reports an empty oldString as no match", () => {
    expect(locateAll("anything", "")).toEqual([]);
  });

  it("replaces every occurrence when replaceAll is set", () => {
    const outcome = applyTextEdit("a\na\na\n", "a", "b", { replaceAll: true });
    expect(outcome).toMatchObject({ ok: true, count: 3 });
    expect(outcome.ok && outcome.content).toBe("b\nb\nb\n");
  });
});

describe("edit tolerance levels", () => {
  it("strips the line-number prefix that read_file adds", () => {
    const outcome = applyTextEdit(
      "const a = 1;\nconst b = 2;\nconst c = 3;\n",
      "2: const b = 2;\n3: const c = 3;",
      "const b = 20;\nconst c = 30;",
    );
    expect(outcome).toMatchObject({ ok: true, level: "line-number-prefix" });
    expect(outcome.ok && outcome.content).toBe("const a = 1;\nconst b = 20;\nconst c = 30;\n");
  });

  it("strips a line-number prefix from a single-line oldString", () => {
    const outcome = applyTextEdit("const a = 1;\n", "1: const a = 1;", "const a = 2;");
    expect(outcome).toMatchObject({ ok: true, level: "line-number-prefix" });
    expect(outcome.ok && outcome.content).toBe("const a = 2;\n");
  });

  it("ignores trailing whitespace in the needle", () => {
    const outcome = applyTextEdit("foo\nbar\n", "foo   ", "FOO");
    expect(outcome).toMatchObject({ ok: true, level: "rstrip" });
    expect(outcome.ok && outcome.content).toBe("FOO\nbar\n");
  });

  it("matches a re-indented block", () => {
    const outcome = applyTextEdit(
      "  if (x) {\n    run();\n  }\n",
      "if (x) {\n  run();\n}",
      "if (y) {\n  run();\n}",
    );
    expect(outcome).toMatchObject({ ok: true, level: "trim" });
    expect(outcome.ok && outcome.content).toBe("if (y) {\n  run();\n}\n");
  });

  it("matches straight quotes against smart quotes in the file", () => {
    const outcome = applyTextEdit("say(\u201Chi\u201D)\n", 'say("hi")', 'say("bye")');
    expect(outcome).toMatchObject({ ok: true, level: "unicode" });
    expect(outcome.ok && outcome.content).toBe('say("bye")\n');
  });

  it("still prefers an exact match over a tolerant one", () => {
    const outcome = applyTextEdit("  foo  \n", "  foo  ", "bar");
    expect(outcome).toMatchObject({ ok: true, level: "exact" });
  });
});

describe("line ending helpers", () => {
  it("detects the dominant ending", () => {
    expect(detectLineEnding("a\r\nb")).toBe("\r\n");
    expect(detectLineEnding("a\nb")).toBe("\n");
    expect(detectLineEnding("single line")).toBe("\n");
  });

  it("forces every break to one ending", () => {
    expect(forceLineEnding("a\nb\r\nc", "\r\n")).toBe("a\r\nb\r\nc");
    expect(forceLineEnding("a\r\nb", "\n")).toBe("a\nb");
  });

  it("shapes a full rewrite after the existing file", () => {
    const written = shapeForWrite("a\nb", {
      bom: true,
      ending: "\r\n",
      content: "old",
      oversized: false,
      size: 3,
    });
    expect(written.charCodeAt(0)).toBe(0xfeff);
    expect(written.slice(1)).toBe("a\r\nb");
    expect(shapeForWrite("a\r\nb")).toBe("a\r\nb");
  });
});

describe("readTextFile", () => {
  const root = async () => await mkdtemp(path.join(tmpdir(), "meowcode-edit-content-"));

  it("reports missing files instead of throwing", async () => {
    const dir = await root();
    expect(await readTextFile(path.join(dir, "nope.txt"))).toMatchObject({ ok: false, reason: "missing" });
  });

  it("keeps the BOM out of the content but flags it", async () => {
    const dir = await root();
    const file = path.join(dir, "bom.txt");
    await writeFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hi\r\n")]));
    const read = await readTextFile(file);
    expect(read.ok && read.file).toMatchObject({ bom: true, ending: "\r\n", content: "hi\r\n" });
  });

  it("rejects non-UTF-8 bytes rather than decoding them to mojibake", async () => {
    const dir = await root();
    const file = path.join(dir, "gbk.txt");
    await writeFile(file, Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
    expect(await readTextFile(file)).toMatchObject({ ok: false, reason: "not-utf8" });
  });

  it("rejects binary content", async () => {
    const dir = await root();
    const file = path.join(dir, "bin.dat");
    await writeFile(file, Buffer.from([0x01, 0x02, 0x00, 0x03]));
    expect(await readTextFile(file)).toMatchObject({ ok: false, reason: "binary" });
  });

  it("caps a whole-file read but not a head-only read", async () => {
    const dir = await root();
    const file = path.join(dir, "big.txt");
    const pad = "x".repeat(1024);
    await writeFile(file, Array.from({ length: Math.ceil(MAX_TEXT_BYTES / 1024) + 8 }, () => pad).join("\n"));

    expect(await readTextFile(file)).toMatchObject({ ok: false, reason: "too-large" });
    const head = await readTextFile(file, { headOnly: true });
    expect(head.ok && head.file.oversized).toBe(true);
    expect(head.ok && head.file.content.length).toBeLessThanOrEqual(MAX_TEXT_BYTES + 1);
  });

  it("refuses a directory", async () => {
    const dir = await root();
    expect(await readTextFile(dir)).toMatchObject({ ok: false, reason: "directory" });
  });
});
