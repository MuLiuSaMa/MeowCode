import { spawn } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { displayPath, resolveToolPath } from "./paths.js";
import type { ToolResult } from "./types.js";

const MAX_SEARCH_CHARS = 12_000;
const SEARCH_TIMEOUT_MS = 30_000;
const DEFAULT_GLOB_RESULTS = 100;
const DEFAULT_GREP_RESULTS = 100;
const MAX_SEARCH_RESULTS = 500;
const MAX_CONTEXT_LINES = 10;
/** 单条匹配行的展示上限：minified 文件一行可达几十万字符，会把整次搜索预算吃光。 */
const MAX_GREP_LINE_CHARS = 500;

function clipMatchLine(text: string): string {
  if (text.length <= MAX_GREP_LINE_CHARS) return text;
  return `${text.slice(0, MAX_GREP_LINE_CHARS)}…[+${text.length - MAX_GREP_LINE_CHARS} chars]`;
}

const IGNORED_GLOBS = [
  ".git/**",
  ".hg/**",
  ".svn/**",
  ".meowcode/**",
  "node_modules/**",
  "dist/**",
  "build/**",
  "out/**",
  ".venv/**",
  "venv/**",
  "__pycache__/**",
  "target/**",
  ".next/**",
  ".turbo/**",
  ".cache/**",
];

type RipgrepJsonEvent = {
  type?: string;
  data?: {
    path?: { text?: string };
    line_number?: number;
    lines?: { text?: string };
  };
};

type RipgrepRun = {
  code: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
  /** 消费者提前收够结果并终止了 rg：此时退出码不是 0/1，但不能当失败 */
  stoppedEarly: boolean;
};

let ripgrepPathCache: string | null = null;

function binaryName(): string {
  return process.platform === "win32" ? "rg.exe" : "rg";
}

async function resolveRipgrepPath(): Promise<string> {
  const configured = process.env.MEOWCODE_RIPGREP_PATH?.trim();
  if (configured) return configured;

  const resources = process.env.MEOWCODE_RESOURCES_PATH?.trim();
  if (resources) {
    return path.join(resources, "agent-server", "ripgrep", binaryName());
  }

  if (ripgrepPathCache) return ripgrepPathCache;
  try {
    const module = await import("@vscode/ripgrep");
    ripgrepPathCache = module.rgPath;
    return ripgrepPathCache;
  } catch {
    throw new Error(
      "Built-in ripgrep is not available. Set MEOWCODE_RIPGREP_PATH to the rg executable.",
    );
  }
}

function normalizeResults(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), MAX_SEARCH_RESULTS);
}

function truncateSearchOutput(text: string): string {
  if (text.length <= MAX_SEARCH_CHARS) return text;
  return `${text.slice(0, MAX_SEARCH_CHARS)}\n... [truncated ${text.length - MAX_SEARCH_CHARS} characters]`;
}

function ignoredGlobArgs(): string[] {
  return IGNORED_GLOBS.flatMap((glob) => ["--glob", `!${glob}`]);
}

/** code mode（run_code 沙箱）用的结构化 grep 结果；只含 match 事件，不含 context 行。 */
export type GrepMatch = { path: string; line: number; text: string };

/**
 * 结构化 grep：返回 {path, line, text} 数组而不是渲染好的文本。
 * 与 searchGrep 同一套 rg 参数与忽略规则；收满 limit 提前终止 rg。
 * 失败（超时/rg 报错）直接 throw —— 调用方是沙箱桥，错误要进模型可见的执行结果。
 */
export async function grepMatches(
  workspace: string,
  target: string,
  pattern: string,
  options: { fixed?: boolean; caseSensitive?: boolean; maxResults?: number },
  signal?: AbortSignal,
  allowOutsideWorkspace = false,
): Promise<GrepMatch[]> {
  const normalizedPattern = pattern.trim();
  if (!normalizedPattern) return [];
  const absoluteTarget = await resolveToolPath(workspace, target, allowOutsideWorkspace);
  const limit = normalizeResults(options.maxResults, DEFAULT_GREP_RESULTS);
  const args = [
    "--json",
    "--no-messages",
    "--color=never",
    "--no-require-git",
    ...ignoredGlobArgs(),
    ...(options.caseSensitive === false ? ["--ignore-case"] : []),
    ...(options.fixed === true ? ["--fixed-strings"] : []),
    "--",
    normalizedPattern,
    absoluteTarget,
  ];
  const executable = await resolveRipgrepPath();
  const matches: GrepMatch[] = [];
  const run = await spawnRipgrep(executable, args, workspace, signal, (line) => {
    let event: RipgrepJsonEvent;
    try {
      event = JSON.parse(line) as RipgrepJsonEvent;
    } catch {
      return;
    }
    const data = event.data;
    const relativePath = data?.path?.text ? displayPath(workspace, data.path.text) : "";
    if (event.type === "match" && relativePath) {
      matches.push({
        path: relativePath,
        line: data?.line_number ?? 0,
        text: data?.lines?.text?.replace(/\r?\n$/, "") ?? "",
      });
      if (matches.length >= limit) return false;
    }
  });
  if (run.timedOut) throw new Error("Content search timed out.");
  if (run.code !== 0 && run.code !== 1 && !run.stoppedEarly) {
    throw new Error(run.stderr.trim() || "ripgrep failed.");
  }
  return matches;
}

