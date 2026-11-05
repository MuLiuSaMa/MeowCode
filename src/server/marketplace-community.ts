import { promises as fs } from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "../agent/atomic-json.js";
import { MarketplaceError, type MarketItemType, type MarketplaceItem } from "./marketplace.js";

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

/** 社区收录仓库（gitcode.com/MuLiuSaMa/MeowCode-Plugins），结构见仓库 README */
const OWNER = "MuLiuSaMa";
const REPO = "MeowCode-Plugins";

/** 单文件大小上限（下载后按字节数校验，超限丢弃报错） */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 每请求超时 */
const FETCH_TIMEOUT_MS = 15_000;
/** 元数据并发拉取上限 */
const MAX_CONCURRENT = 12;
/** 缓存 TTL（内存与磁盘同周期；列表 ?refresh=1 可强制失效） */
const CACHE_TTL_MS = 10 * 60 * 1000;
/** 限流/瞬时错误重试次数 */
const RETRIES = 3;

/** item.json 解析后的社区条目（channel 由服务端补上，不来自仓库） */
export type CommunityMarketplaceItem = MarketplaceItem & {
  author?: string;
  homepage?: string;
  channel: "community";
};

/** 树里缓存的 blob（安装/详情/图标都按 sha 走 raw 直链） */
type CachedBlob = { path: string; sha: string };

type CommunityItem = {
  item: CommunityMarketplaceItem;
  /** 条目目录下的全部 blob（skills/<id>/* 等） */
  blobs: CachedBlob[];
};

type DiskCache = { cachedAt: string; items: Array<{ item: CommunityMarketplaceItem; blobs: CachedBlob[] }> };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type CommunityContext = { homeDir: string };

export type CommunityEntry = CommunityMarketplaceItem & {
  installed: boolean;
  envReady?: boolean;
  updateAvailable?: boolean;
};

export type CommunityListResult = {
  entries: CommunityEntry[];
  icons: Record<string, string>;
};

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/** 仓库目录名（复数）→ 条目类型（单数） */
const DIR_TYPE_BY_FOLDER: Record<string, MarketItemType> = {
  skills: "skill",
  plugins: "plugin",
  mcp: "mcp",
};

const TYPE_DIRS: Record<MarketItemType, string> = {
  skill: "skills",
  plugin: "plugins",
  mcp: "mcp",
};

function assertSafeId(id: string): void {
  if (!ID_PATTERN.test(id) || id.includes("..")) {
    throw new MarketplaceError("invalid_id", `invalid community id: ${id}`);
  }
}

/** 路径必须落在 <typeDir>/<id>/ 内且无穿越段（内容来自远程仓库，合并前不可信） */
function assertContainedPath(target: string, type: MarketItemType, id: string): void {
  const root = `${TYPE_DIRS[type]}/${id}`;
  const normalized = path.posix.normalize(target);
  if (normalized !== root && !normalized.startsWith(`${root}/`)) {
    throw new MarketplaceError("invalid_id", `community path escapes item dir: ${target}`);
  }
}

/** 带限流重试与大小上限的文本下载 */
async function fetchText(retries: number, url: string, fetchImpl: FetchLike): Promise<string> {
  const buffer = await fetchBytes(retries, url, fetchImpl);
  return new TextDecoder().decode(buffer);
}

