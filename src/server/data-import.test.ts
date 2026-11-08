import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zstdCompressSync } from "node:zlib";
import { listSessions } from "../agent/session-store.js";
import { applyImport, applyImportItem, detectImportSources, planImport } from "./data-import.js";
import { startServer, type AgentServer } from "./server.js";

let home: string;
let sessionsDir: string;
let workspace: string;
const uuidA = "01a10f2d-f382-73e3-8743-14fe151203fa";
const uuidB = "01a10f32-a629-7053-8743-14fe151203fa";
const uuidWb = "01a10f33-b629-7053-8743-14fe151203fa";

async function put(filePath: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

/** 生成一段真实的 Codex rollout（session_meta + developer/user/assistant 消息）。 */
function rolloutJsonl(uuid: string, cwd: string, userText: string, assistantText: string): string {
  return [
    JSON.stringify({ timestamp: "2026-10-11T02:50:43Z", type: "session_meta", payload: { session_id: uuid, cwd } }),
    JSON.stringify({
      timestamp: "2026-10-11T02:50:43Z",
      type: "response_item",
      payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<user_instructions>skip me</user_instructions>" }] },
    }),
    JSON.stringify({
      timestamp: "2026-10-11T02:50:44Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: userText }] },
    }),
    JSON.stringify({
      timestamp: "2026-10-11T02:51:00Z",
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: assistantText }] },
    }),
  ].join("\n") + "\n";
}

/** 生成一段 WorkBuddy 风格的对话 jsonl（type:message + input/output_text，首条是包裹上下文）。 */
function workBuddyJsonl(userText: string, assistantText: string): string {
  return [
    JSON.stringify({
      id: "m0",
      timestamp: 1792245106000,
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "<system-reminder data-role=\"user-context\">\nOS Version: win32\n</system-reminder>" }],
    }),
    JSON.stringify({
      id: "m1",
      timestamp: 1792245106521,
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `<system-reminder data-role="user-context">\nOS Version: win32\n</system-reminder>\n<user_query>${userText}</user_query>` }],
    }),
    JSON.stringify({
      id: "m2",
      timestamp: 1792245107000,
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: assistantText }],
    }),
    JSON.stringify({ id: "m3", timestamp: 1792245107500, type: "function_call", payload: {} }),
  ].join("\n") + "\n";
}

