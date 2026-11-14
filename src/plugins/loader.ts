import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti, type Jiti } from "jiti";
import { builtinMeta, iconSvgToDataUrl } from "./builtin-meta.js";
import type { PluginRegistry } from "./registry.js";
import type {
  ExtensionHost,
  PluginDescriptor,
  PluginFactory,
  PluginLoadError,
  PluginManifest,
  PluginPermission,
  PluginSource,
  PluginUiDescriptor,
} from "./types.js";
import { PLUGIN_PERMISSIONS } from "./types.js";

/** 支持的插件文件扩展名 */
const PLUGIN_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs", ".cjs"]);/** 目录型插件的入口候选（按序尝试） */
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

/** 子路径必须落在父目录内（防止 manifest 把入口指到插件目录外）。 */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/** client 脚本只允许 ui/ 下的 .js/.mjs，避免 loader 把任意文件当脚本执行。 */
function validClientEntry(entry: string): boolean {
  const normalized = entry.replace(/\\/g, "/");
  return (
    normalized.startsWith("ui/") &&
    !normalized.includes("../") &&
    /\.(?:js|mjs)$/i.test(normalized)
  );
}

/**
 * 读取 `<插件目录>/plugin.json`。不存在 → undefined（旧插件走权限全开的合成清单）；
 * 存在但不合法 → throw，由 loadPlugins 记为该插件的加载错误。
 */
export async function readPluginManifest(
  entryFile: string,
  expectedId: string,
): Promise<PluginManifest | undefined> {
  const dir = path.dirname(entryFile);
  const manifestPath = path.join(dir, "plugin.json");
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`plugin.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error("plugin.json must be a JSON object");
  const object = parsed as Record<string, unknown>;

  if (object.apiVersion !== 2) throw new Error("plugin.json apiVersion must be 2");
  if (typeof object.id !== "string" || object.id !== expectedId) {
    throw new Error(`plugin.json id must match the plugin directory name "${expectedId}"`);
  }
  if (typeof object.version !== "string" || !object.version.trim()) {
    throw new Error("plugin.json version must be a non-empty string");
  }
  if (object.name !== undefined && typeof object.name !== "string") {
    throw new Error("plugin.json name must be a string");
  }

  const permissionsRaw = object.permissions;
  if (!Array.isArray(permissionsRaw)) throw new Error("plugin.json permissions must be an array");
  const permissions: PluginPermission[] = [];
  for (const value of permissionsRaw) {
    if (typeof value !== "string" || !(PLUGIN_PERMISSIONS as readonly string[]).includes(value)) {
      throw new Error(`plugin.json has an unknown permission: ${String(value)}`);
    }
    if (!permissions.includes(value as PluginPermission)) permissions.push(value as PluginPermission);
  }

  if (object.main !== undefined) {
    if (typeof object.main !== "string" || !object.main.trim()) {
      throw new Error("plugin.json main must be a non-empty string");
    }
    const mainPath = path.resolve(dir, object.main);
    if (!isInside(dir, mainPath)) throw new Error("plugin.json main must stay inside the plugin directory");
  }

  let client: string | undefined;
  if (object.client !== undefined) {
    if (typeof object.client !== "string" || !validClientEntry(object.client)) {
      throw new Error("plugin.json client must be a .js/.mjs file under ui/");
    }
    const clientPath = path.resolve(dir, object.client);
    if (!isInside(dir, clientPath)) throw new Error("plugin.json client must stay inside the plugin directory");
    if (!(await isFile(clientPath))) throw new Error(`plugin.json client file not found: ${object.client}`);
    client = object.client.replace(/\\/g, "/");
  } else {
    const fallback = path.join(dir, "ui", "client.js");
    if (await isFile(fallback)) client = "ui/client.js";
  }

  if (client && !permissions.includes("ui")) {
    throw new Error('plugin.json declares a client entry but does not request the "ui" permission');
  }

  const engines =
    object.engines && typeof object.engines === "object"
      ? (object.engines as { meowcode?: unknown })
      : undefined;
  if (engines?.meowcode !== undefined && typeof engines.meowcode !== "string") {
    throw new Error("plugin.json engines.meowcode must be a string");
  }

  return {
    id: expectedId,
    ...(typeof object.name === "string" ? { name: object.name } : {}),
    version: object.version,
    apiVersion: 2,
    ...(typeof object.main === "string" ? { main: object.main } : {}),
    ...(client ? { client } : {}),
    permissions,
    ...(engines?.meowcode !== undefined ? { engines: { meowcode: engines.meowcode } } : {}),
  };
}

/** AI 创作工具写的标记：该插件由对话里的模型生成，渲染层免二次授权。 */
async function hasAiPluginMarker(homeDir: string, id: string): Promise<boolean> {
  try {
    await fs.access(path.join(homeDir, ".meowcode", ".marketplace", `ai-plugin-${id}.json`));
    return true;
  } catch {
    return false;
  }
}

/** 把 manifest 的 client 入口映射成 `/plugin-ui/<id>/...` 下的相对路径。 */
async function clientDescriptor(
  manifest: PluginManifest | undefined,
  pluginDir: string,
): Promise<PluginUiDescriptor["client"]> {
  if (!manifest?.client) return undefined;
  const entry = manifest.client.replace(/^ui\//, "");
  const stats = await fs.stat(path.resolve(pluginDir, "ui", entry)).catch(() => null);
  return {
    entry,
    permissions: manifest.permissions,
    // mtime 之外的 ctime/size 一起进指纹：同毫秒覆盖也能被 tsc/编辑器写盘识别
    ...(stats
      ? {
          rev: `${entry}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}:${manifest.version}:${manifest.permissions.join(",")}`,
        }
      : {}),
  };
}

/**
 * 插件文件头元数据：`// @meowcode name: ...` / `// @meowcode description: ...`。
 * 自建插件没有市场条目，靠这两行在「已加载插件」里显示中文名与介绍。
 */
