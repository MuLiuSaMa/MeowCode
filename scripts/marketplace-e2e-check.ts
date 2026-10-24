/**
 * 插件市场端到端验证：起真 server（隔离 USERPROFILE 到临时目录）→
 * GET /marketplace → install skill/plugin/mcp → 验证 ~/.meowcode 落盘与生效 → uninstall → 关停。
 * 用法：pnpm build 后 npx tsx scripts/marketplace-e2e-check.ts
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const PORT = 39187;
const TOKEN = "mkt-e2e-token";
const BASE = `http://127.0.0.1:${PORT}`;

const sessionsDir = await mkdtemp(path.join(tmpdir(), "mkt-e2e-sessions-"));
const fakeHome = await mkdtemp(path.join(tmpdir(), "mkt-e2e-home-"));

async function api(pathname: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

function meow(...parts: string[]): string {
  return path.join(fakeHome, ".meowcode", ...parts);
}

const child = spawn(process.execPath, [path.join(REPO, "dist", "server", "server.js")], {
  cwd: REPO,
  env: {
    ...process.env,
    USERPROFILE: fakeHome,
    MEOWCODE_SERVER_PORT: String(PORT),
    MEOWCODE_SESSIONS_DIR: sessionsDir,
    MEOWCODE_WORKSPACE: REPO,
    MEOWCODE_MARKETPLACE_DIR: path.join(REPO, "resources", "marketplace"),
    MEOWCODE_PROVIDERS: JSON.stringify([
      { id: "p1", name: "P", baseUrl: "http://127.0.0.1:1", model: "m", apiKey: "k" },
    ]),
    MEOWCODE_SERVER_TOKEN: TOKEN,
  },
  stdio: ["ignore", "ignore", "pipe"],
});
child.stderr.on("data", (chunk) => console.error("[server:err]", String(chunk).trim()));

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

// 轮询就绪
let ready = false;
for (let i = 0; i < 60; i += 1) {
  try {
    const health = await api("/global/health");
    if (health.status === 200) {
      ready = true;
      break;
    }
  } catch {
    /* 未就绪 */
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
check("server 就绪", ready);
if (ready) {
  // 1) 市场索引（含图标表）
  const list = await api("/marketplace");
  const items: Array<{ id: string; type: string; installed: boolean; icon?: string }> =
    list.body?.items ?? [];
  const icons: Record<string, string> = list.body?.icons ?? {};
  check("GET /marketplace 返回索引", list.status === 200 && items.length >= 95, `${items.length} 项`);
  const iconCount = Object.keys(icons).length;
  check("索引带图标 dataUrl 表", iconCount >= 30, `${iconCount} 个图标`);
  const larkIcon = icons["skill:lark-base"];
  check("lark-base 有真图标（继承飞书插件）", Boolean(larkIcon?.startsWith("data:image/svg+xml")));

  // 1.5) 详情路由：skill → SKILL.md 正文；plugin → usage
  const detail = await api("/marketplace/detail?id=git-commit&type=skill");
  check(
    "detail skill 返回正文（去 frontmatter）",
    detail.status === 200 && typeof detail.body?.detail === "string" && !detail.body.detail.includes("name:"),
    `${String(detail.body?.detail ?? "").length} 字符`,
  );
  const pluginDetail = await api("/marketplace/detail?id=todo&type=plugin");
  check(
    "detail plugin 返回 usage",
    pluginDetail.status === 200 && String(pluginDetail.body?.detail ?? "").includes("todo"),
  );

  // 2) 安装技能：目录落盘 + installed 状态翻转（skill 无需 reload）
  const installSkill = await api("/marketplace/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "git-commit", type: "skill" }),
  });
  check("install skill git-commit", installSkill.status === 200);
  const skillLanded = existsSync(meow("skills", "git-commit", "SKILL.md"));
  check("技能目录已复制到 ~/.meowcode/skills", skillLanded);
  const listAfterSkill = await api("/marketplace");
  const skillEntry = (listAfterSkill.body?.items ?? []).find((entry: { id: string }) => entry.id === "git-commit");
  check("list 中 git-commit installed=true", skillEntry?.installed === true);

  // 3) 安装插件：文件落盘 + reload 后 /plugins 可见
  const installPlugin = await api("/marketplace/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "todo", type: "plugin" }),
  });
  check("install plugin todo", installPlugin.status === 200);
  const pluginLanded = existsSync(meow("plugins", "todo.ts"));
  check("插件文件已复制到 ~/.meowcode/plugins", pluginLanded);
  const plugins = await api("/plugins");
  const todoDescriptor = (plugins.body?.plugins ?? []).find(
    (entry: { id: string }) => entry.id === "todo",
  );
  check("reload 后 /plugins 出现 todo 插件", todoDescriptor?.enabled === true);

  // 4) 安装 MCP：mcp.json 合并 + 无凭据时 envReady=false
  const installMcp = await api("/marketplace/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "github", type: "mcp" }),
  });
  check("install mcp github", installMcp.status === 200);
  const mcpConfig = JSON.parse(await readFile(meow("mcp.json"), "utf8"));
  check(
    "mcp.json 已合并 github 条目（${MEOWCODE_GITHUB_TOKEN} 占位）",
    mcpConfig.mcpServers?.github?.headers?.Authorization === "Bearer ${MEOWCODE_GITHUB_TOKEN}",
  );

  // 5) 卸载：skill 目录删除、mcp 键移除、plugin 摘除
  await api("/marketplace/uninstall", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "git-commit", type: "skill" }),
  });
  await api("/marketplace/uninstall", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "todo", type: "plugin" }),
  });
  await api("/marketplace/uninstall", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "github", type: "mcp" }),
  });
  check("卸载后技能目录已删", !existsSync(meow("skills", "git-commit")));
  check("卸载后插件文件已删", !existsSync(meow("plugins", "todo.ts")));
  const mcpAfter = JSON.parse(await readFile(meow("mcp.json"), "utf8"));
  check("卸载后 mcp.json 键已移除", !mcpConfigAfterExists(mcpAfter));

  // 6) 无标记内容拒绝卸载
  await mkdir(meow("skills", "manual-skill"), { recursive: true });
  const deny = await api("/marketplace/uninstall", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "manual-skill", type: "skill" }),
  });
  check("无标记内容卸载返回 409", deny.status === 409, `实际 ${deny.status}`);
} else {
  failures += 1;
}

await new Promise<void>((resolve) => {
  child.once("exit", () => resolve());
  child.kill();
});
await rm(sessionsDir, { recursive: true, force: true });
await rm(fakeHome, { recursive: true, force: true });

function mcpConfigAfterExists(config: { mcpServers?: Record<string, unknown> }): boolean {
  return Boolean(config.mcpServers?.github);
}

console.log(failures === 0 ? "\nE2E ALL PASS" : `\nE2E FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
