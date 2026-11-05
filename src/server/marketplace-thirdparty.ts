import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "../agent/atomic-json.js";
import { MarketplaceError, type MarketplaceItem } from "./marketplace.js";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type ThirdPartySource = "clawhub" | "skillhub";

/** 条目 id 前缀即来源（Windows 文件名不允许冒号，不能用 cc-haha 的 "clawhub:slug"） */
const SOURCE_BY_PREFIX: Record<string, ThirdPartySource> = {
  "clawhub-": "clawhub",
  "skillhub-": "skillhub",
};

export type ThirdPartyMarketplaceItem = MarketplaceItem & {
  channel: "thirdparty";
  upstream: ThirdPartySource;
  slug: string;
  author?: string;
  downloads?: number;
  /** Unix 秒（两源原始字段口径一致） */
  updatedAt?: number;
  /** 远端图标直链（SkillHub 有、ClawHub 无；list() 下载后转 dataUrl 图标表） */
  iconUrl?: string;
};

export type ThirdPartyEntry = ThirdPartyMarketplaceItem & { installed: boolean };

export type ThirdPartyListResult = {
  entries: ThirdPartyEntry[];
  /** 单源失败不拖垮列表：失败源在这里标记，前端显示「源暂不可用」 */
  sources: Record<ThirdPartySource, "ok" | "failed">;
  /** 图标 dataUrl 表，key = "skill:<id>"（与官方/社区市场同口径） */
  icons: Record<string, string>;
  /** 各源下一页游标：ClawHub 用 cursor、SkillHub 用页码；没有更多就没有该键 */
  nextCursors: Partial<Record<ThirdPartySource, string>>;
};

export type ThirdPartyDetail = { item: ThirdPartyEntry; detail?: string };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type ThirdPartySourceOptions = {
  /** 注入测试用 fetch；缺省用全局 fetch */
  fetchImpl?: FetchLike;
  /** 限流/瞬时错误重试次数（测试设 0 避免退避等待） */
  retries?: number;
  /** 覆盖源地址（测试用 loopback） */
  clawhubBase?: string;
  skillhubBase?: string;
};

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 单文件大小上限（下载后按字节数校验，超限丢弃报错） */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 单技能文件总大小上限 */
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
/** 单技能文件数上限 */
const MAX_FILE_COUNT = 200;
/** 每请求超时 */
const FETCH_TIMEOUT_MS = 15_000;
/** 列表/搜索缓存 TTL（内存；refresh=1 强制失效） */
const CACHE_TTL_MS = 10 * 60 * 1000;
/** 列表每源取多少条 */
const PAGE_SIZE = 50;
/** 详情正文截断（与官方/社区一致） */
const DETAIL_MAX_CHARS = 60_000;

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

// ---------------------------------------------------------------------------
// 通用下载
// ---------------------------------------------------------------------------

