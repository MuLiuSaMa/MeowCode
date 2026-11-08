import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { hasDynamicTool } from "../agent/tools.js";
import { PluginRegistry } from "./registry.js";
import { discoverPlugins, loadPlugins } from "./loader.js";
import type { ExtensionHost } from "./types.js";

const tempDirs: string[] = [];

/**
 * 隔离内置插件根：指向一个空的临时目录，避免测试捡到产品自带的
 * builtin/claude-code-hooks（descriptors 断言只关心 project/user 层）。
 */
const originalBuiltinEnv = process.env.MEOWCODE_BUILTIN_PLUGINS_DIR;
let emptyBuiltinDir = "";

beforeAll(async () => {
  emptyBuiltinDir = await fs.mkdtemp(path.join(os.tmpdir(), "meow-builtin-"));
  process.env.MEOWCODE_BUILTIN_PLUGINS_DIR = emptyBuiltinDir;
});

afterAll(async () => {
  if (originalBuiltinEnv === undefined) delete process.env.MEOWCODE_BUILTIN_PLUGINS_DIR;
  else process.env.MEOWCODE_BUILTIN_PLUGINS_DIR = originalBuiltinEnv;
  await fs.rm(emptyBuiltinDir, { recursive: true, force: true }).catch(() => {});
});

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

  it("内置根目录（无 env 覆盖时）能发现随包的 builtin 插件", async () => {
    const saved = process.env.MEOWCODE_BUILTIN_PLUGINS_DIR;
    delete process.env.MEOWCODE_BUILTIN_PLUGINS_DIR;
    try {
      const builtinDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "builtin");
      const { plugins } = await discoverPlugins([{ dir: builtinDir, source: "builtin" }]);
      expect(plugins.map((item) => item.id)).toContain("claude-code-hooks");
    } finally {
      if (saved !== undefined) process.env.MEOWCODE_BUILTIN_PLUGINS_DIR = saved;
    }
  });

  it("loadPlugins 给 builtin 描述符填元数据（显示名/介绍/图标 dataUrl）", async () => {
    const saved = process.env.MEOWCODE_BUILTIN_PLUGINS_DIR;
    delete process.env.MEOWCODE_BUILTIN_PLUGINS_DIR;
    try {
      const workspace = await makeTempRoot();
      const registry = new PluginRegistry();
      const { descriptors } = await loadPlugins({ workspace, homeDir: workspace, registry });
      const builtin = descriptors.find((d) => d.id === "claude-code-hooks");
      expect(builtin?.source).toBe("builtin");
      expect(builtin?.enabled).toBe(true);
      expect(builtin?.displayName).toBe("Claude Code hooks 桥接");
      expect(builtin?.description).toContain("settings.json");
      expect(builtin?.iconUrl?.startsWith("data:image/svg+xml;base64,")).toBe(true);
      // 元数据不依赖加载成功：即使工厂抛错，描述符仍带介绍
      registry.unregisterAll();
    } finally {
      if (saved !== undefined) process.env.MEOWCODE_BUILTIN_PLUGINS_DIR = saved;
    }
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

describe("插件 UI 面板探测", () => {
  it("目录插件带 ui/index.html 时 descriptor.ui 登记，单文件插件没有", async () => {
    const root = await makeTempRoot();
    const pluginsDir = path.join(root, ".meowcode", "plugins");
    const withUi = path.join(pluginsDir, "with-ui");
    await fs.mkdir(path.join(withUi, "ui"), { recursive: true });
    await fs.writeFile(path.join(withUi, "index.ts"), "export default () => {}");
    await fs.writeFile(path.join(withUi, "ui", "index.html"), "<!doctype html><title>ui</title>");
    await fs.writeFile(path.join(pluginsDir, "single.ts"), "export default () => {}");

    const registry = new PluginRegistry();
    const workspace = await makeTempRoot();
    const { descriptors } = await loadPlugins({ workspace, homeDir: root, registry });

    const uiPlugin = descriptors.find((item) => item.id === "with-ui");
    expect(uiPlugin?.ui).toEqual({ panel: { title: "with-ui", entry: "index.html" } });
    const single = descriptors.find((item) => item.id === "single");
    expect(single?.ui).toBeUndefined();
  });

  it("ui 文件缺失（只有目录）不算面板", async () => {
    const root = await makeTempRoot();
    const pluginsDir = path.join(root, ".meowcode", "plugins");
    const dirOnly = path.join(pluginsDir, "dir-only");
    await fs.mkdir(path.join(dirOnly, "ui"), { recursive: true });
    await fs.writeFile(path.join(dirOnly, "index.ts"), "export default () => {}");

    const registry = new PluginRegistry();
    const workspace = await makeTempRoot();
    const { descriptors } = await loadPlugins({ workspace, homeDir: root, registry });

    expect(descriptors.find((item) => item.id === "dir-only")?.ui).toBeUndefined();
  });
});

describe("插件头注释与宿主注入", () => {
  it("读文件头 @meowcode name/description，列表显示中文名", async () => {
    const home = await makeTempRoot();
    const pluginsDir = path.join(home, ".meowcode", "plugins");
    await fs.mkdir(pluginsDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginsDir, "branded.ts"),
      "// @meowcode name: 字数统计\n// @meowcode description: 统计文本字数\nexport default () => {}",
    );
    const registry = new PluginRegistry();
    const workspace = await makeTempRoot();
    const { descriptors } = await loadPlugins({ workspace, homeDir: home, registry });

    const descriptor = descriptors.find((item) => item.id === "branded");
    expect(descriptor?.displayName).toBe("字数统计");
    expect(descriptor?.description).toBe("统计文本字数");
    registry.unregisterAll();
  });

  it("host 能力通过 api.host 注入给插件", async () => {
    const home = await makeTempRoot();
    const pluginsDir = path.join(home, ".meowcode", "plugins");
    await fs.mkdir(pluginsDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginsDir, "needs-host.ts"),
      "export default (api) => { if (!api.host) throw new Error('missing host'); api.registerTool({ name: 'host_probe', description: 'x', parameters: { type: 'object', properties: {} }, execute: async () => ({ ok: true, output: '1' }) }); }",
    );
    const registry = new PluginRegistry();
    const workspace = await makeTempRoot();
    const host: ExtensionHost = {
      createSkill: async () => ({ ok: true as const, id: "x", path: "x" }),
      createPlugin: async () => ({ ok: true as const, id: "x", path: "x" }),
    };
    const { descriptors } = await loadPlugins({ workspace, homeDir: home, registry, host });

    const descriptor = descriptors.find((item) => item.id === "needs-host");
    expect(descriptor?.error).toBeUndefined();
    expect(descriptor?.toolNames).toContain("host_probe");
    registry.unregisterAll();
  });
});

describe("内置创作插件", () => {
  it("extension-authoring 注入 host 后注册 create_skill / create_plugin", async () => {
    const saved = process.env.MEOWCODE_BUILTIN_PLUGINS_DIR;
    delete process.env.MEOWCODE_BUILTIN_PLUGINS_DIR;
    try {
      const workspace = await makeTempRoot();
      const registry = new PluginRegistry();
      const host: ExtensionHost = {
        createSkill: async () => ({ ok: true as const, id: "x", path: "x" }),
        createPlugin: async () => ({ ok: true as const, id: "x", path: "x" }),
      };
      const { descriptors } = await loadPlugins({ workspace, homeDir: workspace, registry, host });

      const descriptor = descriptors.find((item) => item.id === "extension-authoring");
      expect(descriptor?.error).toBeUndefined();
      expect(descriptor?.toolNames).toEqual(expect.arrayContaining(["create_skill", "create_plugin"]));
      registry.unregisterAll();
    } finally {
      if (saved !== undefined) process.env.MEOWCODE_BUILTIN_PLUGINS_DIR = saved;
    }
  });
});
