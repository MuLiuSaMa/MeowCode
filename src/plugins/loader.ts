import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti, type Jiti } from "jiti";
import { builtinMeta, iconSvgToDataUrl } from "./builtin-meta.js";
import type { PluginRegistry } from "./registry.js";
import type { PluginDescriptor, PluginFactory, PluginLoadError, PluginSource } from "./types.js";

/** 支持的插件文件扩展名 */
const PLUGIN_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs", ".cjs"]);
/** 目录型插件的入口候选（按序尝试） */
const INDEX_CANDIDATES = ["index.ts", "index.mts", "index.js", "index.mjs", "index.cjs"];
/** 跳过的文件：类型声明与测试文件不作为插件 */
const IGNORED_BASENAMES = /\.(d\.ts|test\.tsx?|spec\.tsx?)$/i;

/**
 * 内置插件根目录：与 loader 同级的 builtin/（src 与 dist 的目录布局一致，
 * 开发期跑 src、生产跑 dist 都能解析到）。可用 MEOWCODE_BUILTIN_PLUGINS_DIR
 * 覆盖（测试隔离 / 打包布局特殊时）。同 id 时 project > user > builtin。
 */
function builtinPluginsDir(): string {
  return (
    process.env.MEOWCODE_BUILTIN_PLUGINS_DIR ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), "builtin")
  );
}

/** 来源优先级：数字大的遮蔽数字小的。 */
const SOURCE_RANK: Record<PluginSource, number> = { project: 3, user: 2, builtin: 1 };

/**
 * 目录型插件是否自带 UI 面板：`<插件目录>/ui/index.html`。
 * 面板由渲染层用 iframe 加载（服务端走 `/plugin-ui/<id>/...`）。
 */
async function detectPluginUi(entryFile: string): Promise<{ title: string; entry: string } | null> {
  try {
    const dir = path.dirname(entryFile);
    const uiDir = path.join(dir, "ui");
    const entry = path.join(uiDir, "index.html");
    const stats = await fs.stat(entry);
    if (!stats.isFile()) return null;
    return { title: path.basename(dir), entry: "index.html" };
  } catch {
    return null;
  }
}

export type DiscoveredPlugin = { id: string; path: string; source: PluginSource };
export type DiscoveryRoot = { dir: string; source: PluginSource };

let jitiInstance: Jiti | null = null;

function getJiti(): Jiti {
  if (!jitiInstance) {
    // fsCache/moduleCache 关闭：插件开发期改文件后重启 server 即生效，不残留旧模块
    jitiInstance = createJiti(import.meta.url, {
      interopDefault: true,
      fsCache: false,
      moduleCache: false,
    });
  }
  return jitiInstance;
}

/** 加载插件模块，取工厂函数（默认导出或模块本身） */
export async function importPluginFactory(pluginPath: string): Promise<PluginFactory> {
  const mod = (await getJiti().import(pluginPath)) as unknown;
  const factory =
    typeof mod === "function" ? mod : (mod as { default?: unknown } | null | undefined)?.default;
  if (typeof factory !== "function") {
    throw new Error("plugin module must export a factory function (default export or module itself)");
  }
  return factory as PluginFactory;
}

/** 目录型插件入口：index.* 优先，其次 package.json 的 main 指向的本地文件；都不是则 null */
async function resolveDirectoryEntry(dir: string): Promise<string | null> {
  for (const name of INDEX_CANDIDATES) {
    const candidate = path.join(dir, name);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      /* 继续 */
    }
  }
  try {
    const pkgRaw = await fs.readFile(path.join(dir, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw) as { main?: string };
    if (typeof pkg.main === "string" && pkg.main.length > 0) {
      const mainPath = path.resolve(dir, pkg.main);
      const stat = await fs.stat(mainPath).catch(() => null);
      if (stat?.isFile()) return mainPath;
    }
  } catch {
    /* 无 package.json 或格式不对 */
  }
  return null;
}

/**
 * 发现阶段：逐个 root 扫描（project 先于 user），单文件与一层子目录均可，
 * 不深层递归。同 id 冲突时 project 胜出，被遮蔽的 user 插件单独返回供 UI 展示。
 */