/** 结构化 glob：返回工作区相对路径数组（排序后截到 limit）。失败直接 throw。 */
export async function globPaths(
  workspace: string,
  target: string,
  pattern: string,
  maxResults?: unknown,
  signal?: AbortSignal,
  allowOutsideWorkspace = false,
): Promise<string[]> {
  const normalizedPattern = pattern.trim();
  if (!normalizedPattern) return [];
  const absoluteTarget = await resolveToolPath(workspace, target, allowOutsideWorkspace);
  const limit = normalizeResults(maxResults, DEFAULT_GLOB_RESULTS);
  const executable = await resolveRipgrepPath();
  const run = await spawnRipgrep(
    executable,
    [
      "--files",
      "--no-messages",
      "--color=never",
      "--no-require-git",
      ...ignoredGlobArgs(),
      "--glob",
      normalizedPattern,
      "--",
      absoluteTarget,
    ],
    workspace,
    signal,
  );
  if (run.timedOut) throw new Error("File search timed out.");
  if (run.code !== 0 && run.code !== 1) {
    throw new Error(run.stderr.trim() || "ripgrep failed.");
  }
  return run.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => displayPath(workspace, line))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .slice(0, limit);
}

const MAX_LISTED_FILES = 3_000;

/** 快速打开（Ctrl+P）用：一次列出工作区文件（rg --files，遵守忽略规则）。 */
export async function listWorkspaceFiles(workspace: string): Promise<string[]> {
  const executable = await resolveRipgrepPath();
  const run = await spawnRipgrep(
    executable,
    ["--files", "--no-messages", "--color=never", "--no-require-git", ...ignoredGlobArgs(), "--", workspace],
    workspace,
    undefined,
  );
  if (run.timedOut) throw new Error("File listing timed out.");
  if (run.code !== 0 && run.code !== 1) {
    throw new Error(run.stderr.trim() || "ripgrep failed.");
  }
  return run.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    // 统一 / 分隔：客户端（快开 / 文件页签）按 posix 路径处理
    .map((line) => displayPath(workspace, line).replace(/\\/g, "/"))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .slice(0, MAX_LISTED_FILES);
}

export async function searchGlob(  workspace: string,
  target: string,
  pattern: string,
  maxResults: unknown,
  signal?: AbortSignal,
  allowOutsideWorkspace = false,
): Promise<ToolResult> {
  const normalizedPattern = pattern.trim();
  if (!normalizedPattern) {
    return { output: "pattern must not be empty.", ok: false };
  }
  const absoluteTarget = await resolveToolPath(workspace, target, allowOutsideWorkspace);
  const limit = normalizeResults(maxResults, DEFAULT_GLOB_RESULTS);
  const executable = await resolveRipgrepPath();
  const run = await spawnRipgrep(
    executable,
    [
      "--files",
      "--no-messages",
      "--color=never",
      "--no-require-git",
      ...ignoredGlobArgs(),
      "--glob",
      normalizedPattern,
      "--",
      absoluteTarget,
    ],
    workspace,
    signal,
  );

  if (run.timedOut) return { output: "File search timed out.", ok: false };
  if (run.code !== 0 && run.code !== 1) {
    return { output: run.stderr.trim() || "ripgrep failed.", ok: false };
  }

  const allFiles = run.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => displayPath(workspace, line))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const files = allFiles.slice(0, limit);
  const body = files.join("\n") || "(no matching files)";
  const limitNotice =
    allFiles.length > limit
      ? `\n... [truncated: showing first ${limit} of ${allFiles.length} paths; narrow the pattern or raise maxResults (max ${MAX_SEARCH_RESULTS})]`
      : "";
  return {
    output: truncateSearchOutput(body) + limitNotice,
    ok: true,
  };
}

