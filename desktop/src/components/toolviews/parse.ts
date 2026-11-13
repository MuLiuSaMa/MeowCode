/**
 * 工具行专属视图的解析层（纯函数）。
 *
 * 这些格式由本仓库服务端工具固定产出（read_file 的 `N: `、grep 的
 * `path:line: text`、ask_user 的 `1. q / → a` 等）。解析失败时视图必须回落
 * 纯文本，不能丢内容；单测钉住每种格式。
 */

export type NumberedLine = { no: number; text: string };
export type NumberedOutput = { lines: NumberedLine[]; notes: string[]; numbered: boolean };

export type GrepMatch = { file: string; line: number; text: string };
export type GrepGroup = { file: string; matches: GrepMatch[] };
export type GrepOutput = { groups: GrepGroup[]; notes: string[]; parsed: boolean };

export type PathListOutput = { paths: string[]; notes: string[] };

export type DirectoryEntry = { kind: "dir" | "file"; name: string };
export type DirectoryOutput = { entries: DirectoryEntry[]; notes: string[] };

export type ReadManySection = { path: string; body: string };

export type WebSearchHit = { title: string; url: string; excerpt?: string };
export type WebSearchOutput = { results: WebSearchHit[]; notes: string[] };

export type WebFetchOutput = { url?: string; status?: number; body: string; truncated: boolean };

export type AskQuestion = { question: string; options: string[]; descriptions?: string[] };

/** 旧记录里模型写过「选项即对象」：有 label 取 label，绝不退化成 [object Object] */
const ASK_OPTION_LABEL_KEYS = ["label", "text", "title", "value", "option", "name"] as const;
const ASK_OPTION_DESC_KEYS = ["description", "detail", "hint", "desc", "note"] as const;

function optionFieldText(
  record: Record<string, unknown>,
  keys: readonly string[],
  limit: number,
): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, limit);
    if (typeof value === "number") return String(value);
  }
  return "";
}

function optionLabel(raw: unknown, limit = 120): string {
  if (typeof raw === "string") return raw.trim().slice(0, limit);
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  return optionFieldText(raw as Record<string, unknown>, ASK_OPTION_LABEL_KEYS, limit);
}

function optionDescription(raw: unknown, limit = 200): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  return optionFieldText(raw as Record<string, unknown>, ASK_OPTION_DESC_KEYS, limit);
}

export type MultiEditInput = {
  path: string;
  edits: Array<{ oldString: string; newString: string; replaceAll: boolean }>;
};

export type PatchHunk = { oldLines: string[]; newLines: string[] };
export type PatchFileDisplay = {
  kind: "update" | "add" | "delete";
  path: string;
  hunks: PatchHunk[];
  addedLines: string[];
};

export type GitStatusGroup = { label: string; entries: string[] };
export type GitStatusOutput = {
  header?: string;
  groups: GitStatusGroup[];
  notes: string[];
  clean: boolean;
};

export type JobListItem = { id: string; status: string; command: string };

export type ToolSearchItem = { name: string; description: string };

const NUMBERED_LINE = /^(\d+): ?(.*)$/;
const GREP_LINE = /^(.*?):(\d+): ?(.*)$/;
const DIRECTORY_LINE = /^(dir|file) (.+)$/;
const WEB_SEARCH_LINE = /^- \[(.+?)\]\(([^)\s]+)\)(?:\s+—\s+(.*))?$/;
const ASK_ANSWER_LINE = /^\s*→\s?(.*)$/;
const TOOL_SEARCH_LINE = /^- ([\w.-]+): (.*)$/;
const JOB_LINE = /^- (\S+) \[([^\]]+)\] (.*)$/;

export function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

export function textArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

export function parseNumberedOutput(text: string): NumberedOutput {
  const lines: NumberedLine[] = [];
  const notes: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = NUMBERED_LINE.exec(line);
    if (match) {
      lines.push({ no: Number(match[1]), text: match[2] });
    } else if (line.trim()) {
      notes.push(line);
    }
  }
  return { lines, notes, numbered: lines.length > 0 };
}

export function parseGrepOutput(text: string): GrepOutput {
  const groups: GrepGroup[] = [];
  const byFile = new Map<string, GrepGroup>();
  const notes: string[] = [];
  let matches = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = GREP_LINE.exec(line);
    if (!match) {
      notes.push(line);
      continue;
    }
    const file = match[1];
    const item: GrepMatch = { file, line: Number(match[2]), text: match[3] };
    let group = byFile.get(file);
    if (!group) {
      group = { file, matches: [] };
      byFile.set(file, group);
      groups.push(group);
    }
    group.matches.push(item);
    matches += 1;
  }
  return { groups, notes, parsed: matches > 0 };
}

export function parsePathList(text: string): PathListOutput {
  const paths: string[] = [];
  const notes: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim();
    if (!value) continue;
    if (value.startsWith("... [") || (value.startsWith("(") && value.endsWith(")"))) {
      notes.push(value);
    } else {
      paths.push(value);
    }
  }
  return { paths, notes };
}

