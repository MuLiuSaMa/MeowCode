import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { estimateTokens } from "./context";
import { previewEditDiff } from "./diff";
import { flushSearchIndexWrites } from "./session-search";
import {
  commandEnv,
  decodeCommandOutput,
  degradeStructuredOutput,
  executeTool,
  deferredDynamicToolNames,
  hasDynamicTool,
  listDynamicToolDefinitions,
  registerDynamicTool,
  truncateMiddle,
  unregisterDynamicTool,
} from "./tools";

// 这里会真实 spawn 子进程（冷启动约 1.5s/次），并行负载下给足超时余量。
vi.setConfig({ testTimeout: 30_000 });

const linkType = process.platform === "win32" ? "junction" : "dir";
const POWER_SHELL_51 = path.join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const hasPowerShell51 = process.platform === "win32" && existsSync(POWER_SHELL_51);

/** Windows PowerShell 5.1 的 $OutputEncoding/Python 默认编码与 pwsh 7 不同，用例必须锁 5.1。 */
async function withPowerShell51<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.MEOWCODE_POWERSHELL;
  process.env.MEOWCODE_POWERSHELL = POWER_SHELL_51;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.MEOWCODE_POWERSHELL;
    else process.env.MEOWCODE_POWERSHELL = previous;
  }
}

