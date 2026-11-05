import { promises as fs } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parse as parseToml } from "smol-toml";
import { readJsonFile, writeJsonAtomic, writeTextAtomic } from "../agent/atomic-json.js";
import { SessionStore, flushSessionIndex, sessionFileName } from "../agent/session-store.js";
import type { ChatMessage } from "../agent/types.js";

/**
 * 「数据导入」：从 Qoder CN IDE (~/.qoder + 桌面端 main.sqlite)、WorkBuddy (~/.workbuddy)、
 * Codex (~/.codex) 导入 MCP 连接器、记忆、Skills、会话记录。仅自动探测标准目录；
 * 不改动来源应用数据；同名/同 ID 已存在一律跳过。插件不导（来源是 Claude 格式，加载不了）。
 *
 * 导入按「plan → 逐条 apply」两段式：planImport 列出待导入项（已存在的不会出现），
 * applyImportItem 应用其中一条。桌面端逐条调用以驱动 X/X 进度；applyImport 是
 * plan + 顺序 apply 的批处理包装，供旧路由与测试复用。
 */

export type ImportAppId =
  | "qoder"
  | "qoderintl"
  | "workbuddy"
  | "workbuddyai"
  | "zcode"
  | "opencode"
  | "dsh"
  | "codex";
export type QoderLikeAppId = "qoder" | "qoderintl";

/** Qoder 系桌面端的会话库：国内版 com.qodercn.app.stable，国际版 com.qoder.app.stable */
const QODER_APP_DBS: Record<QoderLikeAppId, string> = {
  qoder: path.join("AppData", "Roaming", "com.qodercn.app.stable", "main.sqlite"),
  qoderintl: path.join("AppData", "Roaming", "com.qoder.app.stable", "main.sqlite"),
};

function isQoderLike(appId: ImportAppId): appId is QoderLikeAppId {
  return appId === "qoder" || appId === "qoderintl";
}

function qoderAppDbPath(homeDir: string, appId: QoderLikeAppId): string {
  return path.join(homeDir, QODER_APP_DBS[appId]);
}
export type WorkBuddyLikeAppId = "workbuddy" | "workbuddyai";

/** WorkBuddy 系应用的数据目录：国内版 ~/.workbuddy，国际版 WorkBuddyAI ~/.workbuddy-ai，结构一致 */
const WORKBUDDY_ROOTS: Record<WorkBuddyLikeAppId, string> = {
  workbuddy: ".workbuddy",
  workbuddyai: ".workbuddy-ai",
};
const WORKBUDDY_LABELS: Record<WorkBuddyLikeAppId, string> = {
  workbuddy: "WorkBuddy",
  workbuddyai: "WorkBuddyAI",
};

function isWorkBuddyLike(appId: ImportAppId): appId is WorkBuddyLikeAppId {
  return appId === "workbuddy" || appId === "workbuddyai";
}

function workBuddyRoot(homeDir: string, appId: WorkBuddyLikeAppId): string {
  return path.join(homeDir, WORKBUDDY_ROOTS[appId]);
}
export type ImportGroupId = "mcp" | "memory" | "skills" | "tasks";

export type ImportSourceGroup = { id: ImportGroupId; count: number };
export type ImportSource = {
  appId: ImportAppId;
  detected: boolean;
  groups: ImportSourceGroup[];
};

export type ImportGroupReport = {
  id: ImportGroupId;
  imported: string[];
  skipped: string[];
  failed: { name: string; reason: string }[];
};
export type ImportReport = { appId: ImportAppId; groups: ImportGroupReport[]; mcpChanged: boolean };

export type McpServerEntry = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
};

/** plan 里的一个待导入项；session.messages 惰性求值（Codex 要解压整个 rollout）。 */
export type ImportPlanItem = {
  group: ImportGroupId;
  /** 展示名（MCP 名 / 目标文件名 / 会话标题） */
  name: string;
  /** tasks 的幂等 key（qoder-chat:<id> / workbuddy-chat:<cid> / zcode-chat:<id> / opencode-chat:<id> / codex:<uuid>） */
  key?: string;
  sourcePath?: string;
  entry?: McpServerEntry;
  targetName?: string;
  indexLine?: string;
  session?: { createdAt: Date; messages: () => Promise<{ messages: ChatMessage[]; cwd: string | null }> };
};

export type ImportItemResult = { status: "imported" | "skipped" | "failed"; reason?: string };

const MEMORY_INDEX_NAME = "MEMORY.md";
const MAX_MEMORY_BYTES = 512 * 1024;
const MAX_TASK_SESSIONS_PER_APPLY = 300;
const MAX_IMPORT_MESSAGES = 400;
const MAX_MESSAGE_CHARS = 20_000;
const WALK_MAX_DEPTH = 6;

const GROUP_IDS: ImportGroupId[] = ["mcp", "memory", "skills", "tasks"];

function group(id: ImportGroupId, count: number): ImportSourceGroup {
  return { id, count };
}

async function exists(p: string): Promise<boolean> {
  return fs
    .stat(p)
    .then(() => true)
    .catch(() => false);
}

/** 收集形如 skills/<name>/SKILL.md 的一层子目录（.system 是 Codex 内置，排除）。 */
async function findSkillDirs(roots: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const root of roots) {
    if (!(await exists(root))) continue;
    await walkForSkills(root, 0, found);
  }
  return found;
}

async function walkForSkills(dir: string, depth: number, found: string[]): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.name === "skills") {
      let children: import("node:fs").Dirent[];
      try {
        children = await fs.readdir(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        if (!child.isDirectory()) continue;
        if (child.name === ".system") continue;
        if (await exists(path.join(full, child.name, "SKILL.md"))) {
          found.push(path.join(full, child.name));
        }
      }
    } else if (depth < WALK_MAX_DEPTH) {
      await walkForSkills(full, depth + 1, found);
    }
  }
}

/** 递归收集匹配后缀的文件（有深度上限）。 */
async function walkFiles(dir: string, depth: number, suffixes: string[], out: string[]): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < WALK_MAX_DEPTH) await walkFiles(full, depth + 1, suffixes, out);
    } else if (suffixes.some((suffix) => entry.name.endsWith(suffix))) {
      out.push(full);
    }
  }
}

async function listMarkdownFiles(dir: string, exclude: string[]): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !exclude.includes(entry.name))
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/** node:sqlite 只读打开；缺库/被占用等失败一律返回 null，调用方降级。 */
async function openReadOnlyDb(dbPath: string): Promise<DatabaseSync | null> {
  if (!(await exists(dbPath))) return null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * dsh 的会话文件是多帧 zstd 顺序拼接，zstdDecompressSync 只解第一帧；
 * 按魔数切帧逐帧解。帧内出现假魔数（概率极低）时向后扩展重试，避免截断丢内容。
 */
function zstdDecompressAllFrames(buf: Buffer): string {
  const starts: number[] = [0];
  let idx = 0;
  while ((idx = buf.indexOf(ZSTD_MAGIC, idx + 1)) !== -1) starts.push(idx);
  const parts: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    let end = i + 1 < starts.length ? starts[i + 1] : buf.length;
    for (;;) {
      try {
        parts.push(zstdDecompressSync(buf.subarray(starts[i], end)).toString("utf8"));
        break;
      } catch {
        const next = buf.indexOf(ZSTD_MAGIC, end + 1);
        if (next === -1) {
          if (end >= buf.length) break;
          end = buf.length;
        } else {
          end = next;
        }
      }
    }
  }
  return parts.join("");
}

