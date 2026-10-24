/**
 * Git 服务：子进程 + 纯解析器，不依赖 HTTP 层，可单测。
 *
 * 设计取舍（见 plans/blazing-vortex-lovelace）：
 *  - 只用 `spawn(git, [args])`，不经 shell，路径一律 `--` 分隔 → 天然免疫命令注入；
 *  - 状态一次 `status --porcelain=v2 -z --branch` 拿齐分支/上游/ahead-behind/文件状态，
 *    `-z` 免引号转义（中文、空格路径都安全）；
 *  - `core.quotepath=false` 让 `git diff` 头里的中文路径不被转成八进制；
 *  - `GIT_TERMINAL_PROMPT=0` 是关键：没凭据时 push/pull 立刻失败而不是挂住等输入；
 *  - 所有写操作串行（`withLock`），避免 `.git/index.lock` 冲突；读操作不进锁。
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { commandEnv, killProcessTree } from "../agent/tools.js";

// ---- 类型 ----

export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "untracked"
  | "conflicted";

export type GitConflictKind =
  | "both_modified"
  | "both_added"
  | "both_deleted"
  | "added_by_us"
  | "added_by_them"
  | "deleted_by_us"
  | "deleted_by_them";

export type GitFileEntry = {
  /** 仓库根相对路径，统一 "/" */
  path: string;
  /** rename/copy 的源路径 */
  origPath?: string;
  /** 暂存侧状态（null = 该侧无变化） */
  index: GitFileStatus | null;
  /** 工作区侧状态 */
  worktree: GitFileStatus | null;
  conflict?: GitConflictKind;
  added?: number;
  removed?: number;
  binary?: boolean;
};

export type GitStatus = {
  isRepo: boolean;
  reason?: string;
  /** 仓库根（绝对路径） */
  root?: string;
  /** 仓库名（根目录名） */
  name?: string;
  /** 当前分支；detached 时为空 */
  branch?: string;
  detached?: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  staged: GitFileEntry[];
  unstaged: GitFileEntry[];
  conflicted: GitFileEntry[];
};

export type GitBranch = {
  name: string;
  sha: string;
  upstream?: string;
  current: boolean;
};

export type GitCommit = {
  sha: string;
  short: string;
  author: string;
  email: string;
  /** 秒级时间戳 */
  time: number;
  parents: string[];
  subject: string;
  body?: string;
};

export type GitRef = { root: string; workspace: string };

export type GitErrorCode =
  | "not_a_repo"
  | "git_unavailable"
  | "identity_missing"
  | "dirty_worktree"
  | "auth_required"
  | "network_error"
  | "no_upstream"
  | "branch_exists"
  | "timeout"
  | "invalid_path"
  | "too_many_paths"
  | "git_failed";

