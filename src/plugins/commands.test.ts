import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginRegistry } from "./registry.js";
import { discoverMarkdownCommands, expandCommandTemplate, loadCommandIndex } from "./commands.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meow-commands-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("discoverMarkdownCommands", () => {
  it("文件名即命令名，frontmatter description，project 同名遮蔽 user", async () => {
    const project = await makeTempDir();
    const user = await makeTempDir();
    await fs.writeFile(
      path.join(project, "deploy.md"),
      "---\ndescription: Deploy the app\n---\nDeploy $ARGUMENTS now.",
    );
    await fs.writeFile(path.join(project, "notes.md"), "plain body");
    await fs.writeFile(path.join(user, "deploy.md"), "user version");
    await fs.writeFile(path.join(user, "only-user.md"), "user body");
    await fs.writeFile(path.join(project, "not-cmd.txt"), "ignored");

    const commands = await discoverMarkdownCommands([
      { dir: project, source: "project" },
      { dir: user, source: "user" },
    ]);

    expect(commands.map((c) => [c.name, c.source])).toEqual([
      ["deploy", "project"],
      ["notes", "project"],
      ["only-user", "user"],
    ]);
    expect(commands[0]?.description).toBe("Deploy the app");
  });
});

describe("expandCommandTemplate", () => {
  it("$ARGUMENTS 替换；无占位符时参数追加为 Arguments 段", () => {
    expect(expandCommandTemplate({ body: "Do $ARGUMENTS with care" }, "x y")).toBe("Do x y with care");
    expect(expandCommandTemplate({ body: "Fixed prompt" }, "extra")).toBe("Fixed prompt\n\nArguments: extra");
    expect(expandCommandTemplate({ body: "Fixed prompt" }, "  ")).toBe("Fixed prompt");
  });
});

describe("loadCommandIndex.resolve", () => {
  async function setup() {
    const workspace = await makeTempDir();
    const home = await makeTempDir();
    const commandsDir = path.join(workspace, ".meowcode", "commands");
    await fs.mkdir(commandsDir, { recursive: true });
    await fs.writeFile(
      path.join(commandsDir, "deploy.md"),
      "---\ndescription: deploy\n---\nDeploy to $ARGUMENTS.",
    );
    const registry = new PluginRegistry();
    registry.addCommand("plug", { name: "plugcmd", run: async (args) => `plugin ran: ${args}` });
    return loadCommandIndex({ workspace, homeDir: home, registry });
  }

  it("markdown 命令展开", async () => {
    const index = await setup();
    expect(await index.resolve("/deploy prod-a")).toBe("Deploy to prod-a.");
    expect(await index.resolve("/deploy")).toBe("Deploy to .");
  });

  it("插件命令执行 run(args)", async () => {
    const index = await setup();
    expect(await index.resolve("/plugcmd alpha beta")).toBe("plugin ran: alpha beta");
  });

  it("未命中 / 非命令文本返回 null（原样透传）", async () => {
    const index = await setup();
    expect(await index.resolve("/nope args")).toBeNull();
    expect(await index.resolve("plain text with / slash")).toBeNull();
  });

  it("commands() 汇总 markdown 与插件命令", async () => {
    const index = await setup();
    const names = index.commands().map((c) => c.name).sort();
    expect(names).toEqual(["deploy", "plugcmd"]);
  });
});
