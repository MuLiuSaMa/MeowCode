import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GitError,
  assertInsideWorkspace,
  classifyGitError,
  createGitService,
  getStatus,
  isGitAvailable,
  normalizeRepoPath,
  parseNumstatZ,
  parsePorcelainV2,
  runGit,
} from "./git";

/** -z 输出：记录之间是 NUL，rename 的源路径是下一条独立记录。 */
function porcelain(records: string[]): Buffer {
  return Buffer.from(records.join("\0") + "\0", "utf8");
}

describe("parsePorcelainV2", () => {
  it("reads header, ordinary, untracked and ignored entries", () => {
    const parsed = parsePorcelainV2(
      porcelain([
        "# branch.oid abc123",
        "# branch.head main",
        "# branch.upstream origin/main",
        "# branch.ab +2 -1",
        "1 M. N... 100644 100644 100644 aaaa bbbb src/app.ts",
        "1 .M N... 100644 100644 100644 aaaa bbbb docs/说明 文档.md",
        "? new file.txt",
        "! ignored.log",
      ]),
    );
    expect(parsed.branch).toBe("main");
    expect(parsed.upstream).toBe("origin/main");
    expect(parsed.ahead).toBe(2);
    expect(parsed.behind).toBe(1);
    expect(parsed.detached).toBe(false);
    expect(parsed.entries).toEqual([
      { path: "src/app.ts", index: "modified", worktree: null },
      { path: "docs/说明 文档.md", index: null, worktree: "modified" },
      { path: "new file.txt", index: null, worktree: "untracked" },
    ]);
  });

  it("keeps the rename source from the next record", () => {
    const parsed = parsePorcelainV2(
      porcelain([
        "# branch.head main",
        "2 R. N... 100644 100644 100644 aaaa bbbb R100 new name.ts",
        "old name.ts",
        "1 .M N... 100644 100644 100644 aaaa bbbb other.ts",
      ]),
    );
    expect(parsed.entries).toEqual([
      { path: "new name.ts", origPath: "old name.ts", index: "renamed", worktree: null },
      { path: "other.ts", index: null, worktree: "modified" },
    ]);
  });

  it("maps unmerged codes to conflict kinds", () => {
    const parsed = parsePorcelainV2(
      porcelain([
        "# branch.head main",
        "u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflict.ts",
        "u AA N... 100644 100644 100644 100644 aaaa bbbb cccc added.ts",
        "u DU N... 100644 100644 100644 100644 aaaa bbbb cccc deleted.ts",
      ]),
    );
    expect(parsed.entries.map((entry) => entry.conflict)).toEqual([
      "both_modified",
      "both_added",
      "deleted_by_us",
    ]);
    expect(parsed.entries.every((entry) => entry.index === "conflicted")).toBe(true);
  });

  it("marks detached HEAD", () => {
    const parsed = parsePorcelainV2(porcelain(["# branch.head (detached)", "# branch.oid abc"]));
    expect(parsed.detached).toBe(true);
    expect(parsed.branch).toBeUndefined();
  });

  it("handles an empty buffer", () => {
    expect(parsePorcelainV2(Buffer.alloc(0))).toEqual({
      ahead: 0,
      behind: 0,
      detached: false,
      entries: [],
    });
  });
});

describe("parseNumstatZ", () => {
  it("parses ordinary records and binary markers", () => {
    const stats = parseNumstatZ(Buffer.from("10\t2\tsrc/a.ts\0-\t-\timg.png\0", "utf8"));
    expect(stats.get("src/a.ts")).toEqual({ added: 10, removed: 2, binary: false });
    expect(stats.get("img.png")).toEqual({ added: 0, removed: 0, binary: true });
  });

  it("parses rename records with the two extra paths", () => {
    const stats = parseNumstatZ(Buffer.from("3\t1\t\0old.ts\0new.ts\0", "utf8"));
    expect(stats.get("old.ts")).toEqual({ added: 3, removed: 1, binary: false });
    expect(stats.get("new.ts")).toEqual({ added: 3, removed: 1, binary: false });
  });
});

describe("classifyGitError", () => {
  it("recognises the common failures", () => {
    expect(classifyGitError("fatal: not a git repository (or any of the parent directories)")).toBe(
      "not_a_repo",
    );
    expect(
      classifyGitError("*** Please tell me who you are.\nrun git config --global user.email"),
    ).toBe("identity_missing");
    expect(classifyGitError("fatal: Authentication failed for 'https://x/y'")).toBe("auth_required");
    expect(classifyGitError("fatal: unable to access: Could not resolve host: github.com")).toBe(
      "network_error",
    );
    expect(classifyGitError("fatal: The current branch has no upstream branch")).toBe("no_upstream");
    expect(classifyGitError("fatal: a branch named 'x' already exists")).toBe("branch_exists");
    expect(classifyGitError("error: Your local changes would be overwritten by merge")).toBe(
      "dirty_worktree",
    );
    expect(classifyGitError("something odd")).toBe("git_failed");
  });
});

