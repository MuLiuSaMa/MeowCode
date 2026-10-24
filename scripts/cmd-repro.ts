/**
 * 复现：装插件后 /命令 是否被展开。
 * 流程：起 server（隔离 home）→ install todo 插件 → GET /plugins 确认 →
 * POST /session/prompt "/todos" → 读会话 JSONL 检查 user 消息文本。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const PORT = 39191;
const TOKEN = "cmd-e2e-token";
const BASE = `http://127.0.0.1:${PORT}`;

const sessionsDir = await mkdtemp(path.join(tmpdir(), "cmd-e2e-sessions-"));
const fakeHome = await mkdtemp(path.join(tmpdir(), "cmd-e2e-home-"));

async function api(pathname: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
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
      { id: "p1", name: "P", baseUrl: "http://127.0.0.1:9", model: "m", apiKey: "k" },
    ]),
    MEOWCODE_SERVER_TOKEN: TOKEN,
  },
  stdio: ["ignore", "ignore", "pipe"],
});
child.stderr.on("data", (chunk) => console.error("[server:err]", String(chunk).trim()));

let ready = false;
for (let i = 0; i < 60; i += 1) {
  try {
    if ((await api("/global/health")).status === 200) { ready = true; break; }
  } catch { /* not ready */ }
  await new Promise((r) => setTimeout(r, 250));
}
console.log("server ready:", ready);

// 建会话
const created = await api("/session/new", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
const sessionId = created.body?.id;
console.log("session:", sessionId, "status:", created.status);

// 装 todo 插件
const install = await api("/marketplace/install", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: "todo", type: "plugin" }),
});
console.log("install todo:", install.status, JSON.stringify(install.body));

const plugins = await api("/plugins");
const todo = (plugins.body?.plugins ?? []).find((p: { id: string }) => p.id === "todo");
console.log("todo descriptor:", JSON.stringify(todo));

// 发 /todos
const prompt = await api("/session/prompt", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ sessionId, message: "/todos" }),
});
console.log("prompt /todos:", prompt.status, JSON.stringify(prompt.body));

// 等 2s 让消息落盘
await new Promise((r) => setTimeout(r, 2000));

// 读会话文件找 user 消息
const files = await readdir(sessionsDir);
let userText: string | null = null;
for (const file of files) {
  if (!file.endsWith(".jsonl")) continue;
  const lines = (await readFile(path.join(sessionsDir, file), "utf8")).split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "message" && entry.message?.role === "user") {
        const content = entry.message.content;
        userText = typeof content === "string" ? content : JSON.stringify(content);
      }
    } catch { /* skip */ }
  }
}
console.log("落盘 user 消息:", JSON.stringify(userText));
console.log(userText && userText.includes("todo") && !userText.startsWith("/todos") ? "EXPANDED ✓" : "NOT EXPANDED ✗");

child.kill();
await rm(sessionsDir, { recursive: true, force: true });
await rm(fakeHome, { recursive: true, force: true });
process.exit(0);
