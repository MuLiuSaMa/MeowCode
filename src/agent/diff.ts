import path from "node:path";
import { applyTextEdit, readTextFile, shapeForWrite, withBom } from "./edit-content.js";
import { readMultiEditGroups } from "./multi-edit.js";
import { displayPath, resolveToolPath } from "./paths.js";
import { planPatch } from "./patch.js";

const MAX_DIFF_CHARS = 20_000;
/** DP 表的单元格上限：超过后只给行数摘要，避免大文件卡死 agent server */
const MAX_DIFF_CELLS = 4_000_000;

type DiffLine = { text: string; marker: " " | "-" | "+" };

/** 审批/审阅只需要改动附近的上下文：整文件上下文会被 MAX_DIFF_CHARS 截成噪音。 */
const DIFF_CONTEXT_LINES = 3;

function pushLeadingContext(result: DiffLine[], lines: string[], upto: number): void {
  const hidden = upto - DIFF_CONTEXT_LINES;
  if (hidden > 0) {
    result.push({ text: `... ${hidden} unchanged lines ...`, marker: " " });
    for (let index = hidden; index < upto; index += 1) result.push({ text: lines[index], marker: " " });
    return;
  }
  for (let index = 0; index < upto; index += 1) result.push({ text: lines[index], marker: " " });
}

function pushTrailingContext(result: DiffLine[], lines: string[], from: number): void {
  const count = lines.length - from;
  const visible = Math.min(count, DIFF_CONTEXT_LINES);
  for (let index = from; index < from + visible; index += 1) result.push({ text: lines[index], marker: " " });
  if (count > visible) result.push({ text: `... ${count - visible} unchanged lines ...`, marker: " " });
}

function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function diffLines(before: string, after: string): DiffLine[] {
  const left = splitLines(before);
  const right = splitLines(after);

  let start = 0;
  while (
    start < left.length &&
    start < right.length &&
    left[start] === right[start]
  ) {
    start += 1;
  }
  let endLeft = left.length;
  let endRight = right.length;
  while (
    endLeft > start &&
    endRight > start &&
    left[endLeft - 1] === right[endRight - 1]
  ) {
    endLeft -= 1;
    endRight -= 1;
  }

  const beforeMiddle = left.slice(start, endLeft);
  const afterMiddle = right.slice(start, endRight);

  // 超大改动不构建 O(n·m) 表：审批时给行数摘要即可，详情看文件本身
  if (beforeMiddle.length * afterMiddle.length > MAX_DIFF_CELLS) {
    const coarse: DiffLine[] = [];
    pushLeadingContext(coarse, left, start);
    coarse.push({
      text: `... [diff omitted: ${beforeMiddle.length} lines removed, ${afterMiddle.length} lines added]`,
      marker: "-",
    });
    pushTrailingContext(coarse, left, endLeft);
    return coarse;
  }

  const rows = beforeMiddle.length + 1;
  const columns = afterMiddle.length + 1;
  const table: number[][] = Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => 0),
  );
  for (let row = rows - 2; row >= 0; row -= 1) {
    for (let column = columns - 2; column >= 0; column -= 1) {
      table[row][column] =
        beforeMiddle[row] === afterMiddle[column]
          ? table[row + 1][column + 1] + 1
          : Math.max(table[row + 1][column], table[row][column + 1]);
    }
  }

  const result: DiffLine[] = [];
  pushLeadingContext(result, left, start);

  let row = 0;
  let column = 0;
  while (row < beforeMiddle.length && column < afterMiddle.length) {
    if (beforeMiddle[row] === afterMiddle[column]) {
      result.push({ text: beforeMiddle[row], marker: " " });
      row += 1;
      column += 1;
      continue;
    }
    if (table[row + 1][column] >= table[row][column + 1]) {
      result.push({ text: beforeMiddle[row], marker: "-" });
      row += 1;
    } else {
      result.push({ text: afterMiddle[column], marker: "+" });
      column += 1;
    }
  }
  while (row < beforeMiddle.length) {
    result.push({ text: beforeMiddle[row], marker: "-" });
    row += 1;
  }
  while (column < afterMiddle.length) {
    result.push({ text: afterMiddle[column], marker: "+" });
    column += 1;
  }
  pushTrailingContext(result, left, endLeft);
  return result;
}

/** 增删行数（回合末「已编辑 N 个文件」与审阅面板共用同一口径）。 */
export type DiffStats = { added: number; removed: number };

/**
 * 统计统一 diff 的增删行数：只数 `+ ` / `- ` 正文行，
 * 跳过 `---` / `+++` 文件头、`@@` 段头与截断提示行。
 */
export function countDiffStats(diff: string): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+ ")) added += 1;
    else if (line.startsWith("- ")) removed += 1;
  }
  return { added, removed };
}

/**
 * 生成统一 diff 文本（before/after 内容对比）。
 * 供审批预览与「审阅」会话记录共用；超长时截断（MAX_DIFF_CHARS）。
 */
export function renderDiff(target: string, before: string, after: string): string | undefined {
  if (before === after) return undefined;
  const lines = diffLines(before, after);
  const output = [
    before ? `--- a/${target}` : "--- /dev/null",
    `+++ b/${target}`,
    "@@",
    ...lines.map((line) => `${line.marker} ${line.text}`),
    ...(after.endsWith("\n") ? [] : ["\\ No newline at end of file"]),
  ].join("\n");
  if (output.length <= MAX_DIFF_CHARS) return output;
  return `${output.slice(0, MAX_DIFF_CHARS)}\n... [diff truncated]`;
}

