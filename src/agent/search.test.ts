import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { searchGlob, searchGrep } from "./search";

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "meowcode-search-"));
  await mkdir(path.join(root, "src", "deep"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(root, "src", "alpha.ts"), "export const alpha = 1;\nconst other = 3;\n");
  await writeFile(path.join(root, "src", "deep", "beta.ts"), "export const beta = 2;\n");
  await writeFile(path.join(root, "README.md"), "plain readme\n");
  await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "export const alpha = 99;\n");
  return root;
}

afterEach(() => {
  delete process.env.MEOWCODE_RIPGREP_PATH;
  delete process.env.MEOWCODE_RESOURCES_PATH;
});

describe("searchGlob", () => {
  it("matches files by pattern, ignores build directories, and returns relative paths", async () => {
    const root = await makeWorkspace();
    const result = await searchGlob(root, ".", "**/*.ts", 200);
    expect(result.ok).toBe(true);
    const lines = result.output.split("\n");
    expect(lines).toContain(path.join("src", "alpha.ts"));
    expect(lines).toContain(path.join("src", "deep", "beta.ts"));
    expect(result.output).not.toContain("node_modules");
  });

  it("honors maxResults and reports the truncation", async () => {
    const root = await makeWorkspace();
    const result = await searchGlob(root, ".", "**/*.ts", 1);
    expect(result.ok).toBe(true);
    const resultLines = result.output
      .split("\n")
      .filter((line) => !line.startsWith("... [truncated"));
    expect(resultLines).toHaveLength(1);
    expect(result.output).toContain("narrow the pattern or raise maxResults");
  });

  it("rejects targets outside the workspace", async () => {
    const root = await makeWorkspace();
    await expect(searchGlob(root, "../elsewhere", "**/*.ts", 10)).rejects.toThrow(
      /outside the workspace/i,
    );
  });

  it("searches outside the workspace in full access mode", async () => {
    const root = await makeWorkspace();
    const outside = await mkdtemp(path.join(tmpdir(), "meowcode-search-outside-"));
    await writeFile(path.join(outside, "outside.ts"), "export const outside = 1;\n");
    const result = await searchGlob(root, outside, "**/*.ts", 10, undefined, true);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("outside.ts");
  });

  it("reports a tool error when ripgrep is missing", async () => {
    const root = await makeWorkspace();
    process.env.MEOWCODE_RIPGREP_PATH = path.join(root, "missing-rg.exe");
    const result = await searchGlob(root, ".", "**/*.ts", 10);
    expect(result.ok).toBe(false);
    expect(result.output).not.toBe("");
  });
});

describe("searchGrep", () => {
  it("finds matches with line numbers and respects ignore rules", async () => {
    const root = await makeWorkspace();
    const result = await searchGrep(root, ".", "alpha", { fixed: true, maxResults: 10 });
    expect(result.ok).toBe(true);
    expect(result.output).toContain(path.join("src", "alpha.ts"));
    expect(result.output).toContain("export const alpha = 1;");
    expect(result.output).not.toContain("node_modules");
  });

  it("supports ignore-case and context lines", async () => {
    const root = await makeWorkspace();
    const result = await searchGrep(root, ".", "ALPHA", {
      caseSensitive: false,
      contextLines: 1,
      maxResults: 10,
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("alpha");
    // alpha.ts 第二行作为上下文出现
    expect(result.output).toContain("other");
  });

  it("is case-sensitive by default", async () => {
    const root = await makeWorkspace();
    const result = await searchGrep(root, ".", "ALPHA", { maxResults: 10 });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("(no matches)");
  });

  it("honors maxResults and reports the truncation", async () => {
    const root = await makeWorkspace();
    const result = await searchGrep(root, ".", "export const", { maxResults: 1 });
    expect(result.ok).toBe(true);
    const matchLines = result.output
      .split("\n")
      .filter((line) => !line.startsWith("... [truncated"));
    expect(matchLines.length).toBe(1);
    expect(result.output).toContain("narrow the pattern or raise maxResults");
  });

  it("hands the untruncated body back as spillText", async () => {
    const root = await makeWorkspace();
    const body = Array.from(
      { length: 400 },
      (_, index) => `export const value${index} = "${"x".repeat(40)}";`,
    ).join("\n");
    await writeFile(path.join(root, "src", "big.ts"), body);

    const capped = await searchGrep(root, ".", "export const", { maxResults: 500 });
    expect(capped.ok).toBe(true);
    expect(capped.output.length).toBeLessThan(12_500);
    expect(capped.spillText).toBeTruthy();
    expect(capped.spillText!.length).toBeGreaterThan(12_000);
    // 落盘用全文必须包含内联被砍掉的尾部
    expect(capped.spillText).toContain("value399");

    const short = await searchGrep(root, "src/alpha.ts", "export", { maxResults: 10 });
    expect(short.ok).toBe(true);
    expect(short.spillText).toBeUndefined();
  });

  it("caps each match line so a minified line cannot eat the whole budget", async () => {
    const root = await makeWorkspace();
    await writeFile(path.join(root, "min.js"), `needle${"x".repeat(5_000)}\n`);
    const result = await searchGrep(root, ".", "needle", { fixed: true, maxResults: 10 });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("…[+");
    const line = result.output.split("\n").find((item) => item.includes("min.js"));
    expect(line?.length ?? 0).toBeLessThan(700);
  });

  it("reports an error for an invalid regex", async () => {
    const root = await makeWorkspace();
    const result = await searchGrep(root, ".", "([unclosed", {});
    expect(result.ok).toBe(false);
  });
});
