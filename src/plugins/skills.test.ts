import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSkillIndexText, discoverSkills, loadSkillIndex } from "./skills.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meow-skills-"));
  tempDirs.push(dir);
  return dir;
}

async function writeSkill(
  root: string,
  name: string,
  frontmatter: string,
  body: string,
): Promise<void> {
  const dir = path.join(root, ".meowcode", "skills", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("discoverSkills", () => {
  it("frontmatter name/description/always；无 description 跳过；project 遮蔽 user", async () => {
    const project = await makeTempDir();
    const user = await makeTempDir();
    await writeSkill(project, "alpha", "name: alpha\ndescription: Alpha skill", "alpha body");
    await writeSkill(project, "nodesc", "name: nodesc", "body");
    await writeSkill(user, "alpha", "name: alpha\ndescription: user alpha", "user body");
    await writeSkill(user, "beta", "description: Beta skill\nalways: true", "beta body");

    const skills = await discoverSkills([
      { dir: path.join(project, ".meowcode", "skills"), source: "project" },
      { dir: path.join(user, ".meowcode", "skills"), source: "user" },
    ]);

    expect(skills.map((s) => [s.name, s.source, s.always])).toEqual([
      ["alpha", "project", false],
      ["beta", "user", true],
    ]);
  });

  it("frontmatter 缺 name 时回退目录名", async () => {
    const project = await makeTempDir();
    await writeSkill(project, "dirname", "description: desc only", "body");
    const skills = await discoverSkills([
      { dir: path.join(project, ".meowcode", "skills"), source: "project" },
    ]);
    expect(skills[0]?.name).toBe("dirname");
  });
});

describe("buildSkillIndexText", () => {
  it("索引行 + always 技能全文内联（超长截断）", () => {
    const text = buildSkillIndexText([
      {
        name: "alpha",
        description: "Alpha skill",
        always: false,
        path: "D:/w/.meowcode/skills/alpha/SKILL.md",
        source: "project",
        body: "b",
      },
      {
        name: "beta",
        description: "Beta skill",
        always: true,
        path: "D:/w/.meowcode/skills/beta/SKILL.md",
        source: "user",
        body: "B".repeat(5000),
      },
    ]);
    expect(text).toContain("- alpha: Alpha skill (read D:/w/.meowcode/skills/alpha/SKILL.md for details)");
    expect(text).toContain("## Skill: beta");
    expect(text).toContain('[skill "beta" truncated]');
  });

  it("空列表返回 undefined", () => {
    expect(buildSkillIndexText([])).toBeUndefined();
  });
});

describe("loadSkillIndex", () => {
  it("workspace 技能进入索引；无技能时 undefined", async () => {
    const workspace = await makeTempDir();
    const home = await makeTempDir();
    expect(await loadSkillIndex({ workspace, homeDir: home })).toBeUndefined();

    await writeSkill(workspace, "ws-skill", "description: from workspace", "body");
    const text = await loadSkillIndex({ workspace, homeDir: home });
    expect(text).toContain("- ws-skill: from workspace");
  });

  it("内置技能进入索引，同名用户技能优先", async () => {
    const marketplace = await makeTempDir();
    const workspace = await makeTempDir();
    const home = await makeTempDir();
    const builtinDir = path.join(marketplace, "builtin-skills");
    const builtinSkill = path.join(builtinDir, "maker");
    await fs.mkdir(builtinSkill, { recursive: true });
    await fs.writeFile(
      path.join(builtinSkill, "SKILL.md"),
      "---\nname: maker\ndescription: builtin maker\n---\nbody",
    );

    const builtinOnly = await loadSkillIndex({ workspace, homeDir: home, builtinDir });
    expect(builtinOnly).toContain("builtin maker");

    await writeSkill(home, "maker", "name: maker\ndescription: user maker", "user");
    const overridden = await loadSkillIndex({ workspace, homeDir: home, builtinDir });
    expect(overridden).toContain("user maker");
    expect(overridden).not.toContain("builtin maker");
  });
});
