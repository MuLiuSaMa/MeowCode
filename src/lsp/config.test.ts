import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  findExecutable,
  isTypeScriptFile,
  loadLspConfig,
  resolveTypeScriptServer,
  serverForFile,
} from "./config";

const dirs: string[] = [];

async function workspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "meowcode-lsp-config-"));
  dirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("LSP config", () => {
  it("falls back to built-in servers when the config file is missing", async () => {
    const root = await workspace();
    const config = await loadLspConfig(root);
    expect(config.disabled).toBe(false);
    expect(config.typescript.disabled).toBe(false);
    expect(config.servers.pyright.command).toBe("pyright-langserver");
    expect(config.servers.gopls.extensions).toContain("go");
  });

  it("normalizes a custom server and overrides/removes built-ins", async () => {
    const root = await workspace();
    await mkdir(path.join(root, ".meowcode"), { recursive: true });
    await writeFile(
      path.join(root, ".meowcode", "lsp.json"),
      JSON.stringify({
        disabled: true,
        timeoutMs: 99_000,
        typescript: { disabled: true, serverPath: "C:/ts/tsserver.js" },
        servers: {
          fake: {
            command: process.execPath,
            args: ["fixture.mjs"],
            extensions: [".FAKE"],
            languageId: "plaintext",
          },
          pyright: false,
        },
      }),
    );
    const config = await loadLspConfig(root);
    expect(config.disabled).toBe(true);
    expect(config.timeoutMs).toBe(30_000);
    expect(config.typescript).toEqual({
      disabled: true,
      serverPath: "C:/ts/tsserver.js",
    });
    expect(config.servers.pyright).toBeUndefined();
    expect(config.servers.fake).toMatchObject({
      command: process.execPath,
      args: ["fixture.mjs"],
      extensions: ["fake"],
      languageId: "plaintext",
    });
    expect(serverForFile(config, "a.fake")).toMatchObject({ kind: "server", name: "fake" });
    expect(serverForFile(config, "a.ts")).toBeUndefined();
  });

  it("maps TypeScript files and finds an absolute executable", async () => {
    const root = await workspace();
    const config = await loadLspConfig(root);
    expect(isTypeScriptFile("a.tsx")).toBe(true);
    expect(isTypeScriptFile("a.py")).toBe(false);
    expect(serverForFile(config, "src/a.ts")).toEqual({ kind: "typescript" });
    expect(await findExecutable(process.execPath)).toBe(process.execPath);
  });

  it("finds the workspace TypeScript server", async () => {
    const root = await workspace();
    const bin = path.join(root, "node_modules", "typescript", "lib");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "tsserver.js"), "// fake\n");
    expect(await resolveTypeScriptServer(root)).toBe(path.join(bin, "tsserver.js"));
  });
});