type ParsedSourceMcp = Record<string, McpServerEntry>;

function mcpFromQoderSettings(raw: unknown): ParsedSourceMcp {
  const out: ParsedSourceMcp = {};
  const servers = (raw as { mcpServers?: unknown } | undefined)?.mcpServers;
  if (!servers || typeof servers !== "object") return out;
  for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
    if (!cfg || typeof cfg !== "object") continue;
    const url = (cfg as { url?: unknown }).url;
    if (typeof url === "string" && url.trim()) out[name] = { url };
  }
  return out;
}

function mcpFromWorkBuddyConnectors(raw: unknown): ParsedSourceMcp {
  const out: ParsedSourceMcp = {};
  const servers = (raw as { mcpServers?: unknown } | undefined)?.mcpServers;
  if (!servers || typeof servers !== "object") return out;
  for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
    if (!cfg || typeof cfg !== "object") continue;
    const c = cfg as { url?: unknown; disabled?: unknown };
    if (c.disabled === true) continue;
    if (typeof c.url === "string" && c.url.trim()) out[name] = { url: c.url };
  }
  return out;
}

/** 宽容解析 JSONC：去注释与尾逗号后再试一次。 */
function parseJsonc(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"\\])\/\/.*$/gm, "$1")
      .replace(/,(\s*[}\]])/g, "$1");
    try {
      return JSON.parse(stripped);
    } catch {
      return undefined;
    }
  }
}

/** OpenCode 的 mcp.servers：local（command 数组）/ remote（url），disabled 不算。 */
function mcpFromOpencodeConfig(raw: unknown): ParsedSourceMcp {
  const out: ParsedSourceMcp = {};
  const servers = (raw as { mcp?: { servers?: unknown } } | undefined)?.mcp?.servers;
  if (!servers || typeof servers !== "object") return out;
  for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
    if (!cfg || typeof cfg !== "object") continue;
    const c = cfg as {
      type?: unknown;
      disabled?: unknown;
      url?: unknown;
      command?: unknown;
      environment?: unknown;
    };
    if (c.disabled === true) continue;
    if (c.type === "remote" && typeof c.url === "string" && c.url.trim()) {
      out[name] = { url: c.url };
      continue;
    }
    if (c.type === "local" && Array.isArray(c.command)) {
      const command = c.command.filter((part): part is string => typeof part === "string");
      const [cmd, ...args] = command;
      if (!cmd) continue;
      out[name] = {
        command: cmd,
        ...(args.length > 0 ? { args } : {}),
        ...(c.environment && typeof c.environment === "object"
          ? { env: c.environment as Record<string, string> }
          : {}),
      };
    }
  }
  return out;
}

function mcpFromCodexToml(raw: unknown): ParsedSourceMcp {  const out: ParsedSourceMcp = {};
  const servers = (raw as { mcp_servers?: unknown } | undefined)?.mcp_servers;
  if (!servers || typeof servers !== "object") return out;
  for (const [name, cfg] of Object.entries(servers as Record<string, unknown>)) {
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) continue;
    const c = cfg as { enabled?: unknown; command?: unknown; args?: unknown; env?: unknown; url?: unknown };
    if (c.enabled === false) continue;
    if (typeof c.command === "string" && c.command.trim()) {
      out[name] = {
        command: c.command,
        ...(Array.isArray(c.args) ? { args: c.args.filter((a): a is string => typeof a === "string") } : {}),
        ...(c.env && typeof c.env === "object" && !Array.isArray(c.env)
          ? {
              env: Object.fromEntries(
                Object.entries(c.env as Record<string, unknown>).filter(
                  (entry): entry is [string, string] => typeof entry[1] === "string",
                ),
              ),
            }
          : {}),
      };
    } else if (typeof c.url === "string" && c.url.trim()) {
      out[name] = { url: c.url };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 探测
// ---------------------------------------------------------------------------

export async function detectImportSources(homeDir: string): Promise<ImportSource[]> {
  const [qoder, qoderintl, workbuddy, workbuddyai, zcode, opencode, dsh, codex] = await Promise.all([
    detectQoderLike(homeDir, "qoder"),
    detectQoderLike(homeDir, "qoderintl"),
    detectWorkBuddyLike(homeDir, "workbuddy"),
    detectWorkBuddyLike(homeDir, "workbuddyai"),
    detectZcode(homeDir),
    detectOpenCode(homeDir),
    detectDsh(homeDir),
    detectCodex(path.join(homeDir, ".codex")),
  ]);
  return [qoder, qoderintl, workbuddy, workbuddyai, zcode, opencode, dsh, codex];
}

async function detectOpenCode(homeDir: string): Promise<ImportSource> {
  const configRoot = path.join(homeDir, ".config", "opencode");
  const dataDb = path.join(homeDir, ".local", "share", "opencode", "opencode.db");
  if (!(await exists(configRoot)) && !(await exists(dataDb))) {
    return { appId: "opencode", detected: false, groups: GROUP_IDS.map((id) => group(id, 0)) };
  }
  let mcp = 0;
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const raw = await fs.readFile(path.join(configRoot, name), "utf8").catch(() => undefined);
    if (raw === undefined) continue;
    mcp = Object.keys(mcpFromOpencodeConfig(parseJsonc(raw))).length;
    break;
  }
  const tasks = (await opencodeConversationMetas(homeDir)).length;
  return {
    appId: "opencode",
    detected: true,
    groups: [group("mcp", mcp), group("memory", 0), group("skills", 0), group("tasks", tasks)],
  };
}

async function detectQoderLike(homeDir: string, appId: QoderLikeAppId): Promise<ImportSource> {
  const notDetected: ImportSource = { appId, detected: false, groups: GROUP_IDS.map((id) => group(id, 0)) };
  if (appId === "qoder") {
    const root = path.join(homeDir, ".qoder");
    if (!(await exists(root))) return notDetected;
  } else if (!(await exists(qoderAppDbPath(homeDir, appId)))) {
    return notDetected;
  }
  let mcp = 0;
  let memory = 0;
  let skills = 0;
  if (appId === "qoder") {
    const root = path.join(homeDir, ".qoder");
    const settings = await readJsonFile<Record<string, unknown>>(path.join(root, "settings.json")).catch(
      () => undefined,
    );
    mcp = Object.keys(mcpFromQoderSettings(settings)).length;
    memory = (await listMarkdownFiles(path.join(root, "memory"), [MEMORY_INDEX_NAME])).length;
    skills = (await findSkillDirs([path.join(root, "plugins", "cache")])).length;
  }
  const tasks = (await qoderConversationMetas(homeDir, appId)).length;
  return {
    appId,
    detected: true,
    groups: [group("mcp", mcp), group("memory", memory), group("skills", skills), group("tasks", tasks)],
  };
}

async function detectZcode(homeDir: string): Promise<ImportSource> {
  const root = path.join(homeDir, ".zcode");
  if (!(await exists(root))) return { appId: "zcode", detected: false, groups: GROUP_IDS.map((id) => group(id, 0)) };
  const memory = (await zcodeMemoryFiles(homeDir)).length;
  const skills = (await findSkillDirs([path.join(root, "cli", "plugins", "cache")])).length;
  const tasks = (await zcodeConversationMetas(homeDir)).length;
  return {
    appId: "zcode",
    detected: true,
    groups: [group("mcp", 0), group("memory", memory), group("skills", skills), group("tasks", tasks)],
  };
}

async function detectWorkBuddyLike(homeDir: string, appId: WorkBuddyLikeAppId): Promise<ImportSource> {
  const root = workBuddyRoot(homeDir, appId);
  if (!(await exists(root))) {
    return { appId, detected: false, groups: GROUP_IDS.map((id) => group(id, 0)) };
  }
  const connectors = await readJsonFile<Record<string, unknown>>(
    path.join(root, "connectors", "default", "mcp.json"),
  ).catch(() => undefined);
  const mcp = Object.keys(mcpFromWorkBuddyConnectors(connectors)).length;
  const memory = (await workBuddyMemoryFiles(root)).length;
  const skills = (
    await findSkillDirs([path.join(root, "plugins", "cache"), path.join(root, "skills")])
  ).length;
  const tasks = (await workBuddyConversationMetas(homeDir, appId, await workBuddyConversationFiles(homeDir, appId)))
    .length;
  return {
    appId,
    detected: true,
    groups: [group("mcp", mcp), group("memory", memory), group("skills", skills), group("tasks", tasks)],
  };
}

async function detectCodex(root: string): Promise<ImportSource> {
  if (!(await exists(root))) return { appId: "codex", detected: false, groups: GROUP_IDS.map((id) => group(id, 0)) };
  let mcp = 0;
  try {
    const toml = parseToml(await fs.readFile(path.join(root, "config.toml"), "utf8"));
    mcp = Object.keys(mcpFromCodexToml(toml)).length;
  } catch {
    mcp = 0;
  }
  const memory = (await listMarkdownFiles(path.join(root, "memories"), [MEMORY_INDEX_NAME])).length;
  const skills = (await findSkillDirs([path.join(root, "skills")])).length;
  const sessionFiles: string[] = [];
  await walkFiles(path.join(root, "sessions"), 0, [".jsonl", ".jsonl.zst"], sessionFiles);
  return {
    appId: "codex",
    detected: true,
    groups: [group("mcp", mcp), group("memory", memory), group("skills", skills), group("tasks", sessionFiles.length)],
  };
}

/** WorkBuddy 记忆候选：user-*-personal/MEMORY.md 优先，其次 memory/*_memory.md（排除 .bak）。 */
async function workBuddyMemoryFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const personalDir = (await fs.readdir(root, { withFileTypes: true }).catch(() => [])).find(
    (entry) => entry.isDirectory() && entry.name.startsWith("user-") && entry.name.endsWith("-personal"),
  );
  if (personalDir) {
    const candidate = path.join(root, personalDir.name, MEMORY_INDEX_NAME);
    if (await exists(candidate)) out.push(candidate);
  }
  const memoryDir = path.join(root, "memory");
  try {
    const entries = await fs.readdir(memoryDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith("_memory.md") && !entry.name.endsWith(".bak")) {
        out.push(path.join(memoryDir, entry.name));
      }
    }
  } catch {
    // 无 memory 目录
  }
  return out;
}

