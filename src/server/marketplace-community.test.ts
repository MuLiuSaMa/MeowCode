import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMarketplaceStore } from "./marketplace";
import { createCommunitySource } from "./marketplace-community";

// ---------------------------------------------------------------------------
// 测试基建：伪造 GitCode 树/直链响应
// ---------------------------------------------------------------------------

type BlobDef = { path: string; body: string | Buffer };

/** 把 blob 列表包成 GitCode 树 API 响应 + raw 直链路由 */
function makeFetch(blobs: BlobDef[]) {
  const shaByPath = new Map(blobs.map((blob, index) => [blob.path, `sha-${index}`]));
  const bodyBySha = new Map(blobs.map((blob, index) => [`sha-${index}`, blob.body]));
  let treeCalls = 0;
  const impl = (async (url: string) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/git/trees/main")) {
      treeCalls += 1;
      const tree = blobs.map((blob, index) => ({
        type: "blob",
        path: blob.path,
        sha: `sha-${index}`,
      }));
      return new Response(JSON.stringify({ tree }), { status: 200 });
    }
    // raw 直链：/blobs/<sha>/<name>
    if (parsed.pathname.includes("/blobs/")) {
      const sha = parsed.pathname.split("/")[4];
      const body = bodyBySha.get(sha);
      if (body === undefined) return new Response("missing", { status: 404 });
      const buffer = typeof body === "string" ? Buffer.from(body, "utf8") : body;
      return new Response(new Uint8Array(buffer), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return {
    fetchImpl: impl,
    calls: () => treeCalls,
    shaOf: (p: string) => shaByPath.get(p) ?? "",
  };
}

const SKILL_ITEM = {
  id: "demo-skill",
  type: "skill",
  name: "社区技能",
  description: "社区技能示例",
  category: "效率提升",
  tags: ["社区"],
  version: "1.0.0",
  author: "someone",
  submittedAt: "2026-10-24T00:00:00.000Z",
};

const PLUGIN_ITEM = {
  id: "demo-plugin",
  type: "plugin",
  name: "社区插件",
  description: "社区插件示例",
  category: "开发工具",
  tags: [],
  version: "2.0.0",
  author: "someone",
};

const MCP_ITEM = {
  id: "demo-mcp",
  type: "mcp",
  name: "社区 MCP",
  description: "社区 MCP 示例",
  category: "开发工具",
  tags: [],
  version: "1.0.0",
  author: "someone",
  server: { url: "https://mcp.example.com" },
  requiresEnv: ["MEOWCODE_DEMO_TOKEN"],
};

function communityBlobs(): BlobDef[] {
  return [
    { path: "skills/demo-skill/item.json", body: JSON.stringify(SKILL_ITEM) },
    { path: "skills/demo-skill/SKILL.md", body: "---\nname: demo-skill\ndescription: x\n---\n技能正文" },
    { path: "plugins/demo-plugin/item.json", body: JSON.stringify(PLUGIN_ITEM) },
    { path: "plugins/demo-plugin/demo-plugin.ts", body: "export default () => 'community';" },
    { path: "mcp/demo-mcp/item.json", body: JSON.stringify(MCP_ITEM) },
  ];
}

let home: string;
let bundles: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "meow-community-home-"));
  bundles = await mkdtemp(path.join(tmpdir(), "meow-community-bundles-"));
  await mkdir(bundles, { recursive: true });
});

afterEach(async () => {
  await Promise.all([
    rm(home, { recursive: true, force: true }),
    rm(bundles, { recursive: true, force: true }),
  ]);
});

