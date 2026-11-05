/**
 * 工具行 diff：只用于聊天里的「修改文件」展开体，不追求 git 级精度。
 *
 * 先剥掉公共前后缀，中间段用 LCS（单元格超限时退化为整段删+加）。
 * 输出行号按原始文本计，方便和 read_file 的行号对上。
 */

export type DiffRowKind = "ctx" | "add" | "del" | "meta" | "hunk";

export type DiffRow = {
  kind: DiffRowKind;
  text: string;
  oldNo?: number;
  newNo?: number;
};

export type LineDiff = {
  rows: DiffRow[];
  added: number;
  removed: number;
  /** 行数超过展示上限，rows 只保留前 MAX_ROWS 行 */
  truncated: boolean;
};

/** 聊天里一次最多画这么多行：再长的改动让用户去右侧看文件 */
const MAX_ROWS = 600;
/** LCS 单元格上限：约 6MB 的 Uint32；超过就直接整段删+加 */
const MAX_LCS_CELLS = 1_500_000;

function normalizeLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (!normalized) return [];
  const lines = normalized.split("\n");
  // 末尾换行不单独算一行
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

type Op = "eq" | "del" | "ins";

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  // dp[i, j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = i * width;
    const next = (i + 1) * width;
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[row + j] =
        a[i] === b[j]
          ? dp[next + j + 1] + 1
          : Math.max(dp[next + j], dp[row + j + 1]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push("eq");
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push("del");
      i += 1;
    } else {
      ops.push("ins");
      j += 1;
    }
  }
  while (i < n) {
    ops.push("del");
    i += 1;
  }
  while (j < m) {
    ops.push("ins");
    j += 1;
  }
  return ops;
}

export function diffLines(before: string, after: string): LineDiff {
  const oldLines = normalizeLines(before);
  const newLines = normalizeLines(after);

  const maxCommon = Math.min(oldLines.length, newLines.length);
  let prefix = 0;
  while (prefix < maxCommon && oldLines[prefix] === newLines[prefix]) prefix += 1;
  const maxSuffix = maxCommon - prefix;
  let suffix = 0;
  while (
    suffix < maxSuffix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
  const newMid = newLines.slice(prefix, newLines.length - suffix);

  const rows: DiffRow[] = [];
  for (let index = 0; index < prefix; index += 1) {
    rows.push({ kind: "ctx", text: oldLines[index], oldNo: index + 1, newNo: index + 1 });
  }

  let oldNo = prefix + 1;
  let newNo = prefix + 1;
  let added = 0;
  let removed = 0;

  if (oldMid.length && newMid.length && oldMid.length * newMid.length <= MAX_LCS_CELLS) {
    const ops = lcsOps(oldMid, newMid);
    let oldIndex = 0;
    let newIndex = 0;
    for (const op of ops) {
      if (op === "eq") {
        rows.push({
          kind: "ctx",
          text: oldMid[oldIndex],
          oldNo: prefix + oldIndex + 1,
          newNo: prefix + newIndex + 1,
        });
        oldIndex += 1;
        newIndex += 1;
      } else if (op === "del") {
        rows.push({ kind: "del", text: oldMid[oldIndex], oldNo: oldNo + oldIndex });
        removed += 1;
        oldIndex += 1;
      } else {
        rows.push({ kind: "add", text: newMid[newIndex], newNo: newNo + newIndex });
        added += 1;
        newIndex += 1;
      }
    }
    oldNo = prefix + oldMid.length + 1;
    newNo = prefix + newMid.length + 1;
  } else {
    for (const line of oldMid) {
      rows.push({ kind: "del", text: line, oldNo });
      oldNo += 1;
      removed += 1;
    }
    for (const line of newMid) {
      rows.push({ kind: "add", text: line, newNo });
      newNo += 1;
      added += 1;
    }
  }

  for (let index = 0; index < suffix; index += 1) {
    rows.push({
      kind: "ctx",
      text: newLines[newLines.length - suffix + index],
      oldNo: oldNo + index,
      newNo: newNo + index,
    });
  }

  const truncated = rows.length > MAX_ROWS;
  return {
    rows: truncated ? rows.slice(0, MAX_ROWS) : rows,
    added,
    removed,
    truncated,
  };
}