describe("tools", () => {
  it("lists files while ignoring build directories and app artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    await writeFile(path.join(root, "README.md"), "hello");
    await writeFile(path.join(root, "dist"), "hidden");
    await mkdir(path.join(root, ".meowcode", "tool-output"), { recursive: true });
    await writeFile(path.join(root, ".meowcode", "tool-output", "log.txt"), "hidden");
    const result = await executeTool("list_dir", { path: "." }, root);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("README.md");
    expect(result.output).not.toContain("dist");
    expect(result.output).not.toContain(".meowcode");
  });

  it("rejects file reads outside the workspace", async () => {
    const result = await executeTool("read_file", { path: "../outside.txt" }, process.cwd());
    expect(result.ok).toBe(false);
    expect(result.output).toContain("outside the workspace");
  });

  it("rejects reads and writes through a junction outside the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    const outside = await mkdtemp(path.join(tmpdir(), "meowcode-outside-"));
    try {
      await writeFile(path.join(outside, "secret.txt"), "secret");
      await symlink(outside, path.join(root, "escape"), linkType);

      const read = await executeTool("read_file", { path: "escape/secret.txt" }, root);
      expect(read.ok).toBe(false);
      expect(read.output).toContain("outside the workspace");

      const write = await executeTool(
        "write_file",
        { path: "escape/new.txt", content: "escaped" },
        root,
      );
      expect(write.ok).toBe(false);
      expect(write.output).toContain("outside the workspace");

      const full = await executeTool("read_file", { path: "escape/secret.txt" }, root, {
        allowOutsideWorkspace: true,
      });
      expect(full.ok).toBe(true);
      expect(full.output).toContain("secret");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("filters credential env vars but keeps system basics", () => {
    expect(
      commandEnv({
        PATH: "C:\\Windows",
        USERPROFILE: "C:\\Users\\me",
        NORMAL_VAR: "ok",
        GH_TOKEN: "secret",
        AWS_SECRET_ACCESS_KEY: "secret",
        OPENAI_API_KEY: "secret",
        SESSION_SECRET: "secret",
        MEOWCODE_SERVER_TOKEN: "secret",
      }),
    ).toEqual({
      PATH: "C:\\Windows",
      USERPROFILE: "C:\\Users\\me",
      NORMAL_VAR: "ok",
    });
  });

  it("strips MeowCode env vars from command environments", async () => {    expect(
      commandEnv({
        MEOWCODE_PROVIDERS: "secret",
        meowcode_server_token: "secret",
        MEOW_TEST_VISIBLE: "visible",
        Path: "C:\\Windows",
      }),
    ).toEqual({ MEOW_TEST_VISIBLE: "visible", Path: "C:\\Windows" });

    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    const previousSecret = process.env.MEOWCODE_PROVIDERS;
    const previousVisible = process.env.MEOW_TEST_VISIBLE;
    process.env.MEOWCODE_PROVIDERS = "secret-provider-key";
    process.env.MEOW_TEST_VISIBLE = "visible-value";
    try {
      const result = await executeTool(
        "run_command",
        {
          command:
            "Write-Output ('P=' + $env:MEOWCODE_PROVIDERS); Write-Output ('V=' + $env:MEOW_TEST_VISIBLE)",
        },
        root,
      );
      expect(result.ok).toBe(true);
      expect(result.output).not.toContain("secret-provider-key");
      expect(result.output).toContain("visible-value");
    } finally {
      if (previousSecret === undefined) delete process.env.MEOWCODE_PROVIDERS;
      else process.env.MEOWCODE_PROVIDERS = previousSecret;
      if (previousVisible === undefined) delete process.env.MEOW_TEST_VISIBLE;
      else process.env.MEOW_TEST_VISIBLE = previousVisible;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads and writes outside the workspace in full access mode", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    const outside = await mkdtemp(path.join(tmpdir(), "meowcode-outside-"));
    const file = path.join(outside, "outside.txt");

    const write = await executeTool(
      "write_file",
      { path: file, content: "hello outside" },
      root,
      { allowOutsideWorkspace: true },
    );
    expect(write.ok).toBe(true);
    expect(await readFile(file, "utf8")).toBe("hello outside");

    const read = await executeTool("read_file", { path: file }, root, {
      allowOutsideWorkspace: true,
    });
    expect(read.ok).toBe(true);
    expect(read.output).toContain("1: hello outside");

    const restricted = await executeTool("read_file", { path: file }, root);
    expect(restricted.ok).toBe(false);
    expect(restricted.output).toContain("outside the workspace");
  });

  it("ends a command promptly when aborted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    const controller = new AbortController();
    const started = Date.now();
    const pending = executeTool("run_command", { command: "Start-Sleep -Seconds 30" }, root, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);

    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.output.toLowerCase()).toContain("aborted");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("keeps Chinese command output readable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    const result = await executeTool("run_command", { command: "Write-Output '中文测试'" }, root);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("中文测试");
    expect(result.output).not.toContain(String.fromCharCode(0xfffd));
  });

  it.skipIf(!hasPowerShell51)("keeps Chinese text piped into native commands", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    try {
      const result = await withPowerShell51(() =>
        executeTool("run_command", { command: '"中文测试" | findstr .' }, root),
      );
      expect(result.ok).toBe(true);
      expect(result.output).toContain("中文测试");
      expect(result.output).not.toContain("????");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("forces UTF-8 Python env for commands", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    const previous = process.env.PYTHONUTF8;
    process.env.PYTHONUTF8 = "0";
    try {
      const result = await executeTool(
        "run_command",
        { command: "Write-Output ($env:PYTHONUTF8 + '|' + $env:PYTHONIOENCODING)" },
        root,
      );
      expect(result.ok).toBe(true);
      expect(result.output).toContain("1|utf-8");
    } finally {
      if (previous === undefined) delete process.env.PYTHONUTF8;
      else process.env.PYTHONUTF8 = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("truncates long output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    const result = await executeTool("run_command", { command: "1..1000" }, root);
    expect(result.output.length).toBeLessThanOrEqual(20_100);
  });

  it("keeps the head and tail of long command output", () => {
    const text = `IMPORTANT-START${"x".repeat(20_000)}IMPORTANT-END`;
    const result = truncateMiddle(text);
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(12_200);
    expect(result.output.startsWith("IMPORTANT-START")).toBe(true);
    expect(result.output.endsWith("IMPORTANT-END")).toBe(true);
  });

  it("persists the captured command output for follow-up reads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    const result = await executeTool("run_command", { command: "'x' * 20000" }, root);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("the log is saved to .meowcode/tool-output/");
    expect(result.spilled).toContain(".meowcode/tool-output/run_command-");
    const full = await readFile(path.join(root, result.spilled!), "utf8");
    expect(full.length).toBeGreaterThanOrEqual(20_000);
  });

  it("reports a native command's exit code, not PowerShell's own", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    // PowerShell 自己永远退 0；不把 $LASTEXITCODE 变成进程退出码的话，
    // 失败的 git/npm/test 会被当成成功（模型据此宣布"构建通过"）
    const green = await executeTool("run_command", { command: "cmd /c exit 0" }, root);
    expect(green.ok).toBe(true);
    const red = await executeTool("run_command", { command: "cmd /c exit 7" }, root);
    expect(red.ok).toBe(false);
  });

  it("hints at the PowerShell equivalent when a bash-style command is used", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    const result = await executeTool("run_command", { command: "export FOO=bar" }, root);
    expect(result.output).toContain("[hint]");
    expect(result.output).toMatch(/PowerShell doesn't have that command|env vars/);
  });

  it("strips ANSI escapes out of command output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    const result = await executeTool(
      "run_command",
      { command: "$e=[char]27; Write-Output ($e + '[31mred' + $e + '[0m done')" },
      root,
    );
    expect(result.output).toContain("red done");
    // 控制序列对模型是纯噪音，必须在采集层清掉
    expect(result.output).not.toContain("\u001b");
  });

  it("does not wait for stdin when a command prompts for input", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    const started = Date.now();
    const result = await executeTool("run_command", { command: "Read-Host 'name'" }, root);
    // 以前 stdin 从不关闭，这里会挂满 120s 才被杀
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(result.output).not.toContain("timed out");
  });

  it("defaults file reads to 400 lines and reports the next offset", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    const content = Array.from({ length: 450 }, (_, index) => `line ${index + 1}`).join("\n");
    await writeFile(path.join(root, "long.txt"), content);

    const result = await executeTool("read_file", { path: "long.txt" }, root);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("400: line 400");
    expect(result.output).not.toContain("401: line 401");
    expect(result.output).toContain("use offset=401");
  });

  it("saves oversized reads to disk and previews head and tail", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    // 600 行 × 每行约 40 字符 ≈ 24KB，超过 8KB 落盘阈值
    const content = Array.from(
      { length: 600 },
      (_, index) => `row ${index + 1} ${"x".repeat(30)}`,
    ).join("\n");
    await writeFile(path.join(root, "big.txt"), content);

    const result = await executeTool("read_file", { path: "big.txt" }, root);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("1: row 1");
    expect(result.output).toContain("full content of big.txt saved to");
    expect(result.output).toContain("read that path with read_file");
    // 尾部预览可见：模型不必 offset 翻到最后一页才知道文件结尾
    expect(result.output).toContain("600: row 600");
    // 头尾之间的中段被省略
    expect(result.output).toMatch(/\[\d+ lines omitted; full content of big\.txt saved to/);
    // 落盘文件确实存在且内容是原文（无行号前缀，行号与原文件对齐）
    const savedPath = result.output.match(/saved to (\S+?) —/)?.[1] ?? "";
    expect(savedPath).toContain(".meowcode/tool-output/read_file-");
    const saved = await readFile(path.join(root, ...savedPath.split("/")), "utf8");
    expect(saved).toBe(content);
  });

  it("按 token 截断中文读取，不按字符放大四倍", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    const content = Array.from(
      { length: 600 },
      (_, index) => `第${index + 1}行：${"中".repeat(40)}`,
    ).join("\n");
    await writeFile(path.join(root, "zh.txt"), content);

    const result = await executeTool("read_file", { path: "zh.txt" }, root);
    expect(result.ok).toBe(true);
    // 4k token 预算：中文约 4k 字符，不能再按 20k 字符灌满
    expect(estimateTokens(result.output)).toBeLessThanOrEqual(4_500);
    expect(result.output).toContain("full content of zh.txt saved to");
    expect(result.output).toContain("600: 第600行");
  });

  it("keeps small files fully inline without saving to disk", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    const content = Array.from({ length: 450 }, (_, index) => `line ${index + 1}`).join("\n");
    await writeFile(path.join(root, "medium.txt"), content);

    const result = await executeTool("read_file", { path: "medium.txt" }, root);
    expect(result.ok).toBe(true);
    // 4KB 的文件即使超过 400 行也不落盘：走原有 offset 分页提示
    expect(result.output).not.toContain("saved to");
    expect(result.output).toContain("use offset=");
  });

  it("respects an explicit small limit while still showing the tail", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    const content = Array.from(
      { length: 600 },
      (_, index) => `row ${index + 1} ${"x".repeat(30)}`,
    ).join("\n");
    await writeFile(path.join(root, "big.txt"), content);

    const result = await executeTool("read_file", { path: "big.txt", limit: 5 }, root);
    expect(result.ok).toBe(true);
    // 显式 limit 只给 5 行头部，不扩张成 100 行预览
    expect(result.output).toContain("5: row 5");
    expect(result.output).not.toContain("6: row 6");
    // 但尾部预览仍然可见
    expect(result.output).toContain("600: row 600");
  });
});

