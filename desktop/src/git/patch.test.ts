import { describe, expect, it } from "vitest";
import { parsePatch } from "./patch";

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,4 +1,5 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " }",
  "@@ -20,3 +21,3 @@ export function x() {",
  "-  return 1;",
  "+  return 2;",
  "\\ No newline at end of file",
].join("\n");

describe("parsePatch", () => {
  it("classifies lines and tracks both line numbers", () => {
    const { rows, omitted } = parsePatch(PATCH);
    expect(omitted).toBe(0);
    expect(rows[0]).toMatchObject({ kind: "meta", text: "diff --git a/src/app.ts b/src/app.ts" });
    // 文件头 ---/+++ 不能当成增删行
    expect(rows[2]).toMatchObject({ kind: "meta" });
    expect(rows[3]).toMatchObject({ kind: "meta" });

    const ctx = rows[5];
    expect(ctx).toMatchObject({ kind: "ctx", text: "const a = 1;", oldNo: 1, newNo: 1 });
    const del = rows[6];
    expect(del).toMatchObject({ kind: "del", text: "const b = 2;", oldNo: 2 });
    expect(del.newNo).toBeUndefined();
    const add = rows[7];
    expect(add).toMatchObject({ kind: "add", text: "const b = 3;", newNo: 2 });
    expect(rows[8]).toMatchObject({ kind: "add", text: "const c = 4;", newNo: 3 });
    expect(rows[9]).toMatchObject({ kind: "ctx", oldNo: 3, newNo: 4 });
  });

  it("resets counters on a second hunk", () => {
    const { rows } = parsePatch(PATCH);
    const hunk2 = rows[10];
    expect(hunk2).toMatchObject({ kind: "hunk" });
    expect(rows[11]).toMatchObject({ kind: "del", oldNo: 20 });
    expect(rows[12]).toMatchObject({ kind: "add", newNo: 21 });
    expect(rows[13]).toMatchObject({ kind: "meta", text: "\\ No newline at end of file" });
  });

  it("treats '+++' inside a hunk as an added line", () => {
    const patch = ["@@ -1 +1 @@", "--- a", "+++ b"].join("\n");
    const { rows } = parsePatch(patch);
    // hunk 之后：`-` 是删除、`+` 是新增
    expect(rows[1]).toMatchObject({ kind: "del", text: "-- a" });
    expect(rows[2]).toMatchObject({ kind: "add", text: "++ b" });
  });

  it("handles new/deleted file headers and binary markers", () => {
    const patch = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
      "diff --git a/img.png b/img.png",
      "Binary files a/img.png and b/img.png differ",
    ].join("\n");
    const { rows } = parsePatch(patch);
    expect(rows.at(-1)).toMatchObject({ kind: "meta", text: "Binary files a/img.png and b/img.png differ" });
    expect(rows.filter((row) => row.kind === "add")).toHaveLength(2);
  });

  it("limits the rendered rows", () => {
    const lines = ["@@ -1 +1 @@"];
    for (let index = 0; index < 6_000; index += 1) lines.push("+line");
    const { rows, omitted } = parsePatch(lines.join("\n"));
    expect(rows).toHaveLength(5_000);
    expect(omitted).toBeGreaterThan(0);
  });

  it("returns zero rows for an empty patch", () => {
    expect(parsePatch("")).toEqual({ rows: [], omitted: 0 });
  });
});