// ---------------------------------------------------------------------------
// 来源解析（plan 共用）
// ---------------------------------------------------------------------------

async function sourceMcp(homeDir: string, appId: ImportAppId): Promise<ParsedSourceMcp> {
  if (appId === "qoder") {
    const settings = await readJsonFile<Record<string, unknown>>(
      path.join(homeDir, ".qoder", "settings.json"),
    ).catch(() => undefined);
    return mcpFromQoderSettings(settings);
  }
  if (isWorkBuddyLike(appId)) {
    const connectors = await readJsonFile<Record<string, unknown>>(
      path.join(workBuddyRoot(homeDir, appId), "connectors", "default", "mcp.json"),
    ).catch(() => undefined);
    return mcpFromWorkBuddyConnectors(connectors);
  }
  if (appId === "opencode") {
    for (const name of ["opencode.jsonc", "opencode.json"]) {
      const raw = await fs.readFile(path.join(homeDir, ".config", "opencode", name), "utf8").catch(() => undefined);
      if (raw === undefined) continue;
      return mcpFromOpencodeConfig(parseJsonc(raw));
    }
    return {};
  }
  if (appId !== "codex") return {};
  try {
    const toml = parseToml(await fs.readFile(path.join(homeDir, ".codex", "config.toml"), "utf8"));
    return mcpFromCodexToml(toml);
  } catch {
    return {};
  }
}

async function readMeowMcp(meowRoot: string): Promise<Record<string, McpServerEntry>> {
  const raw = await readJsonFile<{ mcpServers?: Record<string, McpServerEntry> }>(path.join(meowRoot, "mcp.json"));
  return raw?.mcpServers && typeof raw.mcpServers === "object" ? raw.mcpServers : {};
}

/** 从来源 MEMORY.md 里找引用该文件的索引行（目标文件名不同时改写链接），找不到就用标题兜底。 */
function indexLineFor(
  sourceIndex: string | undefined,
  sourceName: string,
  targetName: string,
  fallbackTitle: string,
): string {
  if (sourceIndex) {
    const match = sourceIndex.split(/\r?\n/).find((line) => line.includes(`(${sourceName})`));
    if (match) return match.replace(`(${sourceName})`, `(${targetName})`);
  }
  return `- [${fallbackTitle}](${targetName})`;
}

type MemoryCandidate = { sourcePath: string; targetName: string; indexLine: string };

async function memoryCandidates(homeDir: string, appId: ImportAppId): Promise<MemoryCandidate[]> {
  if (appId === "qoder") {
    const sourceDir = path.join(homeDir, ".qoder", "memory");
    const sourceIndex = await fs.readFile(path.join(sourceDir, MEMORY_INDEX_NAME), "utf8").catch(() => undefined);
    return (await listMarkdownFiles(sourceDir, [MEMORY_INDEX_NAME])).map((filePath) => {
      const name = path.basename(filePath);
      return {
        sourcePath: filePath,
        targetName: name,
        indexLine: indexLineFor(sourceIndex, name, name, name.replace(/\.md$/, "")),
      };
    });
  }
  if (appId === "zcode") {
    return Promise.all(
      (await zcodeMemoryFiles(homeDir)).map(async (filePath) => {
        const name = path.basename(filePath);
        const targetName = `zcode-${name}`;
        const sourceIndex = await fs
          .readFile(path.join(path.dirname(filePath), MEMORY_INDEX_NAME), "utf8")
          .catch(() => undefined);
        return {
          sourcePath: filePath,
          targetName,
          indexLine: indexLineFor(sourceIndex, name, targetName, `zcode ${name.replace(/\.md$/, "")}`),
        };
      }),
    );
  }
  if (isWorkBuddyLike(appId)) {
    return (await workBuddyMemoryFiles(workBuddyRoot(homeDir, appId))).map((filePath) => {
      const targetName =
        path.basename(filePath) === MEMORY_INDEX_NAME
          ? `${appId}-memory.md`
          : `${appId}-${path.basename(filePath)}`;
      return {
        sourcePath: filePath,
        targetName,
        indexLine: indexLineFor(undefined, targetName, targetName, `${WORKBUDDY_LABELS[appId]} memory`),
      };
    });
  }
  if (appId !== "codex") return [];
  const sourceDir = path.join(homeDir, ".codex", "memories");
  const sourceIndex = await fs.readFile(path.join(sourceDir, MEMORY_INDEX_NAME), "utf8").catch(() => undefined);
  return (await listMarkdownFiles(sourceDir, [MEMORY_INDEX_NAME])).map((filePath) => {
    const base = path.basename(filePath);
    const targetName = `codex-${base}`;
    return {
      sourcePath: filePath,
      targetName,
      indexLine: indexLineFor(sourceIndex, base, targetName, `codex ${base.replace(/\.md$/, "")}`),
    };
  });
}