export async function discoverPlugins(
  roots: DiscoveryRoot[],
): Promise<{ plugins: DiscoveredPlugin[]; shadowed: DiscoveredPlugin[] }> {
  const byId = new Map<string, DiscoveredPlugin>();
  const shadowed: DiscoveredPlugin[] = [];

  for (const { dir, source } of roots) {
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 目录不存在 → 该来源无插件
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!PLUGIN_EXTENSIONS.has(ext) || IGNORED_BASENAMES.test(entry.name)) continue;
        const id = entry.name.slice(0, -ext.length);
        const item: DiscoveredPlugin = { id, path: full, source };
        const existing = byId.get(id);
        if (!existing) byId.set(id, item);
        else if (SOURCE_RANK[existing.source] > SOURCE_RANK[source]) shadowed.push(item);
      } else if (entry.isDirectory()) {
        const entryFile = await resolveDirectoryEntry(full);
        if (!entryFile) continue;
        const item: DiscoveredPlugin = { id: entry.name, path: entryFile, source };
        const existing = byId.get(entry.name);
        if (!existing) byId.set(entry.name, item);
        else if (SOURCE_RANK[existing.source] > SOURCE_RANK[source]) shadowed.push(item);
      }
    }
  }

  // project 先于 user 先于 builtin，同级按文件名字典序，保证加载顺序确定
  const plugins = [...byId.values()].sort((a, b) => {
    if (a.source !== b.source) return SOURCE_RANK[b.source] - SOURCE_RANK[a.source];
    return a.id.localeCompare(b.id);
  });
  return { plugins, shadowed };
}

export type LoadPluginsOptions = {
  workspace: string;
  homeDir: string;
  /** 禁用插件 id 列表（desktop settings 全局启停） */
  disabled?: readonly string[];
  registry: PluginRegistry;
};

/**
 * 发现 + 加载全流程。每个插件独立 try/catch（import 与 factory 各自兜底），
 * 失败 → descriptor 带 error 并回滚部分注册，继续加载下一个。
 */
export async function loadPlugins(options: LoadPluginsOptions): Promise<{
  descriptors: PluginDescriptor[];
  errors: PluginLoadError[];
}> {
  const projectDir = path.join(options.workspace, ".meowcode", "plugins");
  const userDir = path.join(options.homeDir, ".meowcode", "plugins");
  const disabled = new Set(options.disabled ?? []);

  const { plugins, shadowed } = await discoverPlugins([
    { dir: builtinPluginsDir(), source: "builtin" },
    { dir: projectDir, source: "project" },
    { dir: userDir, source: "user" },
  ]);

  const descriptors: PluginDescriptor[] = [];
  const errors: PluginLoadError[] = [];

  for (const item of shadowed) {
    const shadower =
      item.source === "builtin" ? "a user or project plugin" : "a project plugin";
    descriptors.push({
      id: item.id,
      path: item.path,
      source: item.source,
      enabled: false,
      error: `shadowed by ${shadower} with the same id`,
    });
  }

  for (const item of plugins) {
    const descriptor: PluginDescriptor = {
      id: item.id,
      path: item.path,
      source: item.source,
      enabled: !disabled.has(item.id),
    };
    // 内置插件：填 manifest 元数据（显示名 / 介绍 / 图标 dataUrl），
    // UI 不再退化成字母兜底图标 + 「暂无介绍」
    if (item.source === "builtin") {
      const meta = builtinMeta(item.id);
      if (meta) {
        descriptor.displayName = meta.displayName;
        descriptor.description = meta.description;
        descriptor.iconUrl = iconSvgToDataUrl(meta.iconSvg);
      }
    }
    descriptors.push(descriptor);
    if (!descriptor.enabled) continue;

    // 目录型插件可以带 ui/index.html：登记成右侧面板（单文件插件没有目录，自然没有 UI）
    const ui = await detectPluginUi(item.path);
    if (ui) descriptor.ui = { panel: ui };

    options.registry.addPlugin(item.id, item.source, item.path);
    try {
      const factory = await importPluginFactory(item.path);
      const api = options.registry.createApi(item.id, options.workspace, options.homeDir);
      await factory(api);
      const toolNames = options.registry.toolNamesOf(item.id);
      const commandNames = options.registry
        .listCommands()
        .filter((c) => c.source === `plugin:${item.id}`)
        .map((c) => c.name);
      const hookEvents = options.registry.hookEventsOf(item.id);
      if (toolNames.length > 0) descriptor.toolNames = toolNames;
      if (commandNames.length > 0) descriptor.commandNames = commandNames;
      if (hookEvents.length > 0) descriptor.hookEvents = hookEvents;
    } catch (error) {
      options.registry.rollbackPlugin(item.id);
      const message = error instanceof Error ? error.message : String(error);
      descriptor.error = message;
      errors.push({ path: item.path, error: message });
    }
  }

  return { descriptors, errors };
}