/** 带限流重试与大小上限的文本下载；`passThrough` 里的状态码原样返回正文给调用方处理 */
async function fetchText(
  retries: number,
  url: string,
  fetchImpl: FetchLike,
  passThrough: number[] = [],
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (passThrough.includes(response.status)) {
        return await response.text();
      }
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`upstream ${response.status}: ${url}`);
        continue;
      }
      if (!response.ok) {
        throw new Error(`upstream request failed (${response.status}): ${url}`);
      }
      const text = await response.text();
      if (text.length > MAX_FILE_BYTES) {
        throw new MarketplaceError("invalid_id", `third-party file too large: ${url}`);
      }
      return text;
    } catch (error) {
      if (error instanceof MarketplaceError) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchJson<T>(retries: number, url: string, fetchImpl: FetchLike): Promise<T> {
  return JSON.parse(await fetchText(retries, url, fetchImpl)) as T;
}

/** 与官方/社区同构的 SKILL.md 正文提取（去 frontmatter，60k 截断） */
function skillBody(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n");
  const end = normalized.startsWith("---\n") ? normalized.indexOf("\n---", 4) : -1;
  const body = end >= 0 ? normalized.slice(end + 4).replace(/^\n+/, "").trim() : normalized.trim();
  return body.length > DETAIL_MAX_CHARS ? `${body.slice(0, DETAIL_MAX_CHARS - 1)}…` : body;
}

function assertSafeId(id: string): { source: ThirdPartySource; slug: string } {
  if (!ID_PATTERN.test(id) || id.includes("..")) {
    throw new MarketplaceError("invalid_id", `invalid third-party id: ${id}`);
  }
  const prefix = Object.keys(SOURCE_BY_PREFIX).find((key) => id.startsWith(key));
  if (!prefix) {
    throw new MarketplaceError("invalid_id", `third-party id must start with clawhub- or skillhub-: ${id}`);
  }
  const slug = id.slice(prefix.length);
  if (!slug || !ID_PATTERN.test(slug)) {
    throw new MarketplaceError("invalid_id", `invalid third-party slug: ${slug}`);
  }
  return { source: SOURCE_BY_PREFIX[prefix], slug };
}

/** 安装内容里的相对路径必须无穿越段（内容来自远程源，落盘前不可信） */
function assertSafeRelativeFilePath(filePath: string): void {
  if (!filePath || filePath.length > 512 || path.isAbsolute(filePath) || filePath.includes("\0")) {
    throw new MarketplaceError("invalid_id", `unsafe file path: ${filePath}`);
  }
  const normalized = path.posix.normalize(filePath);
  if (normalized.startsWith("..") || normalized.includes("../") || normalized === "..") {
    throw new MarketplaceError("invalid_id", `unsafe file path: ${filePath}`);
  }
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

// ---------------------------------------------------------------------------
// ClawHub（clawhub.ai）——API 形状抄录自 cc-haha clawhubProvider（已对过线上）
// ---------------------------------------------------------------------------

type ClawhubListItem = {
  slug: string;
  displayName?: string;
  summary?: string;
  topics?: string[];
  stats?: { downloads?: number };
  updatedAt?: number;
  latestVersion?: { version?: string };
};

type ClawhubSearchResult = {
  slug: string;
  source?: string;
  install?: { kind?: string };
  displayName?: string;
  summary?: string;
  downloads?: number;
  updatedAt?: number;
  ownerHandle?: string;
};

type ClawhubDetail = {
  skill?: ClawhubListItem & { description?: string };
  latestVersion?: { version?: string; license?: string; createdAt?: number };
  owner?: { handle?: string };
};

type ClawhubVersionDetail = {
  version?: {
    version?: string;
    files?: Array<{ path: string; size: number; sha256?: string }>;
  };
};

// ---------------------------------------------------------------------------
// SkillHub（api.skillhub.cn）——API 形状抄录自 cc-haha skillhubProvider（已对过线上）
// ---------------------------------------------------------------------------

type SkillhubListItem = {
  slug: string;
  name?: string;
  displayName?: string;
  summary?: string;
  summary_zh?: string;
  description?: string;
  description_zh?: string;
  category?: string;
  downloads?: number;
  ownerName?: string;
  version?: string;
  updated_at?: number;
  iconUrl?: string;
};

type SkillhubEnvelope<T> = { code: number; data?: T; message?: string };

type SkillhubDetail = {
  skill?: SkillhubListItem;
  owner?: { handle?: string };
  latestVersion?: { version?: string };
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type ThirdPartyContext = { homeDir: string };

/**
 * 第三方市场源：ClawHub + SkillHub 双源聚合。条目 id = `<source>-<slug>`，
 * 安装目标与安装标记与官方 marketplace.ts 同格式——卸载直接复用
 * 官方 /marketplace/uninstall。纯 fs + 注入 fetch，便于单测。
 */
export function createThirdPartySource(options: ThirdPartySourceOptions = {}) {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const retries = options.retries ?? 3;
  const clawhubBase = options.clawhubBase ?? "https://clawhub.ai";
  const skillhubBase = options.skillhubBase ?? "https://api.skillhub.cn";

  /** ClawHub slug 跨 owner 不唯一：409 时取第一个 owner 记住并带 ?owner= 重试 */
  const clawhubOwnerCache = new Map<string, string>();

  /** 列表/搜索缓存（仅第一页）：key = `${source}|${query}`（只存原始条目，installed 每次现算） */
  const listCache = new Map<string, { page: ProviderPage; at: number }>();

  /** 图标 dataUrl 缓存：key = 远端直链（内容寻址意义不大，TTL 之外不再重拉） */
  const iconCache = new Map<string, string>();

  /** 图标下载 → dataUrl；失败返回 null（卡片回落首字母色块），不拖垮列表 */
  async function iconDataUrl(url: string): Promise<string | null> {
    const cached = iconCache.get(url);
    if (cached) return cached;
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) return null;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > 512 * 1024) return null;
      const mime = response.headers.get("content-type")?.split(";")[0] ?? "image/png";
      const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
      iconCache.set(url, dataUrl);
      return dataUrl;
    } catch {
      return null;
    }
  }

  /** 并发上限映射（图标批量下载用） */
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

  async function clawhubFetchText(url: URL, slug: string): Promise<string> {
    const knownOwner = clawhubOwnerCache.get(slug);
    if (knownOwner && !url.searchParams.has("owner")) {
      url.searchParams.set("owner", knownOwner);
    }
    const text = await fetchText(retries, url.toString(), fetchImpl, [409]);
    try {
      const probe = JSON.parse(text) as { code?: string; matches?: Array<{ ownerHandle?: string }> };
      if (probe?.code !== "AMBIGUOUS_SKILL_SLUG") return text;
      const resolvedOwner = probe.matches?.[0]?.ownerHandle;
      if (!resolvedOwner) throw new Error(`clawhub ambiguous slug without owner match: ${slug}`);
      clawhubOwnerCache.set(slug, resolvedOwner);
      url.searchParams.set("owner", resolvedOwner);
      return fetchText(retries, url.toString(), fetchImpl);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("clawhub ambiguous")) throw error;
      // 非 JSON 响应（正常正文/HTML）原样返回
      return text;
    }
  }

  function clawhubItem(id: string, item: ClawhubListItem): ThirdPartyMarketplaceItem {
    return {
      id,
      type: "skill",
      channel: "thirdparty",
      name: item.displayName || item.slug,
      description: (item.summary || "").replace(/\s+/g, " ").trim().slice(0, 240),
      category: "第三方",
      source: "clawhub",
      upstream: "clawhub",
      slug: item.slug,
      tags: Array.isArray(item.topics) ? item.topics.filter((t): t is string => typeof t === "string").slice(0, 4) : [],
      version: item.latestVersion?.version ?? "0.0.0",
      entry: "",
      entryKind: "dir",
      ...(item.stats?.downloads !== undefined ? { downloads: item.stats.downloads } : {}),
      ...(item.updatedAt !== undefined ? { updatedAt: item.updatedAt } : {}),
    };
  }

  function skillhubItem(id: string, item: SkillhubListItem): ThirdPartyMarketplaceItem {
    return {
      id,
      type: "skill",
      channel: "thirdparty",
      name: item.name || item.displayName || item.slug,
      description: (item.description_zh || item.description || item.summary_zh || item.summary || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 240),
      category: "第三方",
      source: "skillhub",
      upstream: "skillhub",
      slug: item.slug,
      tags: [],
      version: item.version ?? "0.0.0",
      entry: "",
      entryKind: "dir",
      ...(item.downloads !== undefined ? { downloads: item.downloads } : {}),
      ...(item.updated_at !== undefined ? { updatedAt: item.updated_at } : {}),
      ...(item.iconUrl ? { iconUrl: item.iconUrl } : {}),
    };
  }

  // ---- ClawHub 读 -----------------------------------------------------------

  type ProviderPage = { items: ThirdPartyMarketplaceItem[]; nextCursor?: string };

  async function clawhubList(query?: string, cursor?: string): Promise<ProviderPage> {
    if (query) {
      const url = new URL("/api/v1/search", clawhubBase);
      url.searchParams.set("q", query);
      const data = await fetchJson<{ results?: ClawhubSearchResult[] }>(retries, url.toString(), fetchImpl);
      // search 聚合了外部注册表，只能用 ClawHub 自己的 detail/file 端点，先过滤
      const native = (data.results ?? []).filter(
        (result) =>
          result?.slug &&
          (result.source === undefined || result.source === "clawhub") &&
          (result.install?.kind === undefined || result.install.kind === "clawhub"),
      );
      return {
        items: native.slice(0, PAGE_SIZE).map((result) =>
          clawhubItem(`clawhub-${result.slug}`, {
            slug: result.slug,
            displayName: result.displayName,
            summary: result.summary,
            stats: { downloads: result.downloads },
            updatedAt: result.updatedAt,
          }),
        ),
      };
    }
    const url = new URL("/api/v1/skills", clawhubBase);
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("sort", "downloads");
    if (cursor) url.searchParams.set("cursor", cursor);
    const data = await fetchJson<{ items?: ClawhubListItem[]; nextCursor?: string }>(
      retries,
      url.toString(),
      fetchImpl,
    );
    return {
      items: (data.items ?? [])
        .filter((item) => item?.slug)
        .map((item) => clawhubItem(`clawhub-${item.slug}`, item)),
      ...(data.nextCursor ? { nextCursor: data.nextCursor } : {}),
    };
  }

  async function clawhubDetail(slug: string): Promise<{ item: ThirdPartyMarketplaceItem; body?: string; files: Array<{ path: string; size: number; sha256?: string }> }> {
    const url = new URL(`/api/v1/skills/${encodeURIComponent(slug)}`, clawhubBase);
    const data = JSON.parse(await clawhubFetchText(url, slug)) as ClawhubDetail;
    if (!data.skill?.slug) {
      throw new MarketplaceError("not_found", `clawhub skill not found: ${slug}`);
    }
    const item = clawhubItem(`clawhub-${slug}`, data.skill);
    const version = data.latestVersion?.version || data.skill.latestVersion?.version;
    let files: Array<{ path: string; size: number; sha256?: string }> = [];
    if (version) {
      try {
        const versionUrl = new URL(
          `/api/v1/skills/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}`,
          clawhubBase,
        );
        const versionData = JSON.parse(await clawhubFetchText(versionUrl, slug)) as ClawhubVersionDetail;
        files = versionData.version?.files ?? [];
      } catch {
        // 文件清单尽力而为；安装时会重取
      }
    }
    // ClawHub 的 description 就是 SKILL.md 全文（含 frontmatter）
    const rawDescription = data.skill.description || "";
    const body = rawDescription ? skillBody(rawDescription) : undefined;
    return { item, ...(body ? { body } : {}), files };
  }

  async function clawhubFetchFile(slug: string, filePath: string): Promise<string> {
    const url = new URL(`/api/v1/skills/${encodeURIComponent(slug)}/file`, clawhubBase);
    url.searchParams.set("path", filePath);
    return clawhubFetchText(url, slug);
  }

  // ---- SkillHub 读 ----------------------------------------------------------

  async function skillhubList(query?: string, cursor?: string): Promise<ProviderPage> {
    // SkillHub 游标 = 页码字符串
    const page = Math.max(1, Number.parseInt(cursor ?? "1", 10) || 1);
    const url = new URL("/api/skills", skillhubBase);
    url.searchParams.set("page", String(page));
    url.searchParams.set("pageSize", String(PAGE_SIZE));
    if (query) url.searchParams.set("keyword", query);
    const envelope = await fetchJson<SkillhubEnvelope<{ skills?: SkillhubListItem[]; total?: number }>>(
      retries,
      url.toString(),
      fetchImpl,
    );
    if (envelope.code !== 0 || !Array.isArray(envelope.data?.skills)) {
      throw new Error(`skillhub responded code=${envelope.code}: ${envelope.message || "bad payload"}`);
    }
    const total = envelope.data.total ?? 0;
    return {
      items: envelope.data.skills
        .filter((item) => item?.slug)
        .map((item) => skillhubItem(`skillhub-${item.slug}`, item)),
      ...(page * PAGE_SIZE < total ? { nextCursor: String(page + 1) } : {}),
    };
  }

  async function skillhubDetail(slug: string): Promise<{ item: ThirdPartyMarketplaceItem; body?: string; files: Array<{ path: string; size: number; sha256?: string }> }> {
    const data = await fetchJson<SkillhubDetail>(
      retries,
      new URL(`/api/v1/skills/${encodeURIComponent(slug)}`, skillhubBase).toString(),
      fetchImpl,
    );
    if (!data.skill?.slug) {
      throw new MarketplaceError("not_found", `skillhub skill not found: ${slug}`);
    }
    const item = skillhubItem(`skillhub-${slug}`, data.skill);
    let files: Array<{ path: string; size: number; sha256?: string }> = [];
    try {
      const filesData = await fetchJson<{ files?: Array<{ path: string; sha256?: string; size: number }> }>(
        retries,
        new URL(`/api/v1/skills/${encodeURIComponent(slug)}/files`, skillhubBase).toString(),
        fetchImpl,
      );
      files = filesData.files ?? [];
    } catch {
      // 文件清单尽力而为；安装时会重取
    }
    let body: string | undefined;
    if (files.some((file) => file.path === "SKILL.md")) {
      try {
        body = skillBody(await skillhubFetchFile(slug, "SKILL.md"));
      } catch {
        // 正文尽力而为；列表摘要兜底
      }
    }
    return { item, ...(body ? { body } : {}), files };
  }

  async function skillhubFetchFile(slug: string, filePath: string): Promise<string> {
    const url = new URL(`/api/v1/skills/${encodeURIComponent(slug)}/file`, skillhubBase);
    url.searchParams.set("path", filePath);
    // 302 → 对象存储；fetch 默认跟随
    return fetchText(retries, url.toString(), fetchImpl);
  }

  // ---- 公共操作 ---------------------------------------------------------------

  function providerOf(source: ThirdPartySource) {
    return source === "clawhub"
      ? {
          list: clawhubList,
          search: clawhubList,
          detail: clawhubDetail,
          fetchFile: clawhubFetchFile,
        }
      : {
          list: skillhubList,
          search: skillhubList,
          detail: skillhubDetail,
          fetchFile: skillhubFetchFile,
        };
  }

  function skillsDir(ctx: ThirdPartyContext): string {
    return path.join(ctx.homeDir, ".meowcode", "skills");
  }

  function markerFile(id: string, ctx: ThirdPartyContext): string {
    assertSafeId(id);
    return path.join(ctx.homeDir, ".meowcode", ".marketplace", `skill-${id}.json`);
  }

  async function isInstalled(id: string, ctx: ThirdPartyContext): Promise<boolean> {
    try {
      await fs.stat(path.join(skillsDir(ctx), id));
      return true;
    } catch {
      return false;
    }
  }

  return {
    /** 双源列表/搜索：单源失败降级为 failed 标记；首页缓存，翻页游标由调用方回传 */
    async list(
      ctx: ThirdPartyContext,
      opts: {
        query?: string;
        source?: ThirdPartySource;
        refresh?: boolean;
        /** 上一次响应的 nextCursors；缺省取各源第一页 */
        cursors?: Partial<Record<ThirdPartySource, string>>;
      } = {},
    ): Promise<ThirdPartyListResult> {
      const query = opts.query?.trim() || undefined;
      const wanted: ThirdPartySource[] =
        opts.source === "clawhub" || opts.source === "skillhub" ? [opts.source] : ["clawhub", "skillhub"];

      const entries: ThirdPartyMarketplaceItem[] = [];
      const sources: Record<ThirdPartySource, "ok" | "failed"> = { clawhub: "ok", skillhub: "ok" };
      const nextCursors: Partial<Record<ThirdPartySource, string>> = {};
      const seen = new Set<string>();

      await Promise.all(
        wanted.map(async (source) => {
          const cursor = opts.cursors?.[source];
          const cacheKey = `${source}|${query ?? ""}`;
          try {
            let page: ProviderPage;
            // 翻页是显式用户动作，不缓存；首页才走 10 分钟缓存
            if (cursor || opts.refresh) {
              page = query
                ? await providerOf(source).search(query, cursor)
                : await providerOf(source).list(undefined, cursor);
            } else {
              const cached = listCache.get(cacheKey);
              if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
                page = cached.page;
              } else {
                page = query
                  ? await providerOf(source).search(query, cursor)
                  : await providerOf(source).list(undefined, cursor);
                listCache.set(cacheKey, { page, at: Date.now() });
              }
            }
            sources[source] = "ok";
            if (page.nextCursor) nextCursors[source] = page.nextCursor;
            for (const item of page.items) {
              if (seen.has(item.id)) continue;
              seen.add(item.id);
              entries.push(item);
            }
          } catch {
            sources[source] = "failed";
          }
        }),
      );

      if (!seen.size && wanted.every((source) => sources[source] === "failed")) {
        throw new MarketplaceError(
          "not_found",
          "all third-party sources failed: clawhub and skillhub are unreachable",
        );
      }

      const [annotated, iconEntries] = await Promise.all([
        Promise.all(
          entries.map(async (item) => ({
            ...item,
            installed: await isInstalled(item.id, ctx),
          })),
        ),
        // 图标下载不拖垮列表：单张失败就是 null，卡片回落首字母色块
        mapLimited(
          entries.filter((item) => item.iconUrl),
          12,
          async (item) => [item.id, await iconDataUrl(item.iconUrl!)] as const,
        ),
      ]);
      const icons: Record<string, string> = {};
      for (const [id, dataUrl] of iconEntries) {
        if (dataUrl) icons[`skill:${id}`] = dataUrl;
      }
      // 下载量优先，其次名称
      annotated.sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0) || a.name.localeCompare(b.name));
      return { entries: annotated, sources, icons, nextCursors };
    },

    /** 详情：ClawHub description 即 SKILL.md；SkillHub 单独拉 SKILL.md */
    async detail(id: string, ctx: ThirdPartyContext): Promise<ThirdPartyDetail> {
      const { source, slug } = assertSafeId(id);
      const result = await providerOf(source).detail(slug);
      const installed = await isInstalled(id, ctx);
      return {
        item: { ...result.item, id, installed },
        ...(result.body ? { detail: result.body } : {}),
      };
    },

    /**
     * 安装：按文件清单逐个下载到临时目录（sha256 校验），整体 rename 进
     * ~/.meowcode/skills/<id>，写官方同款安装标记（卸载走官方 /marketplace/uninstall）。
     */
    async install(
      id: string,
      ctx: ThirdPartyContext,
    ): Promise<{ id: string; type: "skill"; overwritten: boolean }> {
      const { source, slug } = assertSafeId(id);
      const provider = providerOf(source);
      const detail = await provider.detail(slug);
      let files = detail.files;
      if (!files.length) {
        throw new MarketplaceError("not_found", `third-party skill has no file list: ${id}`);
      }
      if (!files.some((file) => file.path === "SKILL.md")) {
        throw new MarketplaceError("invalid_input", `third-party skill has no SKILL.md: ${id}`);
      }
      if (files.length > MAX_FILE_COUNT) {
        throw new MarketplaceError("invalid_input", `third-party skill has too many files: ${id}`);
      }
      const declaredTotal = files.reduce((sum, file) => sum + (file.size || 0), 0);
      if (files.some((file) => (file.size || 0) > MAX_FILE_BYTES) || declaredTotal > MAX_TOTAL_BYTES) {
        throw new MarketplaceError("invalid_input", `third-party skill exceeds size limits: ${id}`);
      }

      const target = path.join(skillsDir(ctx), id);
      const overwritten = await isInstalled(id, ctx);
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "meowcode-thirdparty-"));
      try {
        let actualTotal = 0;
        for (const file of files) {
          assertSafeRelativeFilePath(file.path);
          const content = await provider.fetchFile(slug, file.path);
          const size = Buffer.byteLength(content, "utf-8");
          if (size > MAX_FILE_BYTES) {
            throw new MarketplaceError("invalid_input", `third-party file too large: ${file.path}`);
          }
          actualTotal += size;
          if (actualTotal > MAX_TOTAL_BYTES) {
            throw new MarketplaceError("invalid_input", `third-party skill exceeds size limits: ${id}`);
          }
          if (file.sha256 && sha256Hex(content) !== file.sha256.toLowerCase()) {
            throw new MarketplaceError("invalid_input", `checksum mismatch for ${file.path}: ${id}`);
          }
          const filePath = path.join(tmpDir, file.path);
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, content, "utf-8");
        }

        await fs.mkdir(path.dirname(target), { recursive: true });
        if (overwritten) {
          await fs.rm(target, { recursive: true, force: true });
        }
        try {
          await fs.rename(tmpDir, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
          // 临时目录与目标跨盘：copy + 清理
          await fs.cp(tmpDir, target, { recursive: true });
          await fs.rm(tmpDir, { recursive: true, force: true });
        }

        const marker = markerFile(id, ctx);
        await fs.mkdir(path.dirname(marker), { recursive: true });
        const existing = await readJsonFile<{ source?: string }>(marker);
        await writeJsonAtomic(marker, {
          id,
          type: "skill",
          source: existing?.source ?? source,
          installedAt: new Date().toISOString(),
        });
        return { id, type: "skill", overwritten };
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}
