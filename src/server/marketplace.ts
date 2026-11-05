import { promises as fs } from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "../agent/atomic-json.js";
import { discoverSkills } from "../plugins/skills.js";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type MarketItemType = "skill" | "plugin" | "mcp";

export type MarketplaceItem = {
  id: string;
  type: MarketItemType;
  name: string;
  description: string;
  category: string;
  source: string;
  tags: string[];
  version: string;
  entry: string;
  entryKind: "dir" | "file";
  /** 相对 bundles 的图标路径（icons/<id>.svg 等） */
  icon?: string;
  /** plugin 专用：详情页使用说明（markdown） */
  usage?: string;
  /** mcp 专用：安装后需要用户注入的环境变量 */
  requiresEnv?: string[];
};

export type MarketplaceDetail = {
  item: MarketplaceItem;
  /** skill → SKILL.md 正文（去 frontmatter，60k 截断）；plugin → usage markdown；mcp → 无 */
  detail?: string;
};

export type MarketplaceEntry = MarketplaceItem & {
  installed: boolean;
  /** mcp 专用：requiresEnv 里的变量是否已在进程环境中 */
  envReady?: boolean;
};

export type MarketplaceInstallResult = {
  id: string;
  type: MarketItemType;
  /** 安装前目标已存在（重装=覆盖） */
  overwritten: boolean;
};

export type MarketplaceErrorCode =
  | "not_found"
  | "not_managed"
  | "invalid_id"
  | "invalid_input"
  | "conflict";