const CODEX_TOML = [
  "[mcp_servers]",
  "",
  "[mcp_servers.node_repl]",
  "type = \"stdio\"",
  "command = 'C:\\Program Files\\node.exe'",
  "",
  "[mcp_servers.node_repl.env]",
  "FOO = \"bar\"",
  "",
  "[mcp_servers.remote]",
  "url = \"https://example.com/mcp\"",
  "",
  "[mcp_servers.off]",
  "command = 'x.exe'",
  "enabled = false",
  "",
].join("\n");

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "meowcode-import-home-"));
  sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-import-sessions-"));
  workspace = await mkdtemp(path.join(tmpdir(), "meowcode-import-ws-"));

  // ---- Qoder fixture ----
  const qoder = path.join(home, ".qoder");
  await put(
    path.join(qoder, "settings.json"),
    JSON.stringify({
      mcpServers: {
        github: { url: "https://api.githubcopilot.com/mcp/", type: "http" },
        broken: {},
        emptyUrl: { url: "" },
      },
    }),
  );
  await put(
    path.join(qoder, "memory", "MEMORY.md"),
    "- [User profile](user-profile.md) — 用户画像\n- [Precision](feedback-precision.md) — 要精确\n",
  );
  await put(path.join(qoder, "memory", "user-profile.md"), "用户喜欢简洁回复。\n");
  await put(path.join(qoder, "memory", "feedback-precision.md"), "---\ndescription: 要精确\n---\n正文。\n");
  await put(path.join(qoder, "plugins", "cache", "mkt", "present", "1.0", "skills", "present-skill", "SKILL.md"), "---\nname: present\n---\nbody\n");
  await put(path.join(qoder, "plugins", "cache", "mkt", "plain", "1.0", "README.md"), "no skills here\n");

  // Qoder 桌面端会话库：一个 standard 会话（含上下文 user 消息）+ 一个 sideChat（不导）
  const qoderDbPath = path.join(home, "AppData", "Roaming", "com.qodercn.app.stable", "main.sqlite");
  await mkdir(path.dirname(qoderDbPath), { recursive: true });
  const qoderDb = new DatabaseSync(qoderDbPath);
  qoderDb.exec(`
    CREATE TABLE chat_sessions (session_id TEXT PRIMARY KEY, title TEXT, cwd TEXT, created_at INTEGER, session_kind TEXT);
    CREATE TABLE chat_session_messages (session_id TEXT, message_id TEXT, sequence INTEGER, payload_json TEXT, role TEXT);
  `);
  qoderDb.prepare("INSERT INTO chat_sessions VALUES (?, ?, ?, ?, ?)").run(
    "q-sess-1", "实现 worktree", workspace, 1792884701109, "standard",
  );
  qoderDb.prepare("INSERT INTO chat_sessions VALUES (?, ?, ?, ?, ?)").run(
    "q-side-1", "侧聊", workspace, 1792884702000, "sideChat",
  );
  const insertQoderMessage = qoderDb.prepare("INSERT INTO chat_session_messages VALUES (?, ?, ?, ?, ?)");
  insertQoderMessage.run("q-sess-1", "qm0", 0, JSON.stringify({ role: "system", text: "system prompt" }), "system");
  insertQoderMessage.run("q-sess-1", "qm1", 1, JSON.stringify({ role: "user", text: "<user_instructions>skip me</user_instructions>" }), "user");
  insertQoderMessage.run("q-sess-1", "qm2", 2, JSON.stringify({ role: "user", text: "修一下主页的音乐卡片" }), "user");
  // 旧 schema：payload 不带 role，正文只在 parts 里
  insertQoderMessage.run("q-sess-1", "qm3", 3, JSON.stringify({
    parts: [
      { type: "thinking", text: "用户想修卡片" },
      { type: "text", text: "已定位：卡片渲染依赖 PC 连接状态字段。" },
    ],
  }), "assistant");
  qoderDb.close();

  // ---- WorkBuddy fixture ----
  const wb = path.join(home, ".workbuddy");
  await put(
    path.join(wb, "connectors", "default", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        "connector:qq-mail": { url: "https://api.mail.qq.com/mcp", disabled: true },
        "connector:ima": { url: "https://ima.qq.com/mcp", type: "streamableHttp" },
      },
    }),
  );
  await put(path.join(wb, "user-u1-personal", "MEMORY.md"), "# WorkBuddy memory\n\n- likes tea\n");
  await put(path.join(wb, "memory", "u1_memory.md"), "daily log\n");
  await put(path.join(wb, "plugins", "cache", "mkt", "doc", "1.0.0", "skills", "wb-skill", "SKILL.md"), "body\n");

  // WorkBuddy 会话：workbuddy.db 记元数据（一条存活、一条已删除），正文在 projects/<项目>/<cid>.jsonl
  await put(path.join(wb, "projects", "d-Test", `${uuidWb}.jsonl`), workBuddyJsonl("现在修复主页的 音乐卡片", "已定位：卡片渲染依赖 PC 连接状态字段。"));
  const wbDbPath = path.join(wb, "workbuddy.db");
  const wbDb = new DatabaseSync(wbDbPath);
  wbDb.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, custom_title TEXT, cwd TEXT, created_at INTEGER, deleted_at INTEGER)");
  wbDb.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)").run(uuidWb, "实现 verify.ts", null, workspace, 1792245106521, null);
  wbDb.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)").run("deleted-cid", "已删除会话", null, workspace, 1792245100000, 1792245110000);
  wbDb.close();

  // ---- Codex fixture ----
  const codex = path.join(home, ".codex");
  await put(path.join(codex, "config.toml"), CODEX_TOML);
  await put(
    path.join(codex, "memories", "MEMORY.md"),
    "- [Raw memories](raw_memories.md) — 原始记忆\n",
  );
  await put(path.join(codex, "memories", "raw_memories.md"), "raw memory body\n");
  await put(path.join(codex, "skills", ".system", "builtin", "SKILL.md"), "system\n");
  await put(
    path.join(codex, "sessions", "2026", "10", "06", `rollout-2026-10-06T11-12-20-${uuidA}.jsonl.zst`),
    zstdCompressSync(
      Buffer.from(
        rolloutJsonl(
          uuidA,
          workspace,
          "现在修复主页的 音乐卡片 只有链接上PC端以后才显示",
          "已定位：卡片渲染依赖 PC 连接状态字段。",
        ),
      ),
    ),
  );
  await put(
    path.join(codex, "sessions", "2026", "10", "06", `rollout-2026-10-06T11-13-39-${uuidB}.jsonl`),
    "fake jsonl",
  );
  await put(
    path.join(codex, "session_index.jsonl"),
    [
      JSON.stringify({ id: uuidA, thread_name: "隐藏PawnIO驱动微软商店安装入口", updated_at: "2026-10-06T03:08:22.591Z" }),
      JSON.stringify({ id: uuidB, updated_at: "2026-10-06T03:13:39.000Z" }),
    ].join("\n") + "\n",
  );

  // ---- ZCode fixture：db.sqlite 里一个 interactive 会话 + 一个子代理会话 + 一个已删除会话 ----
  const zcodeDbPath = path.join(home, ".zcode", "cli", "db", "db.sqlite");
  await mkdir(path.dirname(zcodeDbPath), { recursive: true });
  const zcodeDb = new DatabaseSync(zcodeDbPath);
  zcodeDb.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT,
      time_created INTEGER, time_updated INTEGER, time_deleted INTEGER, task_type TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, sequence INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, sequence INTEGER, data TEXT);
  `);
  zcodeDb.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "sess_z1", null, "调研汽水音乐歌单", "D:\\NexBox", 1792245106521, 1792245200000, null, "interactive",
  );
  zcodeDb.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "sess_subagent_agent_z2", "sess_z1", "子代理会话", "D:\\NexBox", 1792245110000, 1792245120000, null, "subagent_child",
  );
  zcodeDb.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "sess_z3", null, "已删除会话", "D:\\NexBox", 1792245120000, 1792245130000, 1792245140000, "interactive",
  );
  const insertZMessage = zcodeDb.prepare("INSERT INTO message VALUES (?, ?, ?, ?)");
  const insertZPart = zcodeDb.prepare("INSERT INTO part VALUES (?, ?, ?, ?)");
  insertZMessage.run("zm0", "sess_z1", 0, JSON.stringify({ role: "user" }));
  insertZPart.run("zp0", "zm0", 0, JSON.stringify({ type: "text", text: "<system-reminder>context</system-reminder>" }));
  insertZMessage.run("zm1", "sess_z1", 1, JSON.stringify({ role: "user" }));
  insertZPart.run("zp1", "zm1", 0, JSON.stringify({ type: "text", text: "调研汽水音乐的歌单接口" }));
  insertZPart.run("zp2", "zm1", 1, JSON.stringify({ type: "reasoning", text: "想一想" }));
  insertZMessage.run("zm2", "sess_z1", 2, JSON.stringify({ role: "assistant" }));
  insertZPart.run("zp3", "zm2", 0, JSON.stringify({ type: "tool", text: "toolcall" }));
  insertZPart.run("zp4", "zm2", 1, JSON.stringify({ type: "text", text: "已定位：歌单接口走 cookie 鉴权。" }));
  zcodeDb.close();

  // ---- ZCode 记忆与插件（skills）----
  await put(path.join(home, ".zcode", "cli", "memories", "projects", "nexbox-1c9a2ca44994b74f", "memory", "MEMORY.md"), "- [Z 记忆](z-note.md) — z\n");
  await put(path.join(home, ".zcode", "cli", "memories", "projects", "nexbox-1c9a2ca44994b74f", "memory", "z-note.md"), "z memory body\n");
  await put(path.join(home, ".zcode", "cli", "plugins", "cache", "zcode-plugins-official", "github", "0.1.4", "skills", "z-skill", "SKILL.md"), "z skill body\n");

  // ---- OpenCode fixture：jsonc 里 local/remote/disabled 三种 MCP + 一个会话 ----
  await put(
    path.join(home, ".config", "opencode", "opencode.jsonc"),
    [
      "{",
      "  // 注释要能剥掉",
      '  "$schema": "https://opencode.ai/config.json",',
      '  "mcp": {',
      '    "servers": {',
      '      "local-tool": { "type": "local", "command": ["node", "server.js"], "environment": { "FOO": "bar" } },',
      '      "remote-tool": { "type": "remote", "url": "https://example.com/mcp" },',
      '      "off": { "type": "remote", "url": "https://off.example/mcp", "disabled": true },',
      "    },",
      "  },",
      "}",
    ].join("\n"),
  );
  // ---- DeepSeek Harness fixture：多帧 zstd 会话（顶层 + 子代理）----
  const zstdLine = (obj: unknown): Buffer => zstdCompressSync(Buffer.from(`${JSON.stringify(obj)}\n`, "utf8"));
  const writeDshSession = async (dir: string, frames: Buffer[]): Promise<void> => {
    await put(path.join(home, ".dsh", "sessions", "--D-Test--", dir, "session.v4.jsonl.zstd"), Buffer.concat(frames));
  };
  await writeDshSession("session-d1", [
    zstdLine({ type: "session", version: 4, id: "session-d1", createdAt: 1792245500000, cwd: workspace, isSeeded: false, delegationDepth: 0 }),
    zstdCompressSync(
      Buffer.from(
        [
          JSON.stringify({ type: "user/message", seq: 0, time: 1792245501000, data: { content: [{ type: "text", text: "修复主页打开文件夹没用" }], source: { kind: "user" }, role: "user", id: "u1" } }),
          JSON.stringify({ type: "user/message", seq: 1, time: 1792245501500, data: { content: [{ type: "text", text: "Current runtime context. This snapshot supersedes earlier runtime-context snapshots." }], source: { kind: "context" }, role: "user", id: "u2" } }),
          JSON.stringify({ type: "user/message", seq: 2, time: 1792245501600, data: { content: [{ type: "text", text: "<system-reminder>skill list</system-reminder>" }], source: { kind: "user" }, role: "user", id: "u3" } }),
          JSON.stringify({ type: "assistant/message", seq: 3, time: 1792245502000, data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "reasoning", text: "想一想" }, { type: "text", text: "已定位：主页没有挂工作区组件。" }] } } }),
          JSON.stringify({ type: "session/title", seq: 4, time: 1792245502500, data: { title: "修复主页打开文件夹失效" } }),
        ].join("\n") + "\n",
        "utf8",
      ),
    ),
  ]);
  await writeDshSession("d2-subagent", [
    zstdLine({ type: "session", version: 4, id: "d2-subagent", createdAt: 1792245510000, cwd: workspace, isSeeded: false, origin: "subagent", parentSession: "session-d1", delegationDepth: 1 }),
  ]);

  const ocDbPath = path.join(home, ".local", "share", "opencode", "opencode.db");
  await mkdir(path.dirname(ocDbPath), { recursive: true });
  const ocDb = new DatabaseSync(ocDbPath);
  ocDb.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
  `);
  ocDb.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?)").run(
    "ses_oc1", null, "接入音乐歌单接口", workspace, 1792245300000, 1792245400000,
  );
  ocDb.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?)").run(
    "ses_oc_sub", "ses_oc1", "子代理会话", workspace, 1792245310000, 1792245320000,
  );
  const insertOcMessage = ocDb.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)");
  insertOcMessage.run("om0", "ses_oc1", "user", 0, 1792245301000, 1792245301000, JSON.stringify({ text: "接一下歌单接口" }));
  insertOcMessage.run("om1", "ses_oc1", "assistant", 1, 1792245302000, 1792245302000, JSON.stringify({
    content: [
      { type: "reasoning", text: "想一想" },
      { type: "text", text: "歌单接口需要登录态。" },
    ],
  }));
  insertOcMessage.run("om2", "ses_oc1", "system", 2, 1792245304000, 1792245304000, JSON.stringify({ text: "system note" }));
  ocDb.close();

  // ---- MeowCode 目标：预置同 MCP 名与同记忆名，验证 skip ----
  await put(
    path.join(home, ".meowcode", "mcp.json"),
    JSON.stringify({ mcpServers: { github: { url: "https://existing.example/mcp" } } }),
  );
  await put(
    path.join(home, ".meowcode", "memory", "MEMORY.md"),
    "- [Existing](existing.md) — 已有条目\n",
  );
  await put(path.join(home, ".meowcode", "memory", "existing.md"), "existing\n");
  await put(path.join(home, ".meowcode", "memory", "user-profile.md"), "已存在的同名记忆\n");
});