describe("line-ending and encoding safe file tools", () => {
  const tempRoot = async () => await mkdtemp(path.join(tmpdir(), "meowcode-text-"));

  /** 约 5.4MB，超过 MAX_TEXT_BYTES */
  const oversizedText = () => `${Array.from({ length: 500_000 }, (_, index) => `row ${index}`).join("\n")}\n`;

  it("edits a CRLF file with an LF oldString and leaves untouched bytes identical", async () => {
    const root = await tempRoot();
    const file = path.join(root, "crlf.txt");
    await writeFile(file, "alpha\r\nbeta\r\ngamma\r\ndelta\r\n");

    const result = await executeTool(
      "edit_file",
      { path: "crlf.txt", oldString: "beta\ngamma", newString: "BETA\nGAMMA" },
      root,
    );

    expect(result.ok).toBe(true);
    expect(await readFile(file, "utf8")).toBe("alpha\r\nBETA\r\nGAMMA\r\ndelta\r\n");
  });

  it("keeps editing plain LF files", async () => {
    const root = await tempRoot();
    const file = path.join(root, "lf.txt");
    await writeFile(file, "one\ntwo\nthree\n");

    const result = await executeTool(
      "edit_file",
      { path: "lf.txt", oldString: "one\ntwo", newString: "1\n2" },
      root,
    );

    expect(result.ok).toBe(true);
    expect(await readFile(file, "utf8")).toBe("1\n2\nthree\n");
  });

  it("reports ambiguity instead of editing the wrong occurrence", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "dup.txt"), "x\r\ny\r\nx\r\ny\r\n");

    const result = await executeTool(
      "edit_file",
      { path: "dup.txt", oldString: "x\ny", newString: "z" },
      root,
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain("not unique");
    expect(await readFile(path.join(root, "dup.txt"), "utf8")).toBe("x\r\ny\r\nx\r\ny\r\n");
  });

  it("preserves a UTF-8 BOM while editing the first line", async () => {
    const root = await tempRoot();
    const file = path.join(root, "bom.txt");
    await writeFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("head\r\ntail\r\n")]));

    const result = await executeTool(
      "edit_file",
      { path: "bom.txt", oldString: "head\ntail", newString: "HEAD\nTAIL" },
      root,
    );

    expect(result.ok).toBe(true);
    const bytes = await readFile(file);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.subarray(3).toString("utf8")).toBe("HEAD\r\nTAIL\r\n");
  });

  it("write_file keeps the existing file's line endings instead of rewriting every line", async () => {
    const root = await tempRoot();
    const file = path.join(root, "keep.txt");
    await writeFile(file, "old\r\n");

    const result = await executeTool("write_file", { path: "keep.txt", content: "a\nb\n" }, root);

    expect(result.ok).toBe(true);
    expect(await readFile(file, "utf8")).toBe("a\r\nb\r\n");
  });

  it("refuses to read a binary file", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));

    const result = await executeTool("read_file", { path: "blob.bin" }, root);

    expect(result.ok).toBe(false);
    expect(result.output).toContain("binary");
  });

  it("refuses a non-UTF-8 file rather than corrupting it on write-back", async () => {
    const root = await tempRoot();
    const file = path.join(root, "gbk.txt");
    // 「中文」的 GBK 编码：作为 UTF-8 是非法序列
    await writeFile(file, Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]));

    const read = await executeTool("read_file", { path: "gbk.txt" }, root);
    expect(read.ok).toBe(false);
    expect(read.output).toContain("not valid UTF-8");

    const edit = await executeTool("edit_file", { path: "gbk.txt", oldString: "x", newString: "y" }, root);
    expect(edit.ok).toBe(false);

    const overwrite = await executeTool("write_file", { path: "gbk.txt", content: "replaced" }, root);
    expect(overwrite.ok).toBe(false);
    expect([...(await readFile(file))]).toEqual([0xd6, 0xd0, 0xce, 0xc4, 0x0a]);
  });

  it("reads the head of an oversized file and says how much was skipped", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "huge.txt"), oversizedText());

    const result = await executeTool("read_file", { path: "huge.txt", limit: 5 }, root);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("1: row 0");
    expect(result.output).toContain("only the first");
  });

  it("refuses to rewrite a file it would have to hold in memory in full", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "huge.txt"), oversizedText());

    const result = await executeTool(
      "edit_file",
      { path: "huge.txt", oldString: "row 1\nrow 2", newString: "changed" },
      root,
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain("above the");
  });

  it("builds the same approval preview for a CRLF edit as the tool performs", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "preview.txt"), "alpha\r\nbeta\r\ngamma\r\n");

    const diff = await previewEditDiff(root, "preview.txt", "beta\ngamma", "BETA\nGAMMA");

    expect(diff).toContain("+ BETA");
  });
});



