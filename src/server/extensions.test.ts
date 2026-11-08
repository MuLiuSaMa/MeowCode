import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExtensionHost } from "./extensions.js";

const tempDirs: string[] = [];

async function makeHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meow-ext-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function hostFor(home: string) {
  const onSkillCreated = vi.fn();
  const onPluginsChanged = vi.fn(async (_id: string) => ({}) as { toolNames?: string[]; error?: string });
  const host = createExtensionHost({ homeDir: home, onSkillCreated, onPluginsChanged });
  return { host, onSkillCreated, onPluginsChanged };
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

const PLUGIN_CODE = `export default (api) => {
  api.registerTool({
    name: "word_count",
    description: "统计字数",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ ok: true, output: "1" }),
  });
};`;

describe("createSkill", () => {
  it("写 SKILL.md + manual 标记，并刷新技能索引", async () => {
    const home = await makeHome();
    const { host, onSkillCreated } = hostFor(home);

    const result = await host.createSkill({
      id: "weekly-report",
      name: "周报助手",
      description: "用户要写周报时使用",
      body: "# 步骤\n1. 收集本周改动",
    });

    expect(result).toMatchObject({ ok: true, id: "weekly-report" });
    const file = path.join(home, ".meowcode", "skills", "weekly-report", "SKILL.md");
    const raw = await fs.readFile(file, "utf8");
    expect(raw).toContain("name: 周报助手");
    expect(raw).toContain("description: 用户要写周报时使用");
    expect(raw).toContain("# 步骤");
    expect(raw.startsWith("---\n")).toBe(true);

    const marker = JSON.parse(
      await fs.readFile(
        path.join(home, ".meowcode", ".marketplace", "manual-skill-weekly-report.json"),
        "utf8",
      ),
    );
    expect(marker).toMatchObject({
      id: "weekly-report",
      type: "skill",
      target: "skills/weekly-report",
    });
    expect(onSkillCreated).toHaveBeenCalledTimes(1);
  });

  it("非法 id / 缺 description 被拒绝", async () => {
    const home = await makeHome();
    const { host } = hostFor(home);
    await expect(
      host.createSkill({ id: "../evil", description: "x", body: "y" }),
    ).resolves.toMatchObject({ ok: false, stage: "validate" });
    await expect(
      host.createSkill({ id: "Upper-Case", description: "x", body: "y" }),
    ).resolves.toMatchObject({ ok: false, stage: "validate" });
    await expect(host.createSkill({ id: "ok-id", description: "", body: "y" })).resolves.toMatchObject({
      ok: false,
      stage: "validate",
    });
    expect(await exists(path.join(home, ".meowcode", "skills", "ok-id"))).toBe(false);
  });

  it("已存在且非 AI 创建的技能拒绝覆盖；AI 创建的允许覆盖", async () => {
    const home = await makeHome();
    const { host } = hostFor(home);
    const dir = path.join(home, ".meowcode", "skills", "taken");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), "---\nname: taken\ndescription: hand\n---\n");

    await expect(
      host.createSkill({ id: "taken", description: "x", body: "y" }),
    ).resolves.toMatchObject({ ok: false, stage: "validate" });

    const first = await host.createSkill({ id: "mine", description: "v1", body: "one" });
    expect(first.ok).toBe(true);
    const second = await host.createSkill({ id: "mine", description: "v2", body: "two" });
    expect(second.ok).toBe(true);
    expect(await fs.readFile(path.join(home, ".meowcode", "skills", "mine", "SKILL.md"), "utf8")).toContain(
      "two",
    );
  });
});

describe("createPlugin", () => {
  it("写源码 + 头注释 + manual 标记，并返回加载结果", async () => {
    const home = await makeHome();
    const { host, onPluginsChanged } = hostFor(home);
    onPluginsChanged.mockResolvedValueOnce({ toolNames: ["word_count"] });

    const result = await host.createPlugin({
      id: "word-count",
      name: "字数统计",
      description: "统计文本字数",
      code: PLUGIN_CODE,
    });

    expect(result).toMatchObject({ ok: true, id: "word-count", toolNames: ["word_count"] });
    const file = path.join(home, ".meowcode", "plugins", "word-count.ts");
    const raw = await fs.readFile(file, "utf8");
    expect(raw).toContain("// @meowcode name: 字数统计");
    expect(raw).toContain("// @meowcode description: 统计文本字数");
    expect(raw).toContain("export default");
    expect(onPluginsChanged).toHaveBeenCalledWith("word-count");
    expect(
      await exists(path.join(home, ".meowcode", ".marketplace", "manual-plugin-word-count.json")),
    ).toBe(true);
  });

  it("校验：缺 export default / 内置 id / 非法 id", async () => {
    const home = await makeHome();
    const { host } = hostFor(home);
    await expect(
      host.createPlugin({ id: "bad", name: "坏", description: "x", code: "const x = 1;" }),
    ).resolves.toMatchObject({ ok: false, stage: "validate" });
    await expect(
      host.createPlugin({ id: "computer-control", name: "x", description: "x", code: PLUGIN_CODE }),
    ).resolves.toMatchObject({ ok: false, stage: "validate" });
    await expect(
      host.createPlugin({ id: "a/b", name: "x", description: "x", code: PLUGIN_CODE }),
    ).resolves.toMatchObject({ ok: false, stage: "validate" });
  });

  it("加载失败时回滚文件并重载恢复，返回 reload 错误", async () => {
    const home = await makeHome();
    const { host, onPluginsChanged } = hostFor(home);
    onPluginsChanged.mockResolvedValueOnce({ error: "boom" }).mockResolvedValueOnce({});

    const result = await host.createPlugin({
      id: "broken",
      name: "坏插件",
      description: "加载失败",
      code: PLUGIN_CODE,
    });

    expect(result).toMatchObject({ ok: false, stage: "reload" });
    expect(onPluginsChanged).toHaveBeenCalledTimes(2);
    expect(await exists(path.join(home, ".meowcode", "plugins", "broken.ts"))).toBe(false);
  });
});