async function readPluginHeaderMeta(
  filePath: string,
): Promise<{ name?: string; description?: string }> {
  try {
    const head = (await fs.readFile(filePath, "utf8")).slice(0, 4_096);
    const pick = (key: string): string | undefined => {
      const match = new RegExp(`^\\s*//\\s*@meowcode\\s+${key}:\\s*(.+)$`, "im").exec(head);
      return match?.[1]?.trim().slice(0, 200) || undefined;
    };
    return { name: pick("name"), description: pick("description") };
  } catch {
    return {};
  }
}

export type DiscoveredPlugin = {
  id: string;
  path: string;
  source: PluginSource;
  /** 目录型插件才可能有 plugin.json；单文件插件一律走旧行为。 */
  directory?: boolean;
};
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

/**
 * 目录型插件入口：plugin.json 的 main 优先，其次 index.*，
 * 再次 package.json 的 main 指向的本地文件；都不是则 null。
 */
async function resolveDirectoryEntry(dir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(dir, "plugin.json"), "utf8");
    const parsed = JSON.parse(raw) as { main?: unknown };
    if (typeof parsed.main === "string" && parsed.main.length > 0) {
      const mainPath = path.resolve(dir, parsed.main);
      if (isInside(dir, mainPath) && (await isFile(mainPath))) return mainPath;
    }
  } catch {
    /* 无 plugin.json / 格式不对：继续按旧规则找入口 */
  }
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
        const item: DiscoveredPlugin = { id: entry.name, path: entryFile, source, directory: true };
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
  /** AI 自建能力宿主（server 注入；缺省时插件拿不到 api.host） */
  host?: ExtensionHost;
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
    } else {
      // 用户/项目插件：读文件头 `// @meowcode name/description`，让自建插件在列表里有中文名
      const header = await readPluginHeaderMeta(item.path);
      if (header.name) descriptor.displayName = header.name;
      if (header.description) descriptor.description = header.description;
    }

    // 目录型插件可带 plugin.json；非法 manifest 直接记为加载错误，不静默降级
    let manifest: PluginManifest | undefined;
    if (item.directory) {
      try {
        manifest = await readPluginManifest(item.path, item.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        descriptor.error = message;
        errors.push({ path: item.path, error: message });
        descriptors.push(descriptor);
        continue;
      }
    }
    if (manifest) {
      descriptor.version = manifest.version;
      descriptor.manifest = manifest;
      if (manifest.name) descriptor.displayName = manifest.name;
    }
    if (item.source !== "builtin" && (await hasAiPluginMarker(options.homeDir, item.id))) {
      descriptor.aiAuthored = true;
    }

    descriptors.push(descriptor);
    if (!descriptor.enabled) continue;

    // 目录型插件可以带 ui/index.html（iframe 面板）与 ui/client.js（槽位脚本）
    const panel = await detectPluginUi(item.path);
    const client = await clientDescriptor(manifest, path.dirname(item.path));
    if (panel || client) {
      descriptor.ui = {
        ...(panel ? { panel } : {}),
        ...(client ? { client } : {}),
      };
    }

    options.registry.addPlugin(item.id, item.source, item.path, manifest, descriptor.ui);
    try {
      const factory = await importPluginFactory(item.path);
      const api = options.registry.createApi(
        item.id,
        options.workspace,
        options.homeDir,
        options.host,
      );
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
