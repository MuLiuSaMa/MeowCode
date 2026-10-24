import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadWorkspaceInstructions } from "./instructions";

const emptyHome = await mkdtemp(path.join(tmpdir(), "meowcode-instructions-home-"));

afterAll(async () => {
  await rm(emptyHome, { recursive: true, force: true });
});

async function makeWorkspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "meowcode-instructions-"));
}

describe("loadWorkspaceInstructions", () => {
  it("loads AGENTS.md from the workspace root", async () => {
    const workspace = await makeWorkspace();
    try {
      await writeFile(path.join(workspace, "AGENTS.md"), "RULE ONE");
      const instructions = await loadWorkspaceInstructions(workspace, emptyHome);
      expect(instructions).toContain("RULE ONE");
      expect(instructions).toContain("AGENTS.md");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("combines root and .meowcode instructions", async () => {
    const workspace = await makeWorkspace();
    try {
      await writeFile(path.join(workspace, "AGENTS.md"), "ROOT RULE");
      await mkdir(path.join(workspace, ".meowcode"), { recursive: true });
      await writeFile(path.join(workspace, ".meowcode", "AGENTS.md"), "LOCAL RULE");
      const instructions = await loadWorkspaceInstructions(workspace, emptyHome);
      expect(instructions).toContain("ROOT RULE");
      expect(instructions).toContain("LOCAL RULE");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("truncates oversized instructions", async () => {
    const workspace = await makeWorkspace();
    try {
      await writeFile(path.join(workspace, "AGENTS.md"), "x".repeat(20_000));
      const instructions = await loadWorkspaceInstructions(workspace, emptyHome);
      expect(instructions).toContain("[AGENTS.md truncated]");
      expect(instructions!.length).toBeLessThan(16_500);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("returns undefined when no instructions exist", async () => {
    const workspace = await makeWorkspace();
    try {
      expect(await loadWorkspaceInstructions(workspace, emptyHome)).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("ignores AGENTS.md symlinks that escape the workspace", async () => {
    const workspace = await makeWorkspace();
    const outside = await mkdtemp(path.join(tmpdir(), "meowcode-instructions-outside-"));
    try {
      await writeFile(path.join(outside, "secret.md"), "OUTSIDE SECRET");
      try {
        await symlink(path.join(outside, "secret.md"), path.join(workspace, "AGENTS.md"), "file");
      } catch {
        // Windows 无符号链接权限时跳过该用例
        return;
      }
      expect(await loadWorkspaceInstructions(workspace, emptyHome)).toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("appends the global skill index from homeDir", async () => {
    const workspace = await makeWorkspace();
    const home = await mkdtemp(path.join(tmpdir(), "meowcode-instructions-home2-"));
    try {
      const skillDir = path.join(home, ".meowcode", "skills", "demo-global-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, "SKILL.md"),
        "---\nname: demo-global-skill\ndescription: A global skill for tests\n---\nbody",
      );
      const instructions = await loadWorkspaceInstructions(workspace, home);
      expect(instructions).toContain("demo-global-skill");
      expect(instructions).toContain("A global skill for tests");
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
});
