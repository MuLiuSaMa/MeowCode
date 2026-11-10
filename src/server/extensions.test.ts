import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPlugins } from "../plugins/loader.js";
import { PluginRegistry } from "../plugins/registry.js";
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
    const dir = path.join(home, ".meowcode", "plugins", "word-count");
    const raw = await fs.readFile(path.join(dir, "index.ts"), "utf8");
    expect(raw).toContain("// @meowcode name: 字数统计");
    expect(raw).toContain("// @meowcode description: 统计文本字数");
    expect(raw).toContain("export default");
    const manifest = JSON.parse(await fs.readFile(path.join(dir, "plugin.json"), "utf8")) as {
      apiVersion: number;
      main: string;
      permissions: string[];
    };
    expect(manifest).toMatchObject({
      id: "word-count",
      apiVersion: 2,
      main: "index.ts",
      permissions: ["tools", "hooks", "commands", "storage"],
    });
    expect(onPluginsChanged).toHaveBeenCalledWith("word-count");
    expect(
      await exists(path.join(home, ".meowcode", ".marketplace", "manual-plugin-word-count.json")),
    ).toBe(true);
    expect(
      await exists(path.join(home, ".meowcode", ".marketplace", "ai-plugin-word-count.json")),
    ).toBe(true);
  });

  it("带 client 写 ui/client.js 与 manifest，自动补 ui 权限", async () => {
    const home = await makeHome();
    const { host, onPluginsChanged } = hostFor(home);
    onPluginsChanged.mockResolvedValueOnce({ toolNames: ["word_count"] });
    const client = `return { apply(ctx) {
      return ctx.slots.register("session.header.actions", { id: "hello", order: 1 }, () => null);
    } };`;

    const result = await host.createPlugin({
      id: "ui-plugin",
      name: "界面插件",
      description: "带标题栏按钮",
      code: PLUGIN_CODE,
      client,
      permissions: ["tools"],
    });

    expect(result).toMatchObject({ ok: true, client: true });
    const dir = path.join(home, ".meowcode", "plugins", "ui-plugin");
    const manifest = JSON.parse(await fs.readFile(path.join(dir, "plugin.json"), "utf8")) as {
      client?: string;
      permissions: string[];
    };
    expect(manifest.client).toBe("ui/client.js");
    expect(manifest.permissions).toEqual(["tools", "ui", "rpc", "storage", "prompt"]);
    expect(await fs.readFile(path.join(dir, "ui", "client.js"), "utf8")).toContain("slots.register");
  });

  it("client 语法错误在落盘前拒绝", async () => {
    const home = await makeHome();
    const { host, onPluginsChanged } = hostFor(home);
    const result = await host.createPlugin({
      id: "bad-client",
      name: "坏界面",
      description: "语法错误",
      code: PLUGIN_CODE,
      client: "return { apply(ctx) { this is not javascript",
    });
    expect(result).toMatchObject({ ok: false, stage: "validate" });
    expect(onPluginsChanged).not.toHaveBeenCalled();
    expect(await exists(path.join(home, ".meowcode", "plugins", "bad-client"))).toBe(false);
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
    expect(await exists(path.join(home, ".meowcode", "plugins", "broken"))).toBe(false);
  });

  it("创建后 loadPlugins 直接识别 client 与 aiAuthored", async () => {
    const home = await makeHome();
    const { host } = hostFor(home);
    await host.createPlugin({
      id: "ai-ui",
      name: "AI 界面插件",
      description: "创建后即可用",
      code: PLUGIN_CODE,
      client: `return { apply(ctx) {
        return ctx.slots.register("session.header.actions", { id: "hello" }, () => null);
      } };`,
    });

    const registry = new PluginRegistry();
    const { descriptors, errors } = await loadPlugins({
      workspace: await makeHome(),
      homeDir: home,
      registry,
    });
    const descriptor = descriptors.find((item) => item.id === "ai-ui");
    expect(errors).toEqual([]);
    expect(descriptor?.aiAuthored).toBe(true);
    expect(descriptor?.ui?.client?.entry).toBe("client.js");
    expect(descriptor?.manifest?.permissions).toContain("ui");
    registry.unregisterAll();
  });

  it("覆盖旧的 AI 单文件插件时迁移成目录包并移除旧文件", async () => {
    const home = await makeHome();
    const { host, onPluginsChanged } = hostFor(home);
    onPluginsChanged.mockResolvedValueOnce({ toolNames: ["word_count"] });
    const pluginsDir = path.join(home, ".meowcode", "plugins");
    const legacy = path.join(pluginsDir, "legacy-ai.ts");
    await fs.mkdir(pluginsDir, { recursive: true });
    await fs.writeFile(legacy, "export default () => {};\n", "utf8");
    await fs.mkdir(path.join(home, ".meowcode", ".marketplace"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".meowcode", ".marketplace", "manual-plugin-legacy-ai.json"),
      JSON.stringify({ id: "legacy-ai", type: "plugin", target: "plugins/legacy-ai.ts" }),
      "utf8",
    );

    const result = await host.createPlugin({
      id: "legacy-ai",
      name: "迁移插件",
      description: "从单文件迁移",
      code: PLUGIN_CODE,
    });

    expect(result).toMatchObject({ ok: true });
    expect(await exists(legacy)).toBe(false);
    expect(await exists(path.join(pluginsDir, "legacy-ai", "plugin.json"))).toBe(true);
  });
});
