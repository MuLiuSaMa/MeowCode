import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasDynamicTool } from "../agent/tools.js";
import { PluginRegistry } from "./registry.js";
import { discoverPlugins, loadPlugins } from "./loader.js";

const tempDirs: string[] = [];

async function makeTempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "meow-plugins-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** loadPlugins 的 workspace 指向临时目录；home 自动另建独立临时目录（避免 user 根与 project 根重叠） */
async function loader(registry: PluginRegistry, workspace: string, disabled: string[] = []) {
  const home = await makeTempRoot();
  return () => loadPlugins({ workspace, homeDir: home, disabled, registry });
}

describe("discoverPlugins", () => {
  it("单文件 / index 子目录 / package.json main 子目录都可发现，.d.ts 与 *.test.ts 跳过", async () => {
    const root = await makeTempRoot();
    await fs.writeFile(path.join(root, "single.ts"), "export default () => {}");
    await fs.writeFile(path.join(root, "types.d.ts"), "export {}");
    await fs.writeFile(path.join(root, "foo.test.ts"), "export default () => {}");
    const dirEntry = path.join(root, "dir-entry");
    await fs.mkdir(dirEntry);
    await fs.writeFile(path.join(dirEntry, "index.ts"), "export default () => {}");
    const pkgEntry = path.join(root, "pkg-entry");
    await fs.mkdir(pkgEntry);
    await fs.writeFile(
      path.join(pkgEntry, "package.json"),
      JSON.stringify({ main: "./lib/entry.js" }),
    );
    await fs.mkdir(path.join(pkgEntry, "lib"));
    await fs.writeFile(path.join(pkgEntry, "lib", "entry.js"), "module.exports = () => {};");
    // 无入口的子目录 → 忽略
    await fs.mkdir(path.join(root, "empty-dir"));

    const { plugins } = await discoverPlugins([{ dir: root, source: "project" }]);

    expect(plugins.map((p) => p.id).sort()).toEqual(["dir-entry", "pkg-entry", "single"]);
    expect(plugins.every((p) => p.source === "project")).toBe(true);
  });

  it("project 同名遮蔽 user，被遮蔽条目单独返回", async () => {
    const project = await makeTempRoot();
    const user = await makeTempRoot();
    await fs.writeFile(path.join(project, "dup.ts"), "export default () => {}");
    await fs.writeFile(path.join(user, "dup.ts"), "export default () => {}");
    await fs.writeFile(path.join(user, "only-user.ts"), "export default () => {}");

    const { plugins, shadowed } = await discoverPlugins([
      { dir: project, source: "project" },
      { dir: user, source: "user" },
    ]);

    expect(plugins.map((p) => [p.id, p.source])).toEqual([
      ["dup", "project"],
      ["only-user", "user"],
    ]);
    expect(shadowed).toEqual([
      { id: "dup", path: path.join(user, "dup.ts"), source: "user" },
    ]);
  });

  it("目录不存在时静默跳过", async () => {
    const { plugins } = await discoverPlugins([
      { dir: "Z:/definitely/missing/.meowcode/plugins", source: "project" },
    ]);
    expect(plugins).toEqual([]);
  });
});