afterAll(async () => {
  await Promise.all([
    rm(home, { recursive: true, force: true }),
    rm(sessionsDir, { recursive: true, force: true }),
    rm(workspace, { recursive: true, force: true }),
  ]);
});

describe("detectImportSources", () => {
  it("三个应用探测出正确的分组计数", async () => {
    const sources = await detectImportSources(home);
    const byApp = new Map(sources.map((s) => [s.appId, s]));
    expect(byApp.size).toBe(8);
    expect(byApp.get("qoder")).toMatchObject({
      detected: true,
      groups: [
        { id: "mcp", count: 1 }, // broken/emptyUrl 被排除
        { id: "memory", count: 2 },
        { id: "skills", count: 1 },
        { id: "tasks", count: 1 }, // sideChat 不算
      ],
    });
    expect(byApp.get("workbuddy")).toMatchObject({
      detected: true,
      groups: [
        { id: "mcp", count: 1 }, // disabled 不算
        { id: "memory", count: 2 },
        { id: "skills", count: 1 },
        { id: "tasks", count: 1 }, // 已删除的会话不算
      ],
    });
    expect(byApp.get("zcode")).toMatchObject({
      detected: true,
      groups: [
        { id: "mcp", count: 0 },
        { id: "memory", count: 1 },
        { id: "skills", count: 1 },
        { id: "tasks", count: 1 }, // 子代理与已删除会话不算
      ],
    });
    expect(byApp.get("opencode")).toMatchObject({
      detected: true,
      groups: [
        { id: "mcp", count: 2 }, // disabled 不算
        { id: "memory", count: 0 },
        { id: "skills", count: 0 },
        { id: "tasks", count: 1 }, // 子代理会话不算
      ],
    });
    expect(byApp.get("dsh")).toMatchObject({
      detected: true,
      groups: [
        { id: "mcp", count: 0 },
        { id: "memory", count: 0 },
        { id: "skills", count: 0 },
        { id: "tasks", count: 1 }, // 子代理会话不算
      ],
    });
    expect(byApp.get("codex")).toMatchObject({
      detected: true,
      groups: [
        { id: "mcp", count: 2 }, // enabled=false 不算
        { id: "memory", count: 1 },
        { id: "skills", count: 0 }, // .system 排除
        { id: "tasks", count: 2 },
      ],
    });
  });

  it("目录不存在 → detected:false", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "meowcode-import-none-"));
    try {
      const sources = await detectImportSources(empty);
      expect(sources.map((s) => s.detected)).toEqual([false, false, false, false, false, false, false, false]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe("planImport / applyImportItem 逐条导入", () => {
  it("plan 只列待导入项，逐条 apply 后 plan 收缩", async () => {
    const first = await planImport(home, sessionsDir, "workbuddy", ["memory"]);
    expect(first.map((item) => item.name)).toEqual(["workbuddy-memory.md", "workbuddy-u1_memory.md"]);
    const result = await applyImportItem(home, sessionsDir, workspace, first[0]);
    expect(result.status).toBe("imported");
    const second = await planImport(home, sessionsDir, "workbuddy", ["memory"]);
    expect(second.map((item) => item.name)).toEqual(["workbuddy-u1_memory.md"]);
  });

  it("Codex rollout（zst）转成真实消息：developer 与包裹上下文被剔除", async () => {
    const items = await planImport(home, sessionsDir, "codex", ["tasks"]);
    const target = items.find((item) => item.name === "隐藏PawnIO驱动微软商店安装入口");
    expect(target).toBeDefined();
    const { messages, cwd } = await target!.session!.messages();
    expect(cwd).toBe(workspace);
    expect(messages).toEqual([
      { role: "user", content: "现在修复主页的 音乐卡片 只有链接上PC端以后才显示" },
      { role: "assistant", content: "已定位：卡片渲染依赖 PC 连接状态字段。" },
    ]);
  });
});

describe("applyImport mcp", () => {
  it("Qoder：已存在的不进 plan、不覆盖现有配置", async () => {
    const report = await applyImport(home, sessionsDir, workspace, "qoder", ["mcp"]);
    expect(report.groups[0].imported).toEqual([]);
    expect(report.groups[0].skipped).toEqual([]);
    const raw = JSON.parse(await readFile(path.join(home, ".meowcode", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, { url?: string }>;
    };
    expect(raw.mcpServers.github.url).toBe("https://existing.example/mcp");
  });

  it("Codex：stdio + env 映射，enabled=false 与 url 型各自正确", async () => {
    const report = await applyImport(home, sessionsDir, workspace, "codex", ["mcp"]);
    const mcp = report.groups[0];
    expect(mcp.imported).toEqual(["node_repl", "remote"]);
    const raw = JSON.parse(await readFile(path.join(home, ".meowcode", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command?: string; env?: Record<string, string>; url?: string }>;
    };
    expect(raw.mcpServers.node_repl).toEqual({
      command: "C:\\Program Files\\node.exe",
      env: { FOO: "bar" },
    });
    expect(raw.mcpServers.remote).toEqual({ url: "https://example.com/mcp" });
    expect(raw.mcpServers.off).toBeUndefined();
  });

  it("WorkBuddy：disabled 连接器不导入", async () => {
    const report = await applyImport(home, sessionsDir, workspace, "workbuddy", ["mcp"]);
    expect(report.groups[0].imported).toEqual(["connector:ima"]);
    expect(report.groups[0].skipped).toEqual([]);
  });
});

describe("applyImport memory", () => {
  it("Qoder：已存在的不进 plan，新记忆复制并保留来源索引行", async () => {
    const report = await applyImport(home, sessionsDir, workspace, "qoder", ["memory"]);
    expect(report.groups[0].imported).toEqual(["feedback-precision.md"]);
    const copied = await readFile(path.join(home, ".meowcode", "memory", "feedback-precision.md"), "utf8");
    expect(copied).toContain("要精确");
    const index = await readFile(path.join(home, ".meowcode", "memory", "MEMORY.md"), "utf8");
    expect(index).toContain("- [Precision](feedback-precision.md) — 要精确");
    expect(index).toContain("- [Existing](existing.md)");
  });

  it("WorkBuddy：单文件大记忆带前缀导入（personal 索引已在逐条用例导入）", async () => {
    const report = await applyImport(home, sessionsDir, workspace, "workbuddy", ["memory"]);
    expect(report.groups[0].imported).toEqual(["workbuddy-u1_memory.md"]);
    const index = await readFile(path.join(home, ".meowcode", "memory", "MEMORY.md"), "utf8");
    expect(index).toContain("[WorkBuddy memory](workbuddy-memory.md)");
  });

  it("Codex：来源索引行的链接改写成 codex- 前缀", async () => {
    const report = await applyImport(home, sessionsDir, workspace, "codex", ["memory"]);
    expect(report.groups[0].imported).toEqual(["codex-raw_memories.md"]);
    const index = await readFile(path.join(home, ".meowcode", "memory", "MEMORY.md"), "utf8");
    expect(index).toContain("- [Raw memories](codex-raw_memories.md) — 原始记忆");
  });
});

describe("applyImport skills", () => {
  it("Qoder：技能目录复制进 ~/.meowcode/skills，重复导入跳过", async () => {
    const first = await applyImport(home, sessionsDir, workspace, "qoder", ["skills"]);
    expect(first.groups[0].imported).toEqual(["present-skill"]);
    const second = await applyImport(home, sessionsDir, workspace, "qoder", ["skills"]);
    expect(second.groups[0].imported).toEqual([]);
    expect(second.groups[0].skipped).toEqual([]);
    const copied = await readFile(
      path.join(home, ".meowcode", "skills", "present-skill", "SKILL.md"),
      "utf8",
    );
    expect(copied).toContain("body");
    // 导入同时写「我的」手动标记，否则技能页「我的」看不到
    const marker = JSON.parse(
      await readFile(
        path.join(home, ".meowcode", ".marketplace", "manual-skill-present-skill.json"),
        "utf8",
      ),
    );
    expect(marker).toMatchObject({
      id: "present-skill",
      type: "skill",
      target: "skills/present-skill",
    });
  });

  it("WorkBuddy 与 Codex：各自来源正确（Codex 只有 .system → 全跳过为空操作）", async () => {
    const wb = await applyImport(home, sessionsDir, workspace, "workbuddy", ["skills"]);
    expect(wb.groups[0].imported).toEqual(["wb-skill"]);
    const codex = await applyImport(home, sessionsDir, workspace, "codex", ["skills"]);
    expect(codex.groups[0].imported).toEqual([]);
  });
});

describe("applyImport tasks（真实会话导入）", () => {
  it("Qoder：standard 会话转成真实消息，上下文与 system 剔除，二次导入全跳过", async () => {
    const first = await applyImport(home, sessionsDir, workspace, "qoder", ["tasks"]);
    expect(first.groups[0].imported).toEqual(["实现 worktree"]);
    const sessions = await listSessions(sessionsDir);
    const created = sessions.find((s) => s.title === "实现 worktree");
    expect(created).toBeDefined();
    const content = await readFile(created!.filePath, "utf8");
    expect(content).toContain("修一下主页的音乐卡片");
    expect(content).toContain("已定位：卡片渲染依赖 PC 连接状态字段。");
    expect(content).not.toContain("skip me");
    expect(content).not.toContain("system prompt");
    expect(content).not.toContain("用户想修卡片");

    const second = await applyImport(home, sessionsDir, workspace, "qoder", ["tasks"]);
    expect(second.groups[0].imported).toEqual([]);
  });

  it("WorkBuddy：标题/cwd 来自 workbuddy.db，已删除会话不导，正文剔除包裹上下文", async () => {
    const report = await applyImport(home, sessionsDir, workspace, "workbuddy", ["tasks"]);
    expect(report.groups[0].imported).toEqual(["实现 verify.ts"]);
    const sessions = await listSessions(sessionsDir);
    const created = sessions.find((s) => s.title === "实现 verify.ts");
    const content = await readFile(created!.filePath, "utf8");
    expect(content).toContain("现在修复主页的 音乐卡片");
    expect(content).toContain("已定位：卡片渲染依赖 PC 连接状态字段。");
    expect(content).not.toContain("user-context");
    expect(content).not.toContain("已删除会话");
  });

  it("ZCode：interactive 会话转真实消息，子代理/已删除不导，reasoning/tool 剔除", async () => {
    const report = await applyImport(home, sessionsDir, workspace, "zcode", ["tasks", "memory", "skills"]);
    const byId = (id: string) => report.groups.find((g) => g.id === id)!;
    expect(byId("tasks").imported).toContain("调研汽水音乐歌单");
    expect(byId("memory").imported).toEqual(["zcode-z-note.md"]);
    expect(byId("skills").imported).toEqual(["z-skill"]);
    const sessions = await listSessions(sessionsDir);
    const created = sessions.find((s) => s.title === "调研汽水音乐歌单");
    expect(created).toBeDefined();
    const content = await readFile(created!.filePath, "utf8");
    expect(content).toContain("调研汽水音乐的歌单接口");
    expect(content).toContain("已定位：歌单接口走 cookie 鉴权。");
    expect(content).not.toContain("system-reminder");
    expect(content).not.toContain("想一想");
    expect(content).not.toContain("toolcall");
    expect(content).not.toContain("已删除会话");
  });

  it("OpenCode：MCP 映射 local/remote 且剔除 disabled，会话剔除子代理与 reasoning", async () => {
    const report = await applyImport(home, sessionsDir, workspace, "opencode", ["mcp", "tasks"]);
    const byId = (id: string) => report.groups.find((g) => g.id === id)!;
    expect(byId("mcp").imported).toEqual(["local-tool", "remote-tool"]);
    expect(byId("tasks").imported).toEqual(["接入音乐歌单接口"]);
    const sessions = await listSessions(sessionsDir);
    const created = sessions.find((s) => s.title === "接入音乐歌单接口");
    const content = await readFile(created!.filePath, "utf8");
    expect(content).toContain("接一下歌单接口");
    expect(content).toContain("歌单接口需要登录态。");
    expect(content).not.toContain("想一想");
    expect(content).not.toContain("子代理会话");
    const raw = JSON.parse(
      await readFile(path.join(home, ".meowcode", "mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string }> };
    expect(raw.mcpServers["local-tool"]).toEqual({ command: "node", args: ["server.js"], env: { FOO: "bar" } });
    expect(raw.mcpServers["remote-tool"]).toEqual({ url: "https://example.com/mcp" });
  });

  it("DeepSeek Harness：多帧 zstd 会话转真实消息，子代理与注入上下文剔除", async () => {
    const report = await applyImport(home, sessionsDir, workspace, "dsh", ["tasks"]);
    expect(report.groups[0].imported).toEqual(["修复主页打开文件夹失效"]);
    const sessions = await listSessions(sessionsDir);
    const created = sessions.find((s) => s.title === "修复主页打开文件夹失效");
    expect(created).toBeDefined();
    const content = await readFile(created!.filePath, "utf8");
    expect(content).toContain("修复主页打开文件夹没用");
    expect(content).toContain("已定位：主页没有挂工作区组件。");
    expect(content).not.toContain("runtime-context snapshots");
    expect(content).not.toContain("system-reminder");
    expect(content).not.toContain("想一想");
    expect(content).not.toContain("d2-subagent");
  });

  it("Codex：标题来自 session_index.jsonl，无 thread_name 时用 uuid 前缀；坏内容落 stub", async () => {
    const report = await applyImport(home, sessionsDir, workspace, "codex", ["tasks"]);
    expect(report.groups[0].imported).toContain("隐藏PawnIO驱动微软商店安装入口");
    expect(report.groups[0].imported).toContain(`Codex session ${uuidB.slice(0, 8)}`);
    const sessions = await listSessions(sessionsDir);
    const named = sessions.find((s) => s.title === "隐藏PawnIO驱动微软商店安装入口");
    expect(named).toBeDefined();
    // uuidA 是真实 rollout：转换出的 user/assistant 消息都在会话文件里
    const content = await readFile(named!.filePath, "utf8");
    expect(content).toContain("现在修复主页的 音乐卡片 只有链接上PC端以后才显示");
    expect(content).toContain("已定位：卡片渲染依赖 PC 连接状态字段。");
    expect(content).not.toContain("skip me");
    // uuidB 解析不出消息 → stub
    const stubbed = sessions.find((s) => s.title === `Codex session ${uuidB.slice(0, 8)}`);
    expect(stubbed).toBeDefined();
    expect(await readFile(stubbed!.filePath, "utf8")).toContain("正文未能解析");
  });
});

// ---------------------------------------------------------------------------
// 路由集成：MEOWCODE_HOME_DIR 指向 fixture home
// ---------------------------------------------------------------------------

describe("/import 路由", () => {
  const TOKEN = "import-test-token";
  let server: AgentServer;
  let baseUrl: string;
  let routeHome: string;
  let routeSessions: string;
  let routeWorkspace: string;

  beforeAll(async () => {
    routeHome = await mkdtemp(path.join(tmpdir(), "meowcode-import-route-home-"));
    routeSessions = await mkdtemp(path.join(tmpdir(), "meowcode-import-route-sessions-"));
    routeWorkspace = await mkdtemp(path.join(tmpdir(), "meowcode-import-route-ws-"));
    await put(
      path.join(routeHome, ".qoder", "memory", "MEMORY.md"),
      "- [Profile](profile.md) — p\n",
    );
    await put(path.join(routeHome, ".qoder", "memory", "profile.md"), "profile body\n");
    await put(path.join(routeHome, ".meowcode", "mcp.json"), JSON.stringify({ mcpServers: {} }));
    process.env.MEOWCODE_HOME_DIR = routeHome;
    process.env.MEOWCODE_SESSIONS_DIR = routeSessions;
    process.env.MEOWCODE_WORKSPACE = routeWorkspace;
    process.env.MEOWCODE_PROVIDERS = JSON.stringify([
      { id: "p1", name: "provider", baseUrl: "http://127.0.0.1:1", model: "m", apiKey: "secret" },
    ]);
    process.env.MEOWCODE_SERVER_TOKEN = TOKEN;
    server = await startServer({ port: 0 });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server has no TCP address.");
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    await server.shutdown("test");
    delete process.env.MEOWCODE_HOME_DIR;
    delete process.env.MEOWCODE_SESSIONS_DIR;
    delete process.env.MEOWCODE_WORKSPACE;
    delete process.env.MEOWCODE_PROVIDERS;
    delete process.env.MEOWCODE_SERVER_TOKEN;
    await Promise.all([
      rm(routeHome, { recursive: true, force: true }),
      rm(routeSessions, { recursive: true, force: true }),
      rm(routeWorkspace, { recursive: true, force: true }),
    ]);
  });

  function get(pathname: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: { authorization: `Bearer ${TOKEN}`, ...init.headers },
    });
  }

  it("无 token 拒绝", async () => {
    const response = await fetch(`${baseUrl}/import/sources`);
    expect(response.status).toBe(401);
  });

  it("GET /import/sources 返回探测结果", async () => {
    const response = await get("/import/sources");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { sources: Array<{ appId: string; detected: boolean }> };
    expect(body.sources.map((s) => s.appId)).toEqual(["qoder", "qoderintl", "workbuddy", "workbuddyai", "zcode", "opencode", "dsh", "codex"]);
    expect(body.sources.find((s) => s.appId === "qoder")?.detected).toBe(true);
  });

  it("POST /import/apply 校验参数", async () => {
    const badApp = await get("/import/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: "nope", groups: ["mcp"] }),
    });
    expect(badApp.status).toBe(400);
    const badGroups = await get("/import/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: "qoder", groups: ["plugins"] }),
    });
    expect(badGroups.status).toBe(400);
  });

  it("POST /import/plan 列出待导入项", async () => {
    const response = await get("/import/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: "qoder", groups: ["memory"] }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ group: string; name: string }> };
    expect(body.items).toEqual([{ group: "memory", name: "profile.md" }]);
  });

  it("POST /import/apply-one 导入单条并返回状态", async () => {
    const response = await get("/import/apply-one", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: "qoder", group: "memory", name: "profile.md" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "imported" });
    // 再来一次：plan 不再包含该项 → skipped
    const again = await get("/import/apply-one", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: "qoder", group: "memory", name: "profile.md" }),
    });
    expect(await again.json()).toEqual({ status: "skipped" });
  });

  it("POST /import/apply 重复导入全跳过（apply-one 已导过）", async () => {
    const response = await get("/import/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: "qoder", groups: ["memory"] }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      appId: string;
      mcpChanged: boolean;
      groups: Array<{ id: string; imported: string[]; skipped: string[] }>;
    };
    expect(body.appId).toBe("qoder");
    expect(body.mcpChanged).toBe(false);
    expect(body.groups[0].imported).toEqual([]);
    expect(body.groups[0].skipped).toEqual([]);
  });
});
