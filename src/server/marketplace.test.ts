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

describe("mine/manual", () => {
  async function makeSkillDir(root: string, id: string): Promise<string> {
    const dir = path.join(root, id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "SKILL.md"),
      `---\nname: ${id}\ndescription: 手动技能 ${id}\n---\nbody`,
    );
    return dir;
  }

  it("manualImport skill：复制目录 + 写 manual 标记 + mineList 带出 frontmatter", async () => {
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "meow-mkt-src-"));
    try {
      const dir = await makeSkillDir(sourceRoot, "my-skill");
      const marketplace = store();
      const result = await marketplace.manualImport({ type: "skill", sourcePath: dir }, { homeDir: home });
      expect(result).toEqual({ id: "my-skill", type: "skill" });
      expect(
        await readFile(path.join(home, ".meowcode", "skills", "my-skill", "SKILL.md"), "utf8"),
      ).toContain("手动技能");

      const mine = await marketplace.mineList({ homeDir: home });
      expect(mine.skills).toHaveLength(1);
      expect(mine.skills[0]).toMatchObject({
        type: "skill",
        id: "my-skill",
        status: "ok",
        name: "my-skill",
        description: "手动技能 my-skill",
      });

      // 同 id 重复添加 → conflict；直接选 SKILL.md 文件路径同样报 conflict（id 取父目录名）
      await expect(
        marketplace.manualImport(
          { type: "skill", sourcePath: path.join(dir, "SKILL.md") },
          { homeDir: home },
        ),
      ).rejects.toMatchObject({ code: "conflict" });
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it("manualImport plugin：单文件保留扩展名，目录导入剔除 node_modules 且可按 target 卸载", async () => {
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "meow-mkt-src-"));
    try {
      const marketplace = store();
      await writeFile(path.join(sourceRoot, "my-plugin.ts"), "export default () => {};");
      await marketplace.manualImport(
        { type: "plugin", sourcePath: path.join(sourceRoot, "my-plugin.ts") },
        { homeDir: home },
      );
      expect(
        await readFile(path.join(home, ".meowcode", "plugins", "my-plugin.ts"), "utf8"),
      ).toContain("export default");

      const pluginDir = path.join(sourceRoot, "dir-plugin");
      await mkdir(path.join(pluginDir, "node_modules", "dep"), { recursive: true });
      await writeFile(path.join(pluginDir, "index.ts"), "export const x = 1;");
      await writeFile(path.join(pluginDir, "node_modules", "dep", "a.js"), "x");
      await marketplace.manualImport({ type: "plugin", sourcePath: pluginDir }, { homeDir: home });
      expect(await readFile(path.join(home, ".meowcode", "plugins", "dir-plugin", "index.ts"), "utf8")).toBe(
        "export const x = 1;",
      );
      await expect(
        readFile(path.join(home, ".meowcode", "plugins", "dir-plugin", "node_modules", "dep", "a.js"), "utf8"),
      ).rejects.toThrow();

      let mine = await marketplace.mineList({ homeDir: home });
      expect(mine.plugins.map((entry) => entry.id).sort()).toEqual(["dir-plugin", "my-plugin"]);

      // 卸载走 manual 标记的 target：目录整个删除
      await marketplace.uninstall("dir-plugin", "plugin", { homeDir: home });
      await expect(
        readFile(path.join(home, ".meowcode", "plugins", "dir-plugin", "index.ts"), "utf8"),
      ).rejects.toThrow();
      mine = await marketplace.mineList({ homeDir: home });
      expect(mine.plugins.map((entry) => entry.id)).toEqual(["my-plugin"]);
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it("manualImport 撞 id 拒绝：市场已装 / 手放内容；校验失败报 invalid_input", async () => {
    const marketplace = store();
    await marketplace.install("demo-skill", "skill", { homeDir: home });
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "meow-mkt-src-"));
    try {
      // 与市场已装撞 id
      const dir = await makeSkillDir(sourceRoot, "demo-skill");
      await expect(
        marketplace.manualImport({ type: "skill", sourcePath: dir }, { homeDir: home }),
      ).rejects.toMatchObject({ code: "conflict" });

      // 与手放内容撞 id（无任何标记但目标已存在）
      await mkdir(path.join(home, ".meowcode", "skills", "hand-made"), { recursive: true });
      await writeFile(path.join(home, ".meowcode", "skills", "hand-made", "SKILL.md"), "hand");
      const handDir = await makeSkillDir(sourceRoot, "hand-made");
      await expect(
        marketplace.manualImport({ type: "skill", sourcePath: handDir }, { homeDir: home }),
      ).rejects.toMatchObject({ code: "conflict" });

      // 校验失败：目录里没有 SKILL.md
      const emptyDir = path.join(sourceRoot, "empty");
      await mkdir(emptyDir, { recursive: true });
      await expect(
        marketplace.manualImport({ type: "skill", sourcePath: emptyDir }, { homeDir: home }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      // 路径不存在
      await expect(
        marketplace.manualImport(
          { type: "skill", sourcePath: path.join(sourceRoot, "ghost") },
          { homeDir: home },
        ),
      ).rejects.toMatchObject({ code: "invalid_input" });
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });

  it("manualMcpSave：merge 写入 + 更新自己的条目 overwritten=true + 撞键拒绝", async () => {
    const marketplace = store();
    await mkdir(path.join(home, ".meowcode"), { recursive: true });
    await writeFile(
      path.join(home, ".meowcode", "mcp.json"),
      JSON.stringify({ mcpServers: { existing: { command: "keep" } } }),
    );

    const first = await marketplace.manualMcpSave(
      { id: "my-mcp", server: { command: "npx", args: ["-y", "x"] } },
      { homeDir: home },
    );
    expect(first.overwritten).toBe(false);
    const again = await marketplace.manualMcpSave(
      { id: "my-mcp", server: { url: "https://mcp.example.com" } },
      { homeDir: home },
    );
    expect(again.overwritten).toBe(true);

    const config = JSON.parse(await readFile(path.join(home, ".meowcode", "mcp.json"), "utf8"));
    expect(config.mcpServers.existing).toEqual({ command: "keep" });
    expect(config.mcpServers["my-mcp"].url).toBe("https://mcp.example.com");

    // 手编键（无标记）不许静默覆盖
    await expect(
      marketplace.manualMcpSave({ id: "existing", server: { command: "hack" } }, { homeDir: home }),
    ).rejects.toMatchObject({ code: "conflict" });
    // 与市场已装撞 id
    await marketplace.install("demo-mcp", "mcp", { homeDir: home });
    await expect(
      marketplace.manualMcpSave({ id: "demo-mcp", server: { command: "x" } }, { homeDir: home }),
    ).rejects.toMatchObject({ code: "conflict" });
    // 缺 url/command
    await expect(
      marketplace.manualMcpSave({ id: "bad", server: { args: ["x"] } }, { homeDir: home }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("manualMcpToggle：翻转 enabled；非手动条目 not_managed；条目丢失报 not_found 且 mineList 标 missing", async () => {
    const marketplace = store();
    await marketplace.manualMcpSave({ id: "my-mcp", server: { command: "npx" } }, { homeDir: home });
    await marketplace.manualMcpToggle({ id: "my-mcp", enabled: false }, { homeDir: home });
    const config = JSON.parse(await readFile(path.join(home, ".meowcode", "mcp.json"), "utf8"));
    expect(config.mcpServers["my-mcp"].enabled).toBe(false);
    let mine = await marketplace.mineList({ homeDir: home });
    expect(mine.mcp[0]).toMatchObject({ id: "my-mcp", status: "ok", enabled: false });

    await expect(
      marketplace.manualMcpToggle({ id: "ghost", enabled: false }, { homeDir: home }),
    ).rejects.toMatchObject({ code: "not_managed" });

    // 有标记但 mcp.json 键被手删 → toggle 报 not_found，mineList 标 missing
    await marketplace.uninstall("my-mcp", "mcp", { homeDir: home });
    await marketplace.manualMcpSave({ id: "gone", server: { url: "https://x" } }, { homeDir: home });
    const raw = JSON.parse(await readFile(path.join(home, ".meowcode", "mcp.json"), "utf8"));
    delete raw.mcpServers.gone;
    await writeFile(path.join(home, ".meowcode", "mcp.json"), JSON.stringify(raw));
    await expect(
      marketplace.manualMcpToggle({ id: "gone", enabled: true }, { homeDir: home }),
    ).rejects.toMatchObject({ code: "not_found" });
    mine = await marketplace.mineList({ homeDir: home });
    expect(mine.mcp[0]).toMatchObject({ id: "gone", status: "missing" });
  });

  it("manual skill 卸载删除目录与标记；无标记手放内容仍拒绝卸载", async () => {
    const marketplace = store();
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "meow-mkt-src-"));
    try {
      const dir = await makeSkillDir(sourceRoot, "my-skill");
      await marketplace.manualImport({ type: "skill", sourcePath: dir }, { homeDir: home });
      await marketplace.uninstall("my-skill", "skill", { homeDir: home });
      await expect(
        readFile(path.join(home, ".meowcode", "skills", "my-skill", "SKILL.md"), "utf8"),
      ).rejects.toThrow();
      expect((await marketplace.mineList({ homeDir: home })).skills).toEqual([]);

      // 手放内容（无标记）：uninstall 依旧 not_managed
      await mkdir(path.join(home, ".meowcode", "skills", "hand-made"), { recursive: true });
      await writeFile(path.join(home, ".meowcode", "skills", "hand-made", "SKILL.md"), "hand");
      await expect(store().uninstall("hand-made", "skill", { homeDir: home })).rejects.toMatchObject({
        code: "not_managed",
      });
    } finally {
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });
});

