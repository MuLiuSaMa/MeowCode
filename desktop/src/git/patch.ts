/**
 * git patch 解析（纯逻辑，便于单测）。
 *
 * 注意与自研 diff（ReviewTab 的 `"+ "` 带空格前缀）不同：git patch 的行是
 * `+content`（无空格）。所以这里必须自己解析，不能复用 diffLineKind。
 * `+++`/`---`/`@@`/`\`/`diff --git`/`index` 等归 meta 且不推进行号。
 */

export type PatchRow = {
  kind: "meta" | "hunk" | "add" | "del" | "ctx";
  text: string;
  /** 旧文件行号（+ / hunk / meta 为 undefined） */
  oldNo?: number;
  /** 新文件行号 */
  newNo?: number;
};

/** 渲染上限：再大的 patch 浏览器也滚不动，超出提示用户去看文件 */
const MAX_ROWS = 5_000;

/**
 * 解析 git patch。
 *
 * 注意与自研 diff（ReviewTab 的 `"+ "` 带空格前缀）不同：git patch 的行是
 * `+content`（无空格）。所以这里必须自己解析，不能复用 diffLineKind。
 * `+++`/`---`/`@@`/`\`/`diff --git`/`index` 等归 meta 且不推进行号。
 */
export function parsePatch(patch: string): { rows: PatchRow[]; omitted: number } {
  const rows: PatchRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  const lines = patch.split("\n");
  for (const line of lines) {
    if (line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("new file mode") ||
        line.startsWith("deleted file mode") || line.startsWith("old mode") || line.startsWith("new mode") ||
        line.startsWith("similarity index") || line.startsWith("rename from") || line.startsWith("rename to") ||
        line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      rows.push({ kind: "meta", text: line });
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNo = match ? Number(match[1]) : oldNo;
      newNo = match ? Number(match[2]) : newNo;
      rows.push({ kind: "hunk", text: line });
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      // hunk 之前的 --- / +++ 是文件头，不是增删行；空行（末尾换行）不占行
      if (line) rows.push({ kind: "meta", text: line });
      continue;
    }
    if (line.startsWith("\\")) {
      rows.push({ kind: "meta", text: line });
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "add", text: line.slice(1), newNo });
      newNo += 1;
      continue;
    }
    if (line.startsWith("-")) {
      rows.push({ kind: "del", text: line.slice(1), oldNo });
      oldNo += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      rows.push({ kind: "ctx", text: line.slice(1), oldNo, newNo });
      oldNo += 1;
      newNo += 1;
      continue;
    }
    if (!line) continue;
    rows.push({ kind: "meta", text: line });
  }
  if (rows.length <= MAX_ROWS) return { rows, omitted: 0 };
  return { rows: rows.slice(0, MAX_ROWS), omitted: rows.length - MAX_ROWS };
}