/** 带限流重试与大小上限的二进制下载 */
async function fetchBytes(retries: number, url: string, fetchImpl: FetchLike): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      // GitCode 限流以 403/429 表现：退避重试
      if (response.status === 403 || response.status === 429) {
        lastError = new Error(`gitcode rate limited (${response.status})`);
        continue;
      }
      if (!response.ok) {
        throw new Error(`gitcode request failed (${response.status}): ${url}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > MAX_FILE_BYTES) {
        throw new MarketplaceError("invalid_id", `community file too large: ${url}`);
      }
      return buffer;
    } catch (error) {
      // 大小超限直接抛出，不重试
      if (error instanceof MarketplaceError) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** 并发上限映射（元数据/文件批量下载用） */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = Array.from<R>({ length: items.length });
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 与官方市场同构的 SKILL.md 正文提取（去 frontmatter，60k 截断） */
function skillBody(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n");
  const end = normalized.startsWith("---\n") ? normalized.indexOf("\n---", 4) : -1;
  const body = end >= 0 ? normalized.slice(end + 4).replace(/^\n+/, "").trim() : normalized.trim();
  return body.length > 60_000 ? `${body.slice(0, 59_999)}…` : body;
}

const MIME_BY_EXT: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type CommunitySourceOptions = {
  /** 注入测试用 fetch；缺省用全局 fetch */
  fetchImpl?: FetchLike;
  /** 覆盖收录仓库（测试用）；缺省 MuLiuSaMa/MeowCode-Plugins */
  repo?: { owner: string; repo: string };
  /** 限流/瞬时错误重试次数（测试设 0 避免退避等待） */
  retries?: number;
};

/**
 * 社区市场源：从 GitCode 收录仓库拉取条目（树枚举 + raw blob 直链），安装目标与
 * 安装标记与官方 marketplace.ts 同格式——卸载直接复用官方 /marketplace/uninstall。
 */
export function createCommunitySource(options: CommunitySourceOptions = {}) {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const retries = options.retries ?? RETRIES;
  const repo = options.repo ?? { owner: OWNER, repo: REPO };
  const treeUrl = `https://api.gitcode.com/api/v5/repos/${repo.owner}/${repo.repo}/git/trees/main?recursive=1`;
  const rawUrl = (sha: string, name: string): string =>
    `https://raw.gitcode.com/${repo.owner}/${repo.repo}/blobs/${sha}/${encodeURIComponent(name)}`;

  let memoryCache: { items: CommunityItem[]; at: number } | null = null;
  /** 图标 data URL 缓存：key = blob sha（内容寻址，合并后自动换新） */
  const iconCache = new Map<string, string>();

  // ---- 条目加载（内存 → 磁盘 → 网络） ---------------------------------------

  async function loadItems(forceRefresh: boolean, homeDir: string): Promise<CommunityItem[]> {
    if (!forceRefresh && memoryCache && Date.now() - memoryCache.at < CACHE_TTL_MS) {
      return memoryCache.items;
    }
    if (!forceRefresh) {
      const disk = await readDiskCache(homeDir);
      if (disk && Date.now() - new Date(disk.cachedAt).getTime() < CACHE_TTL_MS) {
        memoryCache = { items: disk.items, at: Date.now() };
        return disk.items;
      }
    }
    try {
      const items = await fetchItems();
      memoryCache = { items, at: Date.now() };
      await writeDiskCache(items, homeDir);
      return items;
    } catch (error) {
      // 网络失败：过期的内存/磁盘缓存也比「社区页整个挂掉」好
      if (memoryCache) return memoryCache.items;
      const disk = await readDiskCache(homeDir);
      if (disk) {
        memoryCache = { items: disk.items, at: Date.now() };
        return disk.items;
      }
      throw error;
    }
  }

  async function fetchItems(): Promise<CommunityItem[]> {
    const treeText = await fetchText(retries, treeUrl, fetchImpl);
    const tree = JSON.parse(treeText) as { tree?: Array<{ type?: string; path?: string; sha?: string }> };
    const blobs = (tree.tree ?? []).filter(
      (entry): entry is { type: "blob"; path: string; sha: string } =>
        entry.type === "blob" && typeof entry.path === "string" && typeof entry.sha === "string",
    );

    // item.json 所在目录即条目目录（<typeDir>/<id>/item.json）
    const itemBlobs = blobs.filter((blob) => blob.path.split("/").length === 3 && blob.path.endsWith("/item.json"));
    const items = await mapLimited(itemBlobs, MAX_CONCURRENT, async (blob) => {
      try {
        const meta = JSON.parse(await fetchText(retries, rawUrl(blob.sha, "item.json"), fetchImpl)) as Record<string, unknown>;
        return parseItem(meta, blob.path, blobs);
      } catch {
        // 单个条目损坏不拖垮整个列表
        return null;
      }
    });
    const parsed = items.filter((item): item is CommunityItem => item !== null);
    // 不同目录撞 id/type 时先到先得
    const seen = new Set<string>();
    return parsed.filter((entry) => {
      const key = `${entry.item.type}:${entry.item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function parseItem(
    meta: Record<string, unknown>,
    itemJsonPath: string,
    blobs: Array<{ type: string; path: string; sha: string }>,
  ): CommunityItem | null {
    const dir = path.posix.dirname(itemJsonPath); // <typeDir>/<id>
    const segments = dir.split("/");
    if (segments.length !== 2) return null;
    const [dirType, rawId] = segments;
    const type = DIR_TYPE_BY_FOLDER[dirType];
    if (type !== "skill" && type !== "plugin" && type !== "mcp") return null;
    if (typeof meta.type === "string" && meta.type !== type) return null; // 目录与声明不一致
    if (typeof rawId !== "string" || !ID_PATTERN.test(rawId) || rawId.includes("..")) return null;
    const id = rawId;

    const dirPrefix = `${dir}/`;
    const dirBlobs = blobs
      .filter((blob) => blob.path.startsWith(dirPrefix))
      .map((blob) => ({ path: blob.path, sha: blob.sha }));

    // 技能必须带 SKILL.md；插件必须带 <id>.ts；MCP 必须带 server 配置
    if (type === "skill" && !dirBlobs.some((blob) => blob.path === `${dir}/SKILL.md`)) return null;
    if (type === "plugin" && !dirBlobs.some((blob) => blob.path === `${dir}/${id}.ts`)) return null;
    const server = meta.server;
    if (type === "mcp" && (!server || typeof server !== "object" || Array.isArray(server))) return null;

    const name = typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : id;
    const description =
      typeof meta.description === "string" ? meta.description.replace(/\s+/g, " ").trim().slice(0, 240) : "";
    const version = typeof meta.version === "string" && meta.version.trim() ? meta.version.trim() : "0.0.0";
    const tags = Array.isArray(meta.tags)
      ? meta.tags.filter((t): t is string => typeof t === "string").slice(0, 4)
      : [];
    const icon = typeof meta.icon === "string" && meta.icon.trim() ? path.posix.basename(meta.icon.trim()) : undefined;
    const requiresEnv = Array.isArray(meta.requiresEnv)
      ? meta.requiresEnv.filter((v): v is string => typeof v === "string")
      : undefined;

    return {
      item: {
        id,
        type,
        name,
        description: description || `${id}（社区条目）`,
        category: typeof meta.category === "string" ? meta.category : "效率提升",
        source: "community",
        tags,
        version,
        entry: type === "skill" ? dir : `${dir}/${id}.ts`,
        entryKind: type === "skill" ? "dir" : "file",
        ...(icon ? { icon } : {}),
        ...(type === "mcp" ? { requiresEnv } : {}),
        ...(typeof meta.author === "string" && meta.author.trim() ? { author: meta.author.trim() } : {}),
        ...(typeof meta.homepage === "string" && meta.homepage.trim() ? { homepage: meta.homepage.trim() } : {}),
        channel: "community",
      },
      blobs: dirBlobs,
    };
  }

  // ---- 磁盘缓存 ------------------------------------------------------------

  function diskCachePath(ctx: CommunityContext): string {
    return path.join(ctx.homeDir, ".meowcode", ".marketplace", "community-cache.json");
  }

  async function writeDiskCache(items: CommunityItem[], homeDir: string): Promise<void> {
    const payload: DiskCache = {
      cachedAt: new Date().toISOString(),
      items: items.map((entry) => ({ item: entry.item, blobs: entry.blobs })),
    };
    try {
      await writeJsonAtomic(diskCachePath({ homeDir }), payload);
    } catch {
      /* 缓存写失败不影响主流程 */
    }
  }

  async function readDiskCache(homeDir: string): Promise<DiskCache | null> {
    try {
      const parsed = await readJsonFile<DiskCache>(diskCachePath({ homeDir }));
      if (!parsed || !Array.isArray(parsed.items) || typeof parsed.cachedAt !== "string") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  // ---- 安装状态与标记 --------------------------------------------------------

  function meowRoot(ctx: CommunityContext): string {
    return path.join(ctx.homeDir, ".meowcode");
  }

  function installTarget(type: MarketItemType, id: string, ctx: CommunityContext): string {
    assertSafeId(id);
    const root = meowRoot(ctx);
    if (type === "skill") return path.join(root, "skills", id);
    if (type === "plugin") return path.join(root, "plugins", `${id}.ts`);
    return path.join(root, "mcp.json");
  }

  function markerFile(type: MarketItemType, id: string, ctx: CommunityContext): string {
    assertSafeId(id);
    return path.join(meowRoot(ctx), ".marketplace", `${type}-${id}.json`);
  }

  async function isInstalled(item: CommunityMarketplaceItem, ctx: CommunityContext): Promise<boolean> {
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

  async function readMarkerVersion(type: MarketItemType, id: string, ctx: CommunityContext): Promise<string | undefined> {
    const marker = await readJsonFile<{ version?: string }>(markerFile(type, id, ctx));
    return typeof marker?.version === "string" ? marker.version : undefined;
  }

  async function readUserMcp(ctx: CommunityContext): Promise<{ mcpServers?: Record<string, unknown> }> {
    const config = await readJsonFile<{ mcpServers?: Record<string, unknown> }>(
      path.join(meowRoot(ctx), "mcp.json"),
    );
    return config && typeof config === "object" ? config : {};
  }

  async function readItemJson(entry: CommunityItem): Promise<Record<string, unknown> | null> {
    const blob = entry.blobs.find((candidate) => candidate.path.endsWith("/item.json"));
    if (!blob) return null;
    try {
      return JSON.parse(await fetchText(retries, rawUrl(blob.sha, "item.json"), fetchImpl)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  // ---- 图标 -----------------------------------------------------------------

  async function iconDataUrl(entry: CommunityItem): Promise<string | null> {
    if (!entry.item.icon) return null;
    const iconPath = `${TYPE_DIRS[entry.item.type]}/${entry.item.id}/${entry.item.icon}`;
    assertContainedPath(iconPath, entry.item.type, entry.item.id);
    const blob = entry.blobs.find((candidate) => candidate.path === iconPath);
    if (!blob) return null;
    const cached = iconCache.get(blob.sha);
    if (cached) return cached;
    try {
      const data = await fetchBytes(retries, rawUrl(blob.sha, path.posix.basename(iconPath)), fetchImpl);
      const ext = path.posix.extname(iconPath).toLowerCase();
      const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
      const url = `data:${mime};base64,${data.toString("base64")}`;
      iconCache.set(blob.sha, url);
      return url;
    } catch {
      return null;
    }
  }

  return {
    /** 社区条目列表：installed/envReady/updateAvailable + 图标 dataUrl 表（key = "<type>:<id>"） */
    async list(
      ctx: CommunityContext,
      opts: { refresh?: boolean; officialIds?: ReadonlySet<string> } = {},
    ): Promise<CommunityListResult> {
      const items = await loadItems(Boolean(opts.refresh), ctx.homeDir);
      const visible = items.filter((entry) => !opts.officialIds?.has(`${entry.item.type}:${entry.item.id}`));

      const [entries, iconEntries] = await Promise.all([
        Promise.all(
          visible.map(async (entry): Promise<CommunityEntry> => {
            const installed = await isInstalled(entry.item, ctx);
            const envReady =
              entry.item.type === "mcp" && entry.item.requiresEnv
                ? entry.item.requiresEnv.every((name) => Boolean(process.env[name]))
                : undefined;
            // 更新比对：安装标记里记的 version 与远端不同（MCP 同样适用，重装=覆盖配置）
            const installedVersion = installed ? await readMarkerVersion(entry.item.type, entry.item.id, ctx) : undefined;
            const updateAvailable =
              installedVersion !== undefined && installedVersion !== entry.item.version;
            return {
              ...entry.item,
              installed,
              ...(envReady !== undefined ? { envReady } : {}),
              ...(updateAvailable ? { updateAvailable } : {}),
            };
          }),
        ),
        Promise.all(
          visible
            .filter((entry) => entry.item.icon)
            .map(async (entry) => [`${entry.item.type}:${entry.item.id}`, await iconDataUrl(entry)] as const),
        ),
      ]);
      const icons: Record<string, string> = {};
      for (const [key, dataUrl] of iconEntries) {
        if (dataUrl) icons[key] = dataUrl;
      }
      return { entries, icons };
    },

    /** 详情：技能 → SKILL.md 正文（raw 直链）；插件/MCP → 仅条目 */
    async detail(id: string, type: MarketItemType, ctx: CommunityContext) {
      assertSafeId(id);
      void ctx;
      const items = await loadItems(false, ctx.homeDir);
      const entry = items.find((candidate) => candidate.item.id === id && candidate.item.type === type);
      if (!entry) throw new MarketplaceError("not_found", `community item not found: ${type}/${id}`);
      if (type === "skill") {
        const blob = entry.blobs.find((candidate) => candidate.path === `${TYPE_DIRS.skill}/${id}/SKILL.md`);
        if (blob) {
          try {
            return { item: entry.item, detail: skillBody(await fetchText(retries, rawUrl(blob.sha, "SKILL.md"), fetchImpl)) };
          } catch {
            return { item: entry.item };
          }
        }
      }
      return { item: entry.item };
    },

    /**
     * 安装：按树下载写入官方同款安装目标，并写带 version 的安装标记。
     * 标记与官方 uninstall 完全兼容（多出的 version 字段被官方卸载忽略）。
     */
    async install(id: string, type: MarketItemType, ctx: CommunityContext) {
      assertSafeId(id);
      const items = await loadItems(false, ctx.homeDir);
      const entry = items.find((candidate) => candidate.item.id === id && candidate.item.type === type);
      if (!entry) throw new MarketplaceError("not_found", `community item not found: ${type}/${id}`);

      const overwritten = await isInstalled(entry.item, ctx);

      if (type === "skill") {
        const target = path.join(meowRoot(ctx), "skills", id);
        await fs.mkdir(target, { recursive: true });
        const files = entry.blobs.filter((blob) => blob.path !== `${TYPE_DIRS.skill}/${id}/item.json`);
        await mapLimited(files, MAX_CONCURRENT, async (blob) => {
          assertContainedPath(blob.path, type, id);
          const relative = blob.path.slice(TYPE_DIRS.skill.length + 1 + id.length + 1);
          const dest = path.join(target, ...relative.split("/"));
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.writeFile(dest, await fetchBytes(retries, rawUrl(blob.sha, path.posix.basename(blob.path)), fetchImpl));
        });
      } else if (type === "plugin") {
        const blob = entry.blobs.find((candidate) => candidate.path === `${TYPE_DIRS.plugin}/${id}/${id}.ts`);
        if (!blob) throw new MarketplaceError("not_found", `community plugin source missing: ${id}`);
        const target = path.join(meowRoot(ctx), "plugins", `${id}.ts`);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, await fetchBytes(retries, rawUrl(blob.sha, `${id}.ts`), fetchImpl));
      } else {
        const meta = await readItemJson(entry);
        const server = meta?.server;
        if (!server || typeof server !== "object" || Array.isArray(server)) {
          throw new MarketplaceError("not_found", `community mcp entry malformed: ${id}`);
        }
        const config = await readUserMcp(ctx);
        const servers = { ...config.mcpServers };
        servers[id] = server;
        const target = path.join(meowRoot(ctx), "mcp.json");
        await fs.mkdir(path.dirname(target), { recursive: true });
        await writeJsonAtomic(target, { ...config, mcpServers: servers });
      }

      const marker = markerFile(type, id, ctx);
      await fs.mkdir(path.dirname(marker), { recursive: true });
      await writeJsonAtomic(marker, {
        id,
        type,
        source: "community",
        installedAt: new Date().toISOString(),
        version: entry.item.version,
      });
      return { id, type, overwritten };
    },
  };
}