export async function searchGrep(
  workspace: string,
  target: string,
  pattern: string,
  options: {
    fixed?: unknown;
    caseSensitive?: unknown;
    contextLines?: unknown;
    maxResults?: unknown;
  },
  signal?: AbortSignal,
  allowOutsideWorkspace = false,
): Promise<ToolResult> {
  const normalizedPattern = String(pattern ?? "");
  if (!normalizedPattern) {
    return { output: "pattern must not be empty.", ok: false };
  }
  const absoluteTarget = await resolveToolPath(workspace, target, allowOutsideWorkspace);
  const limit = normalizeResults(options.maxResults, DEFAULT_GREP_RESULTS);
  const contextLines = Math.min(
    Math.max(Number(options.contextLines ?? 0) || 0, 0),
    MAX_CONTEXT_LINES,
  );
  const args = [
    "--json",
    "--no-messages",
    "--color=never",
    "--no-require-git",
    ...ignoredGlobArgs(),
    ...(options.caseSensitive === false ? ["--ignore-case"] : []),
    ...(options.fixed === true ? ["--fixed-strings"] : []),
    ...(contextLines > 0 ? ["--context", String(contextLines)] : []),
    "--",
    normalizedPattern,
    absoluteTarget,
  ];

  const executable = await resolveRipgrepPath();
  const lines: string[] = [];
  let matches = 0;
  const run = await spawnRipgrep(
    executable,
    args,
    workspace,
    signal,
    (line) => {
      let event: RipgrepJsonEvent;
      try {
        event = JSON.parse(line) as RipgrepJsonEvent;
      } catch {
        return;
      }
      const data = event.data;
      const text = clipMatchLine(data?.lines?.text?.replace(/\r?\n$/, "") ?? "");
      const relativePath = data?.path?.text ? displayPath(workspace, data.path.text) : "";
      if (event.type === "match" && relativePath) {
        matches += 1;
        lines.push(`${relativePath}:${data?.line_number ?? 0}: ${text}`);
        // 收够就终止 rg：否则 rg 会把整个工作区扫完才退出
        if (matches >= limit) return false;
      } else if (event.type === "context" && relativePath) {
        lines.push(`${relativePath}:${data?.line_number ?? 0}: ${text}`);
      }
    },
  );

  if (run.timedOut) return { output: "Content search timed out.", ok: false };
  if (run.code !== 0 && run.code !== 1 && !run.stoppedEarly) {
    return { output: run.stderr.trim() || "ripgrep failed.", ok: false };
  }
  const body = lines.join("\n") || "(no matches)";
  const limitNotice =
    matches >= limit
      ? `\n... [truncated: showing first ${matches} matches; narrow the pattern or raise maxResults (max ${MAX_SEARCH_RESULTS})]`
      : "";
  return {
    output: truncateSearchOutput(body) + limitNotice,
    ok: true,
  };
}

/**
 * onLine 给出「一行完整的 rg 输出」：chunk 边界不等于行边界，
 * 逐 chunk split+JSON.parse 会把一条跨 chunk 的事件切成两段非法 JSON 后静默丢掉结果。
 * onLine 返回 false 表示结果已收够，这里立刻终止 rg 并停止缓冲。
 */
async function spawnRipgrep(
  executable: string,
  args: string[],
  workspace: string,
  signal: AbortSignal | undefined,
  onLine?: (line: string) => boolean | void,
): Promise<RipgrepRun> {
  const child = spawn(executable, args, {
    cwd: workspace,
    signal,
    windowsHide: true,
  });

  let stderr = "";
  let stdout = "";
  let timedOut = false;
  let stoppedEarly = false;
  // StringDecoder 保证多字节字符跨 chunk 时不会被切成乱码（中文文件名/内容常见）
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, SEARCH_TIMEOUT_MS);

  const emitLine = (line: string): boolean => {
    if (onLine && onLine(line) === false) {
      stoppedEarly = true;
      child.stdout?.destroy();
      child.kill("SIGTERM");
      return false;
    }
    return true;
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    if (stoppedEarly) return;
    const text = decoder.write(chunk);
    if (!onLine) {
      stdout += text;
      return;
    }
    const parts = (pending + text).split(/\r?\n/);
    pending = parts.pop() ?? "";
    for (const line of parts) {
      if (!line) continue;
      if (!emitLine(line)) return;
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const done = new Promise<RipgrepRun>((resolve) => {
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        code: -1,
        stderr: `${stderr}\n${error.message}`.trim(),
        stdout,
        timedOut,
        stoppedEarly,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (onLine && !stoppedEarly) {
        const tail = pending + decoder.end();
        if (tail) emitLine(tail);
      } else {
        stdout += pending;
      }
      resolve({ code, stderr, stdout, timedOut, stoppedEarly });
    });
  });
  return done;
}