describe("community marketplace source", () => {
  it("列表：解析 item.json、补 channel/author、返回 installed=false", async () => {
    const remote = makeFetch(communityBlobs());
    const source = createCommunitySource({ fetchImpl: remote.fetchImpl, retries: 0 });
    const listing = await source.list({ homeDir: home });

    expect(listing.entries).toHaveLength(3);
    const skill = listing.entries.find((entry) => entry.id === "demo-skill");
    expect(skill?.channel).toBe("community");
    expect(skill?.source).toBe("community");
    expect(skill?.author).toBe("someone");
    expect(skill?.entry).toBe("skills/demo-skill");
    expect(skill?.installed).toBe(false);
  });

  it("列表：官方同 id 条目被跳过", async () => {
    const remote = makeFetch(communityBlobs());
    const source = createCommunitySource({ fetchImpl: remote.fetchImpl, retries: 0 });
    const listing = await source.list(
      { homeDir: home },
      { officialIds: new Set(["skill:demo-skill", "mcp:demo-mcp"]) },
    );
    expect(listing.entries.map((entry) => entry.id).sort()).toEqual(["demo-plugin"]);
  });

  it("缓存：TTL 内不重复请求树；refresh=1 强制重新拉取", async () => {
    const remote = makeFetch(communityBlobs());
    const source = createCommunitySource({ fetchImpl: remote.fetchImpl, retries: 0 });
    await source.list({ homeDir: home });
    await source.list({ homeDir: home });
    expect(remote.calls()).toBe(1);
    await source.list({ homeDir: home }, { refresh: true });
    expect(remote.calls()).toBe(2);
  });

  it("网络失败：有过期磁盘缓存时兜底返回", async () => {
    const remote = makeFetch(communityBlobs());
    const source = createCommunitySource({ fetchImpl: remote.fetchImpl, retries: 0 });
    await source.list({ homeDir: home });

    const failing = createCommunitySource({
      fetchImpl: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
      retries: 0,
    });
    // 内存缓存为空的新实例：读磁盘缓存兜底（同一 home）
    const listing = await failing.list({ homeDir: home });
    expect(listing.entries).toHaveLength(3);
  });

  it("详情：技能返回去 frontmatter 正文", async () => {
    const remote = makeFetch(communityBlobs());
    const source = createCommunitySource({ fetchImpl: remote.fetchImpl, retries: 0 });
    const detail = await source.detail("demo-skill", "skill", { homeDir: home });
    expect(detail.detail).toBe("技能正文");
  });

  it("安装技能：全部文件落盘 + 标记带 version + 官方 store 可卸载", async () => {
    const remote = makeFetch(communityBlobs());
    const source = createCommunitySource({ fetchImpl: remote.fetchImpl, retries: 0 });
    const result = await source.install("demo-skill", "skill", { homeDir: home });
    expect(result.overwritten).toBe(false);

    const body = await readFile(path.join(home, ".meowcode", "skills", "demo-skill", "SKILL.md"), "utf8");
    expect(body).toContain("技能正文");
    expect(existsSync(path.join(home, ".meowcode", "skills", "demo-skill", "item.json"))).toBe(false);

    const marker = JSON.parse(
      await readFile(path.join(home, ".meowcode", ".marketplace", "skill-demo-skill.json"), "utf8"),
    );
    expect(marker.source).toBe("community");
    expect(marker.version).toBe("1.0.0");

    // 官方卸载兼容：标记格式一致，官方 store 直接能删
    const official = createMarketplaceStore(bundles);
    await official.uninstall("demo-skill", "skill", { homeDir: home });
    expect(existsSync(path.join(home, ".meowcode", "skills", "demo-skill"))).toBe(false);
  });

  it("安装插件：写入 ~/.meowcode/plugins/<id>.ts", async () => {
    const remote = makeFetch(communityBlobs());
    const source = createCommunitySource({ fetchImpl: remote.fetchImpl, retries: 0 });
    await source.install("demo-plugin", "plugin", { homeDir: home });
    const code = await readFile(path.join(home, ".meowcode", "plugins", "demo-plugin.ts"), "utf8");
    expect(code).toContain("community");
  });

  it("安装 MCP：server 合并进 mcp.json", async () => {
    const remote = makeFetch(communityBlobs());
    const source = createCommunitySource({ fetchImpl: remote.fetchImpl, retries: 0 });
    await source.install("demo-mcp", "mcp", { homeDir: home });
    const config = JSON.parse(await readFile(path.join(home, ".meowcode", "mcp.json"), "utf8"));
    expect(config.mcpServers["demo-mcp"]).toEqual({ url: "https://mcp.example.com" });
  });

  it("更新检测：远端版本高于标记版本时 updateAvailable=true", async () => {
    const remote = makeFetch(communityBlobs());
    const source = createCommunitySource({ fetchImpl: remote.fetchImpl, retries: 0 });
    await source.install("demo-skill", "skill", { homeDir: home });

    // 远端条目升版
    const bumped = makeFetch([
      { path: "skills/demo-skill/item.json", body: JSON.stringify({ ...SKILL_ITEM, version: "1.1.0" }) },
      { path: "skills/demo-skill/SKILL.md", body: "正文 v2" },
    ]);
    const updater = createCommunitySource({ fetchImpl: bumped.fetchImpl, retries: 0 });
    const listing = await updater.list({ homeDir: home }, { refresh: true });
    const skill = listing.entries.find((entry) => entry.id === "demo-skill");
    expect(skill?.installed).toBe(true);
    expect(skill?.updateAvailable).toBe(true);

    // 重装覆盖
    await updater.install("demo-skill", "skill", { homeDir: home });
    const after = await updater.list({ homeDir: home }, { refresh: true });
    expect(after.entries.find((entry) => entry.id === "demo-skill")?.updateAvailable).toBeFalsy();
  });

  it("损坏条目被跳过：缺 SKILL.md / 目录与 type 不符 / 非法 id", async () => {
    const remote = makeFetch([
      { path: "skills/broken-skill/item.json", body: JSON.stringify({ id: "broken-skill", type: "skill", name: "x" }) },
      { path: "skills/type-mismatch/item.json", body: JSON.stringify({ id: "type-mismatch", type: "mcp", name: "x", server: { url: "https://x" } }) },
      { path: "skills/Bad_ID/item.json", body: JSON.stringify({ id: "Bad_ID", type: "skill", name: "x" }) },
    ]);
    const source = createCommunitySource({ fetchImpl: remote.fetchImpl, retries: 0 });
    const listing = await source.list({ homeDir: home });
    expect(listing.entries).toHaveLength(0);
  });

  it("路径穿越拒绝：越界 blob 的安装直接失败", async () => {
    // 树里直接出现携带 ../ 的恶意路径（合并前不可信）
    const remote = makeFetch([
      { path: "skills/evil/item.json", body: JSON.stringify({ id: "evil", type: "skill", name: "x" }) },
      { path: "skills/evil/SKILL.md", body: "hi" },
      { path: "skills/evil/../../other/target.txt", body: "malware" },
    ]);
    const source = createCommunitySource({ fetchImpl: remote.fetchImpl, retries: 0 });
    await expect(source.install("evil", "skill", { homeDir: home })).rejects.toThrow();
  });

  it("超限文件拒绝下载", async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 97);
    const remote = makeFetch([
      { path: "skills/big/item.json", body: JSON.stringify({ id: "big", type: "skill", name: "x" }) },
      { path: "skills/big/SKILL.md", body: big },
    ]);
    const source = createCommunitySource({ fetchImpl: remote.fetchImpl, retries: 0 });
    await expect(source.install("big", "skill", { homeDir: home })).rejects.toThrow();
  });

  it("官方市场不受影响：ids() 返回官方键集", async () => {
    await mkdir(path.join(bundles, "skills", "official-skill"), { recursive: true });
    await writeFile(path.join(bundles, "skills", "official-skill", "SKILL.md"), "official");
    await writeFile(
      path.join(bundles, "index.json"),
      JSON.stringify({
        version: 1,
        generatedAt: "2026-01-01T00:00:00Z",
        items: [
          {
            id: "official-skill",
            type: "skill",
            name: "Official",
            description: "官方条目",
            category: "效率提升",
            source: "builtin",
            tags: [],
            version: "1.0.0",
            entry: "skills/official-skill",
            entryKind: "dir",
          },
        ],
      }),
    );
    const official = createMarketplaceStore(bundles);
    expect(await official.ids()).toEqual(new Set(["skill:official-skill"]));
  });
});