export function parseDirectoryListing(text: string): DirectoryOutput {
  const entries: DirectoryEntry[] = [];
  const notes: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = DIRECTORY_LINE.exec(line);
    if (match) {
      entries.push({ kind: match[1] as "dir" | "file", name: match[2] });
    } else {
      notes.push(line.trim());
    }
  }
  return { entries, notes };
}

export function parseReadManyOutput(text: string): ReadManySection[] {
  const sections: ReadManySection[] = [];
  let current: { path: string; lines: string[] } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const header = /^=== (.+) ===$/.exec(line);
    if (header) {
      if (current) sections.push({ path: current.path, body: current.lines.join("\n").trim() });
      current = { path: header[1], lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) sections.push({ path: current.path, body: current.lines.join("\n").trim() });
  if (!sections.length && text.trim()) {
    sections.push({ path: "", body: text.trim() });
  }
  return sections;
}

export function parseWebSearchOutput(text: string): WebSearchOutput {
  const results: WebSearchHit[] = [];
  const notes: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim();
    if (!value) continue;
    const match = WEB_SEARCH_LINE.exec(value);
    if (match) {
      results.push({
        title: match[1],
        url: match[2],
        ...(match[3]?.trim() ? { excerpt: match[3].trim() } : {}),
      });
      continue;
    }
    if (value.startsWith("External web content follows")) continue;
    if (value.startsWith("Web search results for")) continue;
    notes.push(value);
  }
  return { results, notes };
}

export function parseWebFetchOutput(text: string): WebFetchOutput {
  const lines = text.split(/\r?\n/);
  let url: string | undefined;
  let status: number | undefined;
  let truncated = false;
  const body: string[] = [];
  let headerSeen = false;
  for (const line of lines) {
    if (!headerSeen && line.startsWith("External web content follows")) continue;
    const fetched = /^Fetched: (.+) \(HTTP (\d+)\)$/.exec(line.trim());
    if (!headerSeen && fetched) {
      url = fetched[1];
      status = Number(fetched[2]);
      headerSeen = true;
      continue;
    }
    if (line.trim().startsWith("(Content truncated at ")) {
      truncated = true;
      continue;
    }
    body.push(line);
  }
  return { url, status, body: body.join("\n").trim(), truncated };
}

export function parseAskQuestions(input: unknown): AskQuestion[] {
  const args = asRecord(input);
  const raw = Array.isArray(args.questions) ? args.questions : [];
  return raw.flatMap((item) => {
    const record = asRecord(item);
    const question = typeof record.question === "string" ? record.question.trim() : "";
    if (!question) return [];
    const options: string[] = [];
    const descriptions: string[] = [];
    for (const option of Array.isArray(record.options) ? record.options : []) {
      const label = optionLabel(option);
      if (!label) continue;
      options.push(label);
      descriptions.push(optionDescription(option));
    }
    return [{ question, options, ...(descriptions.some(Boolean) ? { descriptions } : {}) }];
  });
}

/** 回答按题序回填；服务端把未答写成中文占位，这里归一为空串，由 UI 按语言显示 */
export function parseAskAnswers(text: string | undefined): string[] {
  if (!text) return [];
  const answers: string[] = [];
  let current = -1;
  for (const line of text.split(/\r?\n/)) {
    const numbered = /^(\d+)\.\s/.exec(line);
    if (numbered) {
      current = Number(numbered[1]) - 1;
      continue;
    }
    const match = ASK_ANSWER_LINE.exec(line);
    if (match && current >= 0) {
      const answer = match[1].trim();
      // 中占位归一为空串；`[object Object]` 是旧版本把选项对象 String() 后的坏数据，
      // 按「未回答」处理，别把占位符当成用户的回答展示
      answers[current] =
        answer === "（未回答）" || answer === "[object Object]" ? "" : answer;
    }
  }
  return answers;
}

export function parseMultiEditInput(
  input: unknown,
): { groups: MultiEditInput[]; error?: string } {
  const args = asRecord(input);
  const fallback = textArg(args, "path").trim();
  const raw = Array.isArray(args.edits) ? args.edits : [];
  if (!raw.length) return { groups: [], error: "edits must be a non-empty array" };
  const groups: MultiEditInput[] = [];
  const byPath = new Map<string, MultiEditInput>();
  for (const item of raw) {
    const edit = asRecord(item);
    const path = String(edit.path ?? fallback).trim();
    if (!path) return { groups, error: "an edit is missing path" };
    const oldString = String(edit.oldString ?? "");
    if (!oldString) return { groups, error: "an edit is missing oldString" };
    const parsed = {
      oldString,
      newString: String(edit.newString ?? ""),
      replaceAll: edit.replaceAll === true,
    };
    const existing = byPath.get(path);
    if (existing) {
      existing.edits.push(parsed);
    } else {
      const group = { path, edits: [parsed] };
      byPath.set(path, group);
      groups.push(group);
    }
  }
  return { groups };
}