export class GitError extends Error {
  constructor(
    readonly code: GitErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

// ---- 常量 ----

/** 工作区不是仓库时 status 直接返回空态，不抛错 */
const MAX_PATHS_PER_REQUEST = 2_000;
/** 提交详情最多列多少个文件；初始提交动辄几千个，全量渲染会让弹层卡死 */
const MAX_COMMIT_FILES = 500;
/** diff 补丁上限：超出截断，UI 上标记 truncated */
export const MAX_PATCH_BYTES = 512 * 1024;
/** 合成 untracked patch 时单文件上限 */
const MAX_UNTRACKED_BYTES = 512 * 1024;
/** 合成 untracked patch 的行数上限 */
const MAX_UNTRACKED_LINES = 3_000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
/**
 * 可截断读取（diff / show）的执行器上限：比 MAX_PATCH_BYTES 多一点，
 * 让 `truncatePatch` 能切在预算内，同时不必把几十 MB 的 patch 读进内存。
 * 典型场景：刚 init 的仓库第一个提交包含几千个文件，`git show` 会吐几十 MB。
 */
const MAX_TRUNCATABLE_STDOUT_BYTES = MAX_PATCH_BYTES + 128 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
/**
 * revision 白名单：必须以字母数字开头（否则 `-x` 会被 git 当成选项），
 * 只允许 ref/相对引用里常见的字符。`^` `~` `@{}` 这类写法仍然支持。
 */
const REVISION_PATTERN = /^[0-9a-zA-Z][0-9a-zA-Z^~.\-_/@{}]{3,119}$/;

const TIMEOUTS = {
  read: 15_000,
  write: 30_000,
  commit: 120_000,
  remote: 60_000,
} as const;

// ---- 执行器 ----

export type RunGitOptions = {
  /** 通过 stdin 传入（commit 消息等） */
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** stdout 上限（字节）；默认 4MB */
  maxStdoutBytes?: number;
  /**
   * 允许「输出超限」时返回**部分结果**而不是报错。
   * 只给 diff/show 这类天然可截断的读取用；status/log 必须完整，超限要报错。
   */
  truncateStdout?: boolean;
};

export type RunGitResult = { stdout: Buffer; stderr: string; truncated: boolean };

/**
 * 执行 git 并返回原始字节。
 *
 * stdout 用 Buffer 收集：`-z` 输出里路径与记录分隔都靠 NUL，先转字符串会丢信息。
 * 非 0 退出统一抛 `GitError`（分类见 `classifyGitError`）。
 */
export async function runGit(
  cwd: string,
  args: string[],
  options: RunGitOptions = {},
): Promise<RunGitResult> {
  const timeoutMs = options.timeoutMs ?? TIMEOUTS.read;
  const result = await new Promise<RunGitResult>((resolve, reject) => {
    let child;
    try {
      child = spawn("git", ["--no-pager", "-c", "core.quotepath=false", ...args], {
        cwd,
        env: {
          ...commandEnv(),
          GIT_PAGER: "cat",
          // 没凭据时必须立刻失败，不能挂在终端提示上
          GIT_TERMINAL_PROMPT: "0",
          GIT_EDITOR: "true",
          GIT_MERGE_AUTOEDIT: "no",
          GIT_OPTIONAL_LOCKS: "0",
        },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reject(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? new GitError("git_unavailable", "Git is not installed or not on PATH.", message)
          : new GitError("git_failed", message),
      );
      return;
    }

    const chunks: Buffer[] = [];
    const maxStdout = options.maxStdoutBytes ?? MAX_STDOUT_BYTES;
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;
    let truncated = false;

    const finish = (error?: GitError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(chunks), stderr, truncated });
    };
    const onAbort = () => {
      killProcessTree(child);
      finish(new GitError("git_failed", "Git command aborted."));
    };
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish(new GitError("timeout", `Git command timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const room = maxStdout - stdoutBytes;
      if (chunk.length > room) {
        // 只留下装得下的部分：再多读只会把内存和事件循环一起拖住
        if (room > 0) {
          chunks.push(chunk.subarray(0, room));
          stdoutBytes += room;
        }
        truncated = true;
        killProcessTree(child);
        return;
      }
      chunks.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-MAX_STDERR_BYTES);
    });
    child.on("error", (error: Error) => {
      finish(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? new GitError("git_unavailable", "Git is not installed or not on PATH.", error.message)
          : new GitError("git_failed", error.message),
      );
    });
    child.on("close", (code: number | null) => {
      if (truncated) {
        // 可截断读取：把已有的部分交出去，由调用方标记 truncated
        if (options.truncateStdout) {
          finish();
          return;
        }
        const limit =
          maxStdout >= 1024 * 1024
            ? `${Math.round(maxStdout / (1024 * 1024))}MB`
            : `${Math.max(1, Math.round(maxStdout / 1024))}KB`;
        finish(
          new GitError(
            "git_failed",
            `git ${args[0] ?? ""} produced more than ${limit} of output; narrow it down (single file / fewer paths).`,
          ),
        );
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      const tail = stderr.trim().slice(-500);
      finish(
        new GitError(
          classifyGitError(stderr),
          tail || `git ${args[0] ?? ""} failed (exit ${code ?? "null"})`,
          tail,
        ),
      );
    });

    if (options.input !== undefined) {
      child.stdin?.end(options.input, "utf8");
    } else {
      child.stdin?.end();
    }
  });
  return result;
}

/**
 * stderr 关键字 → 稳定错误码。顺序有讲究：先认"不是仓库"，再认凭据/网络，
 * 最后才是钩子/索引之类的通用失败（都落 `git_failed` 并带 stderr 尾部）。
 */
export function classifyGitError(stderr: string): GitErrorCode {
  const text = stderr.toLowerCase();
  if (text.includes("not a git repository")) return "not_a_repo";
  if (text.includes("please tell me who you are") || text.includes("unable to auto-detect email")) {
    return "identity_missing";
  }
  if (
    text.includes("authentication failed") ||
    text.includes("could not read username") ||
    text.includes("permission denied (publickey)") ||
    text.includes("terminal prompts disabled")
  ) {
    return "auth_required";
  }
  if (
    text.includes("could not resolve host") ||
    text.includes("could not read from remote repository") ||
    text.includes("failed to connect") ||
    text.includes("connection timed out") ||
    text.includes("network is unreachable")
  ) {
    return "network_error";
  }
  if (text.includes("no upstream branch") || text.includes("has no upstream branch")) {
    return "no_upstream";
  }
  if (text.includes("already exists") && text.includes("branch")) return "branch_exists";
  if (
    text.includes("your local changes") ||
    text.includes("would be overwritten") ||
    text.includes("please commit your changes or stash them")
  ) {
    return "dirty_worktree";
  }
  return "git_failed";
}

// ---- porcelain v2 解析 ----

type ParsedEntry = Omit<GitFileEntry, "added" | "removed" | "binary">;

export type ParsedStatus = {
  oid?: string;
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  detached: boolean;
  entries: ParsedEntry[];
};

const STATUS_BY_CODE: Record<string, GitFileStatus | undefined> = {
  M: "modified",
  T: "typechange",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "conflicted",
  "?": "untracked",
};

const CONFLICT_BY_CODE: Record<string, GitConflictKind> = {
  UU: "both_modified",
  AA: "both_added",
  DD: "both_deleted",
  AU: "added_by_us",
  UA: "added_by_them",
  DU: "deleted_by_us",
  UD: "deleted_by_them",
};

/**
 * 解析 `git status --porcelain=v2 -z --branch`。
 *
 * `-z` 下所有记录以 NUL 分隔；rename 的源路径是**下一条独立记录**（不是拼在同行）。
 * 路径可能含空格，所以正则必须贪婪吃尾部 —— 不能 `split(" ")` 取最后一段。
 */
export function parsePorcelainV2(buffer: Buffer): ParsedStatus {
  const records = buffer.toString("utf8").split("\0");
  const parsed: ParsedStatus = { ahead: 0, behind: 0, detached: false, entries: [] };

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;

    if (record.startsWith("# branch.oid ")) {
      parsed.oid = record.slice("# branch.oid ".length);
      continue;
    }
    if (record.startsWith("# branch.head ")) {
      const head = record.slice("# branch.head ".length);
      if (head === "(detached)") parsed.detached = true;
      else parsed.branch = head;
      continue;
    }
    if (record.startsWith("# branch.upstream ")) {
      parsed.upstream = record.slice("# branch.upstream ".length);
      continue;
    }
    if (record.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
      if (match) {
        parsed.ahead = Number(match[1]);
        parsed.behind = Number(match[2]);
      }
      continue;
    }
    if (record.startsWith("?")) {
      // `? <path>`
      parsed.entries.push({
        path: record.slice(2),
        index: null,
        worktree: "untracked",
      });
      continue;
    }
    if (record.startsWith("u ")) {
      const match = /^u (..) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (.+)$/.exec(record);
      if (!match) continue;
      parsed.entries.push({
        path: match[10],
        index: "conflicted",
        worktree: "conflicted",
        conflict: CONFLICT_BY_CODE[match[1]],
      });
      continue;
    }
    if (record.startsWith("2 ")) {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path> → 路径在第 9 组
      const match = /^2 (..) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (.+)$/.exec(record);
      if (!match) continue;
      const origPath = records[index + 1];
      index += 1;
      const [x, y] = [match[1][0], match[1][1]];
      const entry: ParsedEntry = {
        path: match[9],
        ...(origPath ? { origPath } : {}),
        index: x === "." ? null : (STATUS_BY_CODE[x] ?? null),
        worktree: y === "." ? null : (STATUS_BY_CODE[y] ?? null),
      };
      parsed.entries.push(entry);
      continue;
    }
    if (record.startsWith("1 ")) {
      const match = /^1 (..) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (.+)$/.exec(record);
      if (!match) continue;
      const x = match[1][0];
      const y = match[1][1];
      parsed.entries.push({
        path: match[8],
        index: x === "." ? null : (STATUS_BY_CODE[x] ?? null),
        worktree: y === "." ? null : (STATUS_BY_CODE[y] ?? null),
      });
      continue;
    }
    // `!` ignored 记录以及未知行直接忽略
  }

  return parsed;
}

/**
 * 解析 `git diff --numstat -z`。
 *
 * 普通记录：`<added>\t<removed>\t<path>\0`；
 * rename 记录是 `<added>\t<removed>\t\0<src>\0<dst>\0` —— 路径为空时往后吃两条。
 * 二进制用 `-` 表示 added/removed。
 */
export function parseNumstatZ(buffer: Buffer): Map<string, { added: number; removed: number; binary: boolean }> {
  const stats = new Map<string, { added: number; removed: number; binary: boolean }>();
  const records = buffer.toString("utf8").split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(record);
    if (!match) continue;
    const added = match[1] === "-" ? 0 : Number(match[1]);
    const removed = match[2] === "-" ? 0 : Number(match[2]);
    const binary = match[1] === "-" && match[2] === "-";
    let filePath = match[3];
    if (!filePath) {
      // rename：本记录路径为空，源与目标各占一条
      const from = records[index + 1];
      const to = records[index + 2];
      index += 2;
      if (!to) continue;
      stats.set(from, { added, removed, binary });
      filePath = to;
    }
    stats.set(filePath, { added, removed, binary });
  }
  return stats;
}

function mergeStats(
  entry: ParsedEntry,
  staged: Map<string, { added: number; removed: number; binary: boolean }>,
  worktree: Map<string, { added: number; removed: number; binary: boolean }>,
): GitFileEntry {
  const work = worktree.get(entry.path) ?? worktree.get(entry.origPath ?? "");
  const index = staged.get(entry.path) ?? staged.get(entry.origPath ?? "");
  const stat = work ?? index;
  return {
    ...entry,
    ...(stat ? { added: stat.added, removed: stat.removed, binary: stat.binary } : {}),
  };
}

// ---- 路径守卫 ----

/** 拒绝 NUL/换行/绝对路径/`..`，并确认落在给定根内。返回 posix 相对路径。 */
export function normalizeRepoPath(root: string, raw: string, label = "path"): string {
  const value = raw.trim();
  if (!value) throw new GitError("invalid_path", `${label} must not be empty.`);
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new GitError("invalid_path", `${label} contains control characters.`);
  }
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")) {
    throw new GitError("invalid_path", `${label} must be repository-relative.`);
  }
  const normalized = value.replace(/\\/g, "/");
  if (normalized.split("/").some((segment) => segment === "..")) {
    throw new GitError("invalid_path", `${label} must not traverse outside the repository.`);
  }
  const absolute = path.resolve(root, normalized);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new GitError("invalid_path", `${label} resolves outside the repository.`);
  }
  return relative.replace(/\\/g, "/");
}

/** 破坏性操作（discard）只允许工作区内路径：工作区是子目录时不能悄悄丢掉看不见的改动。 */
export function assertInsideWorkspace(root: string, workspace: string, relative: string): void {
  const target = path.resolve(root, relative);
  const rel = path.relative(path.resolve(workspace), target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new GitError(
      "invalid_path",
      "Destructive operations are limited to files inside the workspace.",
    );
  }
}

export function assertPathList(raw: unknown): string[] {
  if (!Array.isArray(raw) || !raw.length) {
    throw new GitError("invalid_path", "paths must be a non-empty array.");
  }
  if (raw.length > MAX_PATHS_PER_REQUEST) {
    throw new GitError("too_many_paths", `At most ${MAX_PATHS_PER_REQUEST} paths per request.`);
  }
  return raw.map((item) => (typeof item === "string" ? item : ""));
}

// ---- 串行锁 ----

let chain: Promise<unknown> = Promise.resolve();

/** 写操作串行：并发 stage/commit 会抢 `.git/index.lock`。 */
export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

// ---- 只读操作 ----

async function resolveRoot(workspace: string): Promise<string> {
  try {
    const { stdout } = await runGit(workspace, ["rev-parse", "--show-toplevel"], {
      timeoutMs: TIMEOUTS.read,
    });
    const root = stdout.toString("utf8").trim();
    if (!root) throw new GitError("not_a_repo", "The workspace is not a Git repository.");
    return path.resolve(root);
  } catch (error) {
    if (error instanceof GitError && error.code === "git_unavailable") throw error;
    if (error instanceof GitError && error.code === "not_a_repo") throw error;
    throw new GitError("not_a_repo", "The workspace is not a Git repository.", error instanceof Error ? error.message : undefined);
  }
}

export async function isGitAvailable(): Promise<boolean> {
  try {
    await runGit(process.cwd(), ["--version"], { timeoutMs: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 仓库状态。不是仓库时**不抛错**，返回 `{ isRepo: false, reason }` 让前端渲染空态。
 */
export async function getStatus(workspace: string): Promise<GitStatus> {
  const empty: GitStatus = { isRepo: false, staged: [], unstaged: [], conflicted: [] };
  try {
    const root = await resolveRoot(workspace);
    const [statusResult, worktreeStats, stagedStats] = await Promise.all([
      runGit(root, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]),
      runGit(root, ["diff", "--numstat", "-z"]).catch(() => ({ stdout: Buffer.alloc(0), stderr: "" })),
      runGit(root, ["diff", "--cached", "--numstat", "-z"]).catch(() => ({
        stdout: Buffer.alloc(0),
        stderr: "",
      })),
    ]);
    const parsed = parsePorcelainV2(statusResult.stdout);
    const stagedMap = parseNumstatZ(stagedStats.stdout);
    const worktreeMap = parseNumstatZ(worktreeStats.stdout);

    const staged: GitFileEntry[] = [];
    const unstaged: GitFileEntry[] = [];
    const conflicted: GitFileEntry[] = [];
    for (const entry of parsed.entries) {
      const merged = mergeStats(entry, stagedMap, worktreeMap);
      if (merged.index === "conflicted" || merged.conflict) {
        conflicted.push(merged);
        continue;
      }
      // XY 两位都非 "." 时同时出现在两组（VS Code 行为）
      if (merged.index) staged.push(merged);
      if (merged.worktree) unstaged.push(merged);
    }
    return {
      isRepo: true,
      root,
      name: path.basename(root),
      branch: parsed.branch,
      detached: parsed.detached,
      ...(parsed.upstream ? { upstream: parsed.upstream } : {}),
      ahead: parsed.ahead,
      behind: parsed.behind,
      staged,
      unstaged,
      conflicted,
    };
  } catch (error) {
    if (error instanceof GitError) {
      if (error.code === "git_unavailable") return { ...empty, reason: "git_unavailable" };
      return { ...empty, reason: error.code };
    }
    return { ...empty, reason: "git_failed" };
  }
}

function isBinaryContent(buffer: Buffer): boolean {
  return buffer.subarray(0, 8_192).includes(0);
}

/** 给 untracked 文件合成一个 new-file patch（`git diff` 不含未跟踪文件）。 */
function synthesizeNewFilePatch(relative: string, content: string): string {
  const lines = content.split(/\r?\n/);
  // 末尾换行不算多一行
  if (lines.at(-1) === "") lines.pop();
  const shown = lines.slice(0, MAX_UNTRACKED_LINES);
  const body = shown.map((line) => `+${line}`).join("\n");
  const note =
    lines.length > MAX_UNTRACKED_LINES
      ? `\n... [${lines.length - MAX_UNTRACKED_LINES} more lines not shown]`
      : "";
  return [
    `diff --git a/${relative} b/${relative}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${relative}`,
    `@@ -0,0 +1,${shown.length} @@`,
    body + note,
  ].join("\n");
}

export type GitDiffResult = {
  patch: string;
  binary: boolean;
  truncated: boolean;
  added: number;
  removed: number;
};

function countPatchLines(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

function truncatePatch(patch: string): { patch: string; truncated: boolean } {
  if (Buffer.byteLength(patch, "utf8") <= MAX_PATCH_BYTES) {
    return { patch, truncated: false };
  }
  // 按字节切可能落在多字节字符中间：把尾部的替换字符去掉，别把半个汉字喂给 UI
  const cut = Buffer.from(patch, "utf8")
    .subarray(0, MAX_PATCH_BYTES)
    .toString("utf8")
    .replace(/\uFFFD+$/, "");
  return {
    patch: `${cut}\n... [patch truncated at ${Math.round(MAX_PATCH_BYTES / 1024)}KB]`,
    truncated: true,
  };
}

export async function getDiff(
  workspace: string,
  input: { path?: string; scope?: "worktree" | "index" | "commit"; sha?: string },
): Promise<GitDiffResult> {
  const root = await resolveRoot(workspace);
  const scope = input.scope ?? "worktree";
  const relative = input.path ? normalizeRepoPath(root, input.path) : undefined;

  let raw: string;
  /** git 输出被执行器按上限截断了（大提交 / 大文件），要透传给 UI */
  let cutByGit = false;
  if (scope === "commit") {
    const sha = (input.sha ?? "").trim();
    if (!REVISION_PATTERN.test(sha)) {
      throw new GitError("invalid_path", "sha is not a valid revision.");
    }
    const truncatable = {
      truncateStdout: true,
      maxStdoutBytes: MAX_TRUNCATABLE_STDOUT_BYTES,
    };
    try {
      const result = await runGit(
        root,
        [
          "show",
          "--format=",
          "--no-ext-diff",
          "--no-textconv",
          "-U3",
          sha,
          ...(relative ? ["--", relative] : []),
        ],
        truncatable,
      );
      raw = result.stdout.toString("utf8");
      cutByGit = result.truncated;
    } catch (error) {
      // merge commit 没有自带 patch（combined diff 被 --format= 吃掉）：退回对比第一父
      const result = await runGit(
        root,
        [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "-U3",
          `${sha}^1`,
          sha,
          ...(relative ? ["--", relative] : []),
        ],
        truncatable,
      ).catch(() => {
        throw error;
      });
      raw = result.stdout.toString("utf8");
      cutByGit = result.truncated;
    }
  } else {
    const args = ["diff", "--no-ext-diff", "--no-textconv", "-U3"];
    if (scope === "index") args.push("--cached");
    if (relative) args.push("--", relative);
    const result = await runGit(root, args, {
      truncateStdout: true,
      maxStdoutBytes: MAX_TRUNCATABLE_STDOUT_BYTES,
    });
    raw = result.stdout.toString("utf8");
    cutByGit = result.truncated;

    // untracked：git diff 看不到，读文件合成 patch。
    // 必须先确认它**确实**没被跟踪 —— 干净文件同样没有 diff，
    // 直接合成会凭空造出一个「新文件」补丁。
    const untracked =
      relative && scope === "worktree" && !raw.trim()
        ? !(await runGit(root, ["ls-files", "--error-unmatch", "--", relative]).then(
            () => true,
            () => false,
          ))
        : false;
    if (relative && scope === "worktree" && untracked) {
      const absolute = path.resolve(root, relative);
      const info = await fs.stat(absolute).catch(() => null);
      if (info?.isFile()) {
        if (info.size > MAX_UNTRACKED_BYTES) {
          const buffer = await fs.readFile(absolute).catch(() => Buffer.alloc(0));
          if (isBinaryContent(buffer)) {
            return { patch: "", binary: true, truncated: false, added: 0, removed: 0 };
          }
          return {
            patch: `diff --git a/${relative} b/${relative}\nnew file mode 100644\n... [file is ${info.size} bytes; too large to preview]`,
            binary: false,
            truncated: true,
            added: 0,
            removed: 0,
          };
        }
        const buffer = await fs.readFile(absolute).catch(() => Buffer.alloc(0));
        if (isBinaryContent(buffer)) {
          return {
            patch: `diff --git a/${relative} b/${relative}\nBinary file (not shown)`,
            binary: true,
            truncated: false,
            added: 0,
            removed: 0,
          };
        }
        raw = synthesizeNewFilePatch(relative, buffer.toString("utf8"));
      }
    }
  }

  const binary = raw.includes("Binary files ") || raw.includes("GIT binary patch");
  const counts = countPatchLines(raw);
  const cut = truncatePatch(raw);
  return { patch: cut.patch, binary, truncated: cut.truncated || cutByGit, ...counts };
}

export async function listBranches(workspace: string): Promise<{ current?: string; detached: boolean; branches: GitBranch[] }> {
  const root = await resolveRoot(workspace);
  const [headResult, branchResult] = await Promise.all([
    runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => ({
      stdout: Buffer.alloc(0),
      stderr: "",
    })),
    runGit(root, [
      "for-each-ref",
      "--format=%(refname:short)%00%(objectname:short)%00%(upstream:short)",
      "refs/heads",
    ]),
  ]);
  const current = headResult.stdout.toString("utf8").trim() || undefined;
  const branches: GitBranch[] = [];
  for (const line of branchResult.stdout.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    const [name, sha, upstream] = line.split("\0");
    if (!name || !sha) continue;
    branches.push({
      name,
      sha,
      ...(upstream ? { upstream } : {}),
      current: name === current,
    });
  }
  branches.sort((a, b) => a.name.localeCompare(b.name));
  return { current, detached: !current, branches };
}

const LOG_FORMAT = "%H%x00%h%x00%an%x00%ae%x00%at%x00%P%x00%s%x00%b";

function parseLog(stdout: string): GitCommit[] {
  const commits: GitCommit[] = [];
  // body 可能含换行：用记录分隔符 \x1e 切开更稳，git 支持 %x1e
  for (const record of stdout.split("\x1e")) {
    const line = record.trim();
    if (!line) continue;
    const [sha, short, author, email, time, parents, subject, body] = line.split("\0");
    if (!sha) continue;
    commits.push({
      sha,
      short: short ?? sha.slice(0, 7),
      author: author ?? "",
      email: email ?? "",
      time: Number(time ?? 0) || 0,
      parents: parents ? parents.split(" ").filter(Boolean) : [],
      subject: subject ?? "",
      ...(body && body.trim() ? { body: body.trim() } : {}),
    });
  }
  return commits;
}

export async function listLog(
  workspace: string,
  options: { limit?: number; skip?: number } = {},
): Promise<{ commits: GitCommit[]; hasMore: boolean }> {
  const root = await resolveRoot(workspace);
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 50)), 200);
  const skip = Math.max(0, Math.floor(options.skip ?? 0));
  let stdout: string;
  try {
    const result = await runGit(root, [
      "log",
      `--format=${LOG_FORMAT}%x1e`,
      "-n",
      String(limit + 1),
      "--skip",
      String(skip),
    ]);
    stdout = result.stdout.toString("utf8");
  } catch (error) {
    // 空仓库（还没有 HEAD）：返回空列表而不是报错
    if (error instanceof GitError && /does not have any commits yet|unknown revision/i.test(error.message)) {
      return { commits: [], hasMore: false };
    }
    if (error instanceof GitError && error.code === "git_failed" && !skip) {
      const head = await runGit(root, ["rev-parse", "--verify", "HEAD"]).catch(() => null);
      if (!head) return { commits: [], hasMore: false };
    }
    throw error;
  }
  const commits = parseLog(stdout);
  const hasMore = commits.length > limit;
  return { commits: commits.slice(0, limit), hasMore };
}

export async function showCommit(
  workspace: string,
  sha: string,
): Promise<{
  commit: GitCommit;
  files: GitFileEntry[];
  /** 该提交涉及的文件总数（files 可能被 MAX_COMMIT_FILES 截断） */
  fileCount: number;
  patch: string;
  truncated: boolean;
}> {
  const root = await resolveRoot(workspace);
  const revision = sha.trim();
  if (!REVISION_PATTERN.test(revision)) {
    throw new GitError("invalid_path", "sha is not a valid revision.");
  }
  const [metaResult, filesResult] = await Promise.all([
    runGit(root, ["show", "-s", `--format=${LOG_FORMAT}`, revision]),
    runGit(root, ["show", "--name-status", "-z", "--format=", revision]).catch(() => ({
      stdout: Buffer.alloc(0),
      stderr: "",
    })),
  ]);
  const commit = parseLog(metaResult.stdout.toString("utf8"))[0];
  if (!commit) throw new GitError("git_failed", "Commit not found.");

  const files: GitFileEntry[] = [];
  const tokens = filesResult.stdout.toString("utf8").split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const code = tokens[index];
    if (!code) continue;
    const status = STATUS_BY_CODE[code[0]] ?? "modified";
    if (code[0] === "R" || code[0] === "C") {
      const from = tokens[index + 1];
      const to = tokens[index + 2];
      index += 2;
      if (!to) continue;
      files.push({ path: to, origPath: from, index: status, worktree: null });
      continue;
    }
    const filePath = tokens[index + 1];
    index += 1;
    if (!filePath) continue;
    files.push({ path: filePath, index: status, worktree: null });
  }

  const diff = await getDiff(workspace, { scope: "commit", sha: revision });
  return {
    commit,
    files: files.slice(0, MAX_COMMIT_FILES),
    fileCount: files.length,
    patch: diff.patch,
    truncated: diff.truncated,
  };
}

// ---- 写操作 ----

export async function stage(workspace: string, paths: unknown): Promise<void> {
  const list = assertPathList(paths);
  const root = await resolveRoot(workspace);
  const normalized = list.map((item) => normalizeRepoPath(root, item));
  await withLock(async () => {
    await runGit(root, ["add", "--", ...normalized], { timeoutMs: TIMEOUTS.write });
  });
}

async function hasHead(root: string): Promise<boolean> {
  const result = await runGit(root, ["rev-parse", "--verify", "HEAD"]).catch(() => null);
  return Boolean(result?.stdout.toString("utf8").trim());
}

export async function unstage(workspace: string, paths: unknown): Promise<void> {
  const list = assertPathList(paths);
  const root = await resolveRoot(workspace);
  const normalized = list.map((item) => normalizeRepoPath(root, item));
  await withLock(async () => {
    // 空仓库没有 HEAD：restore --staged 不可用，只能把索引里的条目移出
    if (await hasHead(root)) {
      await runGit(root, ["restore", "--staged", "--", ...normalized], {
        timeoutMs: TIMEOUTS.write,
      });
      return;
    }
    await runGit(root, ["rm", "--cached", "-r", "--", ...normalized], {
      timeoutMs: TIMEOUTS.write,
    });
  });
}

export async function discard(workspace: string, paths: unknown): Promise<{ discarded: number }> {
  const list = assertPathList(paths);
  const root = await resolveRoot(workspace);
  const normalized = list.map((item) => {
    const relative = normalizeRepoPath(root, item);
    assertInsideWorkspace(root, workspace, relative);
    return relative;
  });
  let discarded = 0;
  await withLock(async () => {
    const status = await getStatus(workspace);
    const untracked = new Set(status.unstaged.filter((entry) => entry.worktree === "untracked").map((entry) => entry.path));
    const tracked: string[] = [];
    for (const relative of normalized) {
      if (untracked.has(relative)) {
        await fs.rm(path.resolve(root, relative), { force: true, recursive: false }).catch(() => undefined);
        discarded += 1;
      } else {
        tracked.push(relative);
      }
    }
    if (tracked.length) {
      await runGit(root, ["restore", "--", ...tracked], { timeoutMs: TIMEOUTS.write });
      discarded += tracked.length;
    }
  });
  return { discarded };
}

export async function commit(workspace: string, message: string): Promise<{ sha: string; short: string; subject: string }> {
  const root = await resolveRoot(workspace);
  const text = (message ?? "").trim();
  if (!text) throw new GitError("git_failed", "Commit message must not be empty.");
  if (text.length > 8_000) throw new GitError("git_failed", "Commit message is too long.");
  return withLock(async () => {
    // 消息走 stdin：避开 argv 长度与引号问题
    await runGit(root, ["commit", "-F", "-"], {
      input: text,
      timeoutMs: TIMEOUTS.commit,
    }).catch((error: unknown) => {
      const text2 = error instanceof GitError ? `${error.message} ${error.detail ?? ""}` : String(error);
      if (/nothing to commit|no changes added to commit|empty commit/i.test(text2)) {
        throw new GitError("git_failed", "Nothing staged to commit.");
      }
      throw error;
    });
    const { stdout } = await runGit(root, ["log", "-1", "--format=%H%x00%h%x00%s"]);
    const [sha, short, subject] = stdout.toString("utf8").trim().split("\0");
    return { sha: sha ?? "", short: short ?? "", subject: subject ?? text.split("\n")[0] };
  });
}

export async function createBranch(
  workspace: string,
  name: string,
  startPoint?: string,
): Promise<{ branch: string }> {
  const root = await resolveRoot(workspace);
  const branch = (name ?? "").trim();
  if (!branch) throw new GitError("git_failed", "Branch name must not be empty.");
  await runGit(root, ["check-ref-format", "--branch", branch]).catch(() => {
    throw new GitError("git_failed", `Invalid branch name: ${branch}`);
  });
  return withLock(async () => {
    const args = ["switch", "-c", branch];
    if (startPoint?.trim()) {
      const start = startPoint.trim();
      if (!REVISION_PATTERN.test(start)) {
        throw new GitError("invalid_path", "startPoint is not a valid revision.");
      }
      args.push(start);
    }
    await runGit(root, args, { timeoutMs: TIMEOUTS.write }).catch(async (error: unknown) => {
      // 老 git 没有 switch：回退 checkout
      if (error instanceof GitError && /not a git command|unknown option/i.test(error.message)) {
        await runGit(root, ["checkout", "-b", branch, ...args.slice(3)], {
          timeoutMs: TIMEOUTS.write,
        });
        return;
      }
      throw error;
    });
    return { branch };
  });
}

export async function switchBranch(
  workspace: string,
  input: { name: string; force?: boolean; stash?: boolean },
): Promise<{ branch: string }> {
  const root = await resolveRoot(workspace);
  const branch = (input.name ?? "").trim();
  if (!branch) throw new GitError("git_failed", "Branch name must not be empty.");
  return withLock(async () => {
    if (input.stash) {
      await runGit(root, ["stash", "push", "-u", "-m", `meowcode: switch to ${branch}`], {
        timeoutMs: TIMEOUTS.write,
      }).catch(() => undefined);
    }
    const args = ["switch"];
    if (input.force) args.push("--discard-changes");
    args.push(branch);
    await runGit(root, args, { timeoutMs: TIMEOUTS.write }).catch(async (error: unknown) => {
      if (error instanceof GitError && /not a git command|unknown option/i.test(error.message)) {
        const fallback = ["checkout", ...(input.force ? ["-f"] : []), branch];
        await runGit(root, fallback, { timeoutMs: TIMEOUTS.write });
        return;
      }
      throw error;
    });
    return { branch };
  });
}

export async function pull(workspace: string): Promise<{ summary: string }> {
  const root = await resolveRoot(workspace);
  return withLock(async () => {
    const status = await getStatus(workspace);
    if (!status.upstream) {
      throw new GitError("no_upstream", "The current branch has no upstream branch.");
    }
    // 固定 --ff-only：分叉时直接报错，让用户自己决定 merge/rebase
    const { stdout, stderr } = await runGit(root, ["pull", "--ff-only"], {
      timeoutMs: TIMEOUTS.remote,
    });
    return { summary: (stdout.toString("utf8") + stderr).trim().slice(0, 2_000) || "Already up to date." };
  });
}

export async function push(
  workspace: string,
  input: { setUpstream?: boolean; force?: boolean } = {},
): Promise<{ summary: string }> {
  const root = await resolveRoot(workspace);
  return withLock(async () => {
    const status = await getStatus(workspace);
    const args = ["push"];
    if (input.force) {
      // 只允许带 lease 的强制推送，绝不裸 --force
      args.push("--force-with-lease");
    }
    if (!status.upstream) {
      const branch = status.branch;
      if (!branch) throw new GitError("no_upstream", "Cannot push from a detached HEAD.");
      // 没有 origin 时提前给明确错误，而不是让 git 报一段含糊的 "does not appear to be a git repository"
      const remote = await runGit(root, ["remote", "get-url", "origin"]).catch(() => null);
      if (!remote?.stdout.toString("utf8").trim()) {
        throw new GitError("no_upstream", "No 'origin' remote is configured for this repository.");
      }
      args.push("-u", "origin", branch);
    }
    const { stdout, stderr } = await runGit(root, args, { timeoutMs: TIMEOUTS.remote });
    return { summary: (stdout.toString("utf8") + stderr).trim().slice(0, 2_000) || "Pushed." };
  });
}

export async function resolveConflict(
  workspace: string,
  input: { path: string; side: "ours" | "theirs" | "mark" },
): Promise<void> {
  const root = await resolveRoot(workspace);
  const relative = normalizeRepoPath(root, input.path);
  assertInsideWorkspace(root, workspace, relative);
  const side = input.side;
  if (side !== "ours" && side !== "theirs" && side !== "mark") {
    throw new GitError("invalid_path", "side must be ours / theirs / mark.");
  }
  await withLock(async () => {
    if (side === "mark") {
      await runGit(root, ["add", "--", relative], { timeoutMs: TIMEOUTS.write });
      return;
    }
    await runGit(root, ["checkout", side === "ours" ? "--ours" : "--theirs", "--", relative], {
      timeoutMs: TIMEOUTS.write,
    });
    await runGit(root, ["add", "--", relative], { timeoutMs: TIMEOUTS.write });
  });
}

/**
 * 收集 AI 生成 commit message 的素材（已暂存内容）。
 * patch 先截到 200KB 再交给生成器：生成器会按文件再切分预算，
 * 这里只防止把几百 MB 的 diff 读进内存。
 */
export async function collectCommitContext(workspace: string): Promise<{
  recentSubjects: string[];
  statText: string;
  patchText: string;
}> {
  const root = await resolveRoot(workspace);
  const [subjectsResult, statResult, patchResult] = await Promise.all([
    runGit(root, ["log", "-n", "10", "--format=%s"]).catch(() => ({
      stdout: Buffer.alloc(0),
      stderr: "",
    })),
    runGit(root, ["diff", "--cached", "--stat"]).catch(() => ({
      stdout: Buffer.alloc(0),
      stderr: "",
    })),
    runGit(root, ["diff", "--cached", "-U1", "--no-ext-diff", "--no-textconv"], {
      // 生成 commit message 只需要开头部分：直接按 256KB 截断，别把几十 MB 读进内存
      truncateStdout: true,
      maxStdoutBytes: 256 * 1024,
    }).catch(() => ({
      stdout: Buffer.alloc(0),
      stderr: "",
    })),
  ]);
  return {
    recentSubjects: subjectsResult.stdout
      .toString("utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
    statText: statResult.stdout.toString("utf8").slice(0, 20_000),
    patchText: patchResult.stdout.toString("utf8").slice(0, 200_000),
  };
}

// ---- 服务对象（server 层用） ----

export type GitService = ReturnType<typeof createGitService>;

/**
 * 把工作区绑定到一组方法上：server 每次都按当前会话 cwd 新建一个（很轻）。
 * 保留独立的模块级函数便于单测直接传 root/workspace。
 */
export function createGitService(options: { workspace: string }) {
  const workspace = options.workspace;
  return {
    workspace,
    status: () => getStatus(workspace),
    diff: (input: { path?: string; scope?: "worktree" | "index" | "commit"; sha?: string }) =>
      getDiff(workspace, input),
    branches: () => listBranches(workspace),
    log: (input?: { limit?: number; skip?: number }) => listLog(workspace, input),
    showCommit: (sha: string) => showCommit(workspace, sha),
    stage: (paths: unknown) => stage(workspace, paths),
    unstage: (paths: unknown) => unstage(workspace, paths),
    discard: (paths: unknown) => discard(workspace, paths),
    commit: (message: string) => commit(workspace, message),
    createBranch: (name: string, startPoint?: string) => createBranch(workspace, name, startPoint),
    switchBranch: (input: { name: string; force?: boolean; stash?: boolean }) =>
      switchBranch(workspace, input),
    pull: () => pull(workspace),
    push: (input?: { setUpstream?: boolean; force?: boolean }) => push(workspace, input),
    resolve: (input: { path: string; side: "ours" | "theirs" | "mark" }) =>
      resolveConflict(workspace, input),
    commitContext: () => collectCommitContext(workspace),
  };
}
