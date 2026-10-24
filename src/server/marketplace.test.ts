import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMarketplaceStore, MarketplaceError } from "./marketplace";

let home: string;
let bundles: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "meow-mkt-home-"));
  bundles = await mkdtemp(path.join(tmpdir(), "meow-mkt-bundles-"));
  await mkdir(path.join(bundles, "skills", "demo-skill"), { recursive: true });
  await writeFile(
    path.join(bundles, "skills", "demo-skill", "SKILL.md"),
    "---\nname: demo-skill\ndescription: A demo skill\n---\nbody",
  );
  await mkdir(path.join(bundles, "mcp"), { recursive: true });
  await writeFile(
    path.join(bundles, "mcp", "demo-mcp.json"),
    JSON.stringify({
      description: "demo mcp",
      server: { url: "https://mcp.example.com", headers: { Authorization: "Bearer ${MEOWCODE_DEMO_TOKEN}" } },
    }),
  );
  await mkdir(path.join(bundles, "plugins"), { recursive: true });
  await writeFile(path.join(bundles, "plugins", "demo-plugin.ts"), "export default () => {};");
  await writeFile(
    path.join(bundles, "index.json"),
    JSON.stringify({
      version: 1,
      generatedAt: "2026-01-01T00:00:00Z",
      items: [
        {
          id: "demo-skill",
          type: "skill",
          name: "Demo",
          description: "A demo skill",
          category: "效率提升",
          source: "builtin",
          tags: [],
          version: "1.0.0",
          entry: "skills/demo-skill",
          entryKind: "dir",
        },
        {
          id: "demo-plugin",
          type: "plugin",
          name: "Demo Plugin",
          description: "A demo plugin",
          category: "开发工具",
          source: "metis",
          tags: [],
          version: "1.0.0",
          entry: "plugins/demo-plugin.ts",
          entryKind: "file",
        },
        {
          id: "demo-mcp",
          type: "mcp",
          name: "Demo MCP",
          description: "A demo mcp",
          category: "开发工具",
          source: "trae",
          tags: [],
          version: "1.0.0",
          entry: "mcp/demo-mcp.json",
          entryKind: "file",
          requiresEnv: ["MEOWCODE_DEMO_TOKEN"],
        },
      ],
    }),
  );
});

afterEach(async () => {
  await Promise.all([
    rm(home, { recursive: true, force: true }),
    rm(bundles, { recursive: true, force: true }),
  ]);
  delete process.env.MEOWCODE_DEMO_TOKEN;
});

function store() {
  return createMarketplaceStore(bundles);
}

