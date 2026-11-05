import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executeTool } from "./tools.js";

async function workspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "meowcode-fileops-"));
}

describe("delete_file / move_file / apply_patch tools", () => {
  it("delete_file 删除文件但拒绝目录", async () => {
    const dir = await workspace();
    await writeFile(path.join(dir, "a.txt"), "x");
    await mkdir(path.join(dir, "sub"));
    expect((await executeTool("delete_file", { path: "a.txt" }, dir)).ok).toBe(true);
    await expect(readFile(path.join(dir, "a.txt"))).rejects.toThrow();
    const refused = await executeTool("delete_file", { path: "sub" }, dir);
    expect(refused.ok).toBe(false);
    expect(refused.output).toContain("directories are not supported");
  });

  it("move_file 保留内容、拒绝覆盖，overwrite=true 时替换", async () => {
    const dir = await workspace();
    await writeFile(path.join(dir, "a.txt"), "A\r\nB\n");
    await writeFile(path.join(dir, "b.txt"), "old");
    const refused = await executeTool("move_file", { from: "a.txt", to: "b.txt" }, dir);
    expect(refused.ok).toBe(false);
    expect(await readFile(path.join(dir, "b.txt"), "utf8")).toBe("old");

    expect(
      (await executeTool("move_file", { from: "a.txt", to: "b.txt", overwrite: true }, dir)).ok,
    ).toBe(true);
    expect(await readFile(path.join(dir, "b.txt"), "utf8")).toBe("A\r\nB\n");
    await expect(readFile(path.join(dir, "a.txt"))).rejects.toThrow();
  });

  it("move_file 自动创建目标目录", async () => {
    const dir = await workspace();
    await writeFile(path.join(dir, "a.txt"), "x");
    expect((await executeTool("move_file", { from: "a.txt", to: "deep/b.txt" }, dir)).ok).toBe(
      true,
    );
    expect(await readFile(path.join(dir, "deep/b.txt"), "utf8")).toBe("x");
  });

  it("apply_patch 通过工具执行并返回变更清单", async () => {
    const dir = await workspace();
    await writeFile(path.join(dir, "a.txt"), "one\ntwo\n");
    const patch = `*** Begin Patch
*** Update File: a.txt
@@
 one
-two
+three
*** End Patch
`;
    const result = await executeTool("apply_patch", { patch }, dir);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("updated a.txt");
    expect(await readFile(path.join(dir, "a.txt"), "utf8")).toBe("one\nthree\n");
  });
});