describe("path guards", () => {
  const root = path.resolve("/tmp/repo");
  const workspace = path.resolve("/tmp/repo/packages/app");

  it("accepts repository-relative paths", () => {
    expect(normalizeRepoPath(root, "src/a.ts")).toBe("src/a.ts");
    expect(normalizeRepoPath(root, "src\\a.ts")).toBe("src/a.ts");
  });

  it("rejects absolute paths, traversal and control characters", () => {
    expect(() => normalizeRepoPath(root, "C:/Windows/system32")).toThrow(GitError);
    expect(() => normalizeRepoPath(root, "/etc/passwd")).toThrow(GitError);
    expect(() => normalizeRepoPath(root, "../outside.ts")).toThrow(GitError);
    expect(() => normalizeRepoPath(root, "a/\0b")).toThrow(GitError);
    expect(() => normalizeRepoPath(root, "  ")).toThrow(GitError);
  });

  it("limits destructive operations to the workspace", () => {
    expect(() => assertInsideWorkspace(root, workspace, "packages/app/src/a.ts")).not.toThrow();
    expect(() => assertInsideWorkspace(root, workspace, "packages/other/a.ts")).toThrow(GitError);
  });
});

// ---- 真实 git 集成（没装 git 就跳过） ----

const hasGit = await isGitAvailable();
const describeGit = hasGit ? describe : describe.skip;

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "meowcode-git-"));
  await runGit(root, ["init", "-q", "-b", "main"]).catch(async () => {
    // 老 git 不支持 -b
    await runGit(root, ["init", "-q"]);
  });
  return root;
}

/**
 * Windows 上每条 git 命令 spawn 约 200–500ms，一个用例要跑 4–5 条命令；
 * 并行跑全量时容易撞上默认 5s 超时，这里统一放宽到 30s。
 */
const slow = (name: string, fn: () => Promise<void>) => it(name, fn, 30_000);

