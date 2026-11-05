import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
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
    // ("alpha".length + "beta".length = 9；摘要行之后才是返回值，用它定位避免撞到耗时/日志里的数字)
    expect(result.output).toContain("\n9");
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

  it("blocks require/process access and every known escape vector", async () => {
    const root = await tempWorkspace();
    for (const snippet of ["return typeof require;", "return typeof process;"]) {
      const result = await executeTool("run_code", { code: snippet }, root);
      expect(result.ok).toBe(true);
      // 沙箱里根本没有这些全局：typeof 返回 undefined 而不是抛错
      expect(result.output).toContain("undefined");
    }
    // 逃逸面：context realm 的 Function、宿主桥/console 函数的 constructor、
    // 桥返回值的 constructor、宿主错误对象的 constructor —— 全部必须拿不到宿主 process。
    const result = await executeTool("run_code", {
      code: `
        const results = [];
        const probe = async (make) => {
          try {
            const p = await make();
            return p && typeof p === "object" && typeof p.version === "string"
              ? "ESCAPED:" + p.version
              : "no-process";
          } catch {
            return "blocked";
          }
        };
        results.push(await probe(async () =>
          (function () { return this; }).call(null).constructor.constructor("return process")()));
        results.push(await probe(async () => meow.read.constructor("return process")()));
        results.push(await probe(async () => console.log.constructor("return process")()));
        results.push(await probe(async () =>
          (await meow.readMany(["missing.txt"])).constructor.constructor("return process")()));
        results.push(await probe(async () => {
          try { await meow.read("missing.txt"); } catch (e) {
            return e.constructor.constructor("return process")();
          }
          return null;
        }));
        return results.join(",");
      `,
    }, root);
    expect(result.ok).toBe(true);
    expect(result.output).not.toContain("ESCAPED");
    expect(result.output).toContain("blocked,blocked,blocked,blocked,blocked");
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

  it("sweeps expired logs from the shared tool-output directory", async () => {
    const root = await tempWorkspace();
    const dir = path.join(root, ".meowcode", "tool-output");
    await mkdir(dir, { recursive: true });
    const stale = path.join(dir, "run_code-stale.log");
    await writeFile(stale, "old");
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(stale, old, old);

    await executeTool("run_code", { code: `console.log("x"); return 1;` }, root);

    // 沙箱日志与其它工具输出共用 7 天保留策略
    await expect(readFile(stale, "utf8")).rejects.toThrow();
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
