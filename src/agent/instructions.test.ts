import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadWorkspaceInstructions, loadWorkspaceInstructionsDetail } from "./instructions";
import { saveMemory } from "./memory";

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
      // 记忆段常驻（ZCode 同款）：预算只约束 AGENTS.md 部分，截断后去掉记忆段再断言
      const memoryStart = instructions!.indexOf("## Memory");
      expect(instructions!.slice(0, memoryStart).length).toBeLessThan(16_500);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("returns the always-on memory guide when no instructions exist", async () => {
    const workspace = await makeWorkspace();
    try {
      const instructions = await loadWorkspaceInstructions(workspace, emptyHome);
      // 记忆段常驻：即使什么都没有也注入准则（此前为 undefined）
      expect(instructions).toContain("## Memory");
      expect(instructions).toContain("memory_write");
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
      const instructions = await loadWorkspaceInstructions(workspace, emptyHome);
      expect(instructions).not.toContain("OUTSIDE SECRET");
      expect(instructions).toContain("## Memory");
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
      const detail = await loadWorkspaceInstructionsDetail(workspace, home);
      expect(detail.text).toContain("demo-global-skill");
      expect(detail.text).toContain("A global skill for tests");
      // 技能索引单独归因：文本与数量都能拿到（上下文来源里的「Skill（N个）」）
      expect(detail.skillIndex).toContain("demo-global-skill");
      expect(detail.skillCount).toBe(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("merges ancestor AGENTS.md files outer-to-inner before workspace rules", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-instructions-nested-"));
    const workspace = path.join(root, "packages", "app");
    await mkdir(workspace, { recursive: true });
    try {
      await writeFile(path.join(root, "AGENTS.md"), "PARENT RULE");
      await writeFile(path.join(workspace, "AGENTS.md"), "CHILD RULE");
      const instructions = await loadWorkspaceInstructions(workspace, emptyHome);
      expect(instructions).toContain("PARENT RULE");
      expect(instructions).toContain("CHILD RULE");
      // 外→内：祖先在前，来源标注可定位
      expect(instructions!.indexOf("PARENT RULE")).toBeLessThan(
        instructions!.indexOf("CHILD RULE"),
      );
      expect(instructions).toContain("<!-- from:");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips ancestor AGENTS.md symlinks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-instructions-nested2-"));
    const workspace = path.join(root, "app");
    const outside = await mkdtemp(path.join(tmpdir(), "meowcode-instructions-out2-"));
    await mkdir(workspace, { recursive: true });
    try {
      await writeFile(path.join(outside, "secret.md"), "ANCESTOR SECRET");
      try {
        await symlink(path.join(outside, "secret.md"), path.join(root, "AGENTS.md"), "file");
      } catch {
        // Windows 无符号链接权限时跳过该用例
        return;
      }
      const instructions = await loadWorkspaceInstructions(workspace, emptyHome);
      expect(instructions).not.toContain("ANCESTOR SECRET");
      expect(instructions).toContain("## Memory");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("truncates oversized ancestor rules per level", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-instructions-big-"));
    const workspace = path.join(root, "app");
    await mkdir(workspace, { recursive: true });
    try {
      await writeFile(path.join(root, "AGENTS.md"), "y".repeat(5_000));
      const instructions = await loadWorkspaceInstructions(workspace, emptyHome);
      expect(instructions).toContain("[AGENTS.md truncated]");
      // 单层 4k 预算：祖先内容不挤占工作区空间
      const marker = instructions!.indexOf("<!-- from:");
      const ancestorText = instructions!.slice(marker, instructions!.indexOf("]", marker));
      expect(ancestorText.length).toBeLessThan(4_300);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drops ancestors first when the workspace rules fill the budget", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-instructions-budget-"));
    const workspace = path.join(root, "app");
    await mkdir(workspace, { recursive: true });
    try {
      await writeFile(path.join(root, "AGENTS.md"), "ANCESTOR SHOULD DROP");
      // 工作区文件超过总预算：祖先整层被丢弃，工作区规则优先足额
      await writeFile(path.join(workspace, "AGENTS.md"), "z".repeat(16_500));
      const instructions = await loadWorkspaceInstructions(workspace, emptyHome);
      expect(instructions).not.toContain("ANCESTOR SHOULD DROP");
      expect(instructions).toContain("z".repeat(1_000));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("appends the memory index after workspace instructions", async () => {
    const workspace = await makeWorkspace();
    const home = await mkdtemp(path.join(tmpdir(), "meowcode-instructions-home3-"));
    try {
      await writeFile(path.join(workspace, "AGENTS.md"), "ROOT RULE");
      await saveMemory(path.join(home, ".meowcode", "memory"), "user-pref", {
        description: "用户级偏好",
        content: "body",
      });
      await mkdir(path.join(workspace, ".meowcode", "memory"), { recursive: true });
      await saveMemory(path.join(workspace, ".meowcode", "memory"), "project-fact", {
        description: "项目级事实",
        content: "body",
      });
      const instructions = await loadWorkspaceInstructions(workspace, home);
      expect(instructions).toContain("ROOT RULE");
      expect(instructions).toContain("## Memory");
      expect(instructions).toContain("[user-pref](user-pref.md) — 用户级偏好");
      expect(instructions).toContain("[project-fact](project-fact.md) — 项目级事实");
      // 记忆段在 AGENTS.md 规则之后
      expect(instructions!.indexOf("ROOT RULE")).toBeLessThan(instructions!.indexOf("## Memory"));
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("returns the memory section alone when no AGENTS.md exists", async () => {
    const workspace = await makeWorkspace();
    const home = await mkdtemp(path.join(tmpdir(), "meowcode-instructions-home4-"));
    try {
      await saveMemory(path.join(home, ".meowcode", "memory"), "only-memory", {
        description: "只有记忆",
        content: "body",
      });
      const instructions = await loadWorkspaceInstructions(workspace, home);
      expect(instructions).toContain("## Memory");
      expect(instructions).toContain("[only-memory](only-memory.md) — 只有记忆");
      expect(instructions).not.toContain("AGENTS.md"); // 不带 AGENTS 前缀误导
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("loads CLAUDE.md and CLAUDE.local.md by default", async () => {
    const workspace = await makeWorkspace();
    try {
      await writeFile(path.join(workspace, "CLAUDE.md"), "CLAUDE RULE");
      await writeFile(path.join(workspace, "CLAUDE.local.md"), "LOCAL CLAUDE RULE");
      const detail = await loadWorkspaceInstructionsDetail(workspace, emptyHome);
      expect(detail.text).toContain("CLAUDE RULE");
      expect(detail.text).toContain("LOCAL CLAUDE RULE");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("can skip CLAUDE.md while keeping AGENTS.md", async () => {
    const workspace = await makeWorkspace();
    try {
      await writeFile(path.join(workspace, "AGENTS.md"), "AGENTS RULE");
      await writeFile(path.join(workspace, "CLAUDE.md"), "CLAUDE RULE");
      const detail = await loadWorkspaceInstructionsDetail(workspace, emptyHome, {
        includeClaudeMd: false,
      });
      expect(detail.text).toContain("AGENTS RULE");
      expect(detail.text).not.toContain("CLAUDE RULE");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("can skip AGENTS.md while keeping CLAUDE.md", async () => {
    const workspace = await makeWorkspace();
    try {
      await writeFile(path.join(workspace, "AGENTS.md"), "AGENTS RULE");
      await writeFile(path.join(workspace, "CLAUDE.md"), "CLAUDE RULE");
      const detail = await loadWorkspaceInstructionsDetail(workspace, emptyHome, {
        includeAgentsMd: false,
      });
      expect(detail.text).not.toContain("AGENTS RULE");
      expect(detail.text).toContain("CLAUDE RULE");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("injects project rules from .meowcode/rules", async () => {
    const workspace = await makeWorkspace();
    try {
      const rulesDir = path.join(workspace, ".meowcode", "rules");
      await mkdir(rulesDir, { recursive: true });
      await writeFile(path.join(rulesDir, "code-style.md"), "# Style\n\nUSE TABS");
      const detail = await loadWorkspaceInstructionsDetail(workspace, emptyHome);
      expect(detail.text).toContain("Project rules");
      expect(detail.text).toContain("code-style");
      expect(detail.text).toContain("USE TABS");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