export class MarketplaceError extends Error {
  constructor(
    readonly code: MarketplaceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

type IndexFile = { version: number; generatedAt: string; items: MarketplaceItem[] };

/** 安装标记（~/.meowcode/.marketplace/<type>-<id>.json）：uninstall 只认带标记的安装物 */
type InstallMarker = { id: string; type: MarketItemType; source: string; installedAt: string };

/** 手动条目标记（~/.meowcode/.marketplace/manual-<type>-<id>.json）：「我的」栏的数据源与卸载凭据 */
export type ManualMarker = {
  id: string;
  type: MarketItemType;
  addedAt: string;
  /** 相对 ~/.meowcode 的安装目标（plugins 目录导入不是 <id>.ts，卸载需要真路径） */
  target: string;
};

export type MineSkillEntry = {
  type: "skill";
  id: string;
  addedAt: string;
  status: "ok" | "missing";
  name: string;
  description: string;
};
export type MinePluginEntry = { type: "plugin"; id: string; addedAt: string; status: "ok" | "missing" };
export type MineMcpEntry = {
  type: "mcp";
  id: string;
  addedAt: string;
  status: "ok" | "missing";
  enabled: boolean;
};
export type MineList = { skills: MineSkillEntry[]; plugins: MinePluginEntry[]; mcp: MineMcpEntry[] };

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/** 插件单文件扩展名（对齐 loader 的发现规则） */
const PLUGIN_EXTS = [".ts", ".mts", ".js", ".mjs", ".cjs"];
/** 插件目录导入时认可的入口（index.* 或 package.json） */
const PLUGIN_INDEX_NAMES = ["index.ts", "index.mts", "index.js", "index.mjs", "index.cjs"];

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type MarketplaceContext = { homeDir: string };

/**
 * 市场存储：bundles 只读（resources/marketplace/），安装目标固定在
 * ~/.meowcode/{skills,plugins,mcp.json}。纯 fs 逻辑，便于单测。
 */
export function createMarketplaceStore(bundlesDir: string | undefined) {
  async function loadIndex(): Promise<MarketplaceItem[]> {
    if (!bundlesDir) return [];
    try {
      const index = await readJsonFile<IndexFile>(path.join(bundlesDir, "index.json"));
      return Array.isArray(index?.items) ? index.items : [];
    } catch {
      return [];
    }
  }

  function meowRoot(ctx: MarketplaceContext): string {
    return path.join(ctx.homeDir, ".meowcode");
  }

  function assertSafeId(id: string): void {
    if (!ID_PATTERN.test(id) || id.includes("..")) {
      throw new MarketplaceError("invalid_id", `invalid marketplace id: ${id}`);
    }
  }

  /** type+id → 安装目标路径（全部断言在 ~/.meowcode 内） */
  function installTarget(type: MarketItemType, id: string, ctx: MarketplaceContext): string {
    assertSafeId(id);
    const root = meowRoot(ctx);
    if (type === "skill") return path.join(root, "skills", id);
    if (type === "plugin") return path.join(root, "plugins", `${id}.ts`);
    return path.join(root, "mcp.json");
  }

  function markerFile(type: MarketItemType, id: string, ctx: MarketplaceContext): string {
    assertSafeId(id);
    return path.join(meowRoot(ctx), ".marketplace", `${type}-${id}.json`);
  }

  async function readMarker(type: MarketItemType, id: string, ctx: MarketplaceContext): Promise<InstallMarker | null> {
    const marker = await readJsonFile<InstallMarker>(markerFile(type, id, ctx));
    return marker ?? null;
  }

  async function writeMarker(type: MarketItemType, item: MarketplaceItem, ctx: MarketplaceContext): Promise<void> {
    const file = markerFile(type, item.id, ctx);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeJsonAtomic(file, {
      id: item.id,
      type,
      source: item.source,
      installedAt: new Date().toISOString(),
    } satisfies InstallMarker);
  }

  async function isInstalled(item: MarketplaceItem, ctx: MarketplaceContext): Promise<boolean> {
    if (item.type === "mcp") {
      const config = await readUserMcp(ctx);
      return Boolean(config.mcpServers?.[item.id]);
    }
    try {
      await fs.stat(installTarget(item.type, item.id, ctx));
      return true;
    } catch {
      return false;
    }
  }

  async function readUserMcp(ctx: MarketplaceContext): Promise<{ mcpServers?: Record<string, unknown> }> {
    // readJsonFile 对缺失/损坏文件返回 undefined（不抛错）
    const config = await readJsonFile<{ mcpServers?: Record<string, unknown> }>(
      path.join(meowRoot(ctx), "mcp.json"),
    );
    return config && typeof config === "object" ? config : {};
  }

  async function exists(target: string): Promise<boolean> {
    try {
      await fs.access(target);
      return true;
    } catch {
      return false;
    }
  }

  function manualMarkerFile(type: MarketItemType, id: string, ctx: MarketplaceContext): string {
    assertSafeId(id);
    return path.join(meowRoot(ctx), ".marketplace", `manual-${type}-${id}.json`);
  }

  async function readManualMarker(type: MarketItemType, id: string, ctx: MarketplaceContext): Promise<ManualMarker | null> {
    const marker = await readJsonFile<ManualMarker>(manualMarkerFile(type, id, ctx));
    return marker && marker.target !== undefined ? marker : null;
  }

  async function writeManualMarker(
    type: MarketItemType,
    id: string,
    target: string,
    ctx: MarketplaceContext,
  ): Promise<void> {
    const file = manualMarkerFile(type, id, ctx);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeJsonAtomic(file, {
      id,
      type,
      target,
      addedAt: new Date().toISOString(),
    } satisfies ManualMarker);
  }

  /** 扫描全部手动标记；文件名/内容非法的跳过 */
  async function listManualMarkers(ctx: MarketplaceContext): Promise<ManualMarker[]> {
    let names: string[];
    try {
      names = await fs.readdir(path.join(meowRoot(ctx), ".marketplace"));
    } catch {
      return [];
    }
    const markers: ManualMarker[] = [];
    for (const name of names) {
      const match = /^manual-(skill|plugin|mcp)-(.+)\.json$/.exec(name);
      if (!match) continue;
      const type = match[1] as MarketItemType;
      const id = match[2];
      if (!ID_PATTERN.test(id) || id.includes("..")) continue;
      const marker = await readJsonFile<ManualMarker>(path.join(meowRoot(ctx), ".marketplace", name));
      if (!marker || typeof marker.addedAt !== "string" || typeof marker.target !== "string") continue;
      markers.push({ id, type, addedAt: marker.addedAt, target: marker.target });
    }
    return markers;
  }

  /** 手动插件是否还在：目录导入 target 指向子目录，文件导入回退 <id>.ts */
  async function manualPluginExists(marker: ManualMarker, ctx: MarketplaceContext): Promise<boolean> {
    if (marker.target) {
      const resolved = path.resolve(meowRoot(ctx), marker.target);
      if (resolved !== meowRoot(ctx) && resolved.startsWith(meowRoot(ctx) + path.sep)) {
        return exists(resolved);
      }
      return false;
    }
    return (
      (await exists(path.join(meowRoot(ctx), "plugins", `${marker.id}.ts`))) ||
      (await exists(path.join(meowRoot(ctx), "plugins", marker.id)))
    );
  }

  const MIME_BY_EXT: Record<string, string> = {
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
  };

  /** 图标 → data URL（<img> 走不了 Bearer 头，随 JSON 一起返回最简单）；bundles 只读，按路径永久缓存 */
  const iconCache = new Map<string, string>();
  async function iconDataUrl(item: MarketplaceItem): Promise<string | null> {
    if (!item.icon || !bundlesDir) return null;
    assertSafeId(item.id);
    if (item.icon.includes("..")) return null;
    const cached = iconCache.get(item.icon);
    if (cached) return cached;
    try {
      const data = await fs.readFile(path.join(bundlesDir, item.icon));
      const mime = MIME_BY_EXT[path.extname(item.icon).toLowerCase()] ?? "application/octet-stream";
      const url = `data:${mime};base64,${data.toString("base64")}`;
      iconCache.set(item.icon, url);
      return url;
    } catch {
      return null;
    }
  }

  return {
    /** 全部官方条目的 "<type>:<id>" 键集（社区源用来跳过与官方撞名的条目） */
    async ids(): Promise<ReadonlySet<string>> {
      const items = await loadIndex();
      return new Set(items.map((item) => `${item.type}:${item.id}`));
    },

    /** 索引 + 每项 installed/envReady 状态 + 图标 dataUrl 表（key = "<type>:<id>"） */
    async list(ctx: MarketplaceContext): Promise<{
      entries: MarketplaceEntry[];
      icons: Record<string, string>;
    }> {
      const indexItems = await loadIndex();
      // 条目状态与图标并行读取：首次加载 100+ 图标时串行读盘会明显拖慢安装后的刷新
      const [entries, iconEntries] = await Promise.all([
        Promise.all(
          indexItems.map(async (item): Promise<MarketplaceEntry> => {
            const installed = await isInstalled(item, ctx);
            const envReady =
              item.type === "mcp" && item.requiresEnv
                ? item.requiresEnv.every((name) => Boolean(process.env[name]))
                : undefined;
            return {
              ...item,
              installed,
              ...(envReady !== undefined ? { envReady } : {}),
            };
          }),
        ),
        Promise.all(
          indexItems
            .filter((item) => item.icon)
            .map(async (item) => {
              const dataUrl = await iconDataUrl(item);
              return [`${item.type}:${item.id}`, dataUrl] as const;
            }),
        ),
      ]);
      const icons: Record<string, string> = {};
      for (const [key, dataUrl] of iconEntries) {
        if (dataUrl) icons[key] = dataUrl;
      }
      return { entries, icons };
    },

    /** 详情：skill → SKILL.md 正文；plugin → usage；mcp → 仅条目 */
    async detail(id: string, type: MarketItemType, ctx: MarketplaceContext): Promise<MarketplaceDetail> {
      assertSafeId(id);
      const item = (await loadIndex()).find((entry) => entry.id === id && entry.type === type);
      if (!item) throw new MarketplaceError("not_found", `marketplace item not found: ${type}/${id}`);
      void ctx;
      if (type === "skill") {
        try {
          const raw = await fs.readFile(path.join(bundlesDir!, item.entry, "SKILL.md"), "utf8");
          // 去 frontmatter（渲染层只要正文）
          const normalized = raw.replace(/\r\n/g, "\n");
          const end = normalized.startsWith("---\n") ? normalized.indexOf("\n---", 4) : -1;
          const body = end >= 0 ? normalized.slice(end + 4).replace(/^\n+/, "").trim() : normalized.trim();
          return {
            item,
            detail: body.length > 60_000 ? `${body.slice(0, 59_999)}…` : body,
          };
        } catch {
          return { item };
        }
      }
      return { item, ...(item.usage ? { detail: item.usage } : {}) };
    },

    /** 安装（默认覆盖）；skill 生效无需重启，plugin/mcp 由路由层触发 reload */
    async install(id: string, type: MarketItemType, ctx: MarketplaceContext): Promise<MarketplaceInstallResult> {
      assertSafeId(id);
      const item = (await loadIndex()).find((entry) => entry.id === id && entry.type === type);
      if (!item) throw new MarketplaceError("not_found", `marketplace item not found: ${type}/${id}`);
      const target = installTarget(type, item.id, ctx);

      let overwritten = false;
      if (type === "skill") {
        overwritten = await isInstalled(item, ctx);
        await fs.rm(target, { recursive: true, force: true });
        const source = path.join(bundlesDir!, item.entry);
        await fs.cp(source, target, { recursive: true });
      } else if (type === "plugin") {
        overwritten = await isInstalled(item, ctx);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(path.join(bundlesDir!, item.entry), target);
      } else {
        const bundle = await readJsonFile<{ description?: string; server: Record<string, unknown> }>(
          path.join(bundlesDir!, item.entry),
        );
        if (!bundle?.server || typeof bundle.server !== "object") {
          throw new MarketplaceError("not_found", `marketplace mcp entry malformed: ${id}`);
        }
        const config = await readUserMcp(ctx);
        const servers = { ...config.mcpServers };
        overwritten = Boolean(servers[item.id]);
        servers[item.id] = bundle.server;
        await fs.mkdir(path.dirname(target), { recursive: true });
        await writeJsonAtomic(target, { ...config, mcpServers: servers });
      }
      await writeMarker(type, item, ctx);
      return { id: item.id, type, overwritten };
    },

    /** 卸载：删带市场标记或手动标记的安装物（用户手工放置的无标记内容不动） */
    async uninstall(id: string, type: MarketItemType, ctx: MarketplaceContext): Promise<void> {
      assertSafeId(id);
      const marker = await readMarker(type, id, ctx);
      const manual = marker ? null : await readManualMarker(type, id, ctx);
      if (!marker && !manual) {
        throw new MarketplaceError("not_managed", `${type}/${id} is not managed by the marketplace`);
      }
      if (type === "mcp") {
        const config = await readUserMcp(ctx);
        const servers = { ...config.mcpServers };
        delete servers[id];
        await writeJsonAtomic(path.join(meowRoot(ctx), "mcp.json"), { ...config, mcpServers: servers });
      } else if (manual?.target) {
        const target = path.resolve(meowRoot(ctx), manual.target);
        if (!target.startsWith(meowRoot(ctx) + path.sep)) {
          throw new MarketplaceError("invalid_id", `unsafe manual target: ${manual.target}`);
        }
        await fs.rm(target, { recursive: true, force: true });
      } else {
        await fs.rm(installTarget(type, id, ctx), { recursive: true, force: true });
      }
      await fs.rm(markerFile(type, id, ctx), { force: true });
      await fs.rm(manualMarkerFile(type, id, ctx), { force: true });
    },

    /** 「我的」栏数据：manual 标记 × 实际存在状态（插件/MCP 运行时状态由路由层 join descriptors/statuses） */
    async mineList(ctx: MarketplaceContext): Promise<MineList> {
      const markers = (await listManualMarkers(ctx)).sort((a, b) => b.addedAt.localeCompare(a.addedAt));
      const skills = await discoverSkills(
        [{ dir: path.join(meowRoot(ctx), "skills"), source: "user" }],
        { allowMissingDescription: true },
      );
      const skillById = new Map(skills.map((skill) => [path.basename(path.dirname(skill.path)), skill] as const));
      const mcpConfig = await readUserMcp(ctx);
      const servers = (mcpConfig.mcpServers ?? {}) as Record<string, { enabled?: unknown }>;

      const out: MineList = { skills: [], plugins: [], mcp: [] };
      for (const marker of markers) {
        if (marker.type === "skill") {
          const skill = skillById.get(marker.id);
          out.skills.push({
            type: "skill",
            id: marker.id,
            addedAt: marker.addedAt,
            status: skill ? "ok" : "missing",
            name: skill?.name ?? marker.id,
            description: skill?.description ?? "",
          });
        } else if (marker.type === "plugin") {
          out.plugins.push({
            type: "plugin",
            id: marker.id,
            addedAt: marker.addedAt,
            status: (await manualPluginExists(marker, ctx)) ? "ok" : "missing",
          });
        } else {
          const server = servers[marker.id];
          out.mcp.push({
            type: "mcp",
            id: marker.id,
            addedAt: marker.addedAt,
            status: server ? "ok" : "missing",
            enabled: server ? server.enabled !== false : false,
          });
        }
      }
      return out;
    },

    /**
     * 手动导入本地内容：skill = 含 SKILL.md 的目录（或 SKILL.md 文件本身），
     * plugin = 单文件（.ts/.mts/.js/.mjs/.cjs）或含 index.* 或 package.json 的一层目录。
     * 与市场/手动/手放内容撞 id 时拒绝（保护既有内容，不静默覆盖）。
     */
    async manualImport(
      input: { type: "skill" | "plugin"; sourcePath: string },
      ctx: MarketplaceContext,
    ): Promise<{ id: string; type: "skill" | "plugin" }> {
      const sourcePath = path.resolve(input.sourcePath);
      const stat = await fs.stat(sourcePath).catch(() => null);
      if (!stat) {
        throw new MarketplaceError("invalid_input", `source path does not exist: ${sourcePath}`);
      }

      let id: string;
      let copy: () => Promise<string>;
      let targetPath: string;
      if (input.type === "skill") {
        const dir =
          stat.isDirectory()
            ? sourcePath
            : path.basename(sourcePath).toLowerCase() === "skill.md"
              ? path.dirname(sourcePath)
              : null;
        if (!dir) {
          throw new MarketplaceError("invalid_input", "skill import expects a directory with SKILL.md (or the SKILL.md file)");
        }
        if (!(await exists(path.join(dir, "SKILL.md")))) {
          throw new MarketplaceError("invalid_input", "SKILL.md not found in the selected directory");
        }
        id = path.basename(dir);
        targetPath = path.join("skills", id);
        copy = async () => {
          await fs.cp(dir, path.join(meowRoot(ctx), targetPath), { recursive: true });
          return targetPath;
        };
      } else if (stat.isDirectory()) {
        const files = await fs.readdir(sourcePath);
        const hasIndex = files.some((file) => PLUGIN_INDEX_NAMES.includes(file.toLowerCase()));
        if (!hasIndex && !files.includes("package.json")) {
          throw new MarketplaceError("invalid_input", "plugin directory needs index.* or package.json");
        }
        id = path.basename(sourcePath);
        targetPath = path.join("plugins", id);
        copy = async () => {
          await fs.cp(sourcePath, path.join(meowRoot(ctx), targetPath), {
            recursive: true,
            // node_modules/.git 不拷：体积大；插件依赖应放在 ~/.meowcode/plugins 下自行管理
            filter: (source) => {
              const base = path.basename(source);
              return base !== "node_modules" && base !== ".git";
            },
          });
          return targetPath;
        };
      } else {
        const ext = path.extname(sourcePath).toLowerCase();
        if (!PLUGIN_EXTS.includes(ext)) {
          throw new MarketplaceError(
            "invalid_input",
            `plugin file extension must be one of ${PLUGIN_EXTS.join("/")}`,
          );
        }
        id = path.basename(sourcePath, path.extname(sourcePath));
        targetPath = path.join("plugins", `${id}${ext}`);
        copy = async () => {
          await fs.mkdir(path.dirname(path.join(meowRoot(ctx), targetPath)), { recursive: true });
          await fs.copyFile(sourcePath, path.join(meowRoot(ctx), targetPath));
          return targetPath;
        };
      }

      assertSafeId(id);
      if (await readMarker(input.type, id, ctx)) {
        throw new MarketplaceError("conflict", `${input.type}/${id} is already installed from the marketplace`);
      }
      if (await readManualMarker(input.type, id, ctx)) {
        throw new MarketplaceError("conflict", `${input.type}/${id} is already in mine`);
      }
      if (await exists(path.join(meowRoot(ctx), targetPath))) {
        throw new MarketplaceError("conflict", `~/.meowcode already has ${targetPath.replace(/\\/g, "/")}`);
      }
      await writeManualMarker(input.type, id, await copy(), ctx);
      return { id, type: input.type };
    },

    /** 手动添加/更新 MCP server：merge 进 ~/.meowcode/mcp.json 并写 manual 标记 */
    async manualMcpSave(
      input: { id: string; server: Record<string, unknown> },
      ctx: MarketplaceContext,
    ): Promise<{ id: string; overwritten: boolean }> {
      assertSafeId(input.id);
      const server = input.server;
      const hasUrl = typeof server.url === "string" && server.url.trim().length > 0;
      const hasCommand = typeof server.command === "string" && server.command.trim().length > 0;
      if (!hasUrl && !hasCommand) {
        throw new MarketplaceError("invalid_input", "server config needs url or command");
      }
      const existingManual = await readManualMarker("mcp", input.id, ctx);
      if (!existingManual && (await readMarker("mcp", input.id, ctx))) {
        throw new MarketplaceError("conflict", `mcp/${input.id} is already installed from the marketplace`);
      }
      const config = await readUserMcp(ctx);
      const servers = { ...config.mcpServers };
      if (!existingManual && servers[input.id]) {
        throw new MarketplaceError("conflict", `mcp/${input.id} already exists in mcp.json (hand-edited)`);
      }
      const overwritten = Boolean(servers[input.id]);
      servers[input.id] = server;
      const mcpFile = path.join(meowRoot(ctx), "mcp.json");
      await fs.mkdir(path.dirname(mcpFile), { recursive: true });
      await writeJsonAtomic(mcpFile, { ...config, mcpServers: servers });
      await writeManualMarker("mcp", input.id, "mcp.json", ctx);
      return { id: input.id, overwritten };
    },

    /** 手动条目启停：改 mcp.json 的 enabled 字段（McpManager 对 enabled:false 直接跳过） */
    async manualMcpToggle(
      input: { id: string; enabled: boolean },
      ctx: MarketplaceContext,
    ): Promise<{ id: string; enabled: boolean }> {
      if (!(await readManualMarker("mcp", input.id, ctx))) {
        throw new MarketplaceError("not_managed", `mcp/${input.id} is not a manual entry`);
      }
      const config = await readUserMcp(ctx);
      const servers = { ...config.mcpServers };
      if (!servers[input.id]) {
        throw new MarketplaceError("not_found", `mcp/${input.id} not found in mcp.json`);
      }
      servers[input.id] = { ...(servers[input.id] as Record<string, unknown>), enabled: input.enabled };
      await writeJsonAtomic(path.join(meowRoot(ctx), "mcp.json"), { ...config, mcpServers: servers });
      return { id: input.id, enabled: input.enabled };
    },
  };
}
