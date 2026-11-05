/**
 * 会话级 git worktree：在主仓库之外给一次对话一份独立检出 + 独立分支，主工作区不动。
 * 只负责创建/回滚；合并与删除由用户用 git 手动完成。
 */
import { promises as fs, type Dirent } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { SessionWorktree } from "../agent/types.js";
import { GitError, runGit, withLock } from "./git.js";

export type CreatedSessionWorktree = {
  worktree: SessionWorktree;
  /** 会话实际 cwd（worktree 根 + 原工作区相对子目录） */
  cwd: string;
  /** 主工作区有未提交改动；worktree 仍基于 HEAD 创建 */
  dirty: boolean;
};

const MAX_ATTEMPTS = 3;
const ADD_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 30_000;
/** 清理前把 worktree HEAD 存到主仓库的备份 ref，用户可随时恢复。 */
const BACKUP_REF_PREFIX = "refs/meowcode-backup/";

export type WorktreeCleanupResult = {
  removed: number;
  skippedDirty: number;
  skippedReferenced: number;
  failed: number;
};

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "repo"
  );
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

async function gitText(cwd: string, args: string[], timeoutMs = 15_000): Promise<string> {
  const { stdout } = await runGit(cwd, args, { timeoutMs });
  return stdout.toString("utf8").trim();
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await runGit(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      timeoutMs: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

/** node_modules 不随 worktree 检出：尽力链接回原目录，让 tsc/构建能直接跑。 */
async function linkNodeModules(source: string, target: string): Promise<void> {
  if (source === target) return;
  try {
    if (!(await fs.stat(source)).isDirectory()) return;
  } catch {
    return;
  }
  if (await pathExists(target)) return;
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(source, target, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    console.warn(
      `[worktree] node_modules link skipped (${source} → ${target}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * 创建 worktree。基于 HEAD 的 SHA，不包含主工作区未提交改动。
 * 失败时清理本次新建的分支/目录；主工作区脏不阻止创建。
 */
export async function createSessionWorktree(
  sourceCwd: string,
  worktreesDir: string,
  options: { fetchUpstream?: boolean } = {},
): Promise<CreatedSessionWorktree> {
  const source = path.resolve(sourceCwd);
  let stat;
  try {
    stat = await fs.stat(source);
  } catch {
    throw new GitError("invalid_path", `Workspace does not exist: ${source}`);
  }
  if (!stat.isDirectory()) {
    throw new GitError("invalid_path", `Workspace is not a directory: ${source}`);
  }

  const repoRoot = path.resolve(
    await gitText(source, ["rev-parse", "--show-toplevel"]).catch((error: unknown) => {
      if (error instanceof GitError) throw error;
      throw new GitError(
        "not_a_repo",
        "The workspace is not a Git repository.",
        error instanceof Error ? error.message : undefined,
      );
    }),
  );

  // 「创建前获取上游更新」是尽力而为：没 remote / 离线 / 鉴权失败都不阻止创建，
  // 只把远端 ref 刷新到最新，再在可快进时把 worktree 基到上游。
  if (options.fetchUpstream) {
    let remote = "";
    try {
      const upstream = await gitText(repoRoot, [
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
      ]);
      const slash = upstream.indexOf("/");
      if (slash > 0) remote = upstream.slice(0, slash);
    } catch {
      // 当前分支没有 upstream：退回默认 remote
    }
    try {
      await runGit(
        repoRoot,
        remote ? ["fetch", "--prune", remote] : ["fetch", "--prune"],
        { timeoutMs: FETCH_TIMEOUT_MS },
      );
    } catch (error) {
      console.warn(
        `[worktree] fetch before create skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  let baseSha = await gitText(repoRoot, ["rev-parse", "--verify", "HEAD"]).catch(
    (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      throw new GitError(
        "git_failed",
        "This repository has no commits yet; create an initial commit before using a worktree.",
        detail,
      );
    },
  );

  // 只有 HEAD 是上游祖先（可快进）时才用上游 SHA；本地已有未推送提交时保持 HEAD，
  // 避免 worktree 意外丢掉本地已提交的工作。
  if (options.fetchUpstream) {
    const upstreamSha = await gitText(repoRoot, ["rev-parse", "--verify", "@{upstream}"]).catch(
      () => "",
    );
    if (upstreamSha && upstreamSha !== baseSha) {
      const fastForwardable = await runGit(
        repoRoot,
        ["merge-base", "--is-ancestor", baseSha, upstreamSha],
        { timeoutMs: 10_000 },
      )
        .then(() => true)
        .catch(() => false);
      if (fastForwardable) baseSha = upstreamSha;
    }
  }

  const dirty = Boolean(await gitText(repoRoot, ["status", "--porcelain=v1", "--untracked-files=normal"]));
  await fs.mkdir(worktreesDir, { recursive: true });

  return withLock(async () => {
    const now = new Date();
    const baseName = slugify(path.basename(repoRoot));
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const id = `${baseName}-${stamp(now)}-${randomBytes(2).toString("hex")}`;
      const branch = `meowcode/${id}`;
      const worktreeRoot = path.join(worktreesDir, id);
      if ((await pathExists(worktreeRoot)) || (await branchExists(repoRoot, branch))) {
        continue;
      }
      try {
        await runGit(repoRoot, ["worktree", "add", "-b", branch, worktreeRoot, baseSha], {
          timeoutMs: ADD_TIMEOUT_MS,
        });
      } catch (error) {
        lastError = error;
        await runGit(repoRoot, ["worktree", "remove", "--force", worktreeRoot], {
          timeoutMs: 30_000,
        }).catch(() => undefined);
        await runGit(repoRoot, ["branch", "-D", branch], { timeoutMs: 15_000 }).catch(
          () => undefined,
        );
        continue;
      }

      const relative = path.relative(repoRoot, source);
      const sessionCwd =
        relative && !relative.startsWith("..") && !path.isAbsolute(relative)
          ? path.join(worktreeRoot, relative)
          : worktreeRoot;
      await fs.mkdir(sessionCwd, { recursive: true });
      await linkNodeModules(path.join(repoRoot, "node_modules"), path.join(worktreeRoot, "node_modules"));
      if (sessionCwd !== worktreeRoot) {
        await linkNodeModules(path.join(source, "node_modules"), path.join(sessionCwd, "node_modules"));
      }

      return {
        worktree: {
          sourceCwd: source,
          repoRoot,
          path: worktreeRoot,
          branch,
          baseSha,
          createdAt: now.toISOString(),
        },
        cwd: sessionCwd,
        dirty,
      };
    }
    throw new GitError(
      "git_failed",
      "Could not create a git worktree (path or branch kept colliding).",
      lastError instanceof Error ? lastError.message : undefined,
    );
  });
}

/** 只用于刚创建但会话落盘失败的兜底回滚；不碰已有用户数据。 */
export async function removeSessionWorktree(worktree: SessionWorktree): Promise<void> {
  await withLock(async () => {
    await runGit(worktree.repoRoot, ["worktree", "remove", "--force", worktree.path], {
      timeoutMs: 30_000,
    }).catch(() => undefined);
    await runGit(worktree.repoRoot, ["branch", "-D", worktree.branch], { timeoutMs: 15_000 }).catch(
      () => undefined,
    );
  });
}

function normalizeWorktreePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function isGitWorktree(dir: string): Promise<boolean> {
  const info = await fs.lstat(path.join(dir, ".git")).catch(() => null);
  return Boolean(info && (info.isFile() || info.isDirectory()));
}

async function worktreeCommonDir(worktreePath: string): Promise<string | null> {
  try {
    return path.resolve(
      await gitText(worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    );
  } catch {
    try {
      return path.resolve(
        worktreePath,
        await gitText(worktreePath, ["rev-parse", "--git-common-dir"]),
      );
    } catch {
      return null;
    }
  }
}

/** node_modules 是创建时链接进来的，.meowcode 是运行时产物：都不算用户的未提交改动。 */
function meaningfulStatusLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .filter((line) => {
      const target = line.length > 3 ? line.slice(3) : line;
      return !/(^|[\\/])(node_modules|\.meowcode)([\\/]|$)/.test(target);
    });
}

/**
 * 清理超过数量限制的旧 worktree。
 *
 * 只删「没有被任何会话引用、且没有用户未提交改动」的目录：
 *  - 被会话引用的（包括已归档会话）永远保留，避免打开旧会话时目录消失；
 *  - 有未提交改动的保留（Git 备份只能保证已提交内容，不能保证工作区文件）；
 *  - 删除前把 HEAD 写进 refs/meowcode-backup/<目录名>，之后可从备份恢复。
 */
export async function pruneSessionWorktrees(options: {
  worktreesDir: string;
  maxKeep: number;
  referencedPaths: ReadonlySet<string>;
}): Promise<WorktreeCleanupResult> {
  const result: WorktreeCleanupResult = {
    removed: 0,
    skippedDirty: 0,
    skippedReferenced: 0,
    failed: 0,
  };
  const limit = Math.max(1, Math.min(100, Math.floor(options.maxKeep)));
  let entries: Dirent[];
  try {
    entries = await fs.readdir(options.worktreesDir, { withFileTypes: true });
  } catch {
    return result;
  }

  const worktrees: Array<{ dir: string; createdAt: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(options.worktreesDir, entry.name);
    if (!(await isGitWorktree(dir))) continue;
    const info = await fs.stat(dir).catch(() => null);
    if (!info) continue;
    worktrees.push({ dir, createdAt: info.birthtimeMs || info.mtimeMs });
  }
  if (worktrees.length <= limit) return result;

  const referenced = new Set(
    [...options.referencedPaths].map((item) => normalizeWorktreePath(item)),
  );
  worktrees.sort((a, b) => a.createdAt - b.createdAt || a.dir.localeCompare(b.dir));

  let remaining = worktrees.length;
  for (const candidate of worktrees) {
    if (remaining <= limit) break;
    if (referenced.has(normalizeWorktreePath(candidate.dir))) {
      result.skippedReferenced += 1;
      continue;
    }
    const status = await gitText(candidate.dir, [
      "status",
      "--porcelain=v1",
      "--untracked-files=normal",
    ]).catch(() => null);
    if (status === null) {
      result.failed += 1;
      continue;
    }
    if (meaningfulStatusLines(status).length) {
      result.skippedDirty += 1;
      continue;
    }

    const commonDir = await worktreeCommonDir(candidate.dir);
    if (!commonDir) {
      result.failed += 1;
      continue;
    }
    const repoRoot = path.dirname(commonDir);
    const head = await gitText(candidate.dir, ["rev-parse", "HEAD"]).catch(() => "");
    if (!head) {
      result.failed += 1;
      continue;
    }
    const branch = await gitText(candidate.dir, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(
      () => "",
    );
    const backupRef = `${BACKUP_REF_PREFIX}${path.basename(candidate.dir)}`;
    try {
      await runGit(repoRoot, ["update-ref", backupRef, head], { timeoutMs: 15_000 });
    } catch {
      result.failed += 1;
      continue;
    }
    try {
      await runGit(repoRoot, ["worktree", "remove", "--force", candidate.dir], {
        timeoutMs: 30_000,
      });
    } catch {
      result.failed += 1;
      continue;
    }
    if (branch.startsWith("meowcode/")) {
      await runGit(repoRoot, ["branch", "-D", branch], { timeoutMs: 15_000 }).catch(
        () => undefined,
      );
    }
    console.warn(`[worktree] removed ${candidate.dir}; backup ${backupRef}`);
    result.removed += 1;
    remaining -= 1;
  }
  return result;
}
