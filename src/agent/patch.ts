import { promises as fs } from "node:fs";
import { writeTextAtomic } from "./atomic-json.js";
import { resolveToolPath } from "./paths.js";

/**
 * Codex 风格的补丁：*** Begin Patch / *** Update File / *** Add File / *** Delete File。
 * 先整体解析并把所有 hunk 应用到内存，全部成功后才写盘；任何一处上下文不匹配
 * 都不会产生半成品文件。行尾（CRLF/LF）按目标文件原样保留。
 */
export type PatchKind = "update" | "add" | "delete";

export type PatchOperation = {
  kind: PatchKind;
  path: string;
  hunks: Array<{ oldLines: string[]; newLines: string[] }>;
  addedLines: string[];
};

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

export function parsePatch(text: string): PatchOperation[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const operations: PatchOperation[] = [];
  let index = 0;
  let started = false;
  let current: PatchOperation | null = null;
  let hunk: { oldLines: string[]; newLines: string[] } | null = null;

  const finishHunk = () => {
    if (current && hunk) {
      current.hunks.push(hunk);
      hunk = null;
    }
  };
  const finishFile = () => {
    finishHunk();
    if (current) {
      if (current.kind === "update" && current.hunks.length === 0) {
        throw new PatchError(`${current.path}: update has no hunks`);
      }
      operations.push(current);
      current = null;
    }
  };

  for (; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trimEnd();
    if (trimmed === "*** Begin Patch") {
      if (started) throw new PatchError("nested *** Begin Patch");
      started = true;
      continue;
    }
    if (trimmed === "*** End Patch") {
      finishFile();
      break;
    }
    if (trimmed.startsWith("*** Update File: ")) {
      finishFile();
      current = {
        kind: "update",
        path: trimmed.slice("*** Update File: ".length).trim(),
        hunks: [],
        addedLines: [],
      };
      continue;
    }
    if (trimmed.startsWith("*** Add File: ")) {
      finishFile();
      current = {
        kind: "add",
        path: trimmed.slice("*** Add File: ".length).trim(),
        hunks: [],
        addedLines: [],
      };
      continue;
    }
    if (trimmed.startsWith("*** Delete File: ")) {
      finishFile();
      current = {
        kind: "delete",
        path: trimmed.slice("*** Delete File: ".length).trim(),
        hunks: [],
        addedLines: [],
      };
      continue;
    }
    if (!current) {
      if (trimmed === "") continue;
      throw new PatchError(`unexpected line outside a file section: ${trimmed.slice(0, 80)}`);
    }
    if (current.kind === "add") {
      if (line.startsWith("+")) current.addedLines.push(line.slice(1));
      else if (trimmed === "") continue;
      else throw new PatchError(`${current.path}: add lines must start with "+"`);
      continue;
    }
    if (current.kind === "delete") {
      if (trimmed === "") continue;
      throw new PatchError(`${current.path}: delete sections cannot contain hunks`);
    }
    if (trimmed.startsWith("@@")) {
      finishHunk();
      hunk = { oldLines: [], newLines: [] };
      continue;
    }
    if (!hunk) {
      if (trimmed === "") continue;
      throw new PatchError(`${current.path}: hunk lines must follow an "@@" header`);
    }
    if (line.startsWith("+")) {
      hunk.newLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      hunk.oldLines.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      hunk.oldLines.push(line.slice(1));
      hunk.newLines.push(line.slice(1));
    } else if (trimmed === "") {
      hunk.oldLines.push("");
      hunk.newLines.push("");
    } else {
      // 宽松处理：没有前缀的行按上下文行对待
      hunk.oldLines.push(line);
      hunk.newLines.push(line);
    }
  }

  if (!started) throw new PatchError("missing *** Begin Patch");
  finishFile();
  if (!operations.length) throw new PatchError("patch contains no file operations");
  return operations;
}

/** writablePaths 用：补丁涉及的所有目标路径（不做解析，越界在执行阶段拒绝）。 */
export function patchPaths(text: string): string[] {
  try {
    return parsePatch(text).map((operation) => operation.path);
  } catch {
    return [];
  }
}

function linesOf(text: string): { lines: string[]; eol: string; trailingNewline: boolean } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const normalized = text.replace(/\r\n/g, "\n");
  const trailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (trailingNewline) lines.pop();
  return { lines, eol, trailingNewline };
}

/**
 * 上下文匹配的三级放宽（对齐 Codex 的 seek_sequence）：精确 → 忽略行尾空白 →
 * 忽略首尾空白。模型抄上下文时最容易多带/少带缩进与行尾空格，为这种事让整轮
 * 补丁失败、再花一整轮重新思考，代价远大于"宽松一点"的风险。
 * 三级都失败才算不匹配 —— 真正的错位置不会因为 trim 就撞上。
 */