describe("efficient editing: multi_edit, receipts, hints, rewrite guard", () => {
  const tempRoot = async () => await mkdtemp(path.join(tmpdir(), "meowcode-edit-"));

  it("applies several edits in one call and returns the combined diff", async () => {
    const root = await tempRoot();
    const file = path.join(root, "multi.ts");
    await writeFile(file, "const a = 1;\nconst b = 2;\nconst c = 3;\n");

    const result = await executeTool(
      "multi_edit",
      {
        path: "multi.ts",
        edits: [
          { oldString: "const a = 1;", newString: "const a = 10;" },
          { oldString: "const c = 3;", newString: "const c = 30;" },
        ],
      },
      root,
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain("2 replacements");
    expect(await readFile(file, "utf8")).toBe("const a = 10;\nconst b = 2;\nconst c = 30;\n");
    expect(result.output).toContain("+ const a = 10;");
    expect(result.output).toContain("no need to re-read");
  });

  it("aborts a multi_edit without writing anything when one edit fails", async () => {
    const root = await tempRoot();
    const file = path.join(root, "abort.ts");
    await writeFile(file, "const a = 1;\nconst b = 2;\n");

    const result = await executeTool(
      "multi_edit",
      {
        path: "abort.ts",
        edits: [
          { oldString: "const a = 1;", newString: "const a = 10;" },
          { oldString: "missing();", newString: "found();" },
        ],
      },
      root,
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain("edit #2 of 2");
    expect(result.output).toContain("nothing was written");
    expect(await readFile(file, "utf8")).toBe("const a = 1;\nconst b = 2;\n");
  });

  it("applies edits across several files in one call", async () => {
    const root = await tempRoot();
    const a = path.join(root, "a.ts");
    const b = path.join(root, "b.ts");
    await writeFile(a, "const a = 1;\n");
    await writeFile(b, "const b = 2;\nconst b2 = 2;\n");

    const result = await executeTool(
      "multi_edit",
      {
        edits: [
          { path: "a.ts", oldString: "const a = 1;", newString: "const a = 10;" },
          { path: "b.ts", oldString: "const b = 2;", newString: "const b = 20;" },
          { path: "b.ts", oldString: "const b2 = 2;", newString: "const b2 = 20;" },
        ],
      },
      root,
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain("multi_edit: 2 files updated");
    expect(result.output).toContain("- a.ts (1 replacement)");
    expect(result.output).toContain("- b.ts (2 replacements)");
    expect(result.output).toContain("no need to re-read");
    expect(await readFile(a, "utf8")).toBe("const a = 10;\n");
    expect(await readFile(b, "utf8")).toBe("const b = 20;\nconst b2 = 20;\n");
  });

  it("writes nothing in any file when one cross-file edit fails", async () => {
    const root = await tempRoot();
    const a = path.join(root, "a.ts");
    const b = path.join(root, "b.ts");
    await writeFile(a, "const a = 1;\n");
    await writeFile(b, "const b = 2;\n");

    const result = await executeTool(
      "multi_edit",
      {
        edits: [
          { path: "a.ts", oldString: "const a = 1;", newString: "const a = 10;" },
          { path: "b.ts", oldString: "missing();", newString: "found();" },
        ],
      },
      root,
    );

    expect(result.ok).toBe(false);
    // 指明是哪个文件的第几条，且两个文件都没变
    expect(result.output).toContain("b.ts");
    expect(result.output).toContain("nothing was written");
    expect(await readFile(a, "utf8")).toBe("const a = 1;\n");
    expect(await readFile(b, "utf8")).toBe("const b = 2;\n");
  });

  it("rejects a cross-file multi_edit that reaches outside the workspace", async () => {
    const root = await tempRoot();
    const outside = await mkdtemp(path.join(tmpdir(), "meowcode-outside-"));
    await writeFile(path.join(root, "a.ts"), "const a = 1;\n");
    await writeFile(path.join(outside, "secret.ts"), "const s = 1;\n");

    const result = await executeTool(
      "multi_edit",
      {
        edits: [
          { path: "a.ts", oldString: "const a = 1;", newString: "const a = 10;" },
          { path: "../" + path.basename(outside) + "/secret.ts", oldString: "const s = 1;", newString: "const s = 10;" },
        ],
      },
      root,
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain("outside the workspace");
    expect(await readFile(path.join(root, "a.ts"), "utf8")).toBe("const a = 1;\n");
  });

  it("reports a missing per-edit path instead of guessing", async () => {
    const root = await tempRoot();
    const result = await executeTool(
      "multi_edit",
      { edits: [{ oldString: "a", newString: "b" }] },
      root,
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain('edit #1 is missing "path"');
  });

  it("supports replaceAll inside a single edit", async () => {
    const root = await tempRoot();
    const file = path.join(root, "rename.ts");
    await writeFile(file, "oldName();\noldName();\n");

    const result = await executeTool(
      "edit_file",
      { path: "rename.ts", oldString: "oldName", newString: "newName", replaceAll: true },
      root,
    );

    expect(result.ok).toBe(true);
    expect(await readFile(file, "utf8")).toBe("newName();\nnewName();\n");
  });

  it("points at the closest lines when oldString is not found", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "hint.ts"), "const alpha = 1;\nconst beta = 2;\n");

    const result = await executeTool(
      "edit_file",
      {
        path: "hint.ts",
        oldString: "const beta = 2;\nconst gamma = 3;",
        newString: "x",
      },
      root,
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain("not found");
    expect(result.output).toContain("L2: const beta = 2;");
  });

  it("lists every ambiguous line and suggests replaceAll", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "dup.ts"), "x\r\ny\r\nx\r\ny\r\n");

    const result = await executeTool("edit_file", { path: "dup.ts", oldString: "x\ny", newString: "z" }, root);

    expect(result.ok).toBe(false);
    expect(result.output).toContain("not unique");
    expect(result.output).toContain("L1");
    expect(result.output).toContain("L3");
    expect(result.output).toContain("replaceAll: true");
  });

  it("refuses a whole-file rewrite that barely changes a large file, unless forced", async () => {
    const root = await tempRoot();
    const file = path.join(root, "big.ts");
    const before = Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n");
    await writeFile(file, `${before}\n`);
    const after = before.replace("line 30", "line thirty");

    const refused = await executeTool("write_file", { path: "big.ts", content: after }, root);
    expect(refused.ok).toBe(false);
    expect(refused.output).toContain("write_file refused");
    expect(refused.output).toContain("force: true");

    const forced = await executeTool("write_file", { path: "big.ts", content: after, force: true }, root);
    expect(forced.ok).toBe(true);
    expect(await readFile(file, "utf8")).toBe(after);
  });

  it("writes atomically and leaves no temp files behind", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "atomic.txt"), "a\n");

    const result = await executeTool(
      "edit_file",
      { path: "atomic.txt", oldString: "a", newString: "b" },
      root,
    );

    expect(result.ok).toBe(true);
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(root);
    expect(names.filter((name) => name.includes(".meowcode-"))).toHaveLength(0);
    expect(names).toContain("atomic.txt");
  });
});