/** Codex 补丁格式的只读解析（镜像 src/agent/patch.ts，失败时保留已解析部分） */
export function parseCodexPatch(text: string): {
  operations: PatchFileDisplay[];
  error?: string;
} {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const operations: PatchFileDisplay[] = [];
  const finishHunk = () => {
    if (current && hunk) {
      current.hunks.push(hunk);
      hunk = null;
    }
  };
  let current: PatchFileDisplay | null = null;
  let hunk: PatchHunk | null = null;
  let started = false;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed === "*** Begin Patch") {
      started = true;
      continue;
    }
    if (trimmed === "*** End Patch") {
      finishHunk();
      if (current) operations.push(current);
      current = null;
      return { operations };
    }
    const update = /^\*\*\* Update File: (.+)$/.exec(trimmed);
    const add = /^\*\*\* Add File: (.+)$/.exec(trimmed);
    const del = /^\*\*\* Delete File: (.+)$/.exec(trimmed);
    if (update || add || del) {
      finishHunk();
      if (current) operations.push(current);
      current = {
        kind: update ? "update" : add ? "add" : "delete",
        path: (update ?? add ?? del)![1].trim(),
        hunks: [],
        addedLines: [],
      };
      continue;
    }
    if (!current) continue;
    if (current.kind === "add") {
      if (line.startsWith("+")) current.addedLines.push(line.slice(1));
      continue;
    }
    if (current.kind === "delete") continue;
    if (trimmed.startsWith("@@")) {
      finishHunk();
      hunk = { oldLines: [], newLines: [] };
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith("+")) {
      hunk.newLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      hunk.oldLines.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      hunk.oldLines.push(line.slice(1));
      hunk.newLines.push(line.slice(1));
    } else if (!trimmed) {
      hunk.oldLines.push("");
      hunk.newLines.push("");
    } else {
      hunk.oldLines.push(line);
      hunk.newLines.push(line);
    }
  }
  finishHunk();
  if (current) operations.push(current);
  if (!started) return { operations: [], error: "missing *** Begin Patch" };
  return { operations };
}

export function parseGitStatusOutput(text: string): GitStatusOutput {
  const groups: GitStatusGroup[] = [];
  const notes: string[] = [];
  let header: string | undefined;
  let clean = false;
  let current: GitStatusGroup | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith("repo ")) {
      header = line.slice("repo ".length).trim();
      continue;
    }
    const group = /^(staged|unstaged|conflicted) \(\d+\):$/.exec(line.trim());
    if (group) {
      current = { label: group[1], entries: [] };
      groups.push(current);
      continue;
    }
    if (line.trim() === "working tree clean") {
      clean = true;
      continue;
    }
    if (current && /^\s{2}/.test(line)) {
      current.entries.push(line.trim());
    } else {
      notes.push(line.trim());
    }
  }
  return { header, groups, notes, clean };
}

export function parseGitDiffOutput(text: string): {
  patch: string;
  added?: number;
  removed?: number;
  truncated: boolean;
} {
  const lines = text.split(/\r?\n/);
  let added: number | undefined;
  let removed: number | undefined;
  let truncated = false;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].trim()) continue;
    const match = /^\[\+(\d+) -(\d+)(.*)\]$/.exec(lines[index].trim());
    if (match) {
      added = Number(match[1]);
      removed = Number(match[2]);
      truncated = match[3].includes("truncated");
      lines.splice(index, 1);
    }
    break;
  }
  return { patch: lines.join("\n").trimEnd(), added, removed, truncated };
}

export function parseJobList(text: string): JobListItem[] {
  return text
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = JOB_LINE.exec(line.trim());
      return match ? [{ id: match[1], status: match[2], command: match[3] }] : [];
    });
}

export function parseToolSearchOutput(text: string): {
  header?: string;
  items: ToolSearchItem[];
  notes: string[];
} {
  const items: ToolSearchItem[] = [];
  const notes: string[] = [];
  let header: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim();
    if (!value) continue;
    const match = TOOL_SEARCH_LINE.exec(value);
    if (match) {
      items.push({ name: match[1], description: match[2] });
      continue;
    }
    if (!items.length) header = value;
    else notes.push(value);
  }
  return { header, items, notes };
}

/** 字面量命中切段（grep 高亮用；只做大小写不敏感的 indexOf，不解释正则） */
export function splitLiteralHighlight(
  text: string,
  needle: string,
  caseSensitive = false,
): Array<{ text: string; hit: boolean }> {
  if (!needle) return [{ text, hit: false }];
  const haystack = caseSensitive ? text : text.toLowerCase();
  const target = caseSensitive ? needle : needle.toLowerCase();
  if (!target) return [{ text, hit: false }];
  const segments: Array<{ text: string; hit: boolean }> = [];
  let cursor = 0;
  while (cursor <= text.length) {
    const index = haystack.indexOf(target, cursor);
    if (index < 0) break;
    if (index > cursor) segments.push({ text: text.slice(cursor, index), hit: false });
    segments.push({ text: text.slice(index, index + needle.length), hit: true });
    cursor = index + needle.length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false });
  return segments.length ? segments : [{ text, hit: false }];
}