async function skillSourceDirs(homeDir: string, appId: ImportAppId): Promise<string[]> {
  const roots = isWorkBuddyLike(appId)
    ? [
        path.join(workBuddyRoot(homeDir, appId), "plugins", "cache"),
        path.join(workBuddyRoot(homeDir, appId), "skills"),
      ]
    : appId === "qoder"
      ? [path.join(homeDir, ".qoder", "plugins", "cache")]
      : appId === "zcode"
        ? [path.join(homeDir, ".zcode", "cli", "plugins", "cache")]
        : appId === "codex"
          ? [path.join(homeDir, ".codex", "skills")]
          : [];
  return findSkillDirs(roots);
}

// ---- 任务记录解析 ----

type CodexIndexLine = { id: string; thread_name?: string; updated_at?: string };

async function parseCodexSessions(root: string): Promise<{
  fileToIndex: Map<string, CodexIndexLine>;
  files: string[];
}> {
  const index = new Map<string, CodexIndexLine>();
  const content = await fs.readFile(path.join(root, "session_index.jsonl"), "utf8").catch(() => "");
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as CodexIndexLine;
      if (typeof parsed.id === "string") index.set(parsed.id, parsed);
    } catch {
      // 忽略坏行
    }
  }
  const files: string[] = [];
  await walkFiles(path.join(root, "sessions"), 0, [".jsonl", ".jsonl.zst"], files);
  return { fileToIndex: index, files };
}

