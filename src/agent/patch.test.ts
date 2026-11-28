import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PatchError, applyPatch, parsePatch, patchPaths } from "./patch.js";

async function workspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "meowcode-patch-"));
}

const UPDATE_PATCH = `*** Begin Patch
*** Update File: a.txt
@@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;
*** End Patch
`;

describe("apply_patch", () => {
  it("按上下文应用 hunk，并保留 CRLF", async () => {
    const dir = await workspace();
    await writeFile(path.join(dir, "a.txt"), "const a = 1;\r\nconst b = 2;\r\nconst c = 4;\r\n");
    const result = await applyPatch(dir, UPDATE_PATCH);
    expect(result.changed).toEqual(["a.txt"]);
    const content = await readFile(path.join(dir, "a.txt"), "utf8");
    expect(content).toBe("const a = 1;\r\nconst b = 3;\r\nconst c = 4;\r\n");
  });

  it("新增与删除文件", async () => {
    const dir = await workspace();
    await writeFile(path.join(dir, "gone.txt"), "bye\n");
    const patch = `*** Begin Patch
*** Add File: dir/new.txt
+hello
+world
*** Delete File: gone.txt
*** End Patch
`;
    const result = await applyPatch(dir, patch);
    expect(result.added).toEqual(["dir/new.txt"]);
    expect(result.deleted).toEqual(["gone.txt"]);
    expect(await readFile(path.join(dir, "dir/new.txt"), "utf8")).toBe("hello\nworld\n");
  });

  it("上下文不匹配时零写入（多文件也不半成品）", async () => {
    const dir = await workspace();
    await writeFile(path.join(dir, "a.txt"), "alpha\n");
    const patch = `*** Begin Patch
*** Add File: created.txt
+one
*** Update File: a.txt
@@
-does not exist
+replacement
*** End Patch
`;
    await expect(applyPatch(dir, patch)).rejects.toBeInstanceOf(PatchError);
    await expect(readFile(path.join(dir, "created.txt"), "utf8")).rejects.toThrow();
    expect(await readFile(path.join(dir, "a.txt"), "utf8")).toBe("alpha\n");
  });

  it("越界路径拒绝", async () => {
    const dir = await workspace();
    const patch = `*** Begin Patch
*** Add File: ../escape.txt
+x
*** End Patch
`;
    await expect(applyPatch(dir, patch)).rejects.toThrow();
  });

  it("新增已存在的文件报错", async () => {
    const dir = await workspace();
    await writeFile(path.join(dir, "a.txt"), "x\n");
    const patch = `*** Begin Patch
*** Add File: a.txt
+y
*** End Patch
`;
    await expect(applyPatch(dir, patch)).rejects.toThrow(/already exists/);
  });

  it("上下文行尾空格不同也能应用（三级放宽的第一级）", async () => {
    const dir = await workspace();
    await writeFile(path.join(dir, "a.txt"), "const a = 1;   \nconst b = 2;\nconst c = 4;\n");
    const result = await applyPatch(dir, UPDATE_PATCH);
    expect(result.changed).toEqual(["a.txt"]);
    expect(await readFile(path.join(dir, "a.txt"), "utf8")).toContain("const b = 3;");
  });

  it("上下文缩进不同也能应用（三级放宽的第二级）", async () => {
    const dir = await workspace();
    await writeFile(path.join(dir, "a.txt"), "\tconst a = 1;\n\tconst b = 2;\n");
    const patch = `*** Begin Patch
*** Update File: a.txt
@@
 const a = 1;
-const b = 2;
+const b = 3;
*** End Patch
`;
    const result = await applyPatch(dir, patch);
    expect(result.changed).toEqual(["a.txt"]);
    // 替换块以补丁文本为准（与 Codex 一致）：被替换的那几行不带原文缩进
    expect(await readFile(path.join(dir, "a.txt"), "utf8")).toBe("const a = 1;\nconst b = 3;\n");
  });

  it("内容真的不同仍然失败，并指出最近似的行号", async () => {
    const dir = await workspace();
    await writeFile(path.join(dir, "a.txt"), "const a = 1;\nconst b = 2;\n");
    const patch = `*** Begin Patch
*** Update File: a.txt
@@
 const a = 1;
-const b = 99;
+const b = 3;
*** End Patch
`;
    await expect(applyPatch(dir, patch)).rejects.toThrow(/closest context at line 1/);
    expect(await readFile(path.join(dir, "a.txt"), "utf8")).toBe("const a = 1;\nconst b = 2;\n");
  });

  it("parsePatch 拒绝缺少 Begin 的文本，patchPaths 提取目标", () => {
    expect(() => parsePatch("just text")).toThrow(PatchError);
    expect(patchPaths(UPDATE_PATCH)).toEqual(["a.txt"]);
    expect(patchPaths("broken")).toEqual([]);
  });
});
