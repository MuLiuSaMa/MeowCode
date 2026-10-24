import { promises as fs } from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "../agent/atomic-json.js";

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

export type MarketplaceErrorCode = "not_found" | "not_managed" | "invalid_id";

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

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

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
        const servers = { ...(config.mcpServers ?? {}) };
        overwritten = Boolean(servers[item.id]);
        servers[item.id] = bundle.server;
        await fs.mkdir(path.dirname(target), { recursive: true });
        await writeJsonAtomic(target, { ...config, mcpServers: servers });
      }
      await writeMarker(type, item, ctx);
      return { id: item.id, type, overwritten };
    },

    /** 卸载：只删带市场标记的安装物（用户手工放置的同名内容不动） */
    async uninstall(id: string, type: MarketItemType, ctx: MarketplaceContext): Promise<void> {
      assertSafeId(id);
      const marker = await readMarker(type, id, ctx);
      if (!marker) {
        throw new MarketplaceError("not_managed", `${type}/${id} is not managed by the marketplace`);
      }
      if (type === "mcp") {
        const config = await readUserMcp(ctx);
        const servers = { ...(config.mcpServers ?? {}) };
        delete servers[id];
        await writeJsonAtomic(path.join(meowRoot(ctx), "mcp.json"), { ...config, mcpServers: servers });
      } else {
        await fs.rm(installTarget(type, id, ctx), { recursive: true, force: true });
      }
      await fs.rm(markerFile(type, id, ctx), { force: true });
    },
  };
}