describe("structured search output degradation", () => {
  it("keeps short output untouched", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    const short = "src/a.ts:1: const value = 1;";
    const result = await degradeStructuredOutput(root, "grep", short);
    expect(result).toEqual({ output: short, truncated: false });
  });

  it("spills oversized results and points at read_file for paging", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    const body = Array.from(
      { length: 600 },
      (_, index) => `src/file${index}.ts:${index + 1}: const value = ${index};`,
    ).join("\n");

    const result = await degradeStructuredOutput(root, "grep", body);
    expect(result.truncated).toBe(true);
    // 预算按 token 计：2k 预算下英文约 8k 字符，不能再按旧的 5k 字符断言
    expect(estimateTokens(result.output)).toBeLessThanOrEqual(2_300);
    expect(result.output).toContain("full result saved to .meowcode/tool-output/");
    expect(result.output).toContain("read_file (offset/limit)");
    // 落盘的是完整内容，模型可以分页续读
    expect(result.spilled).toContain(".meowcode/tool-output/grep-");
    const full = await readFile(path.join(root, result.spilled!), "utf8");
    expect(full).toBe(body);
  });

  it("spills the untruncated body when the inline text was already capped", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    const full = Array.from(
      { length: 600 },
      (_, index) => `src/file${index}.ts:${index + 1}: const value = ${index};`,
    ).join("\n");
    // 搜索层内联只留前 12k，落盘必须是裁剪前的全文
    const inline = `${full.slice(0, 12_000)}\n... [truncated ${full.length - 12_000} characters]`;

    const result = await degradeStructuredOutput(root, "grep", inline, full);
    expect(result.spilled).toBeTruthy();
    const saved = await readFile(path.join(root, result.spilled!), "utf8");
    expect(saved).toBe(full);
    expect(saved).toContain("file599");
  });

  it("keeps the trailing truncation notice when degrading", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    const body = Array.from({ length: 600 }, (_, index) => `src/f${index}.ts:${index}: match`).join("\n");
    const notice = "\n... [truncated: showing first 100 matches; narrow the pattern]";

    const result = await degradeStructuredOutput(root, "grep", body + notice);
    expect(result.output).toContain(notice);
  });

  it("degrades oversized grep results through executeTool", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    await writeFile(
      path.join(root, "big.ts"),
      Array.from({ length: 600 }, (_, index) => `const value${index} = ${index};`).join("\n"),
    );

    const result = await executeTool("grep", { pattern: "const value", maxResults: 500 }, root);
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.output).toContain("full result saved to .meowcode/tool-output/");
  });
});

describe("read_file images", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  it("returns the picture itself when the model accepts images", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    await writeFile(path.join(root, "shot.png"), png);

    const result = await executeTool("read_file", { path: "shot.png" }, root, { vision: true });
    expect(result.ok).toBe(true);
    expect(result.images).toEqual([{ data: png.toString("base64"), mimeType: "image/png" }]);
  });

  it("still rejects image files for text-only models", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    await writeFile(path.join(root, "shot.png"), png);

    const result = await executeTool("read_file", { path: "shot.png" }, root);
    expect(result.ok).toBe(false);
  });

  it("downsizes an under-4MB image by long edge", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    await writeFile(path.join(root, "wide.png"), png);
    const requests: Array<{ path: string; maxEdge?: number }> = [];

    const result = await executeTool("read_file", { path: "wide.png" }, root, {
      vision: true,
      shrinkImage: async (request) => {
        requests.push(request);
        return {
          ok: true,
          data: "QUFBQQ==",
          mimeType: "image/png",
          width: 1568,
          height: 882,
          bytes: 900_000,
          originalWidth: 3200,
          originalHeight: 1800,
        };
      },
    });

    expect(result.images).toEqual([{ data: "QUFBQQ==", mimeType: "image/png" }]);
    expect(result.output).toContain("auto-downscaled from 3200x1800 to 1568x882");
    expect(requests).toHaveLength(1);
    expect(requests[0].maxEdge).toBe(1_568);
  });

  it("keeps the original bytes for a small image even when a resizer is available", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    await writeFile(path.join(root, "small.png"), png);

    const result = await executeTool("read_file", { path: "small.png" }, root, {
      vision: true,
      shrinkImage: async () => ({
        ok: true,
        data: "SHOULD-NOT-BE-USED",
        mimeType: "image/png",
        width: 800,
        height: 600,
        originalWidth: 800,
        originalHeight: 600,
      }),
    });

    expect(result.images).toEqual([{ data: png.toString("base64"), mimeType: "image/png" }]);
    expect(result.output).not.toContain("downscaled");
  });

  it("auto-downsizes oversized images instead of rejecting them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    await writeFile(path.join(root, "big.png"), Buffer.alloc(4 * 1024 * 1024 + 64, 1));
    const requests: Array<{ path: string; maxBytes?: number }> = [];

    const result = await executeTool("read_file", { path: "big.png" }, root, {
      vision: true,
      shrinkImage: async (request) => {
        requests.push(request);
        return {
          ok: true,
          data: "QUFBQQ==",
          mimeType: "image/png",
          width: 1568,
          height: 882,
          bytes: 900_000,
          originalWidth: 3200,
          originalHeight: 1800,
        };
      },
    });

    expect(result.ok).toBe(true);
    expect(result.images).toEqual([{ data: "QUFBQQ==", mimeType: "image/png" }]);
    expect(result.output).toContain("auto-downscaled from 3200x1800 to 1568x882");
    expect(requests).toHaveLength(1);
    expect(requests[0].path.endsWith("big.png")).toBe(true);
  });

  it("unloads oversized images with an actionable note when no resizer is available", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    await writeFile(path.join(root, "big.png"), Buffer.alloc(4 * 1024 * 1024 + 64, 1));

    const result = await executeTool("read_file", { path: "big.png" }, root, { vision: true });

    // 不再硬报错：ok 的文字说明，图片不附带，并指路（先缩放/裁剪再读）
    expect(result.ok).toBe(true);
    expect(result.images).toBeUndefined();
    expect(result.output).toContain("NOT attached");
    expect(result.output).toContain("Downscale or crop it first");
  });

  it("keeps the note actionable when downscaling fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    await writeFile(path.join(root, "big.jpg"), Buffer.alloc(4 * 1024 * 1024 + 64, 1));

    const result = await executeTool("read_file", { path: "big.jpg" }, root, {
      vision: true,
      shrinkImage: async () => ({ ok: false, error: "still too large after downscale" }),
    });

    expect(result.ok).toBe(true);
    expect(result.images).toBeUndefined();
    expect(result.output).toContain("could not be downscaled");
    expect(result.output).toContain("NOT attached");
  });
});

