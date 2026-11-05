import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { LspManager } from "./manager";

const fakeLsp = fileURLToPath(new URL("./fixtures/fake-lsp.mjs", import.meta.url));
const fakeTsserver = fileURLToPath(
  new URL("./fixtures/fake-tsserver.mjs", import.meta.url),
);
const dirs: string[] = [];

async function workspace(config: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "meowcode-lsp-"));
  dirs.push(dir);
  await mkdir(path.join(dir, ".meowcode"), { recursive: true });
  await writeFile(
    path.join(dir, ".meowcode", "lsp.json"),
    JSON.stringify(config),
    "utf8",
  );
  return dir;
}

afterAll(async () => {
  // taskkill /T 是异步的，Windows 上立刻 rmdir 会 EBUSY
  await new Promise((resolve) => setTimeout(resolve, 300));
  await Promise.all(
    dirs.map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => undefined,
      ),
    ),
  );
});

describe("LspManager", () => {
  it("runs a generic LSP server and refreshes diagnostics via didChange", async () => {
    const root = await workspace({
      servers: {
        fake: {
          command: process.execPath,
          args: [fakeLsp],
          extensions: ["fake"],
          languageId: "plaintext",
        },
      },
    });
    const file = path.join(root, "a.fake");
    await writeFile(file, "BAD\n", "utf8");
    const manager = new LspManager();
    try {
      const first = await manager.diagnose({ cwd: root, files: [file], timeoutMs: 15_000 });
      expect(first.serverNames).toEqual(["fake"]);
      expect(first.unavailable).toBeUndefined();
      expect(first.diagnostics).toEqual([
        {
          file,
          line: 1,
          column: 1,
          severity: "error",
          code: "FAKE1",
          message: "fake semantic error",
          source: "fake",
        },
      ]);

      await writeFile(file, "OK\n", "utf8");
      const second = await manager.diagnose({ cwd: root, files: [file], timeoutMs: 15_000 });
      expect(second.diagnostics).toEqual([]);
    } finally {
      manager.disposeAll();
    }
  });

  it("runs tsserver through the TypeScript adapter", async () => {
    const root = await workspace({ typescript: { serverPath: fakeTsserver } });
    const file = path.join(root, "a.ts");
    await writeFile(file, "BAD\n", "utf8");
    const manager = new LspManager();
    try {
      const first = await manager.diagnose({ cwd: root, files: [file], timeoutMs: 15_000 });
      expect(first.serverNames).toEqual(["typescript"]);
      expect(first.diagnostics[0]).toMatchObject({
        file,
        line: 2,
        column: 3,
        severity: "error",
        code: "TS2322",
      });

      await writeFile(file, "const ok = 1;\n", "utf8");
      const second = await manager.diagnose({ cwd: root, files: [file], timeoutMs: 15_000 });
      expect(second.diagnostics).toEqual([]);
    } finally {
      manager.disposeAll();
    }
  });

  it("degrades when the configured command is missing", async () => {
    const root = await workspace({
      servers: {
        missing: {
          command: "meowcode-no-such-lsp-binary",
          args: [],
          extensions: ["nope"],
        },
      },
    });
    const file = path.join(root, "a.nope");
    await writeFile(file, "x\n", "utf8");
    const manager = new LspManager();
    try {
      const result = await manager.diagnose({ cwd: root, files: [file], timeoutMs: 5_000 });
      expect(result.diagnostics).toEqual([]);
      expect(result.unavailable).toContain("not found");
    } finally {
      manager.disposeAll();
    }
  });
});
