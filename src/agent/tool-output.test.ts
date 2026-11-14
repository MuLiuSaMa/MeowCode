import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { truncateWithSpill } from "./tools.js";
import { executeTool } from "./tools.js";

/** 落盘与指针：超预算的工具输出必须能靠 read_file 找回全文，且读产物不再生成新产物。 */

const dirs: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "meowcode-tool-output-"));
  dirs.push(root);
  return root;
}
afterEach(() => {
  // 不删也行（临时目录），但保持测试互不干扰
  dirs.length = 0;
});

describe("truncateWithSpill", () => {
  it("keeps short output untouched", async () => {
    const root = tempRoot();
    const result = await truncateWithSpill(root, "mcp__demo", "short output");
    expect(result).toEqual({ output: "short output", truncated: false });
  });

  it("spills oversized output and points at read_file", async () => {
    const root = tempRoot();
    const body = "x".repeat(24_000); // 4 字符 ≈ 1 token → 约 6000 token
    const result = await truncateWithSpill(root, "mcp__demo", body);

    expect(result.truncated).toBe(true);
    expect(result.output).toContain("full output saved to .meowcode/tool-output/");
    expect(result.output).toContain("read_file (offset/limit)");
    expect(result.spilled).toMatch(/^\.meowcode\/tool-output\/mcp__demo-/);
    // 落盘的是完整内容，模型可以分页续读
    expect(readFileSync(path.join(root, result.spilled ?? ""), "utf8")).toBe(body);
  });

  it("falls back to a hint without a path when spilling fails", async () => {
    // 不存在的工作区根：persistToolOutput 会失败，输出仍要给出可行动提示
    const result = await truncateWithSpill("\0invalid-root", "mcp__demo", "y".repeat(24_000));
    expect(result.truncated).toBe(true);
    expect(result.spilled).toBeUndefined();
    expect(result.output).toContain("narrow the result or re-run with a smaller scope");
  });
});

describe("read_file 不重复落盘", () => {
  it("reading a spilled artifact does not spawn another artifact", async () => {
    const root = tempRoot();
    const dir = path.join(root, ".meowcode", "tool-output");
    mkdirSync(dir, { recursive: true });
    // 2000 行 × 约 4 token：超过 read_file 的落盘阈值且一屏读不完
    const body = Array.from({ length: 2_000 }, (_, index) => `line ${index} content`).join("\n");
    writeFileSync(path.join(dir, "big.log"), body, "utf8");

    const result = await executeTool("read_file", { path: ".meowcode/tool-output/big.log" }, root);

    expect(result.ok).toBe(true);
    expect(result.output).not.toContain("full content of");
    expect(readdirSync(dir)).toEqual(["big.log"]);
  });
});