describe("read_many batch reads", () => {
  it("reads several files with per-file sections and line numbers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    await writeFile(path.join(root, "a.ts"), "alpha\nbeta");
    await writeFile(path.join(root, "b.ts"), "gamma");
    const result = await executeTool("read_many", { paths: ["a.ts", "b.ts"] }, root);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Read 2 files:");
    expect(result.output).toContain("=== a.ts ===");
    expect(result.output).toContain("1: alpha");
    expect(result.output).toContain("2: beta");
    expect(result.output).toContain("=== b.ts ===");
    expect(result.output).toContain("1: gamma");
  });

  it("dedupes paths and reports missing files without failing the batch", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    await writeFile(path.join(root, "a.ts"), "alpha");
    const result = await executeTool(
      "read_many",
      { paths: ["a.ts", "a.ts", "missing.ts"] },
      root,
    );
    expect(result.ok).toBe(true);
    // a.ts 只出现一次；missing.ts 是错误段落，不中断其余文件
    expect(result.output.match(/=== a\.ts ===/g)).toHaveLength(1);
    expect(result.output).toContain("=== missing.ts ===");
    expect(result.output).toContain("not found");
  });

  it("skips files that no longer fit the shared budget and hints read_file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    const big = Array.from({ length: 3_000 }, (_, index) => `line ${index} padding padding`).join("\n");
    await writeFile(path.join(root, "big.ts"), big);
    await writeFile(path.join(root, "small.ts"), "tiny");
    const result = await executeTool("read_many", { paths: ["big.ts", "small.ts"] }, root);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("=== big.ts ===");
    expect(result.output).toContain("use read_file big.ts offset=");
    expect(result.output).toContain("=== small.ts ===");
  });

  it("previews and spills files that no longer fit the shared budget", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    const body = Array.from({ length: 400 }, (_, index) => `line ${index} padding padding padding`).join("\n");
    const names = Array.from({ length: 12 }, (_, index) => `f${index}.ts`);
    for (const name of names) await writeFile(path.join(root, name), body);

    const result = await executeTool("read_many", { paths: names }, root);
    expect(result.ok).toBe(true);
    // 预算耗尽后不再只回一句「自己用 read_file」：给预览 + 全文落盘
    expect(result.output).toContain("full content saved to .meowcode/tool-output/read_many-");
    expect(result.output).toContain("=== f11.ts ===");
    expect(result.output.length).toBeLessThanOrEqual(20_100);
  });

  it("returns readRanges and short-circuits fully covered files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    await writeFile(path.join(root, "a.ts"), "alpha\nbeta");
    await writeFile(path.join(root, "b.ts"), "gamma");

    const first = await executeTool("read_many", { paths: ["a.ts", "b.ts"] }, root);
    expect(first.readRanges).toEqual([
      { path: "a.ts", start: 1, end: 2, total: 2 },
      { path: "b.ts", start: 1, end: 1, total: 1 },
    ]);

    // runtime 注入的覆盖查询命中 a.ts：正文不再重发
    const second = await executeTool("read_many", { paths: ["a.ts", "b.ts"] }, root, {
      readCoverage: async (target) => target === "a.ts",
    });
    expect(second.output).toContain("[already read in full earlier this session and unchanged");
    expect(second.output).not.toContain("1: alpha");
    expect(second.output).toContain("1: gamma");
  });

  it("treats ./a.ts and a.ts as the same file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    await writeFile(path.join(root, "a.ts"), "alpha");
    const result = await executeTool("read_many", { paths: ["./a.ts", "a.ts"] }, root);
    expect(result.output.match(/=== \.\/a\.ts ===/g)).toHaveLength(1);
    expect(result.output).not.toContain("=== a.ts ===");
    // 头部按实际段落数算，不能写「Read 2 files」
    expect(result.output).not.toContain("Read 2 files:");
  });

  it("routes image files to read_file instead of inlining base64", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    await writeFile(path.join(root, "pic.png"), "fake-png");
    const result = await executeTool("read_many", { paths: ["pic.png"] }, root);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("[image file — use read_file");
  });

  it("registers read state so a later edit_file detects external changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-"));
    await writeFile(path.join(root, "a.ts"), "alpha");
    await executeTool("read_many", { paths: ["a.ts"] }, root);
    await writeFile(path.join(root, "a.ts"), "alpha\nexternal change");
    const edit = await executeTool(
      "edit_file",
      { path: "a.ts", oldString: "alpha", newString: "beta" },
      root,
    );
    expect(edit.ok).toBe(true);
    expect(edit.output).toContain("had changed on disk since your last read");
  });

  it("rejects an empty paths array", async () => {
    const result = await executeTool("read_many", { paths: [] }, process.cwd());
    expect(result.ok).toBe(false);
    expect(result.output).toContain("non-empty");
  });
});

/** 最小合法 PDF（每页一行文本），用于验证 read_file 的 PDF 通道。 */
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

describe("read_file PDF", () => {
  it("extracts the text layer with page markers and honours pages=", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-pdf-"));
    await writeFile(
      path.join(root, "doc.pdf"),
      buildPdf(["alpha ".repeat(30), "beta ".repeat(30), "gamma ".repeat(30)]),
    );
    const result = await executeTool("read_file", { path: "doc.pdf", pages: "2" }, root);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("[page 2]");
    expect(result.output).toContain("beta");
    expect(result.output).not.toContain("[page 1]");
    expect(result.documents).toBeUndefined();
  });

  it("attaches a scanned PDF as a document when the model supports pdf input", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-pdf-"));
    await writeFile(path.join(root, "scan.pdf"), buildPdf(["", ""]));
    const result = await executeTool(
      "read_file",
      { path: "scan.pdf" },
      root,
      { pdfDocuments: true },
    );
    expect(result.ok).toBe(true);
    expect(result.documents).toHaveLength(1);
    expect(result.documents?.[0]).toMatchObject({
      mimeType: "application/pdf",
      name: "scan.pdf",
    });
    expect(result.output).toContain("attached as a document");
  });

  it("returns an actionable hint instead of attaching when pdf input is off", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-pdf-"));
    await writeFile(path.join(root, "scan.pdf"), buildPdf(["", ""]));
    const result = await executeTool("read_file", { path: "scan.pdf" }, root);
    expect(result.ok).toBe(true);
    expect(result.documents).toBeUndefined();
    expect(result.output).toContain("scanned PDF");
    expect(result.output).toContain("PDF");
  });

  it("points read_many at read_file for PDFs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-pdf-"));
    await writeFile(path.join(root, "doc.pdf"), buildPdf(["alpha ".repeat(30)]));
    const result = await executeTool("read_many", { paths: ["doc.pdf"] }, root);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("use read_file with pages=");
  });
});

describe("read_video guards", () => {
  it("refuses to render frames for a text-only model", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-video-"));
    const result = await executeTool("read_video", { path: "clip.mp4", mode: "storyboard" }, root);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("text-only");
  });

  it("requires a path", async () => {
    const result = await executeTool("read_video", {}, process.cwd());
    expect(result.ok).toBe(false);
    expect(result.output).toContain('requires a "path"');
  });
});

