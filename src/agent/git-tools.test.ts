import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { isGitAvailable, runGit } from "../git/git.js";
import { executeGitTool, isForceApprovalGitAction, isMutatingGitAction } from "./git-tools.js";

const gitAvailable = await isGitAvailable();

async function repo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "meowcode-git-"));
  await runGit(dir, ["init", "-q"]);
  await runGit(dir, ["config", "user.email", "test@example.com"]);
  await runGit(dir, ["config", "user.name", "Test"]);
  return dir;
}

describe.skipIf(!gitAvailable)("git tool", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await repo();
  });

  it("status → stage → commit 往返", async () => {
    await writeFile(path.join(dir, "a.txt"), "hello\n");
    const status = await executeGitTool({ action: "status" }, dir);
    expect(status.ok).toBe(true);
    expect(status.output).toContain("a.txt");

    expect((await executeGitTool({ action: "stage", paths: ["a.txt"] }, dir)).ok).toBe(true);
    const committed = await executeGitTool({ action: "commit", message: "init" }, dir);
    expect(committed.ok).toBe(true);
    expect(committed.output).toContain("init");

    const log = await executeGitTool({ action: "log", limit: 5 }, dir);
    expect(log.output).toContain("init");
  });

  it("diff 返回补丁与统计", async () => {
    await writeFile(path.join(dir, "a.txt"), "hello\nworld\n");
    const diff = await executeGitTool({ action: "diff" }, dir);
    expect(diff.ok).toBe(true);
    expect(diff.output).toContain("+world");
  });

  it("discard 恢复工作区修改", async () => {
    await writeFile(path.join(dir, "a.txt"), "changed\n");
    const discarded = await executeGitTool({ action: "discard", paths: ["a.txt"] }, dir);
    expect(discarded.ok).toBe(true);
    const status = await executeGitTool({ action: "status" }, dir);
    expect(status.output).toContain("working tree clean");
  });

  it("未知 action 与缺失参数给出明确错误", async () => {
    expect((await executeGitTool({ action: "nope" }, dir)).ok).toBe(false);
    expect((await executeGitTool({ action: "commit" }, dir)).ok).toBe(false);
    expect((await executeGitTool({ action: "branch_create" }, dir)).ok).toBe(false);
  });

  it("审批分类：读操作免审批，高危操作强制确认", () => {
    expect(isMutatingGitAction({ action: "status" })).toBe(false);
    expect(isMutatingGitAction({ action: "commit" })).toBe(true);
    expect(isForceApprovalGitAction({ action: "push" })).toBe(true);
    expect(isForceApprovalGitAction({ action: "discard" })).toBe(true);
    expect(isForceApprovalGitAction({ action: "stage" })).toBe(false);
  });
});
