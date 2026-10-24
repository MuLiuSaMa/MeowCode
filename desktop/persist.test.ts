import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { readJsonWithBackup, writeJsonAtomic } = require("./persist.cjs") as {
  readJsonWithBackup: (filePath: string, fallback: unknown) => unknown;
  writeJsonAtomic: (
    filePath: string,
    value: unknown,
    options?: { pretty?: boolean },
  ) => void;
};

describe("desktop persist helpers", () => {
  it("writes atomically and keeps the previous valid file as .bak", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-persist-"));
    const filePath = path.join(dir, "settings.json");
    writeJsonAtomic(filePath, { version: 1, value: "first" });
    writeJsonAtomic(filePath, { version: 1, value: "second" });

    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ version: 1, value: "second" });
    expect(JSON.parse(await readFile(`${filePath}.bak`, "utf8"))).toEqual({
      version: 1,
      value: "first",
    });
  });

  it("moves a corrupt file aside and falls back to .bak", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-persist-"));
    const filePath = path.join(dir, "settings.json");
    await writeFile(`${filePath}.bak`, JSON.stringify({ value: "backup" }), "utf8");
    await writeFile(filePath, "{broken", "utf8");

    expect(readJsonWithBackup(filePath, { value: "fallback" })).toEqual({ value: "backup" });
    const names = await readdir(dir);
    expect(names.some((name) => name.startsWith("settings.json.corrupt-"))).toBe(true);
    await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