describe("dynamic tool definitions", () => {
  const stub = (name: string, description: string) => ({
    definition: {
      type: "function" as const,
      function: {
        name,
        description,
        parameters: {
          type: "object",
          properties: { q: { type: "string", description: "query" } },
        },
      },
    },
    execute: async () => ({ output: "ok", ok: true }),
  });

  it("is byte-identical regardless of registration order", () => {
    registerDynamicTool("mcp__z__last", stub("mcp__z__last", "z"));
    registerDynamicTool("mcp__a__first", stub("mcp__a__first", "a"));
    const first = JSON.stringify(listDynamicToolDefinitions());
    unregisterDynamicTool("mcp__z__last");
    unregisterDynamicTool("mcp__a__first");

    registerDynamicTool("mcp__a__first", stub("mcp__a__first", "a"));
    registerDynamicTool("mcp__z__last", stub("mcp__z__last", "z"));
    const second = JSON.stringify(listDynamicToolDefinitions());
    unregisterDynamicTool("mcp__z__last");
    unregisterDynamicTool("mcp__a__first");

    expect(second).toBe(first);
    expect(first.indexOf("mcp__a__first")).toBeLessThan(first.indexOf("mcp__z__last"));
  });

  it("超预算的动态工具转入 deferred，tool_search 命中后提升回可见区", async () => {
    const names: string[] = [];
    try {
      // 单工具注册时被冻结到 ≤400 tokens，但极简 stub 实际 ~50 tokens：
      // 200 个 × ~50 ≈ 10k，必然越过 8k 整体预算
      for (let index = 0; index < 200; index += 1) {
        const name = `mcp__bulk__tool_${String(index).padStart(2, "0")}`;
        names.push(name);
        registerDynamicTool(name, stub(name, `bulk test tool number ${index}`));
      }
      const visible = listDynamicToolDefinitions();
      const visibleNames = visible.map((definition) => definition.function.name);
      // 有工具被延迟：可见数 < 30，且可见集是名字序的前缀
      expect(visibleNames.length).toBeLessThan(200);
      expect(visibleNames).toEqual([...visibleNames].sort());
      const deferred = deferredDynamicToolNames();
      expect(deferred.length).toBeGreaterThan(0);
      for (const name of deferred) {
        expect(visibleNames).not.toContain(name);
        expect(hasDynamicTool(name)).toBe(true); // 在册可调用，只是 schema 不发
      }

      // tool_search 按名字命中一个 deferred 工具 → 提升回可见区（下轮生效）
      const target = deferred[0];
      const search = await executeTool("tool_search", { query: target });
      expect(search.ok).toBe(true);
      expect(search.output).toContain(target);
      const after = listDynamicToolDefinitions().map((definition) => definition.function.name);
      expect(after).toContain(target);
      expect(deferredDynamicToolNames()).not.toContain(target);

      // 无命中 → 列出全部在册工具兜底
      const miss = await executeTool("tool_search", { query: "zzz-no-such-keyword" });
      expect(miss.ok).toBe(true);
      expect(miss.output).toContain("No registered tool matches");
    } finally {
      for (const name of names) unregisterDynamicTool(name);
      listDynamicToolDefinitions(); // 触发重算，清空 deferred 集
    }
  });

  it("插件创作入口始终可见，不会被大量 MCP 工具挤出预算", () => {
    const bulk: string[] = [];
    const essentials = ["plugin_authoring_guide", "create_plugin", "create_skill"];
    try {
      for (let index = 0; index < 200; index += 1) {
        const name = `mcp__bulk__tool_${String(index).padStart(2, "0")}`;
        bulk.push(name);
        registerDynamicTool(name, stub(name, `bulk test tool number ${index}`));
      }
      for (const name of essentials) registerDynamicTool(name, stub(name, name));

      const visibleNames = listDynamicToolDefinitions().map(
        (definition) => definition.function.name,
      );
      for (const name of essentials) {
        expect(visibleNames).toContain(name);
        expect(deferredDynamicToolNames()).not.toContain(name);
      }
    } finally {
      for (const name of [...bulk, ...essentials]) unregisterDynamicTool(name);
      listDynamicToolDefinitions();
    }
  });
});

