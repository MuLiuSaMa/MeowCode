import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isGitAvailable, runGit } from "../git/git";
import {
  createSessionWorktree,
  pruneSessionWorktrees,
  removeSessionWorktree,
} from "./worktree";

const hasGit = await isGitAvailable();
const describeGit = hasGit ? describe : describe.skip;
const slow = (name: string, fn: () => Promise<void>) => it(name, fn, 30_000);

async function makeRepo(): Promise<{ root: string; worktreesDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "meowcode-worktree-"));
  const worktreesDir = await mkdtemp(path.join(tmpdir(), "meowcode-worktrees-"));
  await runGit(root, ["init", "-q", "-b", "main"]).catch(async () => {
    await runGit(root, ["init", "-q"]);
  });
  return { root, worktreesDir };
}

async function commitAll(root: string, message = "init"): Promise<string> {
  await runGit(root, ["add", "-A"]);
  await runGit(root, ["commit", "-q", "-m", message]);
  const { stdout } = await runGit(root, ["rev-parse", "HEAD"]);
  return stdout.toString("utf8").trim();
}

describeGit("session worktree", () => {
  const dirs: string[] = [];

  beforeAll(() => {
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

  async function prepare(): Promise<{ root: string; worktreesDir: string; baseSha: string }> {
    const { root, worktreesDir } = await makeRepo();
    dirs.push(root, worktreesDir);
    await writeFile(path.join(root, "README.md"), "hello\n");
    const baseSha = await commitAll(root);
    return { root, worktreesDir, baseSha };
  }

  slow("creates an isolated worktree on a fresh branch", async () => {
    const { root, worktreesDir, baseSha } = await prepare();
    const created = await createSessionWorktree(root, worktreesDir);

    expect(created.worktree.repoRoot).toBe(path.resolve(root));
    expect(created.worktree.sourceCwd).toBe(path.resolve(root));
    expect(created.worktree.baseSha).toBe(baseSha);
    expect(created.worktree.branch).toMatch(/^meowcode\//);
    expect(created.cwd).toBe(created.worktree.path);
    expect(created.dirty).toBe(false);
    expect((await readFile(path.join(created.cwd, "README.md"), "utf8")).trim()).toBe("hello");

    const branch = (await runGit(created.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]))
      .stdout.toString("utf8")
      .trim();
    expect(branch).toBe(created.worktree.branch);

    await writeFile(path.join(created.cwd, "inside.txt"), "only in worktree\n");
    const mainStatus = (await runGit(root, ["status", "--porcelain"])).stdout.toString("utf8");
    expect(mainStatus.trim()).toBe("");
  });

  slow("keeps a subdirectory as the session cwd", async () => {
    const { root, worktreesDir } = await makeRepo();
    dirs.push(root, worktreesDir);
    await mkdir(path.join(root, "packages", "app"), { recursive: true });
    await writeFile(path.join(root, "packages", "app", "index.ts"), "export const a = 1;\n");
    await commitAll(root);

    const created = await createSessionWorktree(path.join(root, "packages", "app"), worktreesDir);
    expect(created.cwd).toBe(path.join(created.worktree.path, "packages", "app"));
    expect((await stat(created.cwd)).isDirectory()).toBe(true);
  });

  slow("reports a dirty main worktree but bases on HEAD", async () => {
    const { root, worktreesDir } = await prepare();
    await writeFile(path.join(root, "uncommitted.txt"), "not in worktree\n");

    const created = await createSessionWorktree(root, worktreesDir);
    expect(created.dirty).toBe(true);
    await expect(stat(path.join(created.cwd, "uncommitted.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  slow("rejects a non-repository workspace", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-notgit-"));
    const worktreesDir = await mkdtemp(path.join(tmpdir(), "meowcode-worktrees-"));
    dirs.push(dir, worktreesDir);
    await expect(createSessionWorktree(dir, worktreesDir)).rejects.toMatchObject({
      code: "not_a_repo",
    });
  });

  slow("rejects a repository without commits", async () => {
    const { root, worktreesDir } = await makeRepo();
    dirs.push(root, worktreesDir);
    await expect(createSessionWorktree(root, worktreesDir)).rejects.toMatchObject({
      code: "git_failed",
    });
  });

  slow("rolls a just-created worktree back", async () => {
    const { root, worktreesDir } = await prepare();
    const created = await createSessionWorktree(root, worktreesDir);
    await removeSessionWorktree(created.worktree);
    await expect(stat(created.worktree.path)).rejects.toMatchObject({ code: "ENOENT" });
    const branches = (await runGit(root, ["branch", "--list", created.worktree.branch]))
      .stdout.toString("utf8")
      .trim();
    expect(branches).toBe("");
  });

  slow("falls back to HEAD when there is no upstream to fetch", async () => {
    const { root, worktreesDir, baseSha } = await prepare();
    const created = await createSessionWorktree(root, worktreesDir, { fetchUpstream: true });
    expect(created.worktree.baseSha).toBe(baseSha);
  });

  slow("prunes the oldest clean unreferenced worktree and keeps a backup ref", async () => {
    const { root, worktreesDir } = await prepare();
    const oldest = await createSessionWorktree(root, worktreesDir);
    const referenced = await createSessionWorktree(root, worktreesDir);
    const dirty = await createSessionWorktree(root, worktreesDir);
    await writeFile(path.join(dirty.cwd, "dirty.txt"), "keep me\n");

    const result = await pruneSessionWorktrees({
      worktreesDir,
      maxKeep: 1,
      referencedPaths: new Set([referenced.worktree.path]),
    });

    expect(result.removed).toBe(1);
    expect(result.skippedReferenced).toBe(1);
    expect(result.skippedDirty).toBe(1);
    expect(result.failed).toBe(0);
    await expect(stat(oldest.worktree.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(referenced.worktree.path)).isDirectory()).toBe(true);
    expect((await stat(dirty.worktree.path)).isDirectory()).toBe(true);

    const refs = (
      await runGit(root, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/meowcode-backup/",
      ])
    ).stdout.toString("utf8");
    expect(refs).toContain(path.basename(oldest.worktree.path));
    const branches = (
      await runGit(root, ["branch", "--list", oldest.worktree.branch])
    ).stdout.toString("utf8").trim();
    expect(branches).toBe("");
  });
});