/** rollout-<timestamp>-<uuid>.jsonl[.zst] → 末尾 36 位 uuid。 */
function codexIdFromFileName(filePath: string): string | null {
  const base = path.basename(filePath).replace(/\.zst$/, "").replace(/\.jsonl$/, "");
  if (base.length < 36) return null;
  const id = base.slice(-36);
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

function clipMessage(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}\n…（已截断）` : text;
}

/**
 * Codex rollout → MeowCode 消息。只取 user/assistant 的文本消息；
 * developer 消息与 <environment_context>/<user_instructions> 这类包裹上下文跳过。
 * zst 用 zlib 原生解压；解析不出消息时由调用方落 stub。
 */
async function readCodexRollout(filePath: string): Promise<{ messages: ChatMessage[]; cwd: string | null }> {
  const buf = await fs.readFile(filePath);
  const text = filePath.endsWith(".zst") ? zstdDecompressSync(buf).toString("utf8") : buf.toString("utf8");
  const messages: ChatMessage[] = [];
  let cwd: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const e = entry as { type?: string; payload?: Record<string, unknown> };
    if (e.type === "session_meta" && typeof e.payload?.cwd === "string") cwd = e.payload.cwd;
    if (e.type !== "response_item") continue;
    const payload = e.payload as
      | { type?: string; role?: string; content?: Array<{ text?: unknown }> }
      | undefined;
    if (payload?.type !== "message") continue;
    const role = payload.role;
    if (role !== "user" && role !== "assistant") continue;
    const parts = Array.isArray(payload.content) ? payload.content : [];
    const joined = parts
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (!joined) continue;
    if (role === "user" && /^<[a-z_]/.test(joined)) continue;
    messages.push({ role, content: clipMessage(joined) });
    if (messages.length >= MAX_IMPORT_MESSAGES) break;
  }
  return { messages, cwd };
}

// ---------------------------------------------------------------------------
// Qoder / WorkBuddy 真实会话
// ---------------------------------------------------------------------------

type ConversationMeta = { key: string; title: string; createdAt: Date; cwd: string | null };

const QODER_LABELS: Record<QoderLikeAppId, string> = {
  qoder: "Qoder CN IDE",
  qoderintl: "Qoder",
};

/** Qoder 系会话元数据在桌面端 main.sqlite；sideChat / 自动化执行会话不导。 */
async function qoderConversationMetas(
  homeDir: string,
  appId: QoderLikeAppId,
): Promise<Array<ConversationMeta & { sessionId: string }>> {
  const db = await openReadOnlyDb(qoderAppDbPath(homeDir, appId));
  if (!db) return [];
  try {
    const rows = db
      .prepare("SELECT session_id, title, cwd, created_at FROM chat_sessions WHERE session_kind = 'standard'")
      .all() as Array<{ session_id: string; title: string | null; cwd: string | null; created_at: number | null }>;
    return rows.map((row) => ({
      key: `qoder-chat:${row.session_id}`,
      sessionId: row.session_id,
      title: row.title?.trim() || `Qoder session ${row.session_id.slice(0, 8)}`,
      createdAt: typeof row.created_at === "number" ? new Date(row.created_at) : new Date(),
      cwd: typeof row.cwd === "string" && row.cwd ? row.cwd : null,
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

async function readQoderChatMessages(dbPath: string, sessionId: string): Promise<ChatMessage[]> {
  const db = await openReadOnlyDb(dbPath);
  if (!db) return [];
  try {
    // payload 有两代 schema：新的是 {role, text}，旧的只有 parts:[{type:"text"|"thinking",...}]
    // 且多数 payload 不带 role → 以列里的 role 为准
    const rows = db
      .prepare("SELECT payload_json, role FROM chat_session_messages WHERE session_id = ? ORDER BY sequence")
      .all(sessionId) as Array<{ payload_json: string; role: string | null }>;
    const messages: ChatMessage[] = [];
    for (const row of rows) {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload_json);
      } catch {
        continue;
      }
      const p = payload as {
        role?: unknown;
        text?: unknown;
        parts?: Array<{ type?: unknown; text?: unknown }>;
      };
      const role = p.role === "user" || p.role === "assistant" ? p.role : row.role;
      if (role !== "user" && role !== "assistant") continue;
      const partText = (Array.isArray(p.parts) ? p.parts : [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
        .trim();
      const text = typeof p.text === "string" && p.text.trim() ? p.text.trim() : partText;
      if (!text) continue;
      if (role === "user" && /^<[a-z_]/.test(text)) continue;
      messages.push({ role, content: clipMessage(text) });
      if (messages.length >= MAX_IMPORT_MESSAGES) break;
    }
    return messages;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** WorkBuddy 系对话正文：~/.workbuddy[.ai]/projects/<项目>/<会话id>.jsonl。 */
async function workBuddyConversationFiles(homeDir: string, appId: WorkBuddyLikeAppId): Promise<string[]> {
  const projectsDir = path.join(workBuddyRoot(homeDir, appId), "projects");
  let projectDirs: import("node:fs").Dirent[];
  try {
    projectDirs = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(projectsDir, entry.name);
    for (const name of await fs.readdir(dir).catch(() => [])) {
      if (name.endsWith(".jsonl")) files.push(path.join(dir, name));
    }
  }
  return files.sort();
}

/** WorkBuddy jsonl 行：{type:"message", role, content:[{type:"input_text"|"output_text", text}]}。 */
function workBuddyLineToMessage(line: string): ChatMessage | null {
  if (!line.trim()) return null;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  const e = entry as { type?: string; role?: string; content?: Array<{ type?: string; text?: unknown }> };
  if (e.type !== "message") return null;
  if (e.role !== "user" && e.role !== "assistant") return null;
  const joined = (Array.isArray(e.content) ? e.content : [])
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!joined) return null;
  if (e.role === "user") {
    // user 消息整条包裹在 <system-reminder> 上下文里，真实提问在 <user_query> 标签中
    if (!/^<[a-z_]/.test(joined)) return { role: e.role, content: clipMessage(joined) };
    const queries = Array.from(joined.matchAll(/<user_query>([\s\S]*?)<\/user_query>/g))
      .map((m) => m[1].trim())
      .filter(Boolean);
    if (queries.length === 0) return null;
    return { role: e.role, content: clipMessage(queries.join("\n\n")) };
  }
  return { role: e.role, content: clipMessage(joined) };
}

async function readWorkBuddyMessages(filePath: string): Promise<ChatMessage[]> {
  const text = await fs.readFile(filePath, "utf8").catch(() => "");
  const messages: ChatMessage[] = [];
  for (const line of text.split(/\r?\n/)) {
    const message = workBuddyLineToMessage(line);
    if (message) messages.push(message);
    if (messages.length >= MAX_IMPORT_MESSAGES) break;
  }
  return messages;
}

/** 无库兜底：从 jsonl 头部找首条真实 user 文本当标题，并带上该行时间戳。 */
async function peekWorkBuddyConversation(
  filePath: string,
): Promise<{ title: string; timestamp: number } | null> {
  const handle = await fs.open(filePath, "r").catch(() => null);
  if (!handle) return null;
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(64 * 1024), 0, 64 * 1024, 0);
    for (const line of buffer.toString("utf8", 0, bytesRead).split(/\r?\n/)) {
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const e = entry as { timestamp?: number };
      const message = workBuddyLineToMessage(line);
      if (message?.role !== "user") continue;
      return {
        title: message.content.replace(/\s+/g, " ").slice(0, 40),
        timestamp: typeof e.timestamp === "number" ? e.timestamp : 0,
      };
    }
    return null;
  } finally {
    await handle.close();
  }
}

/** 会话标题/时间/目录优先取 workbuddy[.ai].db 的 sessions 表；库不可用时走文件兜底。 */
async function workBuddyConversationMetas(
  homeDir: string,
  appId: WorkBuddyLikeAppId,
  files: string[],
): Promise<Array<ConversationMeta & { filePath: string }>> {
  const metaById = new Map<string, { title: string; cwd: string | null; createdAt: number }>();
  const db = await openReadOnlyDb(path.join(workBuddyRoot(homeDir, appId), "workbuddy.db"));
  if (db) {
    try {
      const rows = db
        .prepare(
          "SELECT id, COALESCE(NULLIF(custom_title, ''), title) AS title, cwd, created_at FROM sessions WHERE deleted_at IS NULL",
        )
        .all() as Array<{ id: string; title: string | null; cwd: string | null; created_at: number | null }>;
      for (const row of rows) {
        metaById.set(row.id, {
          title: row.title?.trim() ?? "",
          cwd: typeof row.cwd === "string" && row.cwd ? row.cwd : null,
          createdAt: typeof row.created_at === "number" ? row.created_at : 0,
        });
      }
    } catch {
      // 库结构变化 → 每个文件走 peek 兜底
    } finally {
      db.close();
    }
  }
  // 库可用时只导库里未删除的会话；不可用才按文件全量兜底
  const candidates = db ? files.filter((filePath) => metaById.has(path.basename(filePath, ".jsonl"))) : files;
  return Promise.all(
    files.map(async (filePath) => {
      const id = path.basename(filePath, ".jsonl");
      const meta = metaById.get(id);
      const peek = meta?.title ? null : await peekWorkBuddyConversation(filePath);
      const stat = await fs.stat(filePath).catch(() => null);
      return {
        key: `${appId}-chat:${id}`,
        filePath,
        title: meta?.title || peek?.title || `${WORKBUDDY_LABELS[appId]} session ${id.slice(0, 8)}`,
        createdAt: new Date(meta?.createdAt || peek?.timestamp || stat?.mtimeMs || Date.now()),
        cwd: meta?.cwd ?? null,
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// ZCode 会话
// ---------------------------------------------------------------------------

/** ZCode 记忆：~/.zcode/cli/memories/projects/<项目>/memory/*.md（排除索引）。 */
async function zcodeMemoryFiles(homeDir: string): Promise<string[]> {
  const projectsRoot = path.join(homeDir, ".zcode", "cli", "memories", "projects");
  let projectDirs: import("node:fs").Dirent[];
  try {
    projectDirs = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue;
    files.push(...(await listMarkdownFiles(path.join(projectsRoot, entry.name, "memory"), [MEMORY_INDEX_NAME])));
  }
  return files;
}

/** ZCode 会话元数据在 ~/.zcode/cli/db/db.sqlite；子代理会话与已删除会话不导。 */
async function zcodeConversationMetas(
  homeDir: string,
): Promise<Array<ConversationMeta & { sessionId: string }>> {
  const dbPath = path.join(homeDir, ".zcode", "cli", "db", "db.sqlite");
  const db = await openReadOnlyDb(dbPath);
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        "SELECT id, title, directory, time_created FROM session " +
          "WHERE parent_id IS NULL AND time_deleted IS NULL AND task_type = 'interactive'",
      )
      .all() as Array<{ id: string; title: string | null; directory: string | null; time_created: number | null }>;
    return rows.map((row) => ({
      key: `zcode-chat:${row.id}`,
      sessionId: row.id,
      title: row.title?.trim() || `ZCode session ${row.id.replace(/^sess_/, "").slice(0, 8)}`,
      createdAt: typeof row.time_created === "number" ? new Date(row.time_created) : new Date(),
      cwd: typeof row.directory === "string" && row.directory ? row.directory : null,
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/**
 * session/message/part 三表结构（ZCode 与 OpenCode 同构）：message.data 是 {role,...}，
 * 正文在 part 表（type:"text" 的 data.text），reasoning/tool/file 等部分一律跳过。
 * 两家的排序列不同：ZCode 有 sequence，OpenCode 没有、按时间排。
 */
async function readSqlitePartMessages(
  dbPath: string,
  sessionId: string,
  orderBy: string,
): Promise<ChatMessage[]> {
  const db = await openReadOnlyDb(dbPath);
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        "SELECT m.id AS mid, m.data AS mdata, p.data AS pdata " +
          "FROM message m LEFT JOIN part p ON p.message_id = m.id " +
          `WHERE m.session_id = ? ORDER BY ${orderBy}`,
      )
      .all(sessionId) as Array<{ mid: string; mdata: string; pdata: string | null }>;
    const messages: ChatMessage[] = [];
    let currentMid: string | null = null;
    let role: "user" | "assistant" | null = null;
    let textParts: string[] = [];
    const flush = () => {
      const text = textParts.join("\n").trim();
      if (role && text && !(role === "user" && /^<[a-z_]/.test(text))) {
        messages.push({ role, content: clipMessage(text) });
      }
      textParts = [];
    };
    for (const row of rows) {
      if (row.mid !== currentMid) {
        flush();
        currentMid = row.mid;
        role = null;
        let mdata: unknown;
        try {
          mdata = JSON.parse(row.mdata);
        } catch {
          continue;
        }
        const r = (mdata as { role?: unknown }).role;
        role = r === "user" || r === "assistant" ? r : null;
      }
      if (!role || !row.pdata) continue;
      let part: unknown;
      try {
        part = JSON.parse(row.pdata);
      } catch {
        continue;
      }
      const p = part as { type?: unknown; text?: unknown };
      if (p.type === "text" && typeof p.text === "string") textParts.push(p.text);
    }
    flush();
    return messages.slice(0, MAX_IMPORT_MESSAGES);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

async function readZcodeChatMessages(dbPath: string, sessionId: string): Promise<ChatMessage[]> {
  return readSqlitePartMessages(dbPath, sessionId, "m.sequence, p.sequence");
}

/** OpenCode 会话元数据：桌面端 v2 库（~/.local/share/opencode）优先，旧版 CLI 库（~/.config/opencode）兜底。 */
async function opencodeConversationMetas(
  homeDir: string,
): Promise<Array<ConversationMeta & { sessionId: string; dbPath: string; schema: "v2" | "legacy" }>> {
  const out: Array<ConversationMeta & { sessionId: string; dbPath: string; schema: "v2" | "legacy" }> = [];
  const dataDbPath = path.join(homeDir, ".local", "share", "opencode", "opencode.db");
  const dataDb = await openReadOnlyDb(dataDbPath);
  if (dataDb) {
    try {
      const rows = dataDb
        .prepare("SELECT id, title, directory, time_created FROM session_v2 WHERE parent_id IS NULL")
        .all() as Array<{ id: string; title: string | null; directory: string | null; time_created: number | null }>;
      for (const row of rows) {
        out.push({
          key: `opencode-chat:${row.id}`,
          sessionId: row.id,
          dbPath: dataDbPath,
          schema: "v2",
          title: row.title?.trim() || `OpenCode session ${row.id.slice(-8)}`,
          createdAt: typeof row.time_created === "number" ? new Date(row.time_created) : new Date(),
          cwd: typeof row.directory === "string" && row.directory ? row.directory : null,
        });
      }
    } catch {
      // 库结构变化 → 走旧版兜底
    } finally {
      dataDb.close();
    }
  }
  if (out.length > 0) return out;
  const configDbPath = path.join(homeDir, ".config", "opencode", "opencode.db");
  const legacyDb = await openReadOnlyDb(configDbPath);
  if (!legacyDb) return [];
  try {
    const rows = legacyDb
      .prepare("SELECT id, title, directory, time_created FROM session WHERE parent_id IS NULL")
      .all() as Array<{ id: string; title: string | null; directory: string | null; time_created: number | null }>;
    for (const row of rows) {
      out.push({
        key: `opencode-chat:${row.id}`,
        sessionId: row.id,
        dbPath: configDbPath,
        schema: "legacy",
        title: row.title?.trim() || `OpenCode session ${row.id.slice(0, 8)}`,
        createdAt: typeof row.time_created === "number" ? new Date(row.time_created) : new Date(),
        cwd: typeof row.directory === "string" && row.directory ? row.directory : null,
      });
    }
  } catch {
    return [];
  } finally {
    legacyDb.close();
  }
  return out;
}

/**
 * 桌面端 v2：session_message.type（user/assistant）+ data 内联正文——
 * user 是 {text}，assistant 是 {content:[{type:"text"|"reasoning",...}]}，其余类型（synthetic/system/idle）跳过。
 */
async function readOpencodeV2Messages(dbPath: string, sessionId: string): Promise<ChatMessage[]> {
  const db = await openReadOnlyDb(dbPath);
  if (!db) return [];
  try {
    const rows = db
      .prepare("SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq")
      .all(sessionId) as Array<{ type: string; data: string }>;
    const messages: ChatMessage[] = [];
    for (const row of rows) {
      if (row.type !== "user" && row.type !== "assistant") continue;
      let payload: unknown;
      try {
        payload = JSON.parse(row.data);
      } catch {
        continue;
      }
      let text = "";
      if (row.type === "user") {
        const p = payload as { text?: unknown };
        if (typeof p.text === "string") text = p.text;
      } else {
        const p = payload as { content?: Array<{ type?: unknown; text?: unknown }> };
        text = (Array.isArray(p.content) ? p.content : [])
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\n");
      }
      text = text.trim();
      if (!text) continue;
      if (row.type === "user" && /^<[a-z_]/.test(text)) continue;
      messages.push({ role: row.type, content: clipMessage(text) });
      if (messages.length >= MAX_IMPORT_MESSAGES) break;
    }
    return messages;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

async function readOpencodeChatMessages(
  dbPath: string,
  sessionId: string,
  schema: "v2" | "legacy",
): Promise<ChatMessage[]> {
  if (schema === "v2") return readOpencodeV2Messages(dbPath, sessionId);
  return readSqlitePartMessages(dbPath, sessionId, "m.time_created, m.id, p.time_created, p.id");
}

// ---------------------------------------------------------------------------
// DeepSeek Harness (dsh) 会话
// ---------------------------------------------------------------------------

/** 枚举 ~/.dsh/sessions/<项目>/<会话>/session.v4.jsonl.zstd。 */
async function dshSessionFiles(homeDir: string): Promise<string[]> {
  const sessionsRoot = path.join(homeDir, ".dsh", "sessions");
  let projectDirs: import("node:fs").Dirent[];
  try {
    projectDirs = await fs.readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const project of projectDirs) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(sessionsRoot, project.name);
    for (const dir of await fs.readdir(projectDir).catch(() => [])) {
      const file = path.join(projectDir, dir, "session.v4.jsonl.zstd");
      if (await exists(file)) files.push(file);
    }
  }
  return files.sort();
}

/**
 * 解析一个 dsh 会话文件（多帧 zstd + JSONL）。顶层会话返回 meta + 消息；
 * 子代理会话（origin:"subagent" / 有 parentSession / delegationDepth>0）返回 null。
 * 正文只取 user/message（source.kind==="user"）与 assistant/message 的 text 部分，
 * 运行时上下文快照、system-reminder、reasoning、tool-call 全部剔除。
 */
async function parseDshSession(
  filePath: string,
): Promise<{ title: string; createdAt: Date; cwd: string | null; messages: ChatMessage[] } | null> {
  const text = zstdDecompressAllFrames(await fs.readFile(filePath));
  type DshHeader = { createdAt?: unknown; cwd?: unknown; origin?: unknown; parentSession?: unknown; delegationDepth?: unknown };
  const entries: Array<{ type: string; data?: unknown; [key: string]: unknown }> = [];
  let header: DshHeader | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; data?: unknown };
      if (typeof entry.type !== "string") continue;
      if (entry.type === "session" && !header) header = entry as unknown as DshHeader;
      entries.push(entry as (typeof entries)[number]);
    } catch {
      // 忽略坏行
    }
  }
  if (!header) return null;
  if (header.origin === "subagent" || header.parentSession || (typeof header.delegationDepth === "number" && header.delegationDepth > 0)) {
    return null;
  }
  const messages: ChatMessage[] = [];
  let title = "";
  for (const entry of entries) {
    const data = entry.data as Record<string, unknown> | undefined;
    if (entry.type === "user/message" && data) {
      const source = data.source as { kind?: unknown } | undefined;
      const content = Array.isArray(data.content) ? data.content : [];
      const text = content
        .map((part) => (part as { type?: unknown; text?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")
        .filter(Boolean)
        .join("\n")
        .trim();
      if (!text) continue;
      // 运行时上下文/技能提醒等注入消息：kind 不是 user，或正文以 < 包裹
      if (source?.kind !== "user" || /^<[a-z_]/.test(text)) continue;
      messages.push({ role: "user", content: clipMessage(text) });
      continue;
    }
    if (entry.type === "assistant/message" && data) {
      const message = data.message as { content?: Array<{ type?: unknown; text?: unknown }> } | undefined;
      const text = (Array.isArray(message?.content) ? message!.content : [])
        .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
        .filter(Boolean)
        .join("\n")
        .trim();
      if (text) messages.push({ role: "assistant", content: clipMessage(text) });
      continue;
    }
    if (entry.type === "session/title" && data) {
      if (typeof data.title === "string" && data.title.trim()) title = data.title.trim();
    }
  }
  return {
    title: title.slice(0, 120),
    createdAt: typeof header.createdAt === "number" ? new Date(header.createdAt) : new Date(),
    cwd: typeof header.cwd === "string" && header.cwd ? header.cwd : null,
    messages: messages.slice(0, MAX_IMPORT_MESSAGES),
  };
}

async function dshConversations(
  homeDir: string,
): Promise<Array<ConversationMeta & { messages: ChatMessage[] }>> {
  const out: Array<ConversationMeta & { messages: ChatMessage[] }> = [];
  for (const filePath of await dshSessionFiles(homeDir)) {
    const parsed = await parseDshSession(filePath).catch(() => null);
    if (!parsed) continue;
    const id = path.basename(path.dirname(filePath));
    out.push({
      key: `dsh-chat:${id}`,
      title: parsed.title || `DSH session ${id.replace(/^session-/, "").slice(0, 8)}`,
      createdAt: parsed.createdAt,
      cwd: parsed.cwd,
      messages: parsed.messages,
    });
  }
  return out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

async function detectDsh(homeDir: string): Promise<ImportSource> {
  const root = path.join(homeDir, ".dsh");
  if (!(await exists(root))) return { appId: "dsh", detected: false, groups: GROUP_IDS.map((id) => group(id, 0)) };
  const tasks = (await dshConversations(homeDir)).length;
  return {
    appId: "dsh",
    detected: true,
    groups: [group("mcp", 0), group("memory", 0), group("skills", 0), group("tasks", tasks)],
  };
}

// ---------------------------------------------------------------------------
// plan / apply
// ---------------------------------------------------------------------------

/**
 * 已导入任务记录的来源 key 集合：直接读会话文件头里的 description（= 来源 key）。
 * 标记跟着会话文件走——用户删了会话就能重新导入，不会出现「状态说已导入、文件却没了」。
 */
async function importedTaskKeys(sessionsDir: string): Promise<Set<string>> {
  const keys = new Set<string>();
  let names: string[];
  try {
    names = (await fs.readdir(sessionsDir)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return keys;
  }
  for (const name of names) {
    try {
      const handle = await fs.open(path.join(sessionsDir, name), "r");
      try {
        const buf = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
        const header = JSON.parse(buf.toString("utf8", 0, bytesRead).split(/\r?\n/)[0]) as {
          type?: string;
          description?: unknown;
        };
        if (header?.type === "session" && typeof header.description === "string") {
          keys.add(header.description);
        }
      } finally {
        await handle.close();
      }
    } catch {
      continue;
    }
  }
  return keys;
}

/** 列出待导入项：已存在（同名/同 key）的不会出现在结果里。 */
export async function planImport(
  homeDir: string,
  sessionsDir: string,
  appId: ImportAppId,
  groups: ImportGroupId[],
): Promise<ImportPlanItem[]> {
  const meowRoot = path.join(homeDir, ".meowcode");
  const items: ImportPlanItem[] = [];

  if (groups.includes("mcp")) {
    const source = await sourceMcp(homeDir, appId);
    const current = await readMeowMcp(meowRoot);
    for (const [name, entry] of Object.entries(source)) {
      if (!current[name]) items.push({ group: "mcp", name, entry });
    }
  }

  if (groups.includes("memory")) {
    const memoryDir = path.join(meowRoot, "memory");
    for (const candidate of await memoryCandidates(homeDir, appId)) {
      if (await exists(path.join(memoryDir, candidate.targetName))) continue;
      items.push({
        group: "memory",
        name: candidate.targetName,
        sourcePath: candidate.sourcePath,
        targetName: candidate.targetName,
        indexLine: candidate.indexLine,
      });
    }
  }

  if (groups.includes("skills")) {
    const skillsRoot = path.join(meowRoot, "skills");
    for (const dir of await skillSourceDirs(homeDir, appId)) {
      const name = path.basename(dir);
      if (await exists(path.join(skillsRoot, name))) continue;
      items.push({ group: "skills", name, sourcePath: dir });
    }
  }

  if (groups.includes("tasks")) {
    const imported = await importedTaskKeys(sessionsDir);
    const pending: ImportPlanItem[] = [];
    if (appId === "codex") {
      const root = path.join(homeDir, ".codex");
      const { fileToIndex, files } = await parseCodexSessions(root);
      for (const filePath of files) {
        const id = codexIdFromFileName(filePath);
        if (!id) continue;
        const key = `codex:${id}`;
        if (imported.has(key)) continue;
        const meta = fileToIndex.get(id);
        const title = meta?.thread_name?.trim() || `Codex session ${id.slice(0, 8)}`;
        const createdAt = meta?.updated_at
          ? new Date(meta.updated_at)
          : (await fs.stat(filePath).catch(() => null))?.mtime ?? new Date();
        pending.push({
          group: "tasks",
          name: title,
          key,
          session: {
            createdAt,
            messages: async () => {
              try {
                const { messages, cwd } = await readCodexRollout(filePath);
                if (messages.length > 0) return { messages, cwd };
              } catch {
                // 解压/解析失败 → stub
              }
              return {
                messages: [
                  {
                    role: "user",
                    content: `从 Codex 导入的会话（正文未能解析）。\n\n标题：${title}\n时间：${createdAt.toISOString()}\n来源文件：${path.basename(filePath)}`,
                  },
                ],
                cwd: null,
              };
            },
          },
        });
      }
    } else if (isQoderLike(appId)) {
      const dbPath = qoderAppDbPath(homeDir, appId);
      for (const convo of await qoderConversationMetas(homeDir, appId)) {
        if (imported.has(convo.key)) continue;
        pending.push({
          group: "tasks",
          name: convo.title,
          key: convo.key,
          session: {
            createdAt: convo.createdAt,
            messages: async () => {
              const messages = await readQoderChatMessages(dbPath, convo.sessionId);
              if (messages.length > 0) return { messages, cwd: convo.cwd };
              return {
                messages: [
                  {
                    role: "user",
                    content: `从 ${QODER_LABELS[appId]} 导入的会话（正文未能解析）。\n\n标题：${convo.title}\n时间：${convo.createdAt.toISOString()}`,
                  },
                ],
                cwd: null,
              };
            },
          },
        });
      }
    } else if (appId === "opencode") {
      for (const convo of await opencodeConversationMetas(homeDir)) {
        if (imported.has(convo.key)) continue;
        pending.push({
          group: "tasks",
          name: convo.title,
          key: convo.key,
          session: {
            createdAt: convo.createdAt,
            messages: async () => {
              const messages = await readOpencodeChatMessages(convo.dbPath, convo.sessionId, convo.schema);
              if (messages.length > 0) return { messages, cwd: convo.cwd };
              return {
                messages: [
                  {
                    role: "user",
                    content: `从 OpenCode 导入的会话（正文未能解析）。\n\n标题：${convo.title}\n时间：${convo.createdAt.toISOString()}`,
                  },
                ],
                cwd: null,
              };
            },
          },
        });
      }
    } else if (appId === "zcode") {
      const dbPath = path.join(homeDir, ".zcode", "cli", "db", "db.sqlite");
      for (const convo of await zcodeConversationMetas(homeDir)) {
        if (imported.has(convo.key)) continue;
        pending.push({
          group: "tasks",
          name: convo.title,
          key: convo.key,
          session: {
            createdAt: convo.createdAt,
            messages: async () => {
              const messages = await readZcodeChatMessages(dbPath, convo.sessionId);
              if (messages.length > 0) return { messages, cwd: convo.cwd };
              return {
                messages: [
                  {
                    role: "user",
                    content: `从 ZCode 导入的会话（正文未能解析）。\n\n标题：${convo.title}\n时间：${convo.createdAt.toISOString()}`,
                  },
                ],
                cwd: null,
              };
            },
          },
        });
      }
    } else if (appId === "dsh") {
      for (const convo of await dshConversations(homeDir)) {
        if (imported.has(convo.key)) continue;
        pending.push({
          group: "tasks",
          name: convo.title,
          key: convo.key,
          session: {
            createdAt: convo.createdAt,
            messages: async () => {
              if (convo.messages.length > 0) return { messages: convo.messages, cwd: convo.cwd };
              return {
                messages: [
                  {
                    role: "user",
                    content: `从 DeepSeek Harness 导入的会话（正文未能解析）。\n\n标题：${convo.title}\n时间：${convo.createdAt.toISOString()}`,
                  },
                ],
                cwd: null,
              };
            },
          },
        });
      }
    } else {
      const label = isWorkBuddyLike(appId) ? WORKBUDDY_LABELS[appId] : "WorkBuddy";
      for (const convo of await workBuddyConversationMetas(
        homeDir,
        appId as WorkBuddyLikeAppId,
        await workBuddyConversationFiles(homeDir, appId as WorkBuddyLikeAppId),
      )) {
        if (imported.has(convo.key)) continue;
        pending.push({
          group: "tasks",
          name: convo.title,
          key: convo.key,
          session: {
            createdAt: convo.createdAt,
            messages: async () => {
              const messages = await readWorkBuddyMessages(convo.filePath);
              if (messages.length > 0) return { messages, cwd: convo.cwd };
              return {
                messages: [
                  {
                    role: "user",
                    content: `从 ${label} 导入的会话（正文未能解析）。\n\n标题：${convo.title}\n时间：${convo.createdAt.toISOString()}\n来源文件：${path.basename(convo.filePath)}`,
                  },
                ],
                cwd: null,
              };
            },
          },
        });
      }
    }
    // 最近的会话先导；单次上限防止一次灌进几百条
    pending.sort((a, b) => b.session!.createdAt.getTime() - a.session!.createdAt.getTime());
    items.push(...pending.slice(0, MAX_TASK_SESSIONS_PER_APPLY));
  }

  return items;
}

/** 应用 plan 里的一条待导入项。写操作只落在 ~/.meowcode 与 sessionsDir。 */
export async function applyImportItem(
  homeDir: string,
  sessionsDir: string,
  cwd: string,
  item: ImportPlanItem,
): Promise<ImportItemResult> {
  const meowRoot = path.join(homeDir, ".meowcode");
  try {
    if (item.group === "mcp" && item.entry) {
      const current = await readMeowMcp(meowRoot);
      if (current[item.name]) return { status: "skipped" };
      current[item.name] = item.entry;
      await writeJsonAtomic(path.join(meowRoot, "mcp.json"), { mcpServers: current });
      return { status: "imported" };
    }

    if (item.group === "memory" && item.sourcePath && item.targetName) {
      const target = path.join(meowRoot, "memory", item.targetName);
      if (await exists(target)) return { status: "skipped" };
      const stat = await fs.stat(item.sourcePath).catch(() => null);
      if (!stat) return { status: "failed", reason: "source file missing" };
      if (stat.size > MAX_MEMORY_BYTES) {
        return { status: "failed", reason: `larger than ${MAX_MEMORY_BYTES} bytes` };
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await writeTextAtomic(target, await fs.readFile(item.sourcePath, "utf8"));
      await appendMemoryIndex(meowRoot, [item.indexLine ?? `- [${item.targetName}](${item.targetName})`]);
      return { status: "imported" };
    }

    if (item.group === "skills" && item.sourcePath) {
      const target = path.join(meowRoot, "skills", item.name);
      if (await exists(target)) return { status: "skipped" };
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.cp(item.sourcePath, target, {
        recursive: true,
        filter: (src) => {
          const base = path.basename(src);
          return base !== "node_modules" && base !== ".git";
        },
      });
      return { status: "imported" };
    }

    if (item.group === "tasks" && item.session && item.key) {
      // plan 与 apply 之间可能被并发导入过（双击/两窗口）：落盘前再查一次文件头标记
      const imported = await importedTaskKeys(sessionsDir);
      if (imported.has(item.key)) return { status: "skipped" };
      const { messages, cwd: sourceCwd } = await item.session.messages();
      // 来源会话的 cwd 还存在就用它（会话归属原项目），否则跟随当前工作区
      const sessionCwd = sourceCwd && (await exists(sourceCwd)) ? sourceCwd : cwd;
      await writeSummarySession(sessionsDir, sessionCwd, item.name, messages, item.session.createdAt, item.key);
      await flushSessionIndex(sessionsDir);
      return { status: "imported" };
    }

    return { status: "failed", reason: "incomplete plan item" };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

async function appendMemoryIndex(meowRoot: string, lines: string[]): Promise<void> {
  if (lines.length === 0) return;
  const indexPath = path.join(meowRoot, "memory", MEMORY_INDEX_NAME);
  const existing = await fs.readFile(indexPath, "utf8").catch(() => "");
  const separator = existing && !existing.endsWith("\n") ? "\n" : "";
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.appendFile(indexPath, `${separator}${lines.join("\n")}\n`, "utf8");
}

async function writeSummarySession(
  sessionsDir: string,
  cwd: string,
  title: string,
  messages: ChatMessage[],
  createdAt: Date,
  sourceKey?: string,
): Promise<void> {
  let filePath = path.join(sessionsDir, sessionFileName(cwd, createdAt));
  for (let attempt = 0; ; attempt += 1) {
    try {
      const store = await SessionStore.create(filePath, cwd, {
        ...(sourceKey ? { description: sourceKey } : {}),
        createdAt,
      });
      try {
        await store.appendTitle(title);
        for (const message of messages) {
          await store.appendMessage(message);
        }
      } finally {
        await store.close();
      }
      return;
    } catch (error) {
      // wx 创建失败 = 同一毫秒已有人写这个文件名；挪 1ms 重试
      if ((error as NodeJS.ErrnoException).code === "EEXIST" && attempt < 3) {
        filePath = path.join(sessionsDir, sessionFileName(cwd, new Date(createdAt.getTime() + attempt + 1)));
        continue;
      }
      throw error;
    }
  }
}

/** 批处理包装：plan + 顺序 apply。旧路由与测试用它；桌面端走逐条以驱动进度。 */
export async function applyImport(
  homeDir: string,
  sessionsDir: string,
  cwd: string,
  appId: ImportAppId,
  groups: ImportGroupId[],
): Promise<ImportReport> {
  const items = await planImport(homeDir, sessionsDir, appId, groups);
  const report: ImportReport = { appId, groups: [], mcpChanged: false };
  for (const id of GROUP_IDS.filter((gid) => groups.includes(gid))) {
    const groupReport: ImportGroupReport = { id, imported: [], skipped: [], failed: [] };
    for (const item of items.filter((entry) => entry.group === id)) {
      const result = await applyImportItem(homeDir, sessionsDir, cwd, item);
      if (result.status === "imported") {
        groupReport.imported.push(item.name);
        if (id === "mcp") report.mcpChanged = true;
      } else if (result.status === "skipped") {
        groupReport.skipped.push(item.name);
      } else {
        groupReport.failed.push({ name: item.name, reason: result.reason ?? "unknown" });
      }
    }
    report.groups.push(groupReport);
  }
  return report;
}