describe("memory tools", () => {
  it("writes, reads and deletes a project memory with its index", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-mem-"));
    try {
      const write = await executeTool(
        "memory_write",
        {
          scope: "project",
          name: "build-setup",
          description: "构建走 pnpm",
          content: "仓库用 pnpm，不要 npm install。",
        },
        root,
      );
      expect(write.ok).toBe(true);
      expect(write.output).toContain('Saved project memory "build-setup"');

      const read = await executeTool(
        "memory_read",
        { scope: "project", name: "build-setup" },
        root,
      );
      expect(read.ok).toBe(true);
      expect(read.output).toContain("pnpm");
      expect(read.output).toContain("description: 构建");

      const index = await readFile(
        path.join(root, ".meowcode", "memory", "MEMORY.md"),
        "utf8",
      );
      expect(index).toContain("- [build-setup](build-setup.md) — 构建走 pnpm");

      const remove = await executeTool(
        "memory_delete",
        { scope: "project", name: "build-setup" },
        root,
      );
      expect(remove.ok).toBe(true);
      const missing = await executeTool(
        "memory_read",
        { scope: "project", name: "build-setup" },
        root,
      );
      expect(missing.ok).toBe(false);
      expect(missing.output).toContain("not found");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects bad scope, bad name and empty content", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-mem-"));
    try {
      const scope = await executeTool(
        "memory_write",
        { scope: "global", name: "x", description: "d", content: "c" },
        root,
      );
      expect(scope.ok).toBe(false);
      expect(scope.output).toContain('scope "user" or "project"');

      const name = await executeTool(
        "memory_write",
        { scope: "project", name: "../evil", description: "d", content: "c" },
        root,
      );
      expect(name.ok).toBe(false);
      expect(name.output).toContain("Invalid memory name");

      const empty = await executeTool(
        "memory_write",
        { scope: "project", name: "ok-name", description: "d", content: "  " },
        root,
      );
      expect(empty.ok).toBe(false);
      expect(empty.output).toContain("requires a one-line description");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reserves memory tool names against dynamic registration", () => {
    const stub = {
      definition: {
        type: "function" as const,
        function: {
          name: "memory_write",
          description: "x",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: async () => ({ output: "ok", ok: true }),
    };
    expect(registerDynamicTool("memory_write", stub).ok).toBe(false);
  });
});

describe("session_search tool", () => {
  type SessionMessage = { role: "user" | "assistant"; content: string };

  async function writeSessionFile(
    dir: string,
    fileName: string,
    options: {
      id: string;
      cwd: string;
      createdAt: string;
      title: string;
      messages: SessionMessage[];
    },
  ): Promise<void> {
    const header = {
      type: "session",
      version: 2,
      id: options.id,
      cwd: options.cwd,
      createdAt: options.createdAt,
    };
    const lines = [JSON.stringify(header)];
    options.messages.forEach((message, index) => {
      lines.push(
        JSON.stringify({
          type: "message",
          id: `m${index + 1}`,
          parentId: null,
          timestamp: options.createdAt,
          message,
        }),
      );
    });
    lines.push(
      JSON.stringify({
        type: "title",
        id: "title",
        parentId: null,
        timestamp: options.createdAt,
        title: options.title,
      }),
    );
    await writeFile(path.join(dir, fileName), `${lines.join("\n")}\n`, "utf8");
  }

  it("searches the workspace, excludes the current session and hydrates context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-session-"));
    const sessionsDir = path.join(root, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    try {
      await writeSessionFile(sessionsDir, "a.jsonl", {
        id: "s-a".padEnd(36, "0"),
        cwd: root,
        createdAt: "2026-11-01T00:00:00.000Z",
        title: "当前会话标题",
        messages: [
          { role: "user", content: "esbuild 重启循环怎么修" },
          { role: "assistant", content: "当前会话的答案" },
        ],
      });
      await writeSessionFile(sessionsDir, "b.jsonl", {
        id: "s-b".padEnd(36, "0"),
        cwd: root,
        createdAt: "2026-11-02T00:00:00.000Z",
        title: "旧修复标题",
        messages: [
          { role: "user", content: "esbuild 重启循环怎么修" },
          { role: "assistant", content: "把 watcher 的 debounce 调到 300ms 并跳过 dist" },
        ],
      });
      await writeSessionFile(sessionsDir, "c.jsonl", {
        id: "s-c".padEnd(36, "0"),
        cwd: path.join(root, "other-project"),
        createdAt: "2026-11-03T00:00:00.000Z",
        title: "别的项目标题",
        messages: [
          { role: "user", content: "esbuild 重启循环怎么修" },
          { role: "assistant", content: "别的项目的答案" },
        ],
      });

      const result = await executeTool("session_search", { query: "esbuild" }, root, {
        sessionSearch: { sessionsDir, excludeSessionId: "s-a".padEnd(36, "0") },
      });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("旧修复标题");
      expect(result.output).toContain("[assistant]");
      expect(result.output).toContain("debounce");
      expect(result.output).not.toContain("当前会话标题");
      expect(result.output).not.toContain("别的项目标题");
    } finally {
      await flushSearchIndexWrites();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates the query and runtime availability", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-session-"));
    const sessionsDir = path.join(root, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    try {
      const empty = await executeTool("session_search", { query: "   " }, root, {
        sessionSearch: { sessionsDir },
      });
      expect(empty.ok).toBe(false);
      expect(empty.output).toContain("non-empty");

      const unavailable = await executeTool("session_search", { query: "esbuild" }, root);
      expect(unavailable.ok).toBe(false);
      expect(unavailable.output).toContain("not available");

      const none = await executeTool("session_search", { query: "没有这个词" }, root, {
        sessionSearch: { sessionsDir },
      });
      expect(none.ok).toBe(true);
      expect(none.output).toContain("No past sessions");
    } finally {
      await flushSearchIndexWrites();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("caps the limit and the total output size", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-tools-session-"));
    const sessionsDir = path.join(root, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    try {
      const filler = "上下文".repeat(300);
      for (let index = 0; index < 12; index += 1) {
        await writeSessionFile(sessionsDir, `s${index}.jsonl`, {
          id: `s-${index}`.padEnd(36, "0"),
          cwd: root,
          createdAt: `2026-11-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
          title: `批量标题 ${index}`,
          messages: [
            { role: "user", content: `${filler} 批量关键词` },
            { role: "assistant", content: `${filler} 批量答案` },
            { role: "user", content: `${filler} 后续问题` },
          ],
        });
      }

      const result = await executeTool("session_search", { query: "批量关键词", limit: 999 }, root, {
        sessionSearch: { sessionsDir },
      });
      expect(result.ok).toBe(true);
      expect(result.output).toContain("Found 10 session(s)");
      expect(result.output.length).toBeLessThanOrEqual(4_000);
      expect(result.output).toContain("capped");
    } finally {
      await flushSearchIndexWrites();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("decodeCommandOutput", () => {
  /** “中文测试”的 GBK 字节 */
  const gbkChinese = Buffer.from("d6d0cec4b2e2cad4", "hex");

  it("returns empty output as-is", () => {
    expect(decodeCommandOutput(Buffer.alloc(0), "gb18030")).toBe("");
  });

  it("keeps valid UTF-8 untouched", () => {
    const text = "UTF8 中文测试";
    expect(decodeCommandOutput(Buffer.from(text, "utf8"), "gb18030")).toBe(text);
  });

  it("falls back to the OEM code page for legacy bytes", () => {
    expect(decodeCommandOutput(gbkChinese, "gb18030")).toBe("中文测试");
    expect(decodeCommandOutput(gbkChinese)).toContain("\uFFFD");
  });

  it("decodes mixed UTF-8 and legacy lines independently", () => {
    const mixed = Buffer.concat([
      Buffer.from("UTF8 中文\r\n", "utf8"),
      gbkChinese,
      Buffer.from("\n"),
    ]);
    const output = decodeCommandOutput(mixed, "gb18030");
    expect(output).toContain("UTF8 中文");
    expect(output).toContain("中文测试");
  });

  it("keeps CR-only progress lines readable", () => {
    const output = decodeCommandOutput(
      Buffer.concat([gbkChinese, Buffer.from("\r"), gbkChinese]),
      "gb18030",
    );
    expect(output).toBe("中文测试\r中文测试");
  });

  it("drops an incomplete trailing character instead of poisoning the whole buffer", () => {
    const full = Buffer.from("前缀 中文", "utf8");
    const cut = full.subarray(0, full.length - 1);
    const output = decodeCommandOutput(cut, "gb18030");
    expect(output).toBe("前缀 中");
    expect(output).not.toContain("\uFFFD");
  });

  it("decodes pure ASCII without a fallback", () => {
    expect(decodeCommandOutput(Buffer.from("plain ascii\n", "latin1"))).toBe("plain ascii\n");
  });
});