/**
 * 编辑回执用的紧凑片段：只给改动附近的行，让模型看完就知道改对了，
 * 不必再 read_file 复核（一次复核 = 4k token + 一整个往返）。
 */
export function renderChangeSnippet(
  target: string,
  before: string,
  after: string,
  maxLines = 24,
): string | undefined {
  if (before === after) return undefined;
  const lines = diffLines(before, after);
  const shown = lines.slice(0, maxLines);
  const body = shown.map((line) => `${line.marker} ${line.text}`).join("\n");
  const hidden = lines.length - shown.length;
  return [`--- a/${target}`, `+++ b/${target}`, body, ...(hidden > 0 ? [`... [${hidden} more diff lines]`] : [])]
    .filter(Boolean)
    .join("\n");
}

export async function previewWriteDiff(
  workspace: string,
  target: string,
  content: string,
  allowOutsideWorkspace = false,
): Promise<string | undefined> {
  const file = await resolveToolPath(workspace, target, allowOutsideWorkspace);
  const relativePath = displayPath(workspace, file);
  const existing = await readTextFile(file);
  if (!existing.ok && existing.reason !== "missing") return undefined;
  const before = existing.ok ? withBom(existing.file.content, existing.file.bom) : "";
  // 预览必须等于真正落盘的文本：行尾与 BOM 都按现有文件整形
  const after = shapeForWrite(content, existing.ok ? existing.file : undefined);
  return renderDiff(existing.ok ? relativePath : path.basename(relativePath), before, after);
}

type RawEdit = { oldString: string; newString: string; replaceAll?: boolean };

/** 编辑预览与真实执行共用同一个匹配器：否则审批里可能显示「无变化」而实际会改动。 */
async function previewEditsDiff(
  workspace: string,
  target: string,
  edits: RawEdit[],
  allowOutsideWorkspace: boolean,
): Promise<string | undefined> {
  if (!edits.length) return undefined;
  const file = await resolveToolPath(workspace, target, allowOutsideWorkspace);
  const read = await readTextFile(file);
  if (!read.ok) return undefined;
  let content = read.file.content;
  for (const edit of edits) {
    const outcome = applyTextEdit(content, edit.oldString, edit.newString, {
      replaceAll: edit.replaceAll,
    });
    if (!outcome.ok) return undefined;
    content = outcome.content;
  }
  if (content === read.file.content) return undefined;
  return renderDiff(
    displayPath(workspace, file),
    withBom(read.file.content, read.file.bom),
    withBom(content, read.file.bom),
  );
}

export async function previewEditDiff(
  workspace: string,
  target: string,
  oldString: string,
  newString: string,
  allowOutsideWorkspace = false,
  replaceAll = false,
): Promise<string | undefined> {
  return previewEditsDiff(workspace, target, [{ oldString, newString, replaceAll }], allowOutsideWorkspace);
}

/** 跨文件 multi_edit 的审批预览：每个文件一段 diff，顶部给文件数。 */
async function previewMultiEditDiff(
  workspace: string,
  input: unknown,
  allowOutsideWorkspace: boolean,
): Promise<string | undefined> {
  const groups = readMultiEditGroups(input);
  if (typeof groups === "string") return undefined;
  const sections: string[] = [];
  for (const group of groups) {
    const diff = await previewEditsDiff(workspace, group.path, group.edits, allowOutsideWorkspace);
    if (diff) sections.push(diff);
  }
  if (!sections.length) return undefined;
  if (sections.length === 1) return sections[0];
  return [`multi_edit: ${sections.length} files`, ...sections].join("\n\n");
}

export async function previewDiff(
  tool: string,
  input: unknown,
  workspace: string,
  allowOutsideWorkspace = false,
): Promise<string | undefined> {
  const args = (input ?? {}) as Record<string, unknown>;
  if (tool === "write_file") {
    return previewWriteDiff(
      workspace,
      String(args.path ?? ""),
      String(args.content ?? ""),
      allowOutsideWorkspace,
    );
  }
  if (tool === "edit_file") {
    return previewEditDiff(
      workspace,
      String(args.path ?? ""),
      String(args.oldString ?? ""),
      String(args.newString ?? ""),
      allowOutsideWorkspace,
      Boolean(args.replaceAll),
    );
  }
  if (tool === "multi_edit") {
    return previewMultiEditDiff(workspace, input, allowOutsideWorkspace);
  }
  if (tool === "delete_file") {
    const target = String(args.path ?? "").trim();
    if (!target) return undefined;
    const file = await resolveToolPath(workspace, target, allowOutsideWorkspace);
    const read = await readTextFile(file, {}).catch(() => null);
    if (!read?.ok) return `delete ${target}`;
    return renderDiff(target, read.file.content, "");
  }
  if (tool === "move_file") {
    const from = String(args.from ?? "").trim();
    const to = String(args.to ?? "").trim();
    if (!from || !to) return undefined;
    const source = await resolveToolPath(workspace, from, allowOutsideWorkspace);
    const read = await readTextFile(source, {}).catch(() => null);
    if (!read?.ok) return `move ${from} → ${to}`;
    return [
      `move ${from} → ${to}`,
      renderDiff(from, read.file.content, ""),
      renderDiff(to, "", read.file.content),
    ].join("\n");
  }
  if (tool === "apply_patch") {
    try {
      const planned = await planPatch(workspace, String(args.patch ?? ""), {
        allowOutsideWorkspace,
      });
      return planned
        .map((item) => renderDiff(item.target, item.before ?? "", item.after ?? ""))
        .join("\n");
    } catch {
      return undefined;
    }
  }
  return undefined;
}