describeGit("git service integration", () => {
  const dirs: string[] = [];

  beforeAll(() => {
    // 提交身份：不走全局配置，避免 CI 上 identity_missing
    process.env.GIT_AUTHOR_NAME = "MeowCode Test";
    process.env.GIT_AUTHOR_EMAIL = "test@example.com";
    process.env.GIT_COMMITTER_NAME = "MeowCode Test";
    process.env.GIT_COMMITTER_EMAIL = "test@example.com";
  });

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    delete process.env.GIT_AUTHOR_NAME;
    delete process.env.GIT_AUTHOR_EMAIL;
    delete process.env.GIT_COMMITTER_NAME;
    delete process.env.GIT_COMMITTER_EMAIL;
  });

  slow("reports a non-repo workspace without throwing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-notgit-"));
    dirs.push(dir);
    const status = await getStatus(dir);
    expect(status.isRepo).toBe(false);
    expect(status.reason).toBe("not_a_repo");
  });

  slow("walks status → diff → stage → commit → log", async () => {
    const root = await makeRepo();
    dirs.push(root);
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "app.ts"), "export const a = 1;\n");
    const service = createGitService({ workspace: root });

    // untracked 出现在 unstaged
    const initial = await service.status();
    expect(initial.isRepo).toBe(true);
    expect(initial.root && path.resolve(initial.root)).toBe(path.resolve(await runGit(root, ["rev-parse", "--show-toplevel"]).then((r) => r.stdout.toString("utf8").trim())));
    expect(initial.unstaged.map((entry) => entry.path)).toEqual(["src/app.ts"]);
    expect(initial.unstaged[0].worktree).toBe("untracked");

    // untracked 的合成 patch
    const diff = await service.diff({ path: "src/app.ts", scope: "worktree" });
    expect(diff.patch).toContain("new file mode");
    expect(diff.patch).toContain("+export const a = 1;");
    expect(diff.added).toBe(1);

    // stage 后进入 staged，工作区侧消失
    await service.stage(["src/app.ts"]);
    const staged = await service.status();
    expect(staged.staged.map((entry) => entry.path)).toEqual(["src/app.ts"]);
    expect(staged.staged[0].index).toBe("added");
    expect(staged.unstaged).toEqual([]);

    // commit → log
    const created = await service.commit("feat: add app");
    expect(created.subject).toBe("feat: add app");
    const log = await service.log({ limit: 10 });
    expect(log.commits[0].subject).toBe("feat: add app");
    expect(log.commits[0].sha).toBe(created.sha);

    // 干净文件没有 diff：不能凭空合成「新文件」补丁（刚提交完，工作区与 HEAD 一致）
    const cleanDiff = await service.diff({ path: "src/app.ts" });
    expect(cleanDiff.patch).toBe("");

    // 修改文件后 diff 走普通 patch
    await writeFile(path.join(root, "src", "app.ts"), "export const a = 2;\n");
    const modified = await service.status();
    expect(modified.unstaged[0]).toMatchObject({ path: "src/app.ts", worktree: "modified" });
    const worktreeDiff = await service.diff({ path: "src/app.ts" });
    expect(worktreeDiff.patch).toContain("-export const a = 1;");
    expect(worktreeDiff.removed).toBe(1);

    // showCommit 带文件清单
    const shown = await service.showCommit(created.sha);
    expect(shown.files.map((file) => file.path)).toEqual(["src/app.ts"]);
    expect(shown.patch).toContain("+export const a = 1;");
  });

  slow("unstage works before the first commit (unborn HEAD)", async () => {
    const root = await makeRepo();
    dirs.push(root);
    await writeFile(path.join(root, "a.txt"), "hello\n");
    const service = createGitService({ workspace: root });
    await service.stage(["a.txt"]);
    expect((await service.status()).staged).toHaveLength(1);
    await service.unstage(["a.txt"]);
    const after = await service.status();
    expect(after.staged).toEqual([]);
    expect(after.unstaged.map((entry) => entry.path)).toEqual(["a.txt"]);
  });

  slow("discards tracked changes and removes untracked files", async () => {
    const root = await makeRepo();
    dirs.push(root);
    await writeFile(path.join(root, "tracked.txt"), "one\n");
    const service = createGitService({ workspace: root });
    await service.stage(["tracked.txt"]);
    await service.commit("chore: seed");
    await writeFile(path.join(root, "tracked.txt"), "two\n");
    await writeFile(path.join(root, "loose.txt"), "loose\n");

    const result = await service.discard(["tracked.txt", "loose.txt"]);
    expect(result.discarded).toBe(2);
    const status = await service.status();
    expect(status.unstaged).toEqual([]);
    expect(status.staged).toEqual([]);
  });

  slow("creates and switches branches", async () => {
    const root = await makeRepo();
    dirs.push(root);
    await writeFile(path.join(root, "a.txt"), "hello\n");
    const service = createGitService({ workspace: root });
    await service.stage(["a.txt"]);
    await service.commit("chore: seed");

    const created = await service.createBranch("feature/x");
    expect(created.branch).toBe("feature/x");
    const branches = await service.branches();
    expect(branches.current).toBe("feature/x");
    expect(branches.branches.map((branch) => branch.name)).toEqual(["feature/x", "main"]);

    await service.switchBranch({ name: "main" });
    expect((await service.branches()).current).toBe("main");
  });

  slow("rejects traversal in stage paths", async () => {
    const root = await makeRepo();
    dirs.push(root);
    const service = createGitService({ workspace: root });
    await expect(service.stage(["../outside.txt"])).rejects.toBeInstanceOf(GitError);
    await expect(service.stage(["C:/Windows/win.ini"])).rejects.toBeInstanceOf(GitError);
  });

  slow("fails fast when a remote has no credentials", async () => {
    const root = await makeRepo();
    dirs.push(root);
    await writeFile(path.join(root, "a.txt"), "hello\n");
    const service = createGitService({ workspace: root });
    await service.stage(["a.txt"]);
    await service.commit("chore: seed");
    await runGit(root, ["remote", "add", "origin", "https://127.0.0.1:9/definitely-missing.git"]);
    const started = Date.now();
    await expect(service.push({})).rejects.toBeInstanceOf(GitError);
    // 不能挂在等输入上（GIT_TERMINAL_PROMPT=0 + 无凭据）
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  slow("explains push without an origin remote instead of failing vaguely", async () => {
    const root = await makeRepo();
    dirs.push(root);
    await writeFile(path.join(root, "a.txt"), "hello\n");
    const service = createGitService({ workspace: root });
    await service.stage(["a.txt"]);
    await service.commit("chore: seed");
    await expect(service.push({})).rejects.toMatchObject({ code: "no_upstream" });
  });

  slow("returns an empty log for a repository without commits", async () => {
    const root = await makeRepo();
    dirs.push(root);
    const service = createGitService({ workspace: root });
    await expect(service.log({ limit: 5 })).resolves.toEqual({ commits: [], hasMore: false });
  });
});
