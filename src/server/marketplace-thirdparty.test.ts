import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMarketplaceStore } from "./marketplace";
import { createThirdPartySource } from "./marketplace-thirdparty";

// ---------------------------------------------------------------------------
// 测试基建：伪造 ClawHub / SkillHub 两个上游（loopback 主机名由 base 覆盖注入）
// ---------------------------------------------------------------------------

const CLAWHUB_BASE = "http://clawhub.test";
const SKILLHUB_BASE = "http://skillhub.test";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

const CLAWHUB_ALPHA_MD = "---\nname: alpha\ndescription: x\n---\n# Alpha body";
const CLAWHUB_ALPHA_REF = "ref content A";
const SKILLHUB_BETA_MD = "---\nname: beta\ndescription: y\n---\n# Beta body";
const SKILLHUB_BETA_DOC = "doc content B";

type Route = (url: URL) => Response | undefined;

/** 按 host 分流两个假源；routes 里未命中的返回 404 */
function makeFetch(clawhub: Route[], skillhub: Route[]) {
  const impl = (async (url: string) => {
    const parsed = new URL(url);
    const routes = parsed.hostname === "clawhub.test" ? clawhub : skillhub;
    for (const route of routes) {
      const hit = route(parsed);
      if (hit) return hit;
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return impl;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function clawhubRoutes(counter: { list: number; search: number }): Route[] {
  return [
    (url) => {
      if (url.pathname !== "/api/v1/skills" || !url.searchParams.has("limit")) return undefined;
      counter.list += 1;
      return json({
        items: [
          {
            slug: "alpha",
            displayName: "Alpha",
            summary: "Alpha skill summary",
            topics: ["dev", "tools"],
            stats: { downloads: 100 },
            updatedAt: 1_700_000_000,
            latestVersion: { version: "1.0.0" },
          },
        ],
      });
    },
    (url) => {
      if (url.pathname !== "/api/v1/search") return undefined;
      counter.search += 1;
      return json({
        results: [
          { slug: "alpha", displayName: "Alpha", summary: "Alpha skill summary", downloads: 100 },
          // 外部注册表聚合结果：必须被过滤掉（不能走 ClawHub 的 detail/file 端点）
          { slug: "external", source: "github", summary: "external" },
        ],
      });
    },
    (url) => {
      if (url.pathname !== "/api/v1/skills/alpha") return undefined;
      return json({
        skill: {
          slug: "alpha",
          displayName: "Alpha",
          summary: "Alpha skill summary",
          description: CLAWHUB_ALPHA_MD,
          stats: { downloads: 100 },
        },
        latestVersion: { version: "1.0.0" },
        owner: { handle: "alice" },
      });
    },
    (url) => {
      if (url.pathname !== "/api/v1/skills/alpha/versions/1.0.0") return undefined;
      return json({
        version: {
          version: "1.0.0",
          files: [
            { path: "SKILL.md", size: Buffer.byteLength(CLAWHUB_ALPHA_MD), sha256: sha256(CLAWHUB_ALPHA_MD) },
            { path: "refs/a.md", size: Buffer.byteLength(CLAWHUB_ALPHA_REF), sha256: sha256(CLAWHUB_ALPHA_REF) },
          ],
        },
      });
    },
    (url) => {
      if (url.pathname !== "/api/v1/skills/alpha/file") return undefined;
      if (url.searchParams.get("path") === "SKILL.md") return new Response(CLAWHUB_ALPHA_MD);
      if (url.searchParams.get("path") === "refs/a.md") return new Response(CLAWHUB_ALPHA_REF);
      return new Response("missing", { status: 404 });
    },
  ];
}

function skillhubRoutes(counter: { list: number }, keywordSeen: { value: string | null }): Route[] {
  const BETA_ICON = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return [
    (url) => {
      if (url.pathname === "/icons/beta.png") {
        return new Response(new Uint8Array(BETA_ICON), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (url.pathname !== "/api/skills") return undefined;
      counter.list += 1;
      // 分页参数必须是 pageSize（limit 会被静默忽略）、搜索必须是 keyword
      if (url.searchParams.get("pageSize") !== "50") return json({ code: 1 }, 400);
      keywordSeen.value = url.searchParams.get("keyword");
      const skills = [
        {
          slug: "beta",
          name: "Beta",
          summary: "Beta skill summary",
          downloads: 200,
          version: "2.0.0",
          updated_at: 1_700_000_100,
          iconUrl: `${SKILLHUB_BASE}/icons/beta.png`,
        },
      ].filter(
        (skill) =>
          !keywordSeen.value ||
          skill.slug.includes(keywordSeen.value) ||
          skill.name.toLowerCase().includes(keywordSeen.value.toLowerCase()),
      );
      return json({ code: 0, data: { skills, total: skills.length } });
    },
    (url) => {
      if (url.pathname !== "/api/v1/skills/beta") return undefined;
      return json({
        skill: { slug: "beta", name: "Beta", summary: "Beta skill summary" },
        owner: { handle: "bob" },
        latestVersion: { version: "2.0.0" },
      });
    },
    (url) => {
      if (url.pathname !== "/api/v1/skills/beta/files") return undefined;
      return json({
        count: 2,
        files: [
          { path: "SKILL.md", size: Buffer.byteLength(SKILLHUB_BETA_MD), sha256: sha256(SKILLHUB_BETA_MD) },
          { path: "docs/b.md", size: Buffer.byteLength(SKILLHUB_BETA_DOC), sha256: sha256(SKILLHUB_BETA_DOC) },
        ],
      });
    },
    (url) => {
      if (url.pathname !== "/api/v1/skills/beta/file") return undefined;
      if (url.searchParams.get("path") === "SKILL.md") return new Response(SKILLHUB_BETA_MD);
      if (url.searchParams.get("path") === "docs/b.md") return new Response(SKILLHUB_BETA_DOC);
      return new Response("missing", { status: 404 });
    },
  ];
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe("marketplace thirdparty", () => {
  let homeDir: string;
  let counter: { list: number; search: number };
  let skillhubCounter: { list: number };
  let keywordSeen: { value: string | null };
  let clawhubRoutesOverride: Route[] | null;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "meowcode-thirdparty-"));
    counter = { list: 0, search: 0 };
    skillhubCounter = { list: 0 };
    keywordSeen = { value: null };
    clawhubRoutesOverride = null;
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  function makeStore() {
    return createThirdPartySource({
      retries: 0,
      clawhubBase: CLAWHUB_BASE,
      skillhubBase: SKILLHUB_BASE,
      fetchImpl: makeFetch(
        clawhubRoutesOverride ?? clawhubRoutes(counter),
        skillhubRoutes(skillhubCounter, keywordSeen),
      ),
    });
  }

  it("双源列表合并，按下载量排序，installed 状态来自 skills 目录", async () => {
    const store = makeStore();
    const listing = await store.list({ homeDir });
    expect(listing.sources).toEqual({ clawhub: "ok", skillhub: "ok" });
    expect(listing.entries.map((entry) => entry.id)).toEqual(["skillhub-beta", "clawhub-alpha"]);
    const alpha = listing.entries[1];
    expect(alpha).toMatchObject({
      type: "skill",
      channel: "thirdparty",
      name: "Alpha",
      upstream: "clawhub",
      slug: "alpha",
      downloads: 100,
      installed: false,
    });
    expect(alpha.tags).toEqual(["dev", "tools"]);
    // SkillHub 条目带图标：dataUrl 表按 "skill:<id>" 键返回
    expect(listing.icons["skill:skillhub-beta"]).toMatch(/^data:image\/png;base64,/);
  });

  it("单源失败降级：失败源标记 failed，成功源照常返回", async () => {
    const store = createThirdPartySource({
      retries: 0,
      clawhubBase: CLAWHUB_BASE,
      skillhubBase: SKILLHUB_BASE,
      fetchImpl: makeFetch(clawhubRoutes(counter), [
        () => new Response("boom", { status: 500 }),
      ]),
    });
    const listing = await store.list({ homeDir });
    expect(listing.sources).toEqual({ clawhub: "ok", skillhub: "failed" });
    expect(listing.entries.map((entry) => entry.id)).toEqual(["clawhub-alpha"]);
  });

  it("搜索走服务端：ClawHub 用 q、SkillHub 用 keyword 且分页参数是 pageSize", async () => {
    const store = makeStore();
    const listing = await store.list({ homeDir }, { query: "alpha" });
    expect(counter.search).toBe(1);
    expect(keywordSeen.value).toBe("alpha");
    // 外部注册表聚合结果被过滤，只留 ClawHub 原生条目
    expect(listing.entries.map((entry) => entry.id)).toEqual(["clawhub-alpha"]);
  });

  it("source 参数只取一个源", async () => {
    const store = makeStore();
    const listing = await store.list({ homeDir }, { source: "skillhub" });
    expect(counter.list).toBe(0);
    expect(listing.entries.map((entry) => entry.id)).toEqual(["skillhub-beta"]);
    expect(listing.sources.clawhub).toBe("ok");
  });

  it("列表缓存生效，refresh=1 强制失效", async () => {
    const store = makeStore();
    await store.list({ homeDir });
    await store.list({ homeDir });
    expect(counter.list).toBe(1);
    await store.list({ homeDir }, { refresh: true });
    expect(counter.list).toBe(2);
  });

  it("ClawHub 详情：description 即 SKILL.md，去 frontmatter 得正文", async () => {
    const store = makeStore();
    const detail = await store.detail("clawhub-alpha", { homeDir });
    expect(detail.detail).toBe("# Alpha body");
    expect(detail.item.name).toBe("Alpha");
  });

  it("SkillHub 详情：单独拉 SKILL.md 作正文", async () => {
    const store = makeStore();
    const detail = await store.detail("skillhub-beta", { homeDir });
    expect(detail.detail).toBe("# Beta body");
    expect(detail.item.id).toBe("skillhub-beta");
  });

  it("ClawHub slug 撞 owner：409 AMBIGUOUS_SKILL_SLUG 解析 owner 后重试", async () => {
    let detailCalls = 0;
    clawhubRoutesOverride = [
      (url) => {
        if (url.pathname !== "/api/v1/skills/alpha") return undefined;
        detailCalls += 1;
        if (detailCalls === 1) {
          expect(url.searchParams.has("owner")).toBe(false);
          return json({ code: "AMBIGUOUS_SKILL_SLUG", matches: [{ ownerHandle: "alice" }] }, 409);
        }
        expect(url.searchParams.get("owner")).toBe("alice");
        return json({
          skill: { slug: "alpha", displayName: "Alpha", description: CLAWHUB_ALPHA_MD },
          latestVersion: { version: "1.0.0" },
          owner: { handle: "alice" },
        });
      },
      ...clawhubRoutes(counter).slice(2),
    ];
    const store = makeStore();
    const detail = await store.detail("clawhub-alpha", { homeDir });
    expect(detail.detail).toBe("# Alpha body");
    expect(detailCalls).toBe(2);
  });

  it("安装：文件落盘 + sha256 校验 + 官方同款安装标记，可通过官方端点卸载", async () => {
    const store = makeStore();
    const result = await store.install("clawhub-alpha", { homeDir });
    expect(result).toEqual({ id: "clawhub-alpha", type: "skill", overwritten: false });

    const target = path.join(homeDir, ".meowcode", "skills", "clawhub-alpha");
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toBe(CLAWHUB_ALPHA_MD);
    expect(await readFile(path.join(target, "refs", "a.md"), "utf8")).toBe(CLAWHUB_ALPHA_REF);
    const marker = JSON.parse(
      await readFile(path.join(homeDir, ".meowcode", ".marketplace", "skill-clawhub-alpha.json"), "utf8"),
    );
    expect(marker).toMatchObject({ id: "clawhub-alpha", type: "skill", source: "clawhub" });

    // 装完列表里 installed = true
    const listing = await store.list({ homeDir });
    expect(listing.entries.find((entry) => entry.id === "clawhub-alpha")?.installed).toBe(true);

    // 重装 = 覆盖
    const again = await store.install("clawhub-alpha", { homeDir });
    expect(again.overwritten).toBe(true);

    // 卸载走官方 marketplace 端点（无 bundles 目录，uninstall 不依赖索引）
    const official = createMarketplaceStore(undefined);
    await official.uninstall("clawhub-alpha", "skill", { homeDir });
    expect(existsSync(target)).toBe(false);
    expect(
      existsSync(path.join(homeDir, ".meowcode", ".marketplace", "skill-clawhub-alpha.json")),
    ).toBe(false);
  });

  it("sha256 不匹配拒绝安装且不落盘", async () => {
    clawhubRoutesOverride = [
      ...clawhubRoutes(counter).slice(0, 3),
      (url) => {
        if (url.pathname !== "/api/v1/skills/alpha/versions/1.0.0") return undefined;
        return json({
          version: {
            version: "1.0.0",
            files: [{ path: "SKILL.md", size: 10, sha256: "0".repeat(64) }],
          },
        });
      },
      ...clawhubRoutes(counter).slice(4),
    ];
    const store = makeStore();
    await expect(store.install("clawhub-alpha", { homeDir })).rejects.toThrow(/checksum mismatch/);
    expect(
      existsSync(path.join(homeDir, ".meowcode", "skills", "clawhub-alpha")),
    ).toBe(false);
  });

  it("文件清单带路径穿越段时拒绝安装", async () => {
    clawhubRoutesOverride = [
      ...clawhubRoutes(counter).slice(0, 3),
      (url) => {
        if (url.pathname !== "/api/v1/skills/alpha/versions/1.0.0") return undefined;
        return json({
          version: {
            version: "1.0.0",
            files: [
              { path: "SKILL.md", size: Buffer.byteLength(CLAWHUB_ALPHA_MD), sha256: sha256(CLAWHUB_ALPHA_MD) },
              { path: "../evil.md", size: 3, sha256: sha256("bad") },
            ],
          },
        });
      },
      ...clawhubRoutes(counter).slice(4),
    ];
    const store = makeStore();
    await expect(store.install("clawhub-alpha", { homeDir })).rejects.toThrow(/unsafe file path/);
    expect(existsSync(path.join(homeDir, ".meowcode", "evil.md"))).toBe(false);
  });

  it("翻页：SkillHub 页码游标递增，nextCursors 透传", async () => {
    const pagesSeen: string[] = [];
    const store = createThirdPartySource({
      retries: 0,
      clawhubBase: CLAWHUB_BASE,
      skillhubBase: SKILLHUB_BASE,
      fetchImpl: makeFetch([], [
        (url) => {
          if (url.pathname !== "/api/skills") return undefined;
          const page = Number(url.searchParams.get("page") ?? "1");
          pagesSeen.push(String(page));
          return json({
            code: 0,
            data: {
              skills: [{ slug: `beta-${page}`, name: `Beta${page}`, downloads: 10 - page }],
              total: 51,
            },
          });
        },
      ]),
    });
    const first = await store.list({ homeDir }, { source: "skillhub" });
    // 1 页 50 条 < 总量 51 → 有下一页
    expect(first.entries).toHaveLength(1);
    expect(first.nextCursors.skillhub).toBe("2");
    const second = await store.list({ homeDir }, { source: "skillhub", cursors: { skillhub: "2" } });
    expect(pagesSeen).toEqual(["1", "2"]);
    expect(second.entries.map((entry) => entry.id)).toEqual(["skillhub-beta-2"]);
    expect(second.nextCursors.skillhub).toBeUndefined();
  });

  it("非法 id（非双源前缀）拒绝", async () => {
    const store = makeStore();
    await expect(store.detail("evil-skill", { homeDir })).rejects.toThrow();
    await expect(store.install("official-x", { homeDir })).rejects.toThrow();
  });

  it("SkillHub 安装走 files 端点清单与 file 端点下载", async () => {
    const store = makeStore();
    await store.install("skillhub-beta", { homeDir });
    const target = path.join(homeDir, ".meowcode", "skills", "skillhub-beta");
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toBe(SKILLHUB_BETA_MD);
    expect(await readFile(path.join(target, "docs", "b.md"), "utf8")).toBe(SKILLHUB_BETA_DOC);
    expect((await stat(path.join(target, "SKILL.md"))).isFile()).toBe(true);
  });
});