describe("loadPlugins", () => {
  it("成功插件完成注册并产出 descriptor，坏插件被隔离", async () => {
    const root = await makeTempRoot();
    const pluginsDir = path.join(root, ".meowcode", "plugins");
    await fs.mkdir(pluginsDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginsDir, "good.ts"),
      [
        "export default function (api) {",
        "  api.registerTool({",
        "    name: 'loader_ok_tool',",
        "    description: 'fixture tool',",
        "    parameters: { type: 'object', properties: {} },",
        "    execute: async () => ({ output: 'ok', ok: true }),",
        "  });",
        "  api.on('session_start', () => {});",
        "  api.registerCommand({ name: 'loader_ok_cmd', run: () => 'x' });",
        "}",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(pluginsDir, "partial.ts"),
      [
        "export default function (api) {",
        "  api.registerTool({",
        "    name: 'loader_partial_tool',",
        "    description: 'will be rolled back',",
        "    parameters: { type: 'object', properties: {} },",
        "    execute: async () => ({ output: 'ok', ok: true }),",
        "  });",
        "  throw new Error('factory boom');",
        "}",
      ].join("\n"),
    );

    const registry = new PluginRegistry();
    const { descriptors, errors } = await (await loader(registry, root))();

    const good = descriptors.find((d) => d.id === "good");
    expect(good).toMatchObject({
      id: "good",
      source: "project",
      enabled: true,
      toolNames: ["loader_ok_tool"],
      commandNames: ["loader_ok_cmd"],
      hookEvents: ["session_start"],
    });
    expect(hasDynamicTool("loader_ok_tool")).toBe(true);

    const partial = descriptors.find((d) => d.id === "partial");
    expect(partial?.error).toContain("factory boom");
    expect(errors).toEqual([
      { path: path.join(pluginsDir, "partial.ts"), error: "factory boom" },
    ]);
    // 部分注册被回滚
    expect(hasDynamicTool("loader_partial_tool")).toBe(false);

    registry.unregisterAll();
  });

  it("import 失败（语法错误）被隔离，后续插件继续加载", async () => {
    const root = await makeTempRoot();
    const pluginsDir = path.join(root, ".meowcode", "plugins");
    await fs.mkdir(pluginsDir, { recursive: true });
    await fs.writeFile(path.join(pluginsDir, "broken.ts"), "export default ((((");
    await fs.writeFile(
      path.join(pluginsDir, "after.ts"),
      "export default function (api) { api.registerCommand({ name: 'after_cmd', run: () => 'x' }); }",
    );

    const registry = new PluginRegistry();
    const { descriptors, errors } = await (await loader(registry, root))();

    expect(descriptors.find((d) => d.id === "broken")?.error).toBeTruthy();
    expect(errors).toHaveLength(1);
    expect(registry.getCommand("after_cmd")).toBeDefined();
    registry.unregisterAll();
  });

  it("disabled 列表跳过加载但不缺失 descriptor", async () => {
    const root = await makeTempRoot();
    const pluginsDir = path.join(root, ".meowcode", "plugins");
    await fs.mkdir(pluginsDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginsDir, "off.ts"),
      "export default function (api) { api.registerCommand({ name: 'off_cmd', run: () => 'x' }); }",
    );

    const registry = new PluginRegistry();
    const { descriptors } = await (await loader(registry, root, ["off"]))();

    expect(descriptors).toEqual([
      { id: "off", path: path.join(pluginsDir, "off.ts"), source: "project", enabled: false },
    ]);
    expect(registry.getCommand("off_cmd")).toBeUndefined();
  });

  it("非工厂导出报清晰错误", async () => {
    const root = await makeTempRoot();
    const pluginsDir = path.join(root, ".meowcode", "plugins");
    await fs.mkdir(pluginsDir, { recursive: true });
    await fs.writeFile(path.join(pluginsDir, "nofn.ts"), "export default { notAFunction: true };");

    const registry = new PluginRegistry();
    const { descriptors, errors } = await (await loader(registry, root))();

    expect(descriptors.find((d) => d.id === "nofn")?.error).toContain("factory function");
    expect(errors[0]?.error).toContain("factory function");
  });
});

describe("createPluginSystem.reload", () => {
  it("reload 清空旧注册并重新发现（新文件被捡起）", async () => {
    const { createPluginSystem } = await import("./index.js");
    const workspace = await makeTempRoot();
    const home = await makeTempRoot();
    const pluginsDir = path.join(workspace, ".meowcode", "plugins");
    await fs.mkdir(pluginsDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginsDir, "v1.ts"),
      "export default function (api) { api.registerTool({ name: 'v1_tool', description: 'x', parameters: { type: 'object', properties: {} }, execute: async () => ({ output: '1', ok: true }) }); }",
    );

    const system = await createPluginSystem({ workspace, homeDir: home });
    expect(hasDynamicTool("v1_tool")).toBe(true);

    await fs.rm(path.join(pluginsDir, "v1.ts"));
    await fs.writeFile(
      path.join(pluginsDir, "v2.ts"),
      "export default function (api) { api.registerTool({ name: 'v2_tool', description: 'x', parameters: { type: 'object', properties: {} }, execute: async () => ({ output: '2', ok: true }) }); }",
    );
    const result = await system.reload();

    expect(hasDynamicTool("v1_tool")).toBe(false);
    expect(hasDynamicTool("v2_tool")).toBe(true);
    expect(result.descriptors.map((d) => d.id)).toEqual(["v2"]);
    await system.dispose();
    expect(hasDynamicTool("v2_tool")).toBe(false);
  });
});