describe("createMarketplaceStore.list", () => {
  it("未设置 bundlesDir 时返回空列表且 install 报错", async () => {
    const empty = createMarketplaceStore(undefined);
    expect((await empty.list({ homeDir: home })).entries).toEqual([]);
    await expect(empty.install("demo-skill", "skill", { homeDir: home })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("index 缺失/损坏时 list 返回空", async () => {
    await rm(path.join(bundles, "index.json"));
    expect((await store().list({ homeDir: home })).entries).toEqual([]);
  });

  it("list 带出 installed 与 envReady 状态", async () => {
    const { entries } = await store().list({ homeDir: home });
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => !entry.installed)).toBe(true);
    const mcp = entries.find((entry) => entry.type === "mcp");
    expect(mcp?.envReady).toBe(false); // MEOWCODE_DEMO_TOKEN 未设置
    process.env.MEOWCODE_DEMO_TOKEN = "x";
    const after = await store().list({ homeDir: home });
    expect(after.entries.find((entry) => entry.type === "mcp")?.envReady).toBe(true);
  });

  it("list 返回图标 dataUrl 表（key=<type>:<id>）", async () => {
    await mkdir(path.join(bundles, "icons"), { recursive: true });
    await writeFile(
      path.join(bundles, "icons", "demo-skill.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>',
    );
    await writeFile(
      path.join(bundles, "index.json"),
      JSON.stringify({
        version: 1,
        generatedAt: "2026-01-01T00:00:00Z",
        items: [
          {
            id: "demo-skill",
            type: "skill",
            name: "Demo",
            description: "d",
            category: "效率提升",
            source: "builtin",
            tags: [],
            version: "1.0.0",
            entry: "skills/demo-skill",
            entryKind: "dir",
            icon: "icons/demo-skill.svg",
          },
        ],
      }),
    );
    const { entries, icons } = await store().list({ homeDir: home });
    expect(icons["skill:demo-skill"]).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(entries[0]?.icon).toBe("icons/demo-skill.svg");
  });

  it("detail：skill 返回去 frontmatter 正文，未知 id 报 not_found", async () => {
    const result = await store().detail("demo-skill", "skill", { homeDir: home });
    expect(result.item.id).toBe("demo-skill");
    expect(result.detail).toContain("body");
    expect(result.detail).not.toContain("frontmatter-marker");
    await expect(store().detail("ghost", "skill", { homeDir: home })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("detail：plugin 返回 usage，mcp 无 detail", async () => {
    await writeFile(
      path.join(bundles, "index.json"),
      JSON.stringify({
        version: 1,
        generatedAt: "2026-01-01T00:00:00Z",
        items: [
          {
            id: "demo-plugin",
            type: "plugin",
            name: "Demo Plugin",
            description: "d",
            category: "开发工具",
            source: "metis",
            tags: [],
            version: "1.0.0",
            entry: "plugins/demo-plugin.ts",
            entryKind: "file",
            usage: "## 使用说明",
          },
          {
            id: "demo-mcp",
            type: "mcp",
            name: "Demo MCP",
            description: "d",
            category: "开发工具",
            source: "trae",
            tags: [],
            version: "1.0.0",
            entry: "mcp/demo-mcp.json",
            entryKind: "file",
          },
        ],
      }),
    );
    const pluginDetail = await store().detail("demo-plugin", "plugin", { homeDir: home });
    expect(pluginDetail.detail).toBe("## 使用说明");
    const mcpDetail = await store().detail("demo-mcp", "mcp", { homeDir: home });
    expect(mcpDetail.detail).toBeUndefined();
  });

  it("安装后 installed 变 true", async () => {
    const marketplace = store();
    await marketplace.install("demo-skill", "skill", { homeDir: home });
    const { entries } = await marketplace.list({ homeDir: home });
    expect(entries.find((entry) => entry.id === "demo-skill")?.installed).toBe(true);
    expect(entries.find((entry) => entry.id === "demo-plugin")?.installed).toBe(false);
  });
});

describe("install", () => {
  it("skill 整目录复制到 ~/.meowcode/skills/<id>", async () => {
    await store().install("demo-skill", "skill", { homeDir: home });
    const skillFile = path.join(home, ".meowcode", "skills", "demo-skill", "SKILL.md");
    expect(await readFile(skillFile, "utf8")).toContain("A demo skill");
  });

  it("plugin 复制单文件；mcp 合并写 user 根 mcp.json 且保留既有键", async () => {
    await mkdir(path.join(home, ".meowcode"), { recursive: true });
    await writeFile(
      path.join(home, ".meowcode", "mcp.json"),
      JSON.stringify({ mcpServers: { existing: { command: "keep" } }, note: "keep-me" }),
    );

    const marketplace = store();
    await marketplace.install("demo-plugin", "plugin", { homeDir: home });
    await marketplace.install("demo-mcp", "mcp", { homeDir: home });

    expect(
      await readFile(path.join(home, ".meowcode", "plugins", "demo-plugin.ts"), "utf8"),
    ).toContain("export default");
    const mcpConfig = JSON.parse(
      await readFile(path.join(home, ".meowcode", "mcp.json"), "utf8"),
    );
    expect(Object.keys(mcpConfig.mcpServers)).toEqual(["existing", "demo-mcp"]);
    expect(mcpConfig.note).toBe("keep-me");
    expect(mcpConfig.mcpServers["demo-mcp"].url).toBe("https://mcp.example.com");
  });

  it("重装覆盖且 overwritten=true", async () => {
    const marketplace = store();
    const first = await marketplace.install("demo-skill", "skill", { homeDir: home });
    const second = await marketplace.install("demo-skill", "skill", { homeDir: home });
    expect(first.overwritten).toBe(false);
    expect(second.overwritten).toBe(true);
  });

  it("未知 id 报 not_found；非法 id 报 invalid_id", async () => {
    await expect(store().install("ghost", "skill", { homeDir: home })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(store().install("..%2Fevil", "skill", { homeDir: home })).rejects.toMatchObject({
      code: "invalid_id",
    });
  });

  it("type 不匹配的 id 报 not_found", async () => {
    await expect(store().install("demo-skill", "plugin", { homeDir: home })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("每次安装写市场标记", async () => {
    await store().install("demo-skill", "skill", { homeDir: home });
    const marker = JSON.parse(
      await readFile(path.join(home, ".meowcode", ".marketplace", "skill-demo-skill.json"), "utf8"),
    );
    expect(marker).toMatchObject({ id: "demo-skill", type: "skill", source: "builtin" });
  });
});

describe("uninstall", () => {
  it("带标记的安装物可卸载（目录/文件/键均删除）", async () => {
    const marketplace = store();
    await marketplace.install("demo-skill", "skill", { homeDir: home });
    await marketplace.install("demo-plugin", "plugin", { homeDir: home });
    await marketplace.install("demo-mcp", "mcp", { homeDir: home });

    await marketplace.uninstall("demo-skill", "skill", { homeDir: home });
    await marketplace.uninstall("demo-plugin", "plugin", { homeDir: home });
    await marketplace.uninstall("demo-mcp", "mcp", { homeDir: home });

    const { entries } = await marketplace.list({ homeDir: home });
    expect(entries.every((entry) => !entry.installed)).toBe(true);
    const mcpConfig = JSON.parse(await readFile(path.join(home, ".meowcode", "mcp.json"), "utf8"));
    expect(mcpConfig.mcpServers).toEqual({});
  });

  it("无标记的同名内容拒绝卸载（not_managed），且不删文件", async () => {
    await mkdir(path.join(home, ".meowcode", "skills", "manual-skill"), { recursive: true });
    await writeFile(path.join(home, ".meowcode", "skills", "manual-skill", "SKILL.md"), "mine");
    await expect(store().uninstall("manual-skill", "skill", { homeDir: home })).rejects.toMatchObject({
      code: "not_managed",
    });
    expect(await readFile(path.join(home, ".meowcode", "skills", "manual-skill", "SKILL.md"), "utf8")).toBe("mine");
  });

  it("未安装的 id 卸载报 not_managed", async () => {
    await expect(store().uninstall("demo-skill", "skill", { homeDir: home })).rejects.toBeInstanceOf(
      MarketplaceError,
    );
  });
});
