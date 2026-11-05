import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { countDiffStats, previewEditDiff, previewWriteDiff } from "./diff";

describe("previewWriteDiff", () => {
  it("renders a creation diff for a new file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-diff-"));
    const diff = await previewWriteDiff(root, "notes/todo.md", "hello\n");
    expect(diff).toContain("--- /dev/null");
    expect(diff).toContain("+++ b/todo.md");
    expect(diff).toContain("+ hello");
  });

  it("renders before/after lines when overwriting an existing file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-diff-"));
    const target = path.join(root, "src", "app.ts");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "const a = 1;\n", "utf8");
    const diff = await previewWriteDiff(root, "src/app.ts", "const a = 2;\n");
    expect(diff).toContain(`--- a/${path.join("src", "app.ts")}`);
    expect(diff).toContain("- const a = 1;");
    expect(diff).toContain("+ const a = 2;");
  });

  it("returns undefined when content is identical", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-diff-"));
    const target = path.join(root, "same.txt");
    await writeFile(target, "unchanged\n", "utf8");
    const diff = await previewWriteDiff(root, "same.txt", "unchanged\n");
    expect(diff).toBeUndefined();
  });

  it("does not build a quadratic table for huge rewrites", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-diff-"));
    const before = Array.from({ length: 3000 }, (_, index) => `old line ${index}`).join("\n");
    const after = Array.from({ length: 3000 }, (_, index) => `new line ${index}`).join("\n");
    await writeFile(path.join(root, "big.txt"), before, "utf8");
    const started = Date.now();
    const diff = await previewWriteDiff(root, "big.txt", after);
    expect(diff).toContain("diff omitted");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("flags a missing trailing newline", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-diff-"));
    const diff = await previewWriteDiff(root, "no-newline.txt", "content");
    expect(diff).toContain("\\ No newline at end of file");
  });

  it("rejects paths outside the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-diff-"));
    await expect(previewWriteDiff(root, "../escape.txt", "x")).rejects.toThrow(
      /outside the workspace/i,
    );
  });

  it("previews outside files in full access mode", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-diff-"));
    const outside = await mkdtemp(path.join(tmpdir(), "meowcode-diff-outside-"));
    const target = path.join(outside, "outside.txt");
    await writeFile(target, "old\n", "utf8");
    const diff = await previewWriteDiff(root, target, "new\n", true);
    expect(diff).toContain("- old");
    expect(diff).toContain("+ new");
  });
});

describe("previewEditDiff", () => {
  it("renders the replacement for a unique match", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-diff-"));
    const target = path.join(root, "edit.txt");
    await writeFile(target, "alpha\nbeta\ngamma\n", "utf8");
    const diff = await previewEditDiff(root, "edit.txt", "beta", "BETA");
    expect(diff).toContain("- beta");
    expect(diff).toContain("+ BETA");
    expect(diff).toContain(" alpha");
    expect(diff).toContain(" gamma");
  });

  it("returns undefined when oldString is not unique", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-diff-"));
    const target = path.join(root, "dup.txt");
    await writeFile(target, "same\nsame\n", "utf8");
    const diff = await previewEditDiff(root, "dup.txt", "same", "other");
    expect(diff).toBeUndefined();
  });

  it("returns undefined when oldString is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-diff-"));
    const target = path.join(root, "miss.txt");
    await writeFile(target, "content\n", "utf8");
    const diff = await previewEditDiff(root, "miss.txt", "nope", "other");
    expect(diff).toBeUndefined();
  });

  it("returns undefined for a missing file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-diff-"));
    await expect(previewEditDiff(root, "ghost.txt", "a", "b")).resolves.toBeUndefined();
  });

  it("previews the same edit a CRLF file will actually receive", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-diff-"));
    await writeFile(path.join(root, "crlf.txt"), "a\r\nb\r\nc\r\n", "utf8");
    const diff = await previewEditDiff(root, "crlf.txt", "a\nb", "A\nB");
    expect(diff).toContain("- a");
    expect(diff).toContain("+ A");
  });

  it("folds unchanged context so a one-line change in a 2000-line file stays readable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-diff-"));
    const big = `${Array.from({ length: 2000 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
    await writeFile(path.join(root, "big.txt"), big, "utf8");

    const diff = await previewEditDiff(root, "big.txt", "line 1000", "LINE 1000");

    expect(diff).toContain("- line 1000");
    expect(diff).toContain("+ LINE 1000");
    expect(diff).toContain("unchanged lines");
    expect(diff?.split("\n").length ?? 0).toBeLessThanOrEqual(14);
    // 紧邻改动的上下文仍在，远处的行被折叠
    expect(diff).toContain(" line 999");
    expect(diff).not.toContain(" line 500");
  });
});

describe("countDiffStats", () => {
  it("counts body lines and skips file headers, hunk markers and context", () => {
    const diff = [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@",
      "- old one",
      "+ new one",
      "+ new two",
      " context line",
      "\\ No newline at end of file",
    ].join("\n");
    expect(countDiffStats(diff)).toEqual({ added: 2, removed: 1 });
  });

  it("matches the review list counts for real generated diffs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-diff-"));
    await writeFile(path.join(root, "a.txt"), "one\ntwo\n", "utf8");
    const diff = await previewEditDiff(root, "a.txt", "one\ntwo", "one\nTWO\nthree");
    expect(diff).toBeTruthy();
    expect(countDiffStats(diff!)).toEqual({ added: 2, removed: 1 });
  });

  it("returns zeros for empty input", () => {
    expect(countDiffStats("")).toEqual({ added: 0, removed: 0 });
  });
});
