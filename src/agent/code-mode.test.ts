import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeTool } from "./tools";
import {
  CODE_MODE_MAX_CALLS,
  CODE_MODE_MAX_RESULT_CHARS,
  runCodeInSandbox,
} from "./code-mode";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "meowcode-code-mode-"));
  workspaces.push(root);
  return root;
}

describe("run_code sandbox", () => {
  it("returns only the final value; internal outputs stay out of the conversation", async () => {
    const root = await tempWorkspace();
    await writeFile(path.join(root, "a.txt"), "alpha");
    await writeFile(path.join(root, "b.txt"), "beta");
    const result = await executeTool("run_code", {
      code: `
        const a = await meow.read("a.txt");
        const b = await meow.read("b.txt");
        return a.length + b.length;
      `,
    }, root);
    expect(result.ok).toBe(true);
    // 只有最终值进入对话：内部读到的文件内容绝不出现
    expect(result.output).toContain("10");
    expect(result.output).not.toContain("alpha");
    expect(result.output).not.toContain("beta");
    expect(result.output).toContain("2 internal call(s)");
  });

  it("greps and globs through the sandbox with structured results", async () => {
    const root = await tempWorkspace();
    await writeFile(path.join(root, "one.ts"), "export const needle = 1;\nexport const other = 2;\n");
    await writeFile(path.join(root, "two.ts"), "const needle = 3;\n");
    const result = await executeTool("run_code", {
      code: `
        const hits = await meow.grep("needle");
        const files = await meow.glob("*.ts");
        return { count: hits.length, paths: files.sort() };
      `,
    }, root);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('"count":2');
    expect(result.output).toContain("one.ts");
    expect(result.output).toContain("two.ts");
  });

  it("aggregates readMany results with per-file errors", async () => {
    const root = await tempWorkspace();
    await writeFile(path.join(root, "ok.txt"), "fine");
    const result = await executeTool("run_code", {
      code: `
        const rows = await meow.readMany(["ok.txt", "missing.txt"]);
        return rows.map((r) => r.error ? "ERR" : r.content).join("|");
      `,
    }, root);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("fine|ERR");
  });

  it("blocks require/process access and escapes", async () => {
    const root = await tempWorkspace();
    for (const snippet of ["return typeof require;", "return typeof process;"]) {
      const result = await executeTool("run_code", { code: snippet }, root);
      expect(result.ok).toBe(true);
      // 沙箱里根本没有这些全局：typeof 返回 undefined 而不是抛错
      expect(result.output).toContain("undefined");
    }
    const evil = await executeTool("run_code", {
      code: "const F = (function(){ return this; }).call(null).constructor.constructor; return typeof F('return process')();",
    }, root);
    expect(evil.ok).toBe(true);
    // 关键威胁模型：即使经 this.constructor.constructor 拿到 vm realm 的 Function，
    // 全新 V8 context 里也没有 process / require —— 宿主全局不可达
    expect(evil.output).toContain("undefined");
  });

  it("reports runtime errors with the sandbox console tail", async () => {
    const root = await tempWorkspace();
    const result = await executeTool("run_code", {
      code: `
        console.log("step-1 done");
        console.log("step-2 done");
        throw new Error("boom");
      `,
    }, root);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Error: boom");
    expect(result.output).toContain("step-1 done");
    expect(result.output).toContain("step-2 done");
  });

  it("reports syntax errors without executing", async () => {
    const root = await tempWorkspace();
    const result = await executeTool("run_code", { code: "return ((" }, root);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("SyntaxError");
  });

  it("kills synchronous infinite loops via the vm timeout", async () => {
    const root = await tempWorkspace();
    const result = await runCodeInSandbox({
      workspace: root,
      code: "while (true) {}",
      timeoutMs: 300,
    });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/timed out|exceeded/i);
  });

  it("stops runaway bridge loops at the internal call cap", async () => {
    const root = await tempWorkspace();
    await writeFile(path.join(root, "x.txt"), "x");
    const result = await executeTool("run_code", {
      code: `
        let n = 0;
        while (true) { await meow.read("x.txt"); n += 1; }
        return n;
      `,
    }, root);
    expect(result.ok).toBe(false);
    expect(result.output).toContain(`call cap (${CODE_MODE_MAX_CALLS})`);
  }, 20_000);

  it("truncates oversized return values", async () => {
    const root = await tempWorkspace();
    const result = await executeTool("run_code", {
      code: `return "x".repeat(${CODE_MODE_MAX_RESULT_CHARS + 5000});`,
    }, root);
    expect(result.ok).toBe(true);
    expect(result.output).toContain(`truncated at ${CODE_MODE_MAX_RESULT_CHARS} chars`);
    expect(result.output.length).toBeLessThan(CODE_MODE_MAX_RESULT_CHARS + 300);
  });

  it("persists the execution log under .meowcode/tool-output", async () => {
    const root = await tempWorkspace();
    await writeFile(path.join(root, "a.txt"), "hi");
    const result = await executeTool("run_code", {
      code: `console.log("marker-log-line"); return await meow.read("a.txt");`,
    }, root);
    expect(result.ok).toBe(true);
    const match = result.output.match(/log: (\.meowcode\/tool-output\/run_code-[^.\n]+\.log)/);
    expect(match).toBeTruthy();
    const log = await readFile(path.join(root, match![1].split("/").join(path.sep)), "utf8");
    expect(log).toContain("marker-log-line");
    expect(log).toContain("read(a.txt)");
  });

  it("rejects reads outside the workspace through the bridge", async () => {
    const root = await tempWorkspace();
    const result = await executeTool("run_code", {
      code: `return await meow.read("../outside.txt");`,
    }, root);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("outside the workspace");
  });

  it("honors a caller abort signal", async () => {
    const root = await tempWorkspace();
    const controller = new AbortController();
    controller.abort();
    const result = await runCodeInSandbox({
      workspace: root,
      code: `return await meow.listDir();`,
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("aborted");
  });

  it("listDir mirrors list_dir ignore rules", async () => {
    const root = await tempWorkspace();
    await writeFile(path.join(root, "keep.txt"), "k");
    await mkdir(path.join(root, "node_modules"), { recursive: true });
    const result = await executeTool("run_code", {
      code: `const rows = await meow.listDir(); return rows.map((r) => r.name).join(",");`,
    }, root);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("keep.txt");
    expect(result.output).not.toContain("node_modules");
  });
});