const CONTEXT_MATCHERS: ReadonlyArray<(actual: string, expected: string) => boolean> = [
  (actual, expected) => actual === expected,
  (actual, expected) => actual.replace(/\s+$/, "") === expected.replace(/\s+$/, ""),
  (actual, expected) => actual.trim() === expected.trim(),
];

/** 在 [from, ∞) 里找第一个窗口；返回起点，找不到返回 -1。 */
function seekContext(working: string[], oldLines: string[], from: number): number {
  for (const matches of CONTEXT_MATCHERS) {
    for (let start = from; start + oldLines.length <= working.length; start += 1) {
      let hit = true;
      for (let offset = 0; offset < oldLines.length; offset += 1) {
        if (!matches(working[start + offset], oldLines[offset])) {
          hit = false;
          break;
        }
      }
      if (hit) return start;
    }
  }
  return -1;
}

/** 失败时的"最近似位置"：首行内容（忽略空白）出现在哪，帮模型判断是抄错了还是改错了文件。 */
function nearestContextLine(working: string[], oldLines: string[], from: number): number | undefined {
  const first = oldLines[0]?.trim();
  if (!first) return undefined;
  for (let index = from; index < working.length; index += 1) {
    if (working[index].trim() === first) return index + 1;
  }
  return undefined;
}

function applyHunks(
  path: string,
  before: string,
  hunks: Array<{ oldLines: string[]; newLines: string[] }>,
): string {
  const { lines, eol, trailingNewline } = linesOf(before);
  let working = [...lines];
  let cursor = 0;
  for (const [hunkIndex, hunk] of hunks.entries()) {
    if (!hunk.oldLines.length) {
      throw new PatchError(`${path}: hunk ${hunkIndex + 1} has no context or removed lines`);
    }
    const found = seekContext(working, hunk.oldLines, cursor);
    if (found < 0) {
      const near = nearestContextLine(working, hunk.oldLines, cursor);
      throw new PatchError(
        `${path}: hunk ${hunkIndex + 1} does not match the current file` +
          `${near === undefined ? "" : ` (closest context at line ${near})`}. Re-read the file and regenerate the patch.`,
      );
    }
    working = [
      ...working.slice(0, found),
      ...hunk.newLines,
      ...working.slice(found + hunk.oldLines.length),
    ];
    cursor = found + hunk.newLines.length;
  }
  return `${working.join(eol)}${trailingNewline ? eol : ""}`;
}

export type PatchResult = {
  changed: string[];
  added: string[];
  deleted: string[];
};

export type PlannedPatchFile = {
  target: string;
  file: string;
  kind: PatchKind;
  before: string | null;
  after: string | null;
};

/** 解析 + 预校验 + 在内存中应用；供 applyPatch 与审批预览共用（不写盘）。 */
export async function planPatch(
  workspace: string,
  patchText: string,
  options: { allowOutsideWorkspace?: boolean } = {},
): Promise<PlannedPatchFile[]> {
  const operations = parsePatch(patchText);
  const allowOutside = options.allowOutsideWorkspace ?? false;
  const planned: PlannedPatchFile[] = [];

  for (const operation of operations) {
    const file = await resolveToolPath(workspace, operation.path, allowOutside);
    const stat = await fs.lstat(file).catch(() => null);
    if (stat?.isDirectory()) {
      throw new PatchError(`${operation.path} is a directory; patches only apply to files.`);
    }
    const before =
      stat?.isFile() || stat?.isSymbolicLink()
        ? await fs.readFile(file, "utf8").catch(() => null)
        : null;

    if (operation.kind === "add") {
      if (stat) throw new PatchError(`${operation.path} already exists.`);
      planned.push({
        target: operation.path,
        file,
        kind: "add",
        before: null,
        after: `${operation.addedLines.join("\n")}\n`,
      });
      continue;
    }
    if (before === null) throw new PatchError(`${operation.path} does not exist.`);
    if (operation.kind === "delete") {
      planned.push({ target: operation.path, file, kind: "delete", before, after: null });
      continue;
    }
    planned.push({
      target: operation.path,
      file,
      kind: "update",
      before,
      after: applyHunks(operation.path, before, operation.hunks),
    });
  }
  return planned;
}

/**
 * 解析 + 预校验 + 全部写盘。路径解析走 resolveToolPath，越界与目录目标直接拒绝。
 */
export async function applyPatch(
  workspace: string,
  patchText: string,
  options: { allowOutsideWorkspace?: boolean } = {},
): Promise<PatchResult> {
  const planned = await planPatch(workspace, patchText, options);

  // 预校验全部通过后才落盘
  for (const item of planned) {
    if (item.kind === "delete") await fs.unlink(item.file);
    else await writeTextAtomic(item.file, item.after ?? "");
  }

  return {
    changed: planned.filter((item) => item.kind === "update").map((item) => item.target),
    added: planned.filter((item) => item.kind === "add").map((item) => item.target),
    deleted: planned.filter((item) => item.kind === "delete").map((item) => item.target),
  };
}
