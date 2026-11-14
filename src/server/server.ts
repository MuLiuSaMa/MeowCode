import http from "node:http";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import os from "node:os";
import { mkdirSync, existsSync, readFileSync, statSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { readFile, readdir, rm, stat, unlink, writeFile, cp } from "node:fs/promises";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AgentRuntime, isApprovalMode, isSessionMode } from "../agent/runtime.js";
import { listProviderModels, resolveProviderModelsOptions } from "../agent/models-list.js";
import { composeMail, type MailComposeContext } from "../agent/mail-compose.js";
import { MAX_POLISH_INPUT_CHARS } from "../agent/prompt-polish.js";
import { AGENT_ROLE_NAMES, BUILTIN_AGENTS } from "../agent/agent-definition.js";
import {
  AGENT_PROFILES,
  AGENT_PROFILE_IDS,
  isAgentProfile,
} from "../agent/agent-profiles.js";
import { toolDefinitions } from "../agent/tools.js";
import { readPdfPageCount } from "../agent/pdf.js";
import { isSpeechStyle, readSpeechStyleFromEnv } from "../agent/speech-style.js";
import { normalizeWebConfig } from "../agent/web-search.js";
import { normalizeSubagentLimits } from "../agent/agent-profiles.js";
import { createAgentLogger, pruneAgentLogs } from "../agent/logging.js";
import type { TraceSpan } from "../agent/trace.js";
import {
  clearApprovalRules,
  readApprovalRules,
  removeApprovalRule,
} from "../agent/approval-rules.js";
import type { ApprovalDecision } from "../agent/types.js";
import {
  createWorkspaceWatcher,
  type WorkspaceWatcher,
} from "../agent/workspace-watcher.js";
import {
  getProxyConfig,
  isProxyMode,
  readProxyFromEnv,
  setProxyConfig,
  type ProxyMode,
} from "../agent/proxy.js";
import {
  getSandboxSettings,
  normalizeSandboxSettings,
  readSandboxSettingsFromEnv,
  setSandboxSettings,
} from "../agent/sandbox/policy.js";
import { probeSandbox, revokeSandboxGrantsRemote } from "../agent/sandbox/runner-client.js";
import {
  builtinHarnessSeed,
  createHarnessArchitecture,
  deleteHarnessArchitecture,
  isBuiltinHarnessId,
  isHarnessArchitectureId,
  listHarnessArchitectures,
  loadHarnessDocument,
  renameHarnessArchitecture,
  saveHarnessDocument,
} from "../agent/harness-document.js";
import { SessionStore, newEntryId, sessionFileName } from "../agent/session-store.js";
import { deriveSessionAtCheckpoint } from "./session-derive.js";
import {
  RewindError,
  applyRewind,
  applyUndo,
  cachePlan,
  findUndoable,
  planRewind,
  planUndo,
  takePlan,
} from "./rewind.js";
import { buildExportDoc, renderJson } from "../agent/session-export.js";
import { renderMarkdown } from "../agent/session-export-markdown.js";
import { renderHtml } from "../agent/session-export-html.js";
import { readJsonFile, writeJsonAtomic } from "../agent/atomic-json.js";
import {
  clearMemories,
  deleteMemory,
  isValidMemoryName,
  listMemoryItems,
  memoryDirFor,
  readMemory,
  writeMemoryFile,
  type MemoryScope,
} from "../agent/memory.js";
import { type InstructionSettings } from "../agent/instructions.js";
import {
  deleteRule,
  isValidRuleName,
  listRules,
  readRule,
  writeRule,
} from "../agent/rules.js";
import { createBrowserHostFromEnv } from "../agent/browser-host.js";
import { displayPath, resolveWithinWorkspace } from "../agent/paths.js";
import { planFallbacks } from "../agent/provider-fallback.js";
import {
  GitError,
  createGitService,
  getDiff,
  getStatus,
  type GitErrorCode,
} from "../git/git.js";
import {
  createSessionWorktree,
  pruneSessionWorktrees,
  removeSessionWorktree,
  type CreatedSessionWorktree,
} from "./worktree.js";
import { listWorkspaceFiles } from "../agent/search.js";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_QUERY_CHARS,
  invalidateSearchIndex,
  searchSessions,
} from "../agent/session-search.js";
import {
  createPluginSystem,
  loadCommandIndex,
  type CommandIndex,
  type PluginSystem,
} from "../plugins/index.js";
import { builtinDetailFallback } from "../plugins/builtin-meta.js";
import { createPluginStorage } from "../plugins/storage.js";
import {
  loadHooksConfig,
  parseHooksScope,
  parseRunMode,
  summarizeHooks,
} from "../plugins/builtin/claude-code-hooks/config.js";
import { backfillSkillMarkers, createMarketplaceStore, MarketplaceError, type MarketplaceDetail } from "./marketplace.js";
import { parseMarkdownFrontmatter } from "../plugins/frontmatter.js";
import { createExtensionHost } from "./extensions.js";
import { applyImport, applyImportItem, detectImportSources, planImport, type ImportAppId, type ImportGroupId } from "./data-import.js";

/** /import/plan 与 /import/apply 共用的请求体校验。 */
function parseImportRequest(body: { appId?: unknown; groups?: unknown }):
  | { appId: ImportAppId; groups: ImportGroupId[] }
  | null {
  if (body.appId !== "qoder" && body.appId !== "qoderintl" && body.appId !== "workbuddy" && body.appId !== "workbuddyai" && body.appId !== "zcode" && body.appId !== "opencode" && body.appId !== "dsh" && body.appId !== "codex") return null;
  const groups = Array.isArray(body.groups)
    ? body.groups.filter((id): id is ImportGroupId =>
        id === "mcp" || id === "memory" || id === "skills" || id === "tasks",
      )
    : [];
  return { appId: body.appId, groups };
}

/** 技能目录里的 icon.svg / icon.png → data URL：/skills 列表用它显示自建/内置技能图标。 */async function skillIconDataUrl(skillPath: string): Promise<string | undefined> {
  const dir = path.dirname(skillPath);
  const candidates: Array<[string, string]> = [
    ["icon.svg", "image/svg+xml"],
    ["icon.png", "image/png"],
  ];
  for (const [file, mime] of candidates) {
    try {
      const buf = await readFile(path.join(dir, file));
      if (buf.length === 0 || buf.length > 64 * 1024) continue;
      return `data:${mime};base64,${buf.toString("base64")}`;
    } catch {
      // 没有这个图标就试下一个
    }
  }
  return undefined;
}

/** 本地（我的/自建）技能详情：市场索引没有该 id 时读 ~/.meowcode/skills/<id>/SKILL.md。 */
async function readLocalSkillDetail(homeDir: string, id: string): Promise<MarketplaceDetail | null> {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id) || id.includes("..")) return null;
  try {
    const raw = await readFile(path.join(homeDir, ".meowcode", "skills", id, "SKILL.md"), "utf8");
    const { meta, body } = parseMarkdownFrontmatter(raw);
    return {
      item: {
        id,
        type: "skill",
        name: meta.name || id,
        description: meta.description || "",
        category: "",
        source: "local",
        tags: [],
        version: "",
        entry: `skills/${id}`,
        entryKind: "dir",
      },
      detail: body.slice(0, 60_000),
    };
  } catch {
    return null;
  }
}
import { createCommunitySource } from "./marketplace-community.js";
import { createThirdPartySource, type ThirdPartySource } from "./marketplace-thirdparty.js";
import { getLspManager } from "../lsp/manager.js";
import { builtinSkillsDir, discoverSkills } from "../plugins/skills.js";
import type {
  PendingApproval,
  ProviderConfig,
  SubagentStatus,
  SubagentSummary,
  ToolDocument,
  ToolImage,
  TurnStatus,
} from "../agent/types.js";

const APP_VERSION = "1.4.0";
const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), "AppData", "Roaming", "MeowCode", "agent", "sessions");

/** 插件命令 chip 的展示标记：首行是名称/插件/命令，空行后才是实际 `/command` 文本 */
const PLUGIN_COMMAND_PREFIX = "【插件命令】";

function splitPluginCommandPrompt(
  text: string,
): { header: string; commandText: string } | null {
  if (!text.trimStart().startsWith(PLUGIN_COMMAND_PREFIX)) return null;
  const start = text.indexOf(PLUGIN_COMMAND_PREFIX);
  const lineEnd = text.indexOf("\n", start);
  if (lineEnd < 0) return null;
  const commandText = text.slice(lineEnd + 1).trim();
  if (!commandText.startsWith("/")) return null;
  return { header: text.slice(0, lineEnd).trimEnd(), commandText };
}

type SseClient = {
  response: import("node:http").ServerResponse;
};

type BufferedSseEvent = {
  seq: number;
  frame: string;
};

/** 断线重放缓冲上限；超出后客户端需要整体重同步，避免无限占用内存 */
const SSE_REPLAY_MAX_EVENTS = 5_000;
const SSE_REPLAY_MAX_CHARS = 4_000_000;

const MAGPIE_PROVIDER_PREFIX = "magpie/";
/** 覆盖层本地可写，只认本机网关，别让伪造的条目把请求带去外网。 */
const MAGPIE_LOOPBACK_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;

function magpieHeaders(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key || typeof value !== "string") continue;
    out[key] = value.replace(/[\r\n]+/g, " ").trim();
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * magpie 的 Agent 插件写的覆盖层（`agent/magpie.json`）：模型多时塞不进 env
 * （Windows 环境块 32767 字符上限），所以由桌面端给路径、这里启动时读一次。
 */
export function readMagpieProviders(): ProviderConfig[] {
  const file = process.env.MEOWCODE_MAGPIE_FILE;
  if (!file) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const list = (raw as { providers?: unknown }).providers;
  if (!Array.isArray(list)) return [];
  let prefs: Record<string, { reasoningEffort?: string }> = {};
  try {
    const parsed = JSON.parse(process.env.MEOWCODE_PROVIDER_PREFS ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) prefs = parsed;
  } catch {
    prefs = {};
  }
  const out: ProviderConfig[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const model = typeof record.model === "string" ? record.model.trim() : "";
    const baseUrl = typeof record.baseUrl === "string" ? record.baseUrl.trim() : "";
    if (
      !id.startsWith(MAGPIE_PROVIDER_PREFIX) ||
      seen.has(id) ||
      !model ||
      !MAGPIE_LOOPBACK_URL.test(baseUrl)
    ) {
      continue;
    }
    seen.add(id);
    const positive = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
    const modalities = Array.isArray(record.inputModalities)
      ? record.inputModalities.filter((m) => m === "text" || m === "image" || m === "pdf")
      : [];
    out.push({
      id,
      name: typeof record.name === "string" && record.name ? record.name : "Magpie",
      baseUrl,
      model,
      displayName: typeof record.displayName === "string" ? record.displayName : undefined,
      protocol: "openai-chat-completions",
      contextWindow: positive(record.contextWindow),
      maxTokens: positive(record.maxTokens),
      inputModalities: modalities.length ? (modalities as ProviderConfig["inputModalities"]) : undefined,
      authStyle: "none",
      extraHeaders: magpieHeaders(record.extraHeaders),
      enabled: record.enabled !== false,
      reasoningEffort: prefs[id]?.reasoningEffort || undefined,
    });
  }
  return out;
}

function readProvidersFromEnv(): ProviderConfig[] {
  const raw = process.env.MEOWCODE_PROVIDERS;
  let providers: ProviderConfig[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as ProviderConfig[];
      providers = Array.isArray(parsed) ? parsed : [];
    } catch {
      providers = [];
    }
  }
  const magpie = readMagpieProviders();
  if (!magpie.length) return providers;
  const ids = new Set(magpie.map((provider) => provider.id));
  return [...providers.filter((provider) => !ids.has(provider.id)), ...magpie];
}

/** 实验开关（MEOWCODE_EXPERIMENTAL，JSON）：未设置/解析失败一律全关。 */
function readExperimentalFromEnv(): {
  midstreamToolExec?: boolean;
  incrementalResponses?: boolean;
  nativeCompaction?: boolean;
  promptSegments?: boolean;
  complexityThinking?: boolean;
} | null {
  const raw = process.env.MEOWCODE_EXPERIMENTAL;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      midstreamToolExec?: boolean;
      incrementalResponses?: boolean;
      nativeCompaction?: boolean;
      promptSegments?: boolean;
      complexityThinking?: boolean;
    };
    if (typeof parsed !== "object" || parsed === null) return null;
    const flags: {
      midstreamToolExec?: boolean;
      incrementalResponses?: boolean;
      nativeCompaction?: boolean;
      promptSegments?: boolean;
      complexityThinking?: boolean;
    } = {};
    if (parsed.midstreamToolExec) flags.midstreamToolExec = true;
    // 这个开关默认是开的（官方端点），所以要接受显式 false 才能关掉
    if (typeof parsed.incrementalResponses === "boolean") {
      flags.incrementalResponses = parsed.incrementalResponses;
    }
    if (parsed.nativeCompaction) flags.nativeCompaction = true;
    // 下面两个默认开（缺省即新行为），显式 false 才回退旧行为
    if (typeof parsed.promptSegments === "boolean") flags.promptSegments = parsed.promptSegments;
    if (typeof parsed.complexityThinking === "boolean") {
      flags.complexityThinking = parsed.complexityThinking;
    }
    return Object.keys(flags).length ? flags : null;
  } catch {
    return null;
  }
}

/** 插件禁用清单（MEOWCODE_PLUGINS，JSON：{ disabled: string[] }）：解析失败按空处理。 */
function readPluginsConfigFromEnv(): { disabled: string[] } {
  const raw = process.env.MEOWCODE_PLUGINS;
  if (!raw) return { disabled: [] };
  try {
    const parsed = JSON.parse(raw) as { disabled?: unknown };
    const disabled = Array.isArray(parsed.disabled)
      ? parsed.disabled.filter(
          (item): item is string => typeof item === "string" && item.trim().length > 0,
        )
      : [];
    return { disabled };
  } catch {
    console.error("[plugins] invalid MEOWCODE_PLUGINS JSON; ignoring");
    return { disabled: [] };
  }
}

/**
 * 回合后记忆蒸馏开关（MEOWCODE_MEMORY_EXTRACTION）：桌面端 settings.json 的
 * 初始值。未设置视为开（服务端直跑/测试场景跟随默认）。运行中可经
 * PUT /config/memory-extraction 实时切换，settings.json 由桌面端另行落盘。
 */
function readMemoryFromEnv(): boolean {
  // 兼容旧的 MEOWCODE_MEMORY_EXTRACTION（语义是现在的一个子集：只关蒸馏）
  const raw = process.env.MEOWCODE_MEMORY ?? process.env.MEOWCODE_MEMORY_EXTRACTION;
  if (raw === undefined || raw.trim() === "") return true;
  const normalized = raw.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false";
}

/** 自我学习：**默认关闭**，只有显式写 1/true/on 才开启。 */
function readLearningFromEnv(): boolean {
  const raw = process.env.MEOWCODE_SELF_LEARNING;
  if (raw === undefined || raw.trim() === "") return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on";
}

/** 供应商故障转移：**默认关闭**，设置里显式开启才在临时故障时切备用服务商。 */
function readProviderFallbackFromEnv(): boolean {
  const raw = process.env.MEOWCODE_PROVIDER_FALLBACK;
  if (raw === undefined || raw.trim() === "") return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on";
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function sendError(response: http.ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { error: { code, message } });
}

/**
 * ask_user 答案归一成文本：前端偶尔把整条选项对象回传（`{label, description}`），
 * 直接 String() 会让模型和界面都收到 `[object Object]`。
 */
function answerText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  if (!raw || typeof raw !== "object") return "";
  const record = raw as Record<string, unknown>;
  for (const key of ["label", "text", "value", "answer", "option"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

/** /memory 路由的 scope 参数：不合法值一律 400，不猜测默认层。 */
function parseMemoryScopeParam(value: string | null | undefined): MemoryScope | null {
  return value === "user" || value === "project" ? value : null;
}

/** 市场路由错误统一映射：not_found→404、not_managed→409、invalid_id→400，其余 500 */
function sendMarketplaceError(response: http.ServerResponse, error: unknown): void {
  if (error instanceof MarketplaceError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "not_managed" || error.code === "conflict"
          ? 409
          : 400;
    sendError(response, status, error.code, error.message);
    return;
  }
  sendError(response, 500, "marketplace_failed", error instanceof Error ? error.message : String(error));
}

/** git 错误码 → HTTP 状态：参数类 400，业务冲突类 409，超时 504，git 缺失 503。 */
const GIT_ERROR_STATUS: Record<GitErrorCode, number> = {
  invalid_path: 400,
  too_many_paths: 400,
  not_a_repo: 409,
  dirty_worktree: 409,
  identity_missing: 409,
  auth_required: 409,
  network_error: 409,
  no_upstream: 409,
  branch_exists: 409,
  git_unavailable: 503,
  timeout: 504,
  git_failed: 500,
};

function sendGitError(response: http.ServerResponse, error: unknown): void {
  if (error instanceof GitError) {
    sendError(
      response,
      GIT_ERROR_STATUS[error.code] ?? 500,
      error.code,
      error.message,
    );
    return;
  }
  sendError(response, 500, "git_failed", error instanceof Error ? error.message : String(error));
}

/** 常量时间比较 Authorization 头，避免本地端口被其他进程试探。 */
function isAuthorized(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== "string") return false;
  const actual = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 预览与插件 UI 共用的 MIME 映射（/workspace/raw、/plugin-ui） */
const MIME_BY_EXT: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  woff2: "font/woff2",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  avif: "image/avif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  pdf: "application/pdf",
};

function mimeForFile(file: string): string {
  return MIME_BY_EXT[path.extname(file).slice(1).toLowerCase()] ?? "application/octet-stream";
}

const SUBAGENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function subagentStatusFromTurn(status: TurnStatus | undefined): SubagentStatus {
  if (status === "completed") return "completed";
  if (status === "aborted") return "aborted";
  if (status === "interrupted") return "interrupted";
  if (status === "error") return "failed";
  return "interrupted";
}

async function readJsonBody<T>(request: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 10 * 1024 * 1024) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

/** 用户附图：单条消息最多 3 张，单张 base64 不超过 ~1.9MB 原始字节。 */
const MAX_PROMPT_IMAGES = 3;
const MAX_PROMPT_IMAGE_BASE64 = 2_600_000;
const PROMPT_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
/**
 * 用户附 PDF：单条最多 2 份，单份 base64 ≤ ~28MB（原始 ~20MB）。
 * 视频不进 prompt（30MB ≈ 千万 token），只能经 read_video 工具按帧读。
 */
const MAX_PROMPT_DOCUMENTS = 2;
const MAX_PROMPT_DOCUMENT_BASE64 = 28_000_000;
const PROMPT_DOCUMENT_TYPES = new Set(["application/pdf"]);
/** 单条 prompt 文本上限：再大应走附件/文件工具，避免 body 上限级的文本原样进模型。 */
const MAX_PROMPT_TEXT_CHARS = 1_000_000;
/** 允许运行时热更新的 MCP 凭据 env（desktop OAuth 登录/手动令牌后写入；不接受任意环境变量）。 */
const MCP_CREDENTIAL_ENV_NAMES = new Set([
  "MEOWCODE_GITHUB_TOKEN",
  "MEOWCODE_GITEE_TOKEN",
  "MEOWCODE_GITCODE_TOKEN",
  "MEOWCODE_UNDERMIND_TOKEN",
  "MEOWCODE_FIGMA_TOKEN",
  "LUCKIN_MCP_TOKEN",
  "MEOWCODE_LARK_APP_ID",
  "MEOWCODE_LARK_APP_SECRET",
]);

type ParsedAttachments = {
  ok: true;
  images: ToolImage[];
  documents: ToolDocument[];
} | { ok: false; error: string };

/**
 * 校验请求体里的附件（图片 + PDF）。base64 不带 `data:` 前缀；解码后的字节数
 * 也卡一遍，免得前端把上限算错时把请求顶爆。
 * 视频不接受：prompt 里塞视频等于烧掉整个上下文，只能走 read_video 抽帧。
 */
async function parsePromptAttachments(
  rawImages: unknown,
  rawDocuments: unknown,
): Promise<ParsedAttachments> {
  const images: ToolImage[] = [];
  if (rawImages !== undefined && rawImages !== null) {
    if (!Array.isArray(rawImages)) return { ok: false, error: "images must be an array" };
    if (rawImages.length > MAX_PROMPT_IMAGES) {
      return { ok: false, error: `at most ${MAX_PROMPT_IMAGES} images per message` };
    }
    for (const item of rawImages) {
      const entry = item as { mimeType?: unknown; data?: unknown } | null;
      const mimeType = typeof entry?.mimeType === "string" ? entry.mimeType.toLowerCase() : "";
      const data = typeof entry?.data === "string" ? entry.data : "";
      if (!PROMPT_IMAGE_TYPES.has(mimeType)) {
        return { ok: false, error: `unsupported image type: ${mimeType || "(empty)"}` };
      }
      if (!data) return { ok: false, error: "image data must be a base64 string" };
      if (data.length > MAX_PROMPT_IMAGE_BASE64) {
        return { ok: false, error: "image is too large (max 2 MB each)" };
      }
      images.push({ mimeType, data });
    }
  }

  const documents: ToolDocument[] = [];
  if (rawDocuments !== undefined && rawDocuments !== null) {
    if (!Array.isArray(rawDocuments)) return { ok: false, error: "documents must be an array" };
    if (rawDocuments.length > MAX_PROMPT_DOCUMENTS) {
      return { ok: false, error: `at most ${MAX_PROMPT_DOCUMENTS} documents per message` };
    }
    for (const item of rawDocuments) {
      const entry = item as { mimeType?: unknown; data?: unknown; name?: unknown } | null;
      const mimeType = typeof entry?.mimeType === "string" ? entry.mimeType.toLowerCase() : "";
      const data = typeof entry?.data === "string" ? entry.data : "";
      const name = typeof entry?.name === "string" ? entry.name.trim().slice(0, 200) : "";
      if (!PROMPT_DOCUMENT_TYPES.has(mimeType)) {
        return { ok: false, error: `unsupported document type: ${mimeType || "(empty)"} (PDF only)` };
      }
      if (!data) return { ok: false, error: "document data must be a base64 string" };
      if (data.length > MAX_PROMPT_DOCUMENT_BASE64) {
        return { ok: false, error: "document is too large (max 20 MB each)" };
      }
      // 页数只用于 token 估算；解析失败时留给上下文层按体积保守回退
      const pages = await readPdfPageCount(new Uint8Array(Buffer.from(data, "base64")));
      documents.push({
        mimeType,
        data,
        name: name || "document.pdf",
        ...(pages ? { pages } : {}),
      });
    }
  }
  return { ok: true, images, documents };
}

export type AgentServer = http.Server & {
  /** 关闭 SSE、中止回合、flush/close 所有会话文件；关停脚本用它优雅退出。 */
  shutdown: (reason?: string) => Promise<void>;
};

export async function startServer(options: { port?: number; token?: string } = {}): Promise<AgentServer> {
  const authToken = options.token ?? process.env.MEOWCODE_SERVER_TOKEN;
  if (!authToken) {
    throw new Error("MEOWCODE_SERVER_TOKEN is required (or pass startServer({ token })).");
  }
  delete process.env.MEOWCODE_SERVER_TOKEN;
  // 服务商列表：env 给初值，PUT /config/providers 运行中实时替换（不重启进程）
  let providers = readProvidersFromEnv();
  // 密钥只留在内存：删掉环境变量后，模型通过 run_command 读 env 也拿不到。
  delete process.env.MEOWCODE_PROVIDERS;
  delete process.env.MEOWCODE_MAGPIE_FILE;
  delete process.env.MEOWCODE_PROVIDER_PREFS;
  const sessionsDir = process.env.MEOWCODE_SESSIONS_DIR ?? DEFAULT_SESSIONS_DIR;
  /** 诊断日志与 sessions 同级：<agent>/logs，随数据目录迁移一起搬走 */
  const agentLogDir = process.env.MEOWCODE_LOG_DIR ?? path.join(path.dirname(sessionsDir), "logs");
  const agentLogger = createAgentLogger({ dir: agentLogDir });
  void pruneAgentLogs(agentLogDir).catch(() => undefined);
  const traceSink = (span: TraceSpan): void => {
    agentLogger.log({
      level: span.status === "error" ? "error" : "info",
      event: "span",
      ...span,
    });
  };
  const worktreesDir =
    process.env.MEOWCODE_WORKTREES_DIR ?? path.join(path.dirname(sessionsDir), "worktrees");
  const providerId = process.env.MEOWCODE_PROVIDER_ID;
  const workspace = process.env.MEOWCODE_WORKSPACE;
  // 回合后记忆蒸馏：env 给初值，PUT /config/memory-extraction 运行中实时切换
  let memoryEnabled = readMemoryFromEnv();
  // 自我学习：env 给初值，PUT /config/learning 运行中实时切换
  let learningEnabled = readLearningFromEnv();
  // 供应商故障转移：env 给初值，PUT /config/provider-fallback 运行中实时切换（默认关）
  let providerFallbackEnabled = readProviderFallbackFromEnv();
  // 网络代理：env 给初值，PUT /config/proxy 运行中实时切换。
  // 必须在任何对外请求之前落地，否则首个 provider 调用会绕过代理。
  setProxyConfig(readProxyFromEnv());
  let proxyConfig = getProxyConfig();
  // AGENTS.md / CLAUDE.md 导入开关：env 给初值，PUT /config/instructions 运行中实时切换
  let instructionSettings: InstructionSettings = {
    includeAgentsMd: process.env.MEOWCODE_INCLUDE_AGENTS_MD !== "0",
    includeClaudeMd: process.env.MEOWCODE_INCLUDE_CLAUDE_MD !== "0",
  };
  // 语色：env 给初值，PUT /config/speech-style 运行中实时切换
  let speechStyle = readSpeechStyleFromEnv();
  // 命令沙箱：env 给初值；exec 层进程级单例，PUT /config/sandbox 直接覆盖所有 runtime
  setSandboxSettings(readSandboxSettingsFromEnv());
  // 实验开关（桌面端经环境变量注入；默认全关）
  const experimental = readExperimentalFromEnv();
  // 插件系统：目录发现 + jiti 加载 + MCP；desktop 经 MEOWCODE_PLUGINS 注入禁用清单
  const pluginsWorkspace = workspace ?? process.cwd();
  // 用户层根目录（MCP 配置 / 命令索引 / 技能 / 记忆 / 市场）：默认真实 home，
  // 测试经 MEOWCODE_HOME_DIR 整体隔离——缺了它单测会把真实 ~/.meowcode/mcp.json
  // 的 MCP 服务器拉起来，重连退避能把回合拖过测试超时（server.test.ts SSE 用例踩过）。
  const homeDir = process.env.MEOWCODE_HOME_DIR || os.homedir();
  /** 「我的」历史技能补标记只跑一次：首次打开「我的」时执行（避免测试进程无谓写盘） */
  let mineBackfillDone = false;
  // AI 自建技能/插件：宿主能力先建（回调在下面定义后用可变引用回填），
  // 内置创作插件通过 api.host 调到这里，落盘 + 标记 + 热更新统一处理。
  let invalidateExtensionInstructions: () => void = () => undefined;
  let refreshExtensionPlugins: (
    id: string,
  ) => Promise<{ toolNames?: string[]; error?: string }> = async () => ({});
  const extensionHost = createExtensionHost({
    homeDir,
    onSkillCreated: () => invalidateExtensionInstructions(),
    onPluginsChanged: (id) => refreshExtensionPlugins(id),
  });
  // MCP 不阻塞 HTTP 服务就绪：gitcode 这类 stdio MCP 走 npx 拉起，光解析包 + 启动
  // 子进程就要好几秒，没必要让窗口空等。工具就绪前会被首个回合前的 awaitMcpReady 拦住。
  const pluginSystem: PluginSystem = await createPluginSystem({
    workspace: pluginsWorkspace,
    homeDir,
    blockOnMcp: false,
    host: extensionHost,
    ...(() => {
      const { disabled } = readPluginsConfigFromEnv();
      return disabled.length > 0 ? { disabled } : {};
    })(),
  });
  // MCP 后台启动完成后只记一行耗时：回合不阻塞等它（等它会拖慢首轮，且 MCP 卡死
  // 时整段对话都起不来）。工具注册是即时的，下一轮请求自然带上。
  void pluginSystem.mcpReady.then(() => {
    console.log("[mcp] background startup finished");
  });
  /** 插件 UI 错误环形缓冲：/plugin-ui 脚本加载/渲染失败只记录，不阻断其他插件 */
  const pluginUiErrors = new Map<string, Array<{ message: string; slot?: string; at: string }>>();
  let commandIndex: CommandIndex = await loadCommandIndex({
    workspace: pluginsWorkspace,
    homeDir,
    registry: pluginSystem.registry,
  });
  // 插件市场：bundles 目录（desktop 注入 MEOWCODE_MARKETPLACE_DIR；未设置=市场功能为空）
  const marketplace = createMarketplaceStore(process.env.MEOWCODE_MARKETPLACE_DIR);
  // 社区市场源：GitCode 收录仓库（展示/安装；提交/删除走主进程 IPC，不经此服务端）
  const communityMarket = createCommunitySource();
  // 第三方市场源：ClawHub + SkillHub 聚合（仅 skill）
  const thirdPartyMarket = createThirdPartySource();
  /** 显式 reload 的时间点：文件监听忽略这之后 800ms 内的写盘，避免 create_plugin 触发双 reload */
  let explicitPluginReloadAt = 0;
  /** plugin/mcp 安装卸载后重载插件系统与命令索引（skill 走每轮重扫，无需 reload） */
  const reloadAfterMarketChange = async (): Promise<void> => {
    explicitPluginReloadAt = Date.now();
    await pluginSystem.reload();
    commandIndex = await loadCommandIndex({
      workspace: pluginsWorkspace,
      homeDir,
      registry: pluginSystem.registry,
    });
    // 插件/MCP 变更属于显式边界：应用会话里延后的工具删除/改写。
    runtime.rebuildToolCatalog("plugin_reload");
    broadcast({ type: "plugins_changed" });
  };

  /**
   * 手改插件文件（ui/client.js、index.ts、plugin.json）也自动热重载：
   * 监听 project/user 插件根，350ms 合并写盘风暴；显式 reload 后的回声忽略。
   */
  const pluginWatchers: FSWatcher[] = [];
  let pluginWatchTimer: NodeJS.Timeout | null = null;
  const watchPluginRoots = (): void => {
    if (process.env.VITEST || process.env.NODE_ENV === "test") return; // 测试会反复写 fixture，保持确定性
    const roots = [
      path.join(pluginsWorkspace, ".meowcode", "plugins"),
      path.join(homeDir, ".meowcode", "plugins"),
    ];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      try {
        const watcher = watch(root, { recursive: true }, () => {
          if (Date.now() - explicitPluginReloadAt < 800) return;
          if (pluginWatchTimer) clearTimeout(pluginWatchTimer);
          pluginWatchTimer = setTimeout(() => {
            pluginWatchTimer = null;
            // 显式 reload 已经覆盖了这批写盘，别再重载一次
            if (Date.now() - explicitPluginReloadAt < 800) return;
            void reloadAfterMarketChange().catch((error: unknown) => {
              console.warn(
                "[plugins] file watch reload failed:",
                error instanceof Error ? error.message : String(error),
              );
            });
          }, 350);
          pluginWatchTimer.unref?.();
        });
        watcher.on("error", () => undefined);
        watcher.unref?.();
        pluginWatchers.push(watcher);
      } catch {
        // 平台不支持 recursive watch 时退回显式 reload（工具调用仍会刷新）
      }
    }
  };
  watchPluginRoots();

  // AI 自建插件：重载后把该 id 的加载结果（工具名 / 错误）回给宿主，让模型能修错重试
  refreshExtensionPlugins = async (id) => {
    await reloadAfterMarketChange();
    const descriptor = pluginSystem.descriptors().find((item) => item.id === id);
    return {
      ...(descriptor?.toolNames?.length ? { toolNames: descriptor.toolNames } : {}),
      ...(descriptor?.error ? { error: descriptor.error } : {}),
    };
  };
  /** mcp.json 变化（「我的」手动添加/启停）后 diff 重连 MCP：凭据与 enabled 变了必须重连子进程 */
  const reloadAfterMcpChange = async (): Promise<void> => {
    await pluginSystem.reload({ restartMcp: true });
    commandIndex = await loadCommandIndex({
      workspace: pluginsWorkspace,
      homeDir,
      registry: pluginSystem.registry,
    });
    runtime.rebuildToolCatalog("plugin_reload");
    broadcast({ type: "plugins_changed" });
  };
  mkdirSync(sessionsDir, { recursive: true });
  /** 桌面端注入的内嵌浏览器桥（env）；CLI / 测试环境没有，浏览器工具自动不注册 */
  const browserHost = createBrowserHostFromEnv();
  delete process.env.MEOWCODE_BROWSER_HOST_TOKEN;
  const clients = new Set<SseClient>();
  /** 全局单调递增的事件序号：SSE id + 重放游标都靠它 */
  let lastSeq = 0;
  const replayBuffer: BufferedSseEvent[] = [];
  let replayChars = 0;
  const broadcast = (event: unknown) => {
    lastSeq += 1;
    const payload = JSON.stringify({ ...(event as Record<string, unknown>), seq: lastSeq });
    const frame = `id: ${lastSeq}\ndata: ${payload}\n\n`;
    replayBuffer.push({ seq: lastSeq, frame });
    replayChars += frame.length;
    while (
      replayBuffer.length > SSE_REPLAY_MAX_EVENTS ||
      replayChars > SSE_REPLAY_MAX_CHARS
    ) {
      const removed = replayBuffer.shift();
      if (!removed) break;
      replayChars -= removed.frame.length;
    }
    for (const client of clients) {
      try {
        client.response.write(frame);
      } catch {
        // 半开连接写失败不能冒泡到 runtime 打断回合
        clients.delete(client);
      }
    }
  };

  /**
   * 每个会话一个 runtime（与 Codex thread / ZCode session runtime 同款）：
   * 切走的会话带着自己的 abort/队列/审批进入后台继续跑，当前会话换了也不互相影响。
   */
  const createRuntime = (
    cwd: string | undefined,
    providerSnapshot: ProviderConfig[],
    activeProviderId: string | undefined,
  ): AgentRuntime => {
    const instance = new AgentRuntime({
      providers: JSON.parse(JSON.stringify(providerSnapshot)) as ProviderConfig[],
      providerId: activeProviderId,
      sessionsDir,
      ...(cwd ? { workspace: cwd } : {}),
      browserHost,
      ...(experimental ? { experimental } : {}),
      plugins: pluginSystem.registry,
      mcpReady: pluginSystem.mcpReady,
      memory: memoryEnabled,
      learning: learningEnabled,
      providerFallback: providerFallbackEnabled,
      instructionSettings,
      builtinSkillsDir: builtinSkillsDir(),
      speechStyle,
      traceSink,
    });
    instance.onEvent((event) => broadcast({ ...event, traceId: instance.getTraceId() }));
    return instance;
  };
  let runtime = createRuntime(workspace, providers, providerId);
  /** sessionId → 后台 runtime（只在有运行/排队/审批/错误时保留） */
  const backgroundRuntimes = new Map<string, AgentRuntime>();

  /**
   * 工作区监听：外部编辑器/终端改动 → workspace_changed；.git 变化额外发一次
   * git_changed（2s 节流，避免 git 写操作风暴）。会话切换由 5s 守护重新绑定。
   */
  let workspaceWatcher: WorkspaceWatcher | null = null;
  let lastGitBroadcast = 0;
  const syncWorkspaceWatcher = (): void => {
    const root = runtime.current?.cwd;
    const resolved = root ? path.resolve(root) : "";
    if (workspaceWatcher && workspaceWatcher.root === resolved) return;
    workspaceWatcher?.close();
    workspaceWatcher = null;
    if (!resolved) return;
    const sessionId = runtime.current?.id;
    workspaceWatcher = createWorkspaceWatcher({
      root: resolved,
      onChange: (change) => {
        broadcast({
          type: "workspace_changed",
          ...(sessionId ? { sessionId } : {}),
          root: change.root,
          paths: change.paths,
          ...(change.degraded ? { degraded: true } : {}),
        });
        if (change.git) {
          const now = Date.now();
          if (now - lastGitBroadcast >= 2_000) {
            lastGitBroadcast = now;
            broadcast({ type: "git_changed" });
          }
        }
      },
    });
  };
  syncWorkspaceWatcher();
  const workspaceWatcherGuard = setInterval(syncWorkspaceWatcher, 5_000);
  workspaceWatcherGuard.unref?.();

  /**
   * 会话控制路由的目标 runtime：不带 sessionId 时就是前台会话。
   * 并行主会话各自独立运行，后台会话也必须能被停止/插话，不能强制用户先切过去。
   */
  const resolveRuntime = (sessionId: string | undefined): AgentRuntime | null => {
    if (!sessionId) return runtime;
    if (runtime.current?.id === sessionId) return runtime;
    return backgroundRuntimes.get(sessionId) ?? null;
  };

  const invalidSessionId = (value: unknown): boolean =>
    value !== undefined && (typeof value !== "string" || !value.trim());

  const hasPendingWork = (instance: AgentRuntime): boolean =>
    instance.isRunning ||
    instance.isCompacting ||
    instance.hasBackgroundWork ||
    instance.hasLiveSubagents ||
    instance.queuedPrompts.length > 0 ||
    instance.pendingApprovalList.length > 0;

  const collectRunningSessionIds = (): string[] => {
    const ids = new Set<string>();
    const current = runtime.current;
    if (current && (runtime.isRunning || runtime.queuedPrompts.length > 0)) ids.add(current.id);
    for (const [id, instance] of backgroundRuntimes) {
      if (instance.isRunning || instance.queuedPrompts.length > 0) ids.add(id);
    }
    return [...ids];
  };

  const collectPendingApprovals = (): PendingApproval[] => {
    const list: PendingApproval[] = [];
    const seen = new Set<string>();
    for (const instance of [runtime, ...backgroundRuntimes.values()]) {
      for (const pending of instance.pendingApprovalList) {
        if (seen.has(pending.callId)) continue;
        seen.add(pending.callId);
        list.push(pending);
      }
    }
    return list;
  };

  /** 所有正在压缩上下文的会话：前端据此在切换对话后仍保持压缩状态可见。 */
  const collectCompactingSessionIds = (): string[] => {
    const ids = new Set<string>();
    const current = runtime.current;
    if (current && runtime.isCompacting) ids.add(current.id);
    for (const [id, instance] of backgroundRuntimes) {
      if (instance.isCompacting) ids.add(id);
    }
    return [...ids];
  };

  const demoteActiveRuntime = (): void => {
    const session = runtime.current;
    if (!session) return;
    // 空闲且没有错误可回放的 runtime 直接丢弃；切回来时重新读会话文件即可
    if (hasPendingWork(runtime) || runtime.lastError) {
      backgroundRuntimes.set(session.id, runtime);
    } else {
      void runtime.closeSession().catch(() => undefined);
    }
  };

  const pruneBackgroundRuntimes = (keepId?: string): void => {
    for (const [id, instance] of backgroundRuntimes) {
      if (id === keepId) continue;
      if (hasPendingWork(instance) || instance.lastError) continue;
      backgroundRuntimes.delete(id);
      void instance.closeSession().catch(() => undefined);
    }
  };

  /** 只接受 sessions 目录顶层的 .jsonl，防止通过 filePath 读写任意文件。 */
  const resolveSessionFile = (input: unknown): string | null => {
    if (typeof input !== "string" || !input.trim()) return null;
    const resolved = path.resolve(input.trim());
    const relative = path.relative(path.resolve(sessionsDir), resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    if (relative.includes(path.sep) || !relative.endsWith(".jsonl")) return null;
    return resolved;
  };

  /** 侧会话只允许 sessions/side 顶层的 .jsonl（state.json 也不可作为任意文件读取入口）。 */
  const resolveSideSessionFile = (input: unknown): string | null => {
    if (typeof input !== "string" || !input.trim()) return null;
    const sideDir = path.resolve(path.join(sessionsDir, "side"));
    const resolved = path.resolve(input.trim());
    const relative = path.relative(sideDir, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    if (relative.includes(path.sep) || !relative.endsWith(".jsonl")) return null;
    return resolved;
  };

  const normalizeSessionPath = (filePath: string): string => {
    const resolved = path.resolve(filePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };

  const findRuntimeForSessionFile = (filePath: string): AgentRuntime | null => {
    const target = normalizeSessionPath(filePath);
    if (runtime.current && normalizeSessionPath(runtime.current.filePath) === target) {
      return runtime;
    }
    for (const instance of backgroundRuntimes.values()) {
      if (instance.current && normalizeSessionPath(instance.current.filePath) === target) {
        return instance;
      }
    }
    return null;
  };

  /** 最后活动会话：重启后优先恢复它，而不是“该工作区最新会话” */
  type SessionStateFile = {
    version: 1;
    lastSessionFile?: string;
    sideLastSessionFile?: string;
    updatedAt?: string;
  };
  const sessionStateFile = path.join(sessionsDir, "state.json");
  let sessionState: SessionStateFile | null = null;
  let stateWriteChain: Promise<void> = Promise.resolve();

  const readSessionState = async (): Promise<SessionStateFile> => {
    try {
      const parsed = await readJsonFile<Partial<SessionStateFile>>(sessionStateFile);
      if (!parsed || typeof parsed !== "object") return { version: 1 };
      return {
        version: 1,
        ...(typeof parsed.lastSessionFile === "string"
          ? { lastSessionFile: parsed.lastSessionFile }
          : {}),
        ...(typeof parsed.sideLastSessionFile === "string"
          ? { sideLastSessionFile: parsed.sideLastSessionFile }
          : {}),
      };
    } catch {
      return { version: 1 };
    }
  };

  const updateSessionState = (patch: Partial<SessionStateFile>): Promise<void> => {
    stateWriteChain = stateWriteChain
      .then(async () => {
        const current = sessionState ?? (await readSessionState());
        const next: SessionStateFile = {
          ...current,
          ...patch,
          version: 1,
          updatedAt: new Date().toISOString(),
        };
        sessionState = next;
        await writeJsonAtomic(sessionStateFile, next);
      })
      .catch(() => undefined);
    return stateWriteChain;
  };

  const rememberActiveSession = (session: SessionStore | null): Promise<void> =>
    session ? updateSessionState({ lastSessionFile: session.filePath }) : Promise.resolve();

  const rememberSideSession = (session: SessionStore | null): Promise<void> =>
    session ? updateSessionState({ sideLastSessionFile: session.filePath }) : Promise.resolve();

  /** 新 runtime 继承当前模型配置；成功后由调用方替换 active。 */
  const createFreshRuntime = (): AgentRuntime =>
    createRuntime(undefined, runtime.providersConfig, runtime.activeProviderId || providerId);

  const activateSession = async (filePath: string): Promise<SessionStore> => {
    const target = await SessionStore.load(filePath);
    if (runtime.current?.id === target.id) {
      return runtime.current;
    }

    const existing = backgroundRuntimes.get(target.id);
    if (existing) {
      // 审批模式按会话保留；运行中的回合继续用启动时的模式快照
      // 把当前全局模型选择同步到切回的会话；正在流式的那一轮不受影响，下一轮生效
      const activeId = runtime.activeProviderId;
      const activeModel = runtime.providersConfig.find((item) => item.id === activeId)?.model;
      if (activeId) {
        try {
          if (activeModel) await existing.setModel(activeId, activeModel);
          else existing.setActiveProvider(activeId);
        } catch {
          // provider 已被删除时保持原配置
        }
      }
      demoteActiveRuntime();
      backgroundRuntimes.delete(target.id);
      runtime = existing;
    } else {
      const next = createFreshRuntime();
      await next.switchSession(filePath);
      demoteActiveRuntime();
      runtime = next;
    }
    pruneBackgroundRuntimes(target.id);
    if (!runtime.current) throw new Error(`Failed to switch to session: ${filePath}`);
    return runtime.current;
  };

  /**
   * 侧边聊天 runtime：懒创建（首个 /side/* 请求才启动）。
   * - sessionsDir 用 sessions/side 子目录：listSessions 只扫顶层，侧边会话不进主列表，
   *   也避免与主会话文件名冲突（文件名含 cwd + 分钟）。
   * - 不传 workspace：不自动恢复/加载任何会话。
   * - providers 深拷贝：侧边切换模型不污染主 runtime 的配置对象。
   */
  let sideRuntime: AgentRuntime | null = null;
  const ensureSideRuntime = (): AgentRuntime => {
    if (!sideRuntime) {
      sideRuntime = new AgentRuntime({
        providers: JSON.parse(JSON.stringify(providers)) as ProviderConfig[],
        providerId,
        sessionsDir: path.join(sessionsDir, "side"),
        browserHost,
        // 侧边聊天不参与子 Agent 体系：避免派生出不可见的子会话
        enableTaskTool: false,
        memory: memoryEnabled,
        learning: learningEnabled,
        providerFallback: providerFallbackEnabled,
        instructionSettings,
        builtinSkillsDir: builtinSkillsDir(),
        speechStyle,
        traceSink,
      });
      sideRuntime.onEvent((event) =>
        broadcast({ ...event, side: true, traceId: sideRuntime?.getTraceId() }),
      );
    }
    return sideRuntime;
  };
  /** 规则文件增删改后让所有存活 runtime 在下一轮重新读取 instructions。 */
  const invalidateInstructions = (): void => {
    runtime.invalidateInstructions();
    if (sideRuntime) sideRuntime.invalidateInstructions();
    for (const instance of backgroundRuntimes.values()) {
      instance.invalidateInstructions();
    }
  };
  // AI 自建技能：落盘后让技能索引在下一轮重新生成
  invalidateExtensionInstructions = invalidateInstructions;
  const restoreSideRuntime = async (filePath?: string): Promise<void> => {
    if (!filePath) return;
    try {
      await ensureSideRuntime().switchSession(filePath);
    } catch {
      // 侧会话文件被删除/损坏：保留空 runtime，前端会新建
      await updateSessionState({ sideLastSessionFile: undefined });
    }
  };

  // 监听端口前恢复最后的会话：前端启动时不应看到 404 或“最新会话”覆盖当前会话
  const initialState = await readSessionState();
  sessionState = initialState;
  await runtime.restore(workspace, resolveSessionFile(initialState.lastSessionFile) ?? undefined);
  if (runtime.current) await rememberActiveSession(runtime.current);
  await restoreSideRuntime(resolveSideSessionFile(initialState.sideLastSessionFile) ?? undefined);

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${request.socket.localPort}`);
    const pathname = url.pathname;
    // 插件界面脚本由渲染层用 fetch 取：dev 下渲染层在 Vite 源、打包后在 file://，
    // 相对 agent server 都是跨源请求。路由本身用 query token 鉴权且只监听 127.0.0.1，
    // 这里放行读取；否则插件 ui/client.js 会直接报 "Failed to fetch"。
    if (pathname.startsWith("/plugin-ui/")) {
      response.setHeader("access-control-allow-origin", "*");
      response.setHeader("access-control-allow-methods", "GET, HEAD, OPTIONS");
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
    }
    // /session/asset 服务于 <img> 标签、/plugin-ui 服务于插件 iframe：两者都带不了
    // Authorization 头，允许 query token 等价鉴权（token 只在本机内存里，server 只监听 127.0.0.1）
    const assetQueryToken =
      pathname === "/session/asset" || pathname.startsWith("/plugin-ui/")
        ? url.searchParams.get("token")
        : null;
    const authorized =
      isAuthorized(request.headers.authorization, authToken) || assetQueryToken === authToken;
    if (!authorized) {
      sendError(response, 401, "unauthorized", "Missing or invalid server token.");
      return;
    }

    try {
      if (pathname === "/global/health" && request.method === "GET") {
        sendJson(response, 200, { healthy: true, version: APP_VERSION });
        return;
      }

      if (pathname === "/event" && request.method === "GET") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        // 事件投递只走上面那个全局监听器（clients 集合广播）。
        // 这里绝不能再 onEvent 一次 —— 之前两个监听器各写一遍 response，
        // 每条 assistant_delta 都到两次，前端就「重复说同样的字」。
        const rawLastEventId = Array.isArray(request.headers["last-event-id"])
          ? request.headers["last-event-id"][0]
          : request.headers["last-event-id"];
        const requestedSeq = Number(rawLastEventId ?? url.searchParams.get("lastEventId") ?? "");
        const hasRequestedSeq = Number.isInteger(requestedSeq) && requestedSeq >= 0;

        response.write(
          `data: ${JSON.stringify({ type: "server.connected", version: APP_VERSION, lastSeq })}\n\n`,
        );

        if (hasRequestedSeq && requestedSeq < lastSeq) {
          const firstAvailable = replayBuffer[0]?.seq ?? lastSeq + 1;
          if (requestedSeq + 1 < firstAvailable) {
            // 缺口已被缓冲区淘汰（或服务端重启导致序号回退）：要求客户端整体重同步
            const resync = JSON.stringify({
              type: "server.resync",
              reason: "gap",
              lastSeq,
              seq: lastSeq,
            });
            response.write(`id: ${lastSeq}\ndata: ${resync}\n\n`);
          } else {
            for (const entry of replayBuffer) {
              if (entry.seq > requestedSeq) response.write(entry.frame);
            }
          }
        } else if (hasRequestedSeq && requestedSeq > lastSeq) {
          // 客户端记录的序号比当前服务端还大：服务端已重启，同样需要全量对账
          const resync = JSON.stringify({
            type: "server.resync",
            reason: "restart",
            lastSeq,
            seq: lastSeq,
          });
          response.write(`id: ${lastSeq}\ndata: ${resync}\n\n`);
        }

        // 重放完成后再加入广播集合，避免补发与实时事件交错重复
        const client: SseClient = { response };
        clients.add(client);
        const heartbeat = setInterval(() => {
          try {
            // SSE 注释帧：前端解析器会忽略，但能让两端及时发现半开连接
            response.write(": ping\n\n");
          } catch {
            clearInterval(heartbeat);
            clients.delete(client);
          }
        }, 15_000);
        heartbeat.unref?.();
        request.on("close", () => {
          clearInterval(heartbeat);
          clients.delete(client);
        });
        return;
      }

      if (pathname === "/session" && request.method === "GET") {
        const session = runtime.current;
        if (!session) {
          sendError(response, 404, "no_session", "No active session.");
          return;
        }
        const usage = session.usageTotals;
        sendJson(response, 200, {
          id: session.id,
          cwd: session.cwd,
          worktree: session.worktree ?? null,
          filePath: session.filePath,
          createdAt: session.createdAt,
          messageCount: session.messages.length,
          title: session.title,
          plan: session.currentPlan,
          compactionSummary: session.currentCompactionSummary,
          running: runtime.isRunning,
          runningSessionId: runtime.activeTurnSessionId,
          // 所有主会话的运行/待审批都在这里汇总，侧栏才能同时显示多个圆点
          runningSessionIds: collectRunningSessionIds(),
          pendingApproval: runtime.pendingApproval,
          pendingApprovals: collectPendingApprovals(),
          pendingAsk: runtime.pendingAsk,
          queuedPrompts: runtime.queuedPrompts,
          recoveredPrompts: runtime.recoveredPrompts,
          approvalMode: runtime.currentApprovalMode,
          mode: runtime.currentSessionMode,
          agentProfile: runtime.currentAgentProfile,
          /** 当前生效的架构图 id：自定义架构（custom-*）优先，否则等于档位 */
          harnessArchitecture: runtime.currentHarnessArchitecture,
          lastTurn: runtime.lastTurn,
          compactingSessionIds: collectCompactingSessionIds(),
          lastError: runtime.lastError,
          usage: usage.hasUsage ? usage : null,
          metrics: session.lastTurnMetrics,
          subagents: session.subagents.map((item): SubagentSummary => {
            // 进程重启后持久化状态可能还是 running，但没有 live runtime 就按中断展示
            if (item.status === "running" && !runtime.liveSubagentIds.includes(item.agentId)) {
              return { ...item, status: "interrupted" };
            }
            return item;
          }),
        });
        return;
      }

      if (pathname === "/session/plan" && request.method === "GET") {
        const session = runtime.current;
        sendJson(response, 200, { plan: session?.currentPlan ?? null });
        return;
      }

      // 当前会话的上下文占用（真实 inputTokens 优先，其次本地估算）
      if (pathname === "/session/context" && request.method === "GET") {
        sendJson(response, 200, runtime.getContextUsage());
        return;
      }

      // 诊断摘要：日志目录 + 当前链路 id + span 汇总；范围可选 sessionId
      if (pathname === "/diagnostics/summary" && request.method === "GET") {
        const target = resolveRuntime(url.searchParams.get("session") ?? undefined) ?? runtime;
        sendJson(response, 200, {
          logDir: agentLogDir,
          logFile: agentLogger.filePath(),
          traceId: target.getTraceId(),
          summary: target.getTraceSummary(),
          spans: target.getTraceSpans(50),
        });
        return;
      }

      if (pathname === "/diagnostics/traces" && request.method === "GET") {
        const target = resolveRuntime(url.searchParams.get("session") ?? undefined) ?? runtime;
        const raw = Number(url.searchParams.get("limit"));
        const limit = Number.isFinite(raw) ? Math.min(500, Math.max(1, Math.floor(raw))) : 100;
        sendJson(response, 200, {
          traceId: target.getTraceId(),
          spans: target.getTraceSpans(limit),
        });
        return;
      }

      // 一键审查：把未提交改动交给 reviewer 子 Agent，返回 findings 文本
      if (pathname === "/review/start" && request.method === "POST") {
        const body = await readJsonBody<{ sessionId?: string }>(request);
        const target = resolveRuntime(body.sessionId) ?? runtime;
        const session = target.current;
        if (!session) {
          sendError(response, 400, "no_session", "No active session.");
          return;
        }
        const status = await getStatus(session.cwd);
        if (!status.isRepo) {
          sendError(response, 400, "not_a_repo", "The workspace is not a git repository.");
          return;
        }
        if (!status.staged.length && !status.unstaged.length) {
          sendError(response, 400, "no_changes", "There are no uncommitted changes to review.");
          return;
        }
        const [stagedDiff, worktreeDiff] = await Promise.all([
          getDiff(session.cwd, { scope: "index" }).catch(() => null),
          getDiff(session.cwd, { scope: "worktree" }).catch(() => null),
        ]);
        const patch = [stagedDiff?.patch ?? "", worktreeDiff?.patch ?? ""]
          .filter(Boolean)
          .join("\n")
          .slice(0, 60_000);
        const files = [...status.staged, ...status.unstaged]
          .slice(0, 40)
          .map((entry) => `${entry.path} (${entry.index ?? entry.worktree ?? "?"})`)
          .join("\n");
        const prompt = [
          "Review the uncommitted changes below. Read the affected files for context when needed.",
          "Report findings grouped by file: severity (critical/major/minor), file:line, the problem, and a concrete fix.",
          "Only report real defects (correctness, security, data loss, regressions). Do not restate the diff or praise the code.",
          "If nothing is wrong, say \"No blocking issues found\" and list any minor notes.",
          "",
          "Changed files:",
          files,
          "",
          "Diff:",
          patch || "(binary or too large to inline; open the files)",
        ].join("\n");
        try {
          const result = await target.reviewChanges(prompt);
          sendJson(response, 200, result);
        } catch (error) {
          sendError(
            response,
            500,
            "review_failed",
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      }

      // 本会话 Agent 改过的文件（审阅面板数据源）：按文件聚合，最新在前
      if (pathname === "/session/changes" && request.method === "GET") {        const session = runtime.current;
        const summaryOnly = url.searchParams.get("summary") === "1";
        type ChangeSummary = {
          path: string;
          operation: "write_file" | "edit_file" | "delete_file" | "move_file";
          changeCount: number;
          added: number;
          removed: number;
          timestamp: string;
          diff: string;
        };
        const countMarker = (diff: string, marker: string) =>
          diff.split("\n").filter((line) => line.startsWith(`${marker} `)).length;
        const byPath = new Map<string, ChangeSummary>();
        for (const entry of session?.fileChanges ?? []) {
          const added = countMarker(entry.diff, "+");
          const removed = countMarker(entry.diff, "-");
          const existing = byPath.get(entry.path);
          if (existing) {
            existing.changeCount += 1;
            existing.added += added;
            existing.removed += removed;
            existing.operation = entry.operation;
            existing.timestamp = entry.timestamp;
            existing.diff = `${existing.diff}\n\n${entry.diff}`;
          } else {
            byPath.set(entry.path, {
              path: entry.path,
              operation: entry.operation,
              changeCount: 1,
              added,
              removed,
              timestamp: entry.timestamp,
              diff: entry.diff,
            });
          }
        }
        const MAX_AGGREGATE_DIFF = 40_000;
        const changes = [...byPath.values()]
          .map((item) =>
            item.diff.length > MAX_AGGREGATE_DIFF
              ? { ...item, diff: `${item.diff.slice(0, MAX_AGGREGATE_DIFF)}\n... [diff truncated]` }
              : item,
          )
          .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        // 输入框悬浮胶囊只要统计：summary=1 丢掉 diff，避免每次 file_changed 都传 40k 文本
        if (summaryOnly) {
          sendJson(response, 200, {
            changes: changes.map(({ path, operation, changeCount, added, removed, timestamp }) => ({
              path,
              operation,
              changeCount,
              added,
              removed,
              timestamp,
            })),
          });
          return;
        }
        sendJson(response, 200, { changes });
        return;
      }

      // 工作区文件列表（快速打开 Ctrl+P）
      if (pathname === "/workspace/files" && request.method === "GET") {
        const session = runtime.current;
        if (!session) {
          sendError(response, 404, "no_session", "No active session.");
          return;
        }
        try {
          sendJson(response, 200, { files: await listWorkspaceFiles(session.cwd) });
        } catch (error) {
          sendError(response, 500, "list_failed", error instanceof Error ? error.message : String(error));
        }
        return;
      }

      // 目录浏览（文件页签逐层展开）：只列某目录的直接子项，不递归
      if (pathname === "/workspace/dir" && request.method === "GET") {
        const session = runtime.current;
        if (!session) {
          sendError(response, 404, "no_session", "No active session.");
          return;
        }
        const relative = (url.searchParams.get("path") ?? "").trim();
        let dir: string;
        try {
          dir = await resolveWithinWorkspace(session.cwd, relative || ".");
        } catch {
          sendError(response, 400, "outside_workspace", "Path is outside the workspace.");
          return;
        }
        try {
          const items = await readdir(dir, { withFileTypes: true });
          const entries = items
            .map((item) => ({
              name: item.name,
              // 统一用 / 分隔（客户端按 posix 路径处理；Windows 上 displayPath 会出反斜杠）
              path: displayPath(session.cwd, path.join(dir, item.name)).replace(/\\/g, "/"),
              dir: item.isDirectory(),
            }))
            .sort(
              (a, b) =>
                Number(b.dir) - Number(a.dir) ||
                a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
            );
          sendJson(response, 200, { path: displayPath(session.cwd, dir).replace(/\\/g, "/"), entries });
        } catch {
          sendError(response, 404, "not_found", "Directory not found.");
        }
        return;
      }

      // 读取工作区文件（文件查看器；1MB 上限，拒绝二进制）
      if (pathname === "/workspace/file" && request.method === "GET") {
        const session = runtime.current;
        if (!session) {
          sendError(response, 404, "no_session", "No active session.");
          return;
        }
        const relative = (url.searchParams.get("path") ?? "").trim();
        if (!relative) {
          sendError(response, 400, "invalid_request", "path is required");
          return;
        }
        let file: string;
        try {
          file = await resolveWithinWorkspace(session.cwd, relative);
        } catch {
          sendError(response, 400, "outside_workspace", "Path is outside the workspace.");
          return;
        }
        try {
          const info = await stat(file);
          if (!info.isFile()) {
            sendError(response, 400, "not_a_file", "Path is not a file.");
            return;
          }
          if (info.size > 1_000_000) {
            sendError(response, 413, "file_too_large", "File is larger than 1 MB.");
            return;
          }
          const buffer = await readFile(file);
          if (buffer.subarray(0, 8192).includes(0)) {
            sendError(response, 415, "binary_file", "Binary files are not supported.");
            return;
          }
          sendJson(response, 200, { path: displayPath(session.cwd, file), content: buffer.toString("utf8") });
        } catch {
          sendError(response, 404, "not_found", "File not found.");
        }
        return;
      }

      // 读取工作区文件原始字节（图片/视频/音频/PDF 预览；20MB 上限，base64 传输）
      if (pathname === "/workspace/raw" && request.method === "GET") {
        const session = runtime.current;
        if (!session) {
          sendError(response, 404, "no_session", "No active session.");
          return;
        }
        const relative = (url.searchParams.get("path") ?? "").trim();
        if (!relative) {
          sendError(response, 400, "invalid_request", "path is required");
          return;
        }
        let file: string;
        try {
          file = await resolveWithinWorkspace(session.cwd, relative);
        } catch {
          sendError(response, 400, "outside_workspace", "Path is outside the workspace.");
          return;
        }
        try {
          const info = await stat(file);
          if (!info.isFile()) {
            sendError(response, 400, "not_a_file", "Path is not a file.");
            return;
          }
          if (info.size > 20_000_000) {
            sendError(response, 413, "file_too_large", "File is larger than 20 MB.");
            return;
          }
          const buffer = await readFile(file);
          sendJson(response, 200, {
            path: displayPath(session.cwd, file),
            mime: mimeForFile(file),
            size: info.size,
            contentBase64: buffer.toString("base64"),
          });
        } catch {
          sendError(response, 404, "not_found", "File not found.");
        }
        return;
      }

      // ---- Git：源码管理（状态 / diff / 暂存 / 提交 / 分支 / 远端 / AI 文案） ----
      // 工作区固定取当前会话的 cwd；不是仓库时 /git/status 仍返回 200 + isRepo:false，
      // 其余端点抛 not_a_repo（409），前端据此渲染空态或提示。
      if (pathname.startsWith("/git/")) {
        const session = runtime.current;
        if (!session) {
          sendError(response, 404, "no_session", "No active session.");
          return;
        }
        const git = createGitService({ workspace: session.cwd });
        try {
          if (pathname === "/git/status" && request.method === "GET") {
            sendJson(response, 200, await git.status());
            return;
          }

          if (pathname === "/git/diff" && request.method === "GET") {
            const scope = url.searchParams.get("scope") ?? "worktree";
            if (scope !== "worktree" && scope !== "index" && scope !== "commit") {
              sendError(response, 400, "invalid_request", "scope must be worktree / index / commit.");
              return;
            }
            const filePath = url.searchParams.get("path") ?? undefined;
            sendJson(
              response,
              200,
              await git.diff({
                ...(filePath ? { path: filePath } : {}),
                scope,
                ...(scope === "commit" ? { sha: url.searchParams.get("sha") ?? "" } : {}),
              }),
            );
            return;
          }

          if (pathname === "/git/stage" && request.method === "POST") {
            const body = await readJsonBody<{ paths?: unknown; all?: boolean }>(request);
            // all：列表可能被截断，交给服务端整仓暂存，避免几万个路径拼进命令行
            if (body.all === true) await git.stageAll();
            else await git.stage(body.paths);
            broadcast({ type: "git_changed" });
            sendJson(response, 200, { ok: true });
            return;
          }

          if (pathname === "/git/unstage" && request.method === "POST") {
            const body = await readJsonBody<{ paths?: unknown; all?: boolean }>(request);
            if (body.all === true) await git.unstageAll();
            else await git.unstage(body.paths);
            broadcast({ type: "git_changed" });
            sendJson(response, 200, { ok: true });
            return;
          }

          if (pathname === "/git/discard" && request.method === "POST") {
            const body = await readJsonBody<{ paths?: unknown }>(request);
            const result = await git.discard(body.paths);
            broadcast({ type: "git_changed" });
            sendJson(response, 200, { ok: true, discarded: result.discarded });
            return;
          }

          if (pathname === "/git/commit" && request.method === "POST") {
            const body = await readJsonBody<{ message?: string }>(request);
            if (typeof body.message !== "string") {
              sendError(response, 400, "invalid_request", "message must be a string.");
              return;
            }
            const created = await git.commit(body.message);
            broadcast({ type: "git_changed" });
            sendJson(response, 200, created);
            return;
          }

          if (pathname === "/git/branches" && request.method === "GET") {
            sendJson(response, 200, await git.branches());
            return;
          }

          if (pathname === "/git/branches/switch" && request.method === "POST") {
            const body = await readJsonBody<{
              name?: string;
              force?: boolean;
              stash?: boolean;
            }>(request);
            if (typeof body.name !== "string" || !body.name.trim()) {
              sendError(response, 400, "invalid_request", "name must be a non-empty string.");
              return;
            }
            const result = await git.switchBranch({
              name: body.name,
              force: body.force === true,
              stash: body.stash === true,
            });
            broadcast({ type: "git_changed" });
            sendJson(response, 200, result);
            return;
          }

          if (pathname === "/git/branches/create" && request.method === "POST") {
            const body = await readJsonBody<{ name?: string; startPoint?: string }>(request);
            if (typeof body.name !== "string" || !body.name.trim()) {
              sendError(response, 400, "invalid_request", "name must be a non-empty string.");
              return;
            }
            const result = await git.createBranch(
              body.name,
              typeof body.startPoint === "string" ? body.startPoint : undefined,
            );
            broadcast({ type: "git_changed" });
            sendJson(response, 200, result);
            return;
          }

          if (pathname === "/git/log" && request.method === "GET") {
            const limit = Number(url.searchParams.get("limit") ?? "50");
            const skip = Number(url.searchParams.get("skip") ?? "0");
            sendJson(response, 200, await git.log({
              limit: Number.isFinite(limit) ? limit : 50,
              skip: Number.isFinite(skip) ? skip : 0,
            }));
            return;
          }

          if (pathname === "/git/commit" && request.method === "GET") {
            const sha = (url.searchParams.get("sha") ?? "").trim();
            if (!sha) {
              sendError(response, 400, "invalid_request", "sha is required.");
              return;
            }
            sendJson(response, 200, await git.showCommit(sha));
            return;
          }

          if (pathname === "/git/pull" && request.method === "POST") {
            const result = await git.pull();
            broadcast({ type: "git_changed" });
            sendJson(response, 200, { ok: true, ...result });
            return;
          }

          if (pathname === "/git/push" && request.method === "POST") {
            const body = await readJsonBody<{ setUpstream?: boolean; force?: boolean }>(request);
            const result = await git.push({
              setUpstream: body.setUpstream === true,
              force: body.force === true,
            });
            broadcast({ type: "git_changed" });
            sendJson(response, 200, { ok: true, ...result });
            return;
          }

          if (pathname === "/git/resolve" && request.method === "POST") {
            const body = await readJsonBody<{
              path?: string;
              side?: "ours" | "theirs" | "mark";
            }>(request);
            if (typeof body.path !== "string" || !body.path.trim()) {
              sendError(response, 400, "invalid_request", "path is required.");
              return;
            }
            await git.resolve({
              path: body.path,
              side: body.side ?? "mark",
            });
            broadcast({ type: "git_changed" });
            sendJson(response, 200, { ok: true });
            return;
          }

          if (pathname === "/git/commit-message" && request.method === "POST") {
            const body = await readJsonBody<{ hint?: string }>(request).catch(() => ({ hint: undefined }));
            if (body.hint !== undefined && typeof body.hint !== "string") {
              sendError(response, 400, "invalid_request", "hint must be a string.");
              return;
            }
            const context = await git.commitContext();
            const controller = new AbortController();
            // 思考型模型可能先烧几千 token 再给正文；内部还会自动重试一次，给足 90s
            const timer = setTimeout(() => controller.abort(), 90_000);
            try {
              const message = await runtime.generateCommitMessage(context, {
                signal: controller.signal,
              });
              sendJson(response, 200, { message });
            } catch (error) {
              sendError(
                response,
                502,
                "commit_message_failed",
                error instanceof Error ? error.message : String(error),
              );
            } finally {
              clearTimeout(timer);
            }
            return;
          }

          sendError(response, 404, "not_found", `Unknown git route: ${pathname}`);
        } catch (error) {
          sendGitError(response, error);
        }
        return;
      }

      // 会话图片资产：前端 <img> 直接引用（恢复后的历史图片不再有 base64 快照可渲染）
      if (pathname === "/session/asset" && request.method === "GET") {
        const file = (url.searchParams.get("file") ?? "").trim();
        // 只接受 "<sessionId>/<fileName>" 两段式引用；文件名走 basename 再校验，杜绝路径穿越
        const [sessionId, fileName] = file.split("/");
        if (
          !sessionId ||
          !fileName ||
          file.includes("..") ||
          sessionId !== path.basename(sessionId) ||
          fileName !== path.basename(fileName)
        ) {
          sendError(response, 400, "invalid_request", "file must be <sessionId>/<fileName>.");
          return;
        }
        try {
          const buffer = await readFile(
            path.join(sessionsDir, "assets", sessionId, fileName),
          );
          response.writeHead(200, {
            "content-type": mimeForFile(fileName),
            "content-length": buffer.length,
            "cache-control": "private, max-age=86400",
          });
          response.end(buffer);
        } catch {
          sendError(response, 404, "not_found", "Asset not found.");
        }
        return;
      }

      // 手动压缩上下文：生成摘要并落盘，历史保留在会话文件里
      if (pathname === "/session/compact" && request.method === "POST") {
        if (runtime.isCompacting) {
          sendError(response, 409, "compaction_running", "正在压缩对话历史，请稍候。");
          return;
        }
        await runtime.compactSession();
        sendJson(response, 200, { success: true });
        return;
      }

      // 用户手动改名（AI 标题生成失败时的兜底入口）
      if (pathname === "/session/title" && request.method === "PUT") {
        const body = await readJsonBody<{ title: string }>(request);
        const title = await runtime.renameSession(body.title ?? "");
        sendJson(response, 200, { title });
        return;
      }

      if (pathname === "/sessions" && request.method === "GET") {
        sendJson(response, 200, { sessions: await runtime.listSessions() });
        return;
      }

      // 会话全文检索：纯本地子串匹配影子索引，零 LLM 调用
      if (pathname === "/sessions/search" && request.method === "GET") {
        const query = (url.searchParams.get("q") ?? "").trim();
        if (query.length > MAX_QUERY_CHARS) {
          sendError(response, 400, "invalid_request", `q must be at most ${MAX_QUERY_CHARS} characters.`);
          return;
        }
        if (!query) {
          sendJson(response, 200, {
            query: "",
            hits: [],
            scanned: 0,
            skipped: 0,
            reindexed: 0,
            truncated: false,
          });
          return;
        }
        const rawLimit = Number(url.searchParams.get("limit") ?? "");
        const limit =
          Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_LIMIT) : DEFAULT_LIMIT;
        const workspace = (url.searchParams.get("workspace") ?? "").trim();
        try {
          sendJson(
            response,
            200,
            await searchSessions(sessionsDir, query, {
              limit,
              ...(workspace ? { workspace } : {}),
            }),
          );
        } catch (error) {
          sendError(
            response,
            500,
            "search_failed",
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      }

      // 重命名任意会话（侧栏行菜单；不必先切换过去）
      if (pathname === "/sessions/title" && request.method === "PUT") {
        const body = await readJsonBody<{ filePath?: string; title?: string }>(request);
        const filePath = resolveSessionFile(body.filePath);
        const title = String(body.title ?? "").trim().slice(0, 100);
        if (!filePath) {
          sendError(response, 400, "invalid_request", "filePath must be a session file.");
          return;
        }
        if (!title) {
          sendError(response, 400, "invalid_request", "title must be a non-empty string.");
          return;
        }
        try {
          const target = findRuntimeForSessionFile(filePath);
          if (target) {
            sendJson(response, 200, { title: await target.renameSession(title) });
          } else {
            const store = await SessionStore.load(filePath);
            try {
              await store.appendTitle(title);
              await store.flush();
            } finally {
              await store.close().catch(() => undefined);
            }
            broadcast({ type: "session_title", sessionId: store.id, title });
            sendJson(response, 200, { title });
          }
        } catch (error) {
          sendError(
            response,
            404,
            "rename_failed",
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      }

      // 删除会话文件；运行/排队/压缩/审批中的会话必须先停止
      if (pathname === "/sessions/delete" && request.method === "POST") {
        const body = await readJsonBody<{ filePath?: string }>(request);
        const filePath = resolveSessionFile(body.filePath);
        if (!filePath) {
          sendError(response, 400, "invalid_request", "filePath must be a session file.");
          return;
        }
        const target = findRuntimeForSessionFile(filePath);
        if (target && hasPendingWork(target)) {
          sendError(
            response,
            409,
            "session_busy",
            "该会话还在生成、排队或等待审批，先停止后再删除。",
          );
          return;
        }
        let targetCwd: string | undefined;
        let targetId: string | undefined;
        if (target) {
          targetCwd = target.current?.cwd;
          targetId = target.current?.id;
          if (targetId) backgroundRuntimes.delete(targetId);
          // Windows 上打开的文件句柄会阻止 unlink：先释放 writer 再删文件
          target.abort();
          await target.closeSession().catch(() => undefined);
        }
        // 删除文件前先记下会话 id，用于清理 sessions/subagents/<父id>/
        let deletedSessionId = targetId;
        if (!deletedSessionId) {
          try {
            deletedSessionId = (await SessionStore.load(filePath)).id;
          } catch {
            // 文件不可读时没有子目录可清理
          }
        }
        try {
          await unlink(filePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            // 删除失败时把当前 runtime 恢复成可用状态（文件还在）
            if (target === runtime) {
              const next = createFreshRuntime();
              try {
                await next.switchSession(filePath);
                runtime = next;
              } catch {
                // 文件本身不可读时保持旧 runtime，用户可再删一次
              }
            }
            sendError(
              response,
              500,
              "delete_failed",
              error instanceof Error ? error.message : String(error),
            );
            return;
          }
        }
        if (deletedSessionId && SUBAGENT_ID_PATTERN.test(deletedSessionId)) {
          await rm(path.join(sessionsDir, "subagents", deletedSessionId), {
            recursive: true,
            force: true,
          }).catch(() => undefined);
        }
        // 会话全文检索的影子索引：会话没了，索引一并清掉
        await invalidateSearchIndex(sessionsDir, path.basename(filePath)).catch(() => undefined);
        // 会话图片资产：整目录清理，避免孤儿文件堆积
        if (deletedSessionId) {
          await rm(path.join(sessionsDir, "assets", deletedSessionId), {
            recursive: true,
            force: true,
          }).catch(() => undefined);
        }
        if (targetId) {
          await unlink(path.join(sessionsDir, ".partial", `${targetId}.json`)).catch(
            () => undefined,
          );
        }
        if (target === runtime) {
          const cwd = targetCwd ?? workspace ?? process.cwd();
          // 当前会话被删掉：立即在同一个工作区开新会话，前端不用处理空状态
          const next = createFreshRuntime();
          const session = await next.newSession(cwd);
          runtime = next;
          pruneBackgroundRuntimes(session.id);
          await rememberActiveSession(runtime.current);
          sendJson(response, 200, { deleted: true, activeSessionId: session.id });
          return;
        }
        sendJson(response, 200, { deleted: true });
        return;
      }

      // 从源会话复制一份完整历史，作为新的活动会话
      if (pathname === "/sessions/branch" && request.method === "POST") {
        const body = await readJsonBody<{ filePath?: string }>(request);
        const filePath = resolveSessionFile(body.filePath);
        if (!filePath) {
          sendError(response, 400, "invalid_request", "filePath must be a session file.");
          return;
        }
        const target = findRuntimeForSessionFile(filePath);
        if (target && hasPendingWork(target)) {
          sendError(
            response,
            409,
            "session_busy",
            "该会话还在生成、排队或等待审批，停止后再创建分支。",
          );
          return;
        }
        try {
          const source = await SessionStore.load(filePath);
          const sourceHeader = source.entries[0];
          const rootSessionId =
            sourceHeader.type === "session"
              ? (sourceHeader.rootSessionId ?? sourceHeader.id)
              : source.id;
          const header = {
            type: "session",
            version: 2 as const,
            id: randomUUID(),
            cwd: source.cwd,
            createdAt: new Date().toISOString(),
            parentSessionId: source.id,
            rootSessionId,
            ...(sourceHeader.type === "session" && sourceHeader.worktree
              ? { worktree: sourceHeader.worktree }
              : {}),
          };
          // 分支图片资产：把源会话 assets 拷到分支名下并改写引用前缀，
          // 两边各自独立（删除一边不影响另一边）。拷贝失败不阻断分支：引用照抄，
          // hydrate 时缺图静默跳过（与旧会话行为一致）。
          const branchId = header.id;
          let refsRewritten = false;
          try {
            await cp(
              path.join(sessionsDir, "assets", source.id),
              path.join(sessionsDir, "assets", branchId),
              { recursive: true, errorOnExist: true, force: false },
            );
            refsRewritten = true;
          } catch {
            // 源会话没有资产（ENOENT）属常态；其余错误同样降级
          }
          const lines = [
            JSON.stringify(header),
            // 子 Agent 转录属于源会话目录，分支不复制文件，索引也不能带过去
            ...source.entries
              .slice(1)
              .filter((entry) => entry.type !== "subagent")
              .map((entry) => {
                if (
                  refsRewritten &&
                  entry.type === "message" &&
                  entry.imageRefs?.length
                ) {
                  return JSON.stringify({
                    ...entry,
                    imageRefs: entry.imageRefs.map((ref) => ({
                      ...ref,
                      file: `${branchId}/${ref.file.split("/")[1] ?? ""}`,
                    })),
                  });
                }
                return JSON.stringify(entry);
              }),
          ];
          const sourceTitle = source.title;
          if (sourceTitle) {
            lines.push(
              JSON.stringify({
                type: "title",
                id: newEntryId(),
                parentId: null,
                timestamp: new Date().toISOString(),
                title: `${sourceTitle}（分支）`.slice(0, 100),
              }),
            );
          }
          const content = `${lines.join("\n")}\n`;
          let branchPath = path.join(sessionsDir, sessionFileName(source.cwd, new Date()));
          let written = false;
          for (let attempt = 0; attempt < 4 && !written; attempt += 1) {
            try {
              await writeFile(branchPath, content, { encoding: "utf8", flag: "wx" });
              written = true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 3) {
                throw error;
              }
              branchPath = branchPath.replace(/\.jsonl$/, `_${randomUUID().slice(0, 8)}.jsonl`);
            }
          }
          if (!written) throw new Error("Failed to create the branch file.");

          const next = createFreshRuntime();
          await next.switchSession(branchPath);
          demoteActiveRuntime();
          runtime = next;
          pruneBackgroundRuntimes(runtime.current?.id);
          const session = runtime.current;
          if (!session) throw new Error("Failed to activate the branch.");
          await rememberActiveSession(session);
          sendJson(response, 200, {
            id: session.id,
            cwd: session.cwd,
            filePath: session.filePath,
            createdAt: session.createdAt,
            title: session.title,
          });
        } catch (error) {
          sendError(
            response,
            500,
            "branch_failed",
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      }

      // 会话检查点：列出（时间线分隔线） / 手动创建 / 恢复（截断分支出新会话）
      if (pathname === "/session/checkpoints" && request.method === "GET") {
        const session = runtime.current;
        sendJson(response, 200, { checkpoints: session?.checkpoints ?? [] });
        return;
      }

      if (pathname === "/session/checkpoint" && request.method === "POST") {
        if (!runtime.current) {
          sendError(response, 404, "no_session", "No active session.");
          return;
        }
        if (hasPendingWork(runtime)) {
          sendError(
            response,
            409,
            "session_busy",
            "该会话还在生成、排队或等待审批，停止后再创建检查点。",
          );
          return;
        }
        const body = await readJsonBody<{ label?: string }>(request).catch(
          () => ({}) as { label?: string },
        );
        try {
          const checkpoint = await runtime.createCheckpoint(
            typeof body.label === "string" ? body.label : undefined,
          );
          sendJson(response, 200, { checkpoint });
        } catch (error) {
          sendError(
            response,
            500,
            "checkpoint_failed",
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      }

      if (pathname === "/session/checkpoints/restore" && request.method === "POST") {
        const body = await readJsonBody<{ filePath?: string; checkpointId?: string }>(request);
        const checkpointId =
          typeof body.checkpointId === "string" ? body.checkpointId.trim() : "";
        if (!checkpointId) {
          sendError(response, 400, "invalid_request", "checkpointId is required.");
          return;
        }
        const filePath = body.filePath
          ? resolveSessionFile(body.filePath)
          : (runtime.current?.filePath ?? null);
        if (!filePath) {
          sendError(response, 400, "invalid_request", "No session to restore from.");
          return;
        }
        const target = findRuntimeForSessionFile(filePath);
        if (target && hasPendingWork(target)) {
          sendError(
            response,
            409,
            "session_busy",
            "该会话还在生成、排队或等待审批，停止后再恢复检查点。",
          );
          return;
        }
        try {
          const source = await SessionStore.load(filePath);
          const checkpointExists = source.entries.some(
            (entry) => entry.type === "checkpoint" && entry.id === checkpointId,
          );
          if (!checkpointExists) {
            sendError(
              response,
              404,
              "checkpoint_not_found",
              "Checkpoint not found in this session.",
            );
            return;
          }
          // 派生逻辑抽到 session-derive.ts（/session/rewind 也复用）；restore 语义 = 仅回滚对话
          const derived = await deriveSessionAtCheckpoint({
            sourceFilePath: filePath,
            source,
            checkpointId,
            sessionsDir,
          });

          const next = createFreshRuntime();
          await next.switchSession(derived.filePath);
          demoteActiveRuntime();
          runtime = next;
          pruneBackgroundRuntimes(runtime.current?.id);
          const session = runtime.current;
          if (!session) throw new Error("Failed to activate the restored session.");
          await rememberActiveSession(session);
          sendJson(response, 200, {
            id: session.id,
            cwd: session.cwd,
            filePath: session.filePath,
            createdAt: session.createdAt,
            title: session.title,
          });
        } catch (error) {
          sendError(
            response,
            500,
            "restore_failed",
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      }

      if (pathname === "/session/messages" && request.method === "GET") {
        // 悬浮岛等第二窗口要读后台会话的历史：带 sessionId 时路由到对应 runtime（仅运行/排队/审批中的后台会话有 runtime）
        const target = resolveRuntime(url.searchParams.get("sessionId")?.trim() || undefined);
        const session = target?.current ?? null;
        if (!session) {
          sendJson(response, 200, {
            messages: [],
            compaction: null,
            compactions: [],
            checkpoints: [],
            turnChanges: [],
            turnDurations: [],
            usageSamples: [],
            compactionQuality: null,
          });
          return;
        }
        sendJson(response, 200, {
          messages: session.messagesForClient,
          compaction: session.lastCompaction,
          compactions: session.compactionPoints,
          checkpoints: session.checkpoints,
          // 按回合聚合的文件改动：历史回放时在每轮末尾重建「已编辑 N 个文件」卡片
          turnChanges: session.turnFileChangeGroups,
          // 按回合的运行耗时：历史回放时在每轮末尾显示运行时间
          turnDurations: session.turnDurations,
          // 每次模型调用的用量样本：右侧命中率曲线的实时观感（重载后仍连续）
          usageSamples: session.usageSamples,
          compactionQuality: session.lastCompactionQuality,
        });
        return;
      }

      // 会话/代码双回滚：预览（dryRun）与执行。both=对话+代码 / conversation=仅对话 / code=仅代码
      if (pathname === "/session/rewind" && request.method === "POST") {
        const body = await readJsonBody<{
          checkpointId?: string;
          mode?: string;
          dryRun?: boolean;
          planId?: string;
          force?: boolean;
          keepNewFiles?: boolean;
          filePath?: string;
        }>(request);
        const checkpointId = typeof body.checkpointId === "string" ? body.checkpointId.trim() : "";
        if (!checkpointId) {
          sendError(response, 400, "invalid_request", "checkpointId is required.");
          return;
        }
        const mode: "both" | "conversation" | "code" =
          body.mode === "conversation" || body.mode === "code" ? body.mode : "both";
        const dryRun = body.dryRun !== false;
        const keepNewFiles = body.keepNewFiles === true;
        const force = body.force === true;
        const filePath = body.filePath
          ? resolveSessionFile(body.filePath)
          : (runtime.current?.filePath ?? null);
        if (!filePath) {
          sendError(response, 400, "invalid_request", "No session to rewind.");
          return;
        }
        const target = findRuntimeForSessionFile(filePath);
        if (target && hasPendingWork(target)) {
          sendError(
            response,
            409,
            "session_busy",
            "该会话还在生成、排队或等待审批，停止后再回滚。",
          );
          return;
        }
        const sendRewindError = (error: unknown): void => {
          if (error instanceof RewindError) {
            const status =
              error.code === "needs_force" || error.code === "cwd_changed"
                ? 409
                : error.code === "apply_failed" ||
                    error.code === "derive_failed" ||
                    error.code === "blob_missing"
                  ? 500
                  : 400;
            sendError(response, status, error.code, error.message);
            return;
          }
          sendError(
            response,
            500,
            "rewind_failed",
            error instanceof Error ? error.message : String(error),
          );
        };
        try {
          const source =
            target?.current && target.current.filePath === filePath
              ? target.current
              : await SessionStore.load(filePath);
          // 与打点共用同一 store 实例（内存 state 才一致）；拥有该会话的 runtime 优先
          const store = (target ?? runtime).snapshotStoreOf(source);
          if (!store) {
            sendError(response, 400, "no_snapshot", "文件快照已关闭，无法回滚代码（可仅回滚对话）。");
            return;
          }
          if (dryRun) {
            const plan = await planRewind({ session: source, checkpointId, mode, store, keepNewFiles });
            cachePlan(plan);
            sendJson(response, 200, plan);
            return;
          }
          const plan = body.planId ? takePlan(body.planId) : null;
          if (!plan || plan.checkpoint.id !== checkpointId) {
            sendError(response, 400, "plan_expired", "预览已过期，请重新预览后再回滚。");
            return;
          }
          const result = await applyRewind({
            session: source,
            plan,
            store,
            force,
            derive: async () => {
              const derived = await deriveSessionAtCheckpoint({
                sourceFilePath: filePath,
                source,
                checkpointId: plan.checkpoint.id,
                sessionsDir,
                titleSuffix: "（回滚）",
              });
              const next = createFreshRuntime();
              await next.switchSession(derived.filePath);
              demoteActiveRuntime();
              runtime = next;
              pruneBackgroundRuntimes(runtime.current?.id);
              const activated = runtime.current;
              if (!activated) throw new Error("Failed to activate the rewound session.");
              await rememberActiveSession(activated);
              return derived;
            },
          });
          // 留痕：切换完成后再追加，用 runtime 持有的 live store —— 内存态与文件同步，
          // undoable 查询（runtime.current.lastRewind）立刻可见，无需重进页面
          const entrySession = runtime.current;
          if (!entrySession) throw new Error("Failed to activate the rewound session.");
          await entrySession.appendRewind({
            checkpointId: plan.checkpoint.id,
            mode: plan.mode,
            journal: result.rewindId,
            ...(result.derived ? { derivedSessionId: result.derived.id } : {}),
            sourceSessionId: source.id,
            fileCount: result.applied + result.deleted,
          });
          // 三种模式都广播：code 给主窗刷新审阅面板；both/conversation 让悬浮岛等
          // 订阅方清掉源会话尾流并重新拉快照（activeId 已切到派生会话）
          (target ?? runtime).emit({
            type: "files_rewound",
            sessionId: source.id,
            checkpointId: plan.checkpoint.id,
            restored: result.applied,
            deleted: result.deleted,
          });
          sendJson(response, 200, {
            rewindId: result.rewindId,
            applied: result.applied,
            deleted: result.deleted,
            ...(result.derived
              ? (() => {
                  const session = runtime.current;
                  return {
                    id: session?.id ?? result.derived.id,
                    filePath: session?.filePath ?? result.derived.filePath,
                    cwd: session?.cwd,
                    createdAt: session?.createdAt,
                    title: session?.title,
                  };
                })()
              : {}),
          });
        } catch (error) {
          sendRewindError(error);
        }
        return;
      }

      // 当前会话最近一次可撤销的回滚
      if (pathname === "/session/rewind/undoable" && request.method === "GET") {
        const session = runtime.current;
        const store = session ? runtime.snapshotStoreOf(session) : null;
        if (!session || !store) {
          sendJson(response, 200, { undoable: null });
          return;
        }
        try {
          sendJson(response, 200, { undoable: await findUndoable(session, store) });
        } catch (error) {
          sendError(
            response,
            500,
            "rewind_failed",
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      }

      // 撤销回滚：把文件改回回滚前状态；both/conversation 模式可切回源会话（对话同步还原）
      if (pathname === "/session/rewind/undo" && request.method === "POST") {
        const body = await readJsonBody<{
          rewindId?: string;
          dryRun?: boolean;
          switchBack?: boolean;
          force?: boolean;
        }>(request);
        const session = runtime.current;
        if (!session) {
          sendError(response, 404, "no_session", "No active session.");
          return;
        }
        if (hasPendingWork(runtime)) {
          sendError(
            response,
            409,
            "session_busy",
            "该会话还在生成、排队或等待审批，停止后再撤销回滚。",
          );
          return;
        }
        const store = runtime.snapshotStoreOf(session);
        if (!store) {
          sendError(response, 400, "no_snapshot", "文件快照已关闭，无法撤销回滚。");
          return;
        }
        const sendUndoError = (error: unknown): void => {
          if (error instanceof RewindError) {
            const status = error.code === "needs_force" ? 409 : 400;
            sendError(response, status, error.code, error.message);
            return;
          }
          sendError(
            response,
            500,
            "undo_failed",
            error instanceof Error ? error.message : String(error),
          );
        };
        try {
          const { plan, journal } = await planUndo(
            session,
            store,
            typeof body.rewindId === "string" ? body.rewindId : undefined,
          );
          if (body.dryRun) {
            sendJson(response, 200, {
              plan,
              undoable: await findUndoable(session, store),
            });
            return;
          }
          const result = await applyUndo({ session, plan, journal, store, force: body.force === true });
          // journal 用完即删：撤销只允许一次（redo 不支持，源会话/派生会话留档兜底）
          await rm(store.journalFile(journal.rewindId), { force: true }).catch(() => undefined);
          // 悬浮岛等订阅方同步：撤销也是一次文件回写，源会话尾流作废
          runtime.emit({
            type: "files_rewound",
            sessionId: runtime.current?.id ?? journal.sourceSessionId,
            checkpointId: journal.checkpointId,
            restored: result.restored,
            deleted: result.deleted,
          });
          let switched: { id: string; filePath: string; title: string | null } | null = null;
          const sourceFile =
            journal.mode !== "code" && body.switchBack !== false
              ? resolveSessionFile(journal.sourceFilePath)
              : null;
          if (sourceFile) {
            const next = createFreshRuntime();
            await next.switchSession(sourceFile);
            demoteActiveRuntime();
            runtime = next;
            pruneBackgroundRuntimes(runtime.current?.id);
            const activated = runtime.current;
            if (activated) {
              await rememberActiveSession(activated);
              switched = {
                id: activated.id,
                filePath: activated.filePath,
                title: activated.title,
              };
            }
          }
          sendJson(response, 200, { ...result, ...(switched ? { switched } : {}) });
        } catch (error) {
          sendUndoError(error);
        }
        return;
      }

      // 会话导出：markdown / html 直接回文本，json 回结构化文档。
      // 主进程负责选路径与写盘（渲染层没有 fs），这里只产内容。
      if (pathname === "/session/export" && request.method === "POST") {
        const body = await readJsonBody<{
          filePath?: string;
          format?: "markdown" | "html" | "json";
          includeThinking?: boolean;
          includeTools?: boolean;
          inlineImages?: boolean;
          maxToolOutput?: number;
        }>(request);
        const filePath = resolveSessionFile(body.filePath);
        if (!filePath) {
          sendError(response, 400, "invalid_request", "filePath must be a session file.");
          return;
        }
        const format = body.format === "json" ? "json" : body.format === "html" ? "html" : "markdown";
        try {
          // 正在运行的会话先把待写队列刷盘，否则会漏掉最后几条
          const live = findRuntimeForSessionFile(filePath);
          if (live) await live.flush().catch(() => undefined);
          const store = await SessionStore.load(filePath);
          let payload: string;
          try {
            const doc = buildExportDoc(store.entries, {
              includeThinking: body.includeThinking !== false,
              includeTools: body.includeTools !== false,
            });
            const options = {
              sourcePath: filePath,
              inlineImages: body.inlineImages !== false,
              ...(typeof body.maxToolOutput === "number"
                ? { maxToolOutput: Math.max(0, body.maxToolOutput) }
                : {}),
            };
            payload =
              format === "json"
                ? renderJson(doc)
                : format === "html"
                  ? renderHtml(doc, options)
                  : renderMarkdown(doc, options);
          } finally {
            await store.close().catch(() => undefined);
          }
          const contentType =
            format === "json"
              ? "application/json; charset=utf-8"
              : format === "html"
                ? "text/html; charset=utf-8"
                : "text/markdown; charset=utf-8";
          response.writeHead(200, {
            "content-type": contentType,
            "content-length": Buffer.byteLength(payload),
            "cache-control": "no-store",
          });
          response.end(payload);
        } catch (error) {
          sendError(
            response,
            404,
            "export_failed",
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      }

      // 子 Agent 只读转录：只认当前父会话目录下的子会话；不恢复、不写文件。
      const subagentMatch = pathname.match(/^\/session\/subagents\/([^/]+)\/messages$/);
      if (subagentMatch && request.method === "GET") {
        const agentId = subagentMatch[1];
        const parent = runtime.current;
        if (!parent) {
          sendError(response, 404, "no_session", "No active session.");
          return;
        }
        if (!SUBAGENT_ID_PATTERN.test(agentId) || !SUBAGENT_ID_PATTERN.test(parent.id)) {
          sendError(response, 400, "invalid_request", "agentId must be a subagent session id.");
          return;
        }
        const parentDir = path.join(sessionsDir, "subagents", parent.id);
        const filePath = path.join(parentDir, `${agentId}.jsonl`);
        const relative = path.relative(path.resolve(parentDir), path.resolve(filePath));
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
          sendError(response, 400, "invalid_request", "Invalid subagent path.");
          return;
        }
        let store: SessionStore;
        try {
          store = await SessionStore.load(filePath);
        } catch {
          sendError(response, 404, "subagent_not_found", "Subagent transcript not found.");
          return;
        }
        const header = store.entries[0];
        if (
          !header ||
          header.type !== "session" ||
          header.agentKind !== "subagent" ||
          header.parentSessionId !== parent.id ||
          header.id !== agentId
        ) {
          sendError(response, 404, "subagent_not_found", "Subagent transcript not found.");
          return;
        }
        const live = runtime.liveSubagentIds.includes(agentId);
        const status: SubagentStatus = live
          ? "running"
          : store.openTurn
            ? "interrupted"
            : subagentStatusFromTurn(store.lastTurnEnd?.status);
        const transcriptUsage = store.usageTotals;
        sendJson(response, 200, {
          agentId,
          parentSessionId: parent.id,
          callId: header.parentCallId ?? "",
          description: header.description ?? store.title ?? "子 Agent",
          agentType: header.agentType ?? "general",
          title: store.title,
          status,
          createdAt: store.createdAt,
          messages: store.messages,
          compaction: store.lastCompaction,
          compactions: store.compactionPoints,
          usage: transcriptUsage.hasUsage ? transcriptUsage : null,
          lastTurn: store.lastTurnEnd
            ? {
                status: store.lastTurnEnd.status,
                ...(store.lastTurnEnd.error ? { error: store.lastTurnEnd.error } : {}),
              }
            : null,
          openTurn: Boolean(store.openTurn),
        });
        return;
      }

      const subagentAbortMatch = pathname.match(/^\/session\/subagents\/([^/]+)\/abort$/);
      if (subagentAbortMatch && request.method === "POST") {
        const agentId = subagentAbortMatch[1];
        const parent = runtime.current;
        if (!parent || !SUBAGENT_ID_PATTERN.test(agentId)) {
          sendError(response, 400, "invalid_request", "agentId must be a subagent session id.");
          return;
        }
        if (!runtime.abortSubagent(agentId)) {
          sendError(response, 409, "not_running", "Subagent is not running.");
          return;
        }
        sendJson(response, 200, { success: true });
        return;
      }

      const subagentPromptMatch = pathname.match(/^\/session\/subagents\/([^/]+)\/prompt$/);
      if (subagentPromptMatch && request.method === "POST") {
        const agentId = subagentPromptMatch[1];
        const parent = runtime.current;
        if (!parent || !SUBAGENT_ID_PATTERN.test(agentId)) {
          sendError(response, 400, "invalid_request", "agentId must be a subagent session id.");
          return;
        }
        const body = await readJsonBody<{ message?: string }>(request);
        const message = typeof body.message === "string" ? body.message.trim() : "";
        if (!message) {
          sendError(response, 400, "invalid_request", "message must not be empty.");
          return;
        }
        try {
          await runtime.continueSubagent(agentId, message);
          sendJson(response, 200, { started: true });
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          const status = /still running/i.test(text)
            ? 409
            : /not found|Invalid subagent/i.test(text)
              ? 404
              : 400;
          sendError(response, status, "subagent_prompt_failed", text);
        }
        return;
      }

      const subagentSteerMatch = pathname.match(/^\/session\/subagents\/([^/]+)\/steer$/);
      if (subagentSteerMatch && request.method === "POST") {
        const agentId = subagentSteerMatch[1];
        const parent = runtime.current;
        if (!parent || !SUBAGENT_ID_PATTERN.test(agentId)) {
          sendError(response, 400, "invalid_request", "agentId must be a subagent session id.");
          return;
        }
        const body = await readJsonBody<{ message?: string }>(request);
        const message = typeof body.message === "string" ? body.message.trim() : "";
        if (!message) {
          sendError(response, 400, "invalid_request", "message must not be empty.");
          return;
        }
        try {
          runtime.steerSubagent(agentId, message);
          sendJson(response, 200, { mode: "queued" });
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          const status = /not found/i.test(text)
            ? 404
            : /not running|pending steers|too long/i.test(text)
              ? 409
              : 400;
          sendError(response, status, "subagent_steer_failed", text);
        }
        return;
      }

      if (pathname === "/session/new" && request.method === "POST") {
        const body = await readJsonBody<{
          cwd?: string;
          worktree?: boolean;
          worktreeSettings?: {
            fetchUpstream?: boolean;
            autoCleanup?: boolean;
            maxKeep?: number;
          };
        }>(request);
        const sourceCwd = path.resolve(
          body.cwd ?? runtime.current?.cwd ?? workspace ?? process.cwd(),
        );
        let created: CreatedSessionWorktree | null = null;
        if (body.worktree === true) {
          const worktreeSettings = body.worktreeSettings ?? {};
          if (worktreeSettings.autoCleanup === true) {
            try {
              const sessions = await runtime.listSessions();
              const referencedPaths = new Set(
                sessions.flatMap((session) =>
                  session.worktree ? [session.worktree.path] : [],
                ),
              );
              const requestedMaxKeep =
                typeof worktreeSettings.maxKeep === "number" &&
                Number.isFinite(worktreeSettings.maxKeep)
                  ? worktreeSettings.maxKeep
                  : 15;
              const cleanup = await pruneSessionWorktrees({
                worktreesDir,
                maxKeep: Math.max(1, Math.min(100, Math.floor(requestedMaxKeep))),
                referencedPaths,
              });
              if (cleanup.removed || cleanup.failed) {
                console.error(
                  `[worktree] cleanup removed=${cleanup.removed} skippedDirty=${cleanup.skippedDirty} skippedReferenced=${cleanup.skippedReferenced} failed=${cleanup.failed}`,
                );
              }
            } catch (error) {
              console.error(
                `[worktree] cleanup skipped: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }
          try {
            created = await createSessionWorktree(sourceCwd, worktreesDir, {
              fetchUpstream: worktreeSettings.fetchUpstream === true,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const detail = error instanceof GitError ? error.detail : undefined;
            sendError(
              response,
              400,
              "worktree_failed",
              detail && detail !== message ? `${message}\n${detail}` : message,
            );
            return;
          }
        }
        const next = createFreshRuntime();
        let session;
        try {
          session = await next.newSession(
            created?.cwd ?? sourceCwd,
            created ? { worktree: created.worktree } : {},
          );
        } catch (error) {
          if (created) await removeSessionWorktree(created.worktree).catch(() => undefined);
          throw error;
        }
        demoteActiveRuntime();
        runtime = next;
        pruneBackgroundRuntimes(session.id);
        await rememberActiveSession(runtime.current);
        sendJson(response, 200, {
          ...session,
          ...(created?.dirty ? { worktreeDirty: true } : {}),
        });
        return;
      }

      if (pathname === "/session/switch" && request.method === "POST") {
        const body = await readJsonBody<{ filePath?: string }>(request);
        const filePath = resolveSessionFile(body.filePath);
        if (!filePath) {
          sendError(response, 400, "invalid_request", "filePath must be a session file.");
          return;
        }
        const session = await activateSession(filePath);
        await rememberActiveSession(session);
        sendJson(response, 200, {
          id: session.id,
          cwd: session.cwd,
          worktree: session.worktree ?? null,
          filePath: session.filePath,
          messages: session.messages,
        });
        return;
      }

      if (pathname === "/session/prompt" && request.method === "POST") {
        const body = await readJsonBody<{
          message: string;
          queueId?: string;
          sessionId?: string;
          images?: unknown;
          documents?: unknown;
        }>(request);
        const parsedImages = await parsePromptAttachments(body.images, body.documents);
        if (!parsedImages.ok) {
          sendError(response, 400, "invalid_request", parsedImages.error);
          return;
        }
        // 只发附件不写字是合法的（截图/拖 PDF 后直接回车），但两者都没有就不行
        if (
          !body.message?.trim() &&
          !parsedImages.images.length &&
          !parsedImages.documents.length
        ) {
          sendError(response, 400, "invalid_request", "message must be a non-empty string");
          return;
        }
        if (invalidSessionId(body.sessionId)) {
          sendError(response, 400, "invalid_request", "sessionId must be a non-empty string");
          return;
        }
        const target = resolveRuntime(body.sessionId?.trim());
        if (!target) {
          sendError(response, 404, "session_not_found", "That session is not running.");
          return;
        }
        if (!target.current) {
          sendError(response, 409, "no_session", "No active session. Create a session first.");
          return;
        }
        if (
          body.queueId !== undefined &&
          (typeof body.queueId !== "string" || !body.queueId.trim() || body.queueId.length > 100)
        ) {
          sendError(response, 400, "invalid_request", "queueId must be a non-empty string");
          return;
        }
        if (target.isCompacting) {
          sendError(response, 409, "compaction_running", "正在压缩对话历史，完成后再发送。");
          return;
        }
        // 模型没开识图时直接拒绝：否则图片会被静默丢掉，用户以为模型"看不见"
        if (parsedImages.images.length && !target.acceptsImages) {
          sendError(
            response,
            400,
            "vision_disabled",
            "当前模型未开启识图。请在设置 → 模型里勾选「图片」输入模态后再发送图片。",
          );
          return;
        }
        // PDF 同理：没开 pdf 模态（或协议承载不了文档块）时明确拒绝，而不是抽完文本白花钱
        if (parsedImages.documents.length && !target.acceptsPdf) {
          sendError(
            response,
            400,
            "pdf_disabled",
            "当前模型未开启 PDF 输入。请在设置 → 模型里勾选「PDF」输入模态（需要 Anthropic Messages 或 OpenAI Responses 协议）。",
          );
          return;
        }
        // 每个会话独立 runtime：别的会话在跑不影响这里；同一会话运行中会自动排队
        // 斜杠命令（markdown 声明式 / 插件代码式）：命中则展开为 prompt 文本，未命中原样透传。
        // 插件命令 chip 的标记首行保留给前端渲染卡片，命令本体在空行之后。
        let promptText = body.message ?? "";
        const pluginCommand = splitPluginCommandPrompt(promptText);
        const commandLine = pluginCommand?.commandText ?? promptText;
        if (commandLine.trimStart().startsWith("/")) {
          try {
            const expanded = await commandIndex.resolve(commandLine);
            if (expanded !== null) {
              promptText = pluginCommand ? `${pluginCommand.header}\n\n${expanded}` : expanded;
            }
          } catch (error) {
            // 命令展开失败按原文发送，不让插件问题打断用户输入
            console.error("[plugins] command expansion failed:", error);
          }
        }
        if (promptText.length > MAX_PROMPT_TEXT_CHARS) {
          sendError(
            response,
            413,
            "prompt_too_large",
            `消息过长（${promptText.length.toLocaleString()} 字符，最多 ${MAX_PROMPT_TEXT_CHARS.toLocaleString()}）。请把大段内容放进文件后让模型读取。`,
          );
          return;
        }
        const tooLarge = target.promptTooLarge(
          promptText,
          parsedImages.images,
          parsedImages.documents,
        );
        if (tooLarge) {
          sendError(response, 413, "prompt_too_large", tooLarge.message);
          return;
        }
        void target
          .prompt(
            promptText,
            body.queueId?.trim(),
            parsedImages.images,
            parsedImages.documents,
          )
          .catch(() => undefined);
        sendJson(response, 202, { accepted: true });
        return;
      }

      // 写信页 AI 写：不属于任何会话，直接复用当前激活的模型服务商。
      if (pathname === "/mail/compose" && request.method === "POST") {
        type MailComposeBody = {
          mode?: unknown;
          instruction?: unknown;
          to?: unknown;
          subject?: unknown;
          original?: unknown;
          draft?: unknown;
          from?: unknown;
          providerId?: unknown;
        };
        const body = await readJsonBody<MailComposeBody>(request).catch(
          () => ({}) as MailComposeBody,
        );
        const fromRaw =
          body.from && typeof body.from === "object" ? (body.from as Record<string, unknown>) : {};
        const context: MailComposeContext = {
          mode: body.mode === "reply" || body.mode === "forward" ? body.mode : "new",
          instruction: typeof body.instruction === "string" ? body.instruction : "",
          to: typeof body.to === "string" ? body.to : "",
          subject: typeof body.subject === "string" ? body.subject : "",
          original: typeof body.original === "string" ? body.original : "",
          draft: typeof body.draft === "string" ? body.draft : "",
          from: {
            name: typeof fromRaw.name === "string" ? fromRaw.name : "",
            email: typeof fromRaw.email === "string" ? fromRaw.email : "",
          },
        };
        if (
          !(context.instruction ?? "").trim() &&
          !(context.subject ?? "").trim() &&
          !(context.original ?? "").trim() &&
          !(context.draft ?? "").trim()
        ) {
          sendError(response, 400, "empty_context", "请先填写主题、写作要求或正文，再使用 AI 写作。");
          return;
        }
        const requestedProviderId =
          typeof body.providerId === "string" ? body.providerId.trim() : "";
        const requestedProvider = requestedProviderId
          ? runtime.providersConfig.find(
              (item) => item.id === requestedProviderId && item.enabled !== false,
            )
          : undefined;
        const provider =
          requestedProvider ??
          runtime.providersConfig.find((item) => item.id === runtime.activeProviderId) ??
          runtime.providersConfig[0];
        if (!provider) {
          sendError(response, 400, "no_provider", "请先在设置中配置模型服务商。");
          return;
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60_000);
        try {
          const text = await composeMail({ provider, context, signal: controller.signal });
          sendJson(response, 200, { text });
        } catch (error) {
          const aborted = controller.signal.aborted;
          sendError(
            response,
            aborted ? 504 : 502,
            aborted ? "timeout" : "provider_error",
            aborted
              ? "AI 写作超时（60 秒），请重试。"
              : error instanceof Error
                ? error.message
                : String(error),
          );
        } finally {
          clearTimeout(timeout);
        }
        return;
      }

      // 输入建议：回合结束后由客户端触发，复用当前会话前缀预测下一句
      if (pathname === "/session/suggestion" && request.method === "POST") {
        const body = await readJsonBody<{ sessionId?: string }>(request);
        if (invalidSessionId(body.sessionId) || !body.sessionId?.trim()) {
          sendError(response, 400, "invalid_request", "sessionId must be a non-empty string");
          return;
        }
        const target = resolveRuntime(body.sessionId.trim());
        if (!target?.current) {
          sendError(response, 404, "session_not_found", "That session is not running.");
          return;
        }
        const suggestion = await target.suggestNextPrompt();
        sendJson(response, 200, { suggestion });
        return;
      }

      if (pathname === "/session/queue/remove" && request.method === "POST") {
        const body = await readJsonBody<{ id?: string; sessionId?: string }>(request);
        if (typeof body.id !== "string" || !body.id.trim()) {
          sendError(response, 400, "invalid_request", "id must be a non-empty string");
          return;
        }
        if (invalidSessionId(body.sessionId)) {
          sendError(response, 400, "invalid_request", "sessionId must be a non-empty string");
          return;
        }
        const target = resolveRuntime(body.sessionId?.trim());
        if (!target) {
          sendError(response, 404, "session_not_found", "That session is not running.");
          return;
        }
        if (!target.removeQueuedPrompt(body.id)) {
          sendError(response, 404, "not_queued", "Queued prompt not found.");
          return;
        }
        sendJson(response, 200, { removed: true });
        return;
      }

      // 拖动排序：把排队项移到锚点之前（beforeId 为 null 表示队尾）
      if (pathname === "/session/queue/reorder" && request.method === "POST") {
        const body = await readJsonBody<{
          id?: string;
          beforeId?: string | null;
          sessionId?: string;
        }>(request);
        if (typeof body.id !== "string" || !body.id.trim()) {
          sendError(response, 400, "invalid_request", "id must be a non-empty string");
          return;
        }
        if (
          body.beforeId !== undefined &&
          body.beforeId !== null &&
          (typeof body.beforeId !== "string" || !body.beforeId.trim())
        ) {
          sendError(response, 400, "invalid_request", "beforeId must be a string or null");
          return;
        }
        if (invalidSessionId(body.sessionId)) {
          sendError(response, 400, "invalid_request", "sessionId must be a non-empty string");
          return;
        }
        const target = resolveRuntime(body.sessionId?.trim());
        if (!target) {
          sendError(response, 404, "session_not_found", "That session is not running.");
          return;
        }
        if (!target.reorderQueuedPrompt(body.id, body.beforeId ?? null)) {
          sendError(response, 404, "not_queued", "Queued prompt not found.");
          return;
        }
        sendJson(response, 200, { reordered: true, queuedPrompts: target.queuedPrompts });
        return;
      }

      // 编辑排队项正文：原位替换，不产生新队列项
      if (pathname === "/session/queue/edit" && request.method === "POST") {
        const body = await readJsonBody<{ id?: string; message?: string; sessionId?: string }>(
          request,
        );
        if (typeof body.id !== "string" || !body.id.trim()) {
          sendError(response, 400, "invalid_request", "id must be a non-empty string");
          return;
        }
        if (typeof body.message !== "string" || !body.message.trim()) {
          sendError(response, 400, "invalid_request", "message must be a non-empty string");
          return;
        }
        if (invalidSessionId(body.sessionId)) {
          sendError(response, 400, "invalid_request", "sessionId must be a non-empty string");
          return;
        }
        const target = resolveRuntime(body.sessionId?.trim());
        if (!target) {
          sendError(response, 404, "session_not_found", "That session is not running.");
          return;
        }
        if (!target.editQueuedPrompt(body.id, body.message)) {
          sendError(response, 404, "not_queued", "Queued prompt not found.");
          return;
        }
        sendJson(response, 200, { edited: true, queuedPrompts: target.queuedPrompts });
        return;
      }
      // 丢弃重启后恢复出来的待发送消息
      if (pathname === "/session/recovered/discard" && request.method === "POST") {
        const body = await readJsonBody<{ id?: string }>(request);
        if (typeof body.id !== "string" || !body.id.trim()) {
          sendError(response, 400, "invalid_request", "id must be a non-empty string");
          return;
        }
        const discarded = await runtime.discardRecoveredPrompt(body.id);
        if (!discarded) {
          sendError(response, 404, "not_recovered", "Recovered prompt not found.");
          return;
        }
        sendJson(response, 200, { discarded: true });
        return;
      }

      if (pathname === "/session/steer" && request.method === "POST") {
        const body = await readJsonBody<{ id?: string; sessionId?: string }>(request);
        if (typeof body.id !== "string" || !body.id.trim()) {
          sendError(response, 400, "invalid_request", "id must be a non-empty string");
          return;
        }
        if (invalidSessionId(body.sessionId)) {
          sendError(response, 400, "invalid_request", "sessionId must be a non-empty string");
          return;
        }
        const target = resolveRuntime(body.sessionId?.trim());
        if (!target) {
          sendError(response, 404, "session_not_found", "That session is not running.");
          return;
        }
        try {
          target.steerQueuedPrompt(body.id);
          sendJson(response, 200, { ok: true });
        } catch (error) {
          sendError(
            response,
            409,
            "not_steerable",
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      }

      if (pathname === "/session/abort" && request.method === "POST") {
        const body = await readJsonBody<{ sessionId?: string }>(request);
        if (invalidSessionId(body.sessionId)) {
          sendError(response, 400, "invalid_request", "sessionId must be a non-empty string");
          return;
        }
        const target = resolveRuntime(body.sessionId?.trim());
        if (!target) {
          sendError(response, 404, "session_not_found", "That session is not running.");
          return;
        }
        target.abort();
        sendJson(response, 200, { success: true });
        return;
      }

      // ask_user 问题回答：resolve 挂起的虚拟工具，答案（按题序对齐）作为工具结果返回给模型
      if (pathname === "/session/answer" && request.method === "POST") {
        const body = await readJsonBody<{ callId?: string; answers?: unknown; answer?: string }>(request);
        if (typeof body.callId !== "string" || !body.callId.trim()) {
          sendError(response, 400, "invalid_request", "callId is required");
          return;
        }
        const answers = Array.isArray(body.answers)
          ? body.answers.map((item) => answerText(item))
          : [answerText(body.answer)];
        let handled = false;
        for (const instance of [runtime, ...backgroundRuntimes.values()]) {
          if (instance.respondToAsk(body.callId, answers)) {
            handled = true;
            break;
          }
        }
        sendJson(response, 200, { success: true, handled });
        return;
      }

      if (pathname === "/approval/response" && request.method === "POST") {
        const body = await readJsonBody<{
          callId: string;
          approved: boolean;
          feedback?: string;
          remember?: string;
        }>(request);
        const remember =
          body.remember === "tool" ||
          body.remember === "path" ||
          body.remember === "command-exact" ||
          body.remember === "command-prefix"
            ? body.remember
            : undefined;
        const decision: ApprovalDecision = {
          approved: Boolean(body.approved),
          ...(typeof body.feedback === "string" && body.feedback.trim()
            ? { feedback: body.feedback }
            : {}),
          ...(remember ? { remember } : {}),
        };
        // 审批可能属于后台会话，也可能属于某个子 Agent；按 callId 让各 runtime 级联查找。
        let handled = false;
        for (const instance of [runtime, ...backgroundRuntimes.values()]) {
          if (instance.respondToApproval(body.callId, decision)) {
            handled = true;
            break;
          }
        }
        sendJson(response, 200, { success: true, handled });
        return;
      }

      // 项目级审批规则：只允许当前/后台会话已知的工作区，避免任意路径读写
      if (pathname === "/approval-rules") {
        const known = [...new Set(
          [runtime, ...backgroundRuntimes.values()]
            .map((instance) => instance.current?.cwd)
            .filter((cwd): cwd is string => Boolean(cwd)),
        )];
        const requested = url.searchParams.get("workspace");
        const workspace = requested && known.includes(requested) ? requested : known[0];
        if (request.method === "GET") {
          if (!workspace) {
            sendJson(response, 200, { workspace: null, rules: [] });
            return;
          }
          sendJson(response, 200, { workspace, rules: await readApprovalRules(workspace) });
          return;
        }
        if (request.method === "DELETE") {
          if (!workspace) {
            sendError(response, 400, "no_workspace", "No workspace is open.");
            return;
          }
          if (url.searchParams.get("all") === "1") {
            const cleared = await clearApprovalRules(workspace);
            sendJson(response, 200, { workspace, cleared });
            return;
          }
          const id = url.searchParams.get("id");
          if (!id) {
            sendError(response, 400, "invalid_id", "Rule id is required.");
            return;
          }
          const removed = await removeApprovalRule(workspace, id);
          sendJson(response, 200, { workspace, removed });
          return;
        }
      }

      // 工具审批模式：read-only = 只读；ask = 每次询问；auto = 可写根内自动；full = 完全访问（自动放行）
      if (pathname === "/session/permissions" && request.method === "PUT") {
        const body = await readJsonBody<{ mode?: string }>(request);
        if (!isApprovalMode(body.mode)) {
          sendError(
            response,
            400,
            "invalid_request",
            `mode must be "read-only", "ask", "auto", or "full", got ${body.mode}`,
          );
          return;
        }
        await runtime.setApprovalMode(body.mode);
        sendJson(response, 200, { mode: runtime.currentApprovalMode });
        return;
      }

      if (pathname === "/session/permissions" && request.method === "GET") {
        sendJson(response, 200, { mode: runtime.currentApprovalMode });
        return;
      }

      // 内置角色注册表（架构图右侧面板只读展示：工具、系统提示词、门禁绑定）
      if (pathname === "/agent-definitions" && request.method === "GET") {
        const definitions = AGENT_ROLE_NAMES.map((name) => {
          const definition = BUILTIN_AGENTS[name];
          return {
            name,
            description: definition.description,
            tools: definition.tools ? [...definition.tools].sort() : null,
            readOnly: definition.readOnly === true,
            expectedGates: definition.expectedGates ?? [],
            injectInstructions: definition.injectInstructions !== false,
            systemPrompt: definition.systemPrompt,
          };
        });
        // 主 Agent 档位（标准/极简/复杂）：架构页菜单与聊天框切换器的数据源
        const profiles = AGENT_PROFILE_IDS.map((id) => {
          const profile = AGENT_PROFILES[id];
          return {
            id,
            name: profile.name,
            tagline: profile.tagline,
            description: profile.description,
            roles: [...profile.roles],
            tools: profile.tools ? [...profile.tools].sort() : null,
            maxSubagents: profile.maxSubagents,
            prompt: profile.prompt,
          };
        });
        sendJson(response, 200, {
          definitions,
          profiles,
          tools: toolDefinitions.map((definition) => definition.function.name),
        });
        return;
      }

      // 可编辑架构图（metis 式 harness 文档）：每个主 Agent 档位一张独立图
      // （.meowcode/harness/<profile>.json；缺省回该档位的内置种子）。
      // workspace 缺省取当前会话目录；保存后空闲的治理 run 在下一次 admit 前装载新图。
      if (pathname === "/harness" && request.method === "GET") {
        const workspace = (url.searchParams.get("workspace") ?? "").trim() || runtime.current?.cwd;
        if (!workspace) {
          sendError(response, 404, "no_session", "No active session; pass ?workspace=.");
          return;
        }
        const rawProfile = url.searchParams.get("profile");
        if (rawProfile !== null && !isHarnessArchitectureId(rawProfile)) {
          sendError(
            response,
            400,
            "invalid_request",
            `profile must be a builtin tier or an architecture id, got ${rawProfile}`,
          );
          return;
        }
        const profile = rawProfile ?? runtime.currentAgentProfile;
        // seed=1：返回内置种子（编辑器「重置为内置架构」，不读磁盘）；自定义架构回标准种子
        const document =
          url.searchParams.get("seed") === "1"
            ? builtinHarnessSeed(isBuiltinHarnessId(profile) ? profile : "standard")
            : await loadHarnessDocument(workspace, profile);
        // 主 Agent 节点没写提示词时，编辑器用这份档位默认值预填，方便直接在它上面改
        const rootAgent = document.nodes.find((node) => node.type === "agent");
        const override = (rootAgent?.data as { systemPrompt?: unknown } | undefined)?.systemPrompt;
        const baseProfile = isBuiltinHarnessId(profile) ? profile : runtime.currentAgentProfile;
        const agentPrompt =
          (typeof override === "string" && override.trim()) || AGENT_PROFILES[baseProfile].prompt;
        sendJson(response, 200, { workspace, profile, document, agentPrompt });
        return;
      }
      if (pathname === "/harness" && request.method === "PUT") {
        const body = await readJsonBody<{
          workspace?: string;
          profile?: string;
          document?: unknown;
        }>(request);
        const workspace = (body.workspace ?? "").trim() || runtime.current?.cwd;
        if (!workspace) {
          sendError(response, 400, "invalid_request", "workspace or an active session is required.");
          return;
        }
        if (body.profile !== undefined && !isHarnessArchitectureId(body.profile)) {
          sendError(
            response,
            400,
            "invalid_request",
            `profile must be a builtin tier or an architecture id, got ${body.profile}`,
          );
          return;
        }
        const profile = body.profile ?? runtime.currentAgentProfile;
        if (!body.document || typeof body.document !== "object") {
          sendError(response, 400, "invalid_request", "document must be a harness JSON object.");
          return;
        }
        const saved = await saveHarnessDocument(workspace, body.document, profile);
        if (!saved.valid) {
          sendError(response, 400, "invalid_harness", saved.errors.join("\n"));
          return;
        }
        // 只有保存的是当前档位的图才需要重载；notice=true：下一回合追加 in-history 提醒
        if (profile === runtime.currentAgentProfile) runtime.refreshHarness(true);
        sendJson(response, 200, { workspace, profile, saved: true });
        return;
      }

      // 架构图列表（左栏「主 Agent」）：内置三档 + 工作区里的自定义架构
      if (pathname === "/harness/list" && request.method === "GET") {
        const workspace = (url.searchParams.get("workspace") ?? "").trim() || runtime.current?.cwd;
        if (!workspace) {
          sendError(response, 404, "no_session", "No active session; pass ?workspace=.");
          return;
        }
        sendJson(response, 200, { workspace, architectures: await listHarnessArchitectures(workspace) });
        return;
      }

      // 新建架构图：默认复制标准 Agent 的图，命名「自定义 Agent」（可后续改名）
      if (pathname === "/harness/create" && request.method === "POST") {
        const body = await readJsonBody<{
          workspace?: string;
          name?: string;
          cloneFrom?: string;
        }>(request);
        const workspace = (body.workspace ?? "").trim() || runtime.current?.cwd;
        if (!workspace) {
          sendError(response, 400, "invalid_request", "workspace or an active session is required.");
          return;
        }
        if (body.cloneFrom !== undefined && !isHarnessArchitectureId(body.cloneFrom)) {
          sendError(response, 400, "invalid_request", `invalid cloneFrom: ${body.cloneFrom}`);
          return;
        }
        const created = await createHarnessArchitecture(workspace, {
          name: body.name,
          cloneFrom: body.cloneFrom,
        });
        sendJson(response, 201, {
          workspace,
          id: created.id,
          name: created.name,
          document: created.document,
        });
        return;
      }

      // 给自定义架构改名
      if (pathname === "/harness/rename" && request.method === "POST") {
        const body = await readJsonBody<{ workspace?: string; id?: string; name?: string }>(request);
        const workspace = (body.workspace ?? "").trim() || runtime.current?.cwd;
        if (!workspace) {
          sendError(response, 400, "invalid_request", "workspace or an active session is required.");
          return;
        }
        if (!body.id || !isHarnessArchitectureId(body.id)) {
          sendError(response, 400, "invalid_request", `invalid id: ${String(body.id)}`);
          return;
        }
        if (isBuiltinHarnessId(body.id)) {
          sendError(response, 400, "invalid_request", "builtin architectures cannot be renamed.");
          return;
        }
        const ok = await renameHarnessArchitecture(workspace, body.id, body.name ?? "");
        if (!ok) {
          sendError(response, 404, "not_found", `architecture ${body.id} not found.`);
          return;
        }
        sendJson(response, 200, { workspace, id: body.id, renamed: true });
        return;
      }

      // 删除自定义架构（内置三档受保护）
      if (pathname === "/harness/architecture" && request.method === "DELETE") {
        const workspace = (url.searchParams.get("workspace") ?? "").trim() || runtime.current?.cwd;
        const id = url.searchParams.get("id") ?? "";
        if (!workspace) {
          sendError(response, 400, "invalid_request", "workspace or an active session is required.");
          return;
        }
        if (!isHarnessArchitectureId(id) || isBuiltinHarnessId(id)) {
          sendError(response, 400, "invalid_request", `cannot delete architecture ${id}`);
          return;
        }
        const ok = await deleteHarnessArchitecture(workspace, id);
        if (!ok) {
          sendError(response, 404, "not_found", `architecture ${id} not found.`);
          return;
        }
        sendJson(response, 200, { workspace, id, deleted: true });
        return;
      }

      // 会话模式：default = 现状；plan = 只写 plans/ 下计划文档；goal = 只注入目标推进指令
      if (pathname === "/session/mode" && request.method === "PUT") {
        const body = await readJsonBody<{ mode?: string }>(request);
        if (!isSessionMode(body.mode)) {
          sendError(
            response,
            400,
            "invalid_request",
            `mode must be "default", "plan", or "goal", got ${body.mode}`,
          );
          return;
        }
        await runtime.setSessionMode(body.mode);
        sendJson(response, 200, { mode: runtime.currentSessionMode });
        return;
      }

      // 主 Agent 档位：standard = 完整能力；minimal = 只有 read_file / run_command；complex = 编排强化
      if (pathname === "/session/agent-profile" && request.method === "PUT") {
        const body = await readJsonBody<{ profile?: string }>(request);
        if (!isAgentProfile(body.profile)) {
          sendError(
            response,
            400,
            "invalid_request",
            `profile must be "standard", "minimal", or "complex", got ${body.profile}`,
          );
          return;
        }
        await runtime.setAgentProfile(body.profile);
        sendJson(response, 200, { profile: runtime.currentAgentProfile });
        return;
      }

      // 会话切到自定义架构图（只换图，提示词/工具仍按档位）；id 传空 = 回到档位图
      if (pathname === "/session/architecture" && request.method === "PUT") {
        const body = await readJsonBody<{ id?: string | null }>(request);
        const rawId = typeof body.id === "string" ? body.id.trim() : "";
        if (rawId && !isHarnessArchitectureId(rawId)) {
          sendError(response, 400, "invalid_request", `invalid architecture id: ${rawId}`);
          return;
        }
        if (rawId && isBuiltinHarnessId(rawId)) {
          sendError(
            response,
            400,
            "invalid_request",
            "builtin tiers are selected via agent-profile, not architecture",
          );
          return;
        }
        await runtime.setHarnessArchitecture(rawId || null);
        sendJson(response, 200, { architecture: runtime.currentHarnessArchitecture });
        return;
      }

      // 插件/MCP 概览：设置页数据源
      if (pathname === "/plugins" && request.method === "GET") {
        sendJson(response, 200, {
          plugins: pluginSystem.descriptors(),
          errors: pluginSystem.errors(),
          mcp: pluginSystem.mcp.statuses(),
          mcpErrors: pluginSystem.mcpErrors(),
          commands: commandIndex.commands(),
        });
        return;
      }

      // 插件 UI 调 host：POST /plugins/<id>/rpc，method 必须由该插件 registerRpc 注册
      const pluginRpcMatch = /^\/plugins\/([^/]+)\/rpc$/.exec(pathname);
      if (pluginRpcMatch && request.method === "POST") {
        const pluginId = decodeURIComponent(pluginRpcMatch[1]);
        const descriptor = pluginSystem.descriptors().find((item) => item.id === pluginId);
        if (!descriptor || !descriptor.enabled) {
          sendError(response, 404, "not_found", "plugin not found");
          return;
        }
        if (descriptor.manifest && !descriptor.manifest.permissions.includes("rpc")) {
          sendError(response, 403, "forbidden", 'plugin did not declare the "rpc" permission');
          return;
        }
        const body = await readJsonBody<{ method?: unknown; args?: unknown; sessionId?: unknown }>(request);
        const method = typeof body.method === "string" ? body.method : "";
        if (!method) {
          sendError(response, 400, "invalid_request", "method is required");
          return;
        }
        const entry = pluginSystem.registry.getRpc(pluginId, method);
        if (!entry) {
          sendError(response, 404, "not_found", `rpc method "${method}" is not registered`);
          return;
        }
        try {
          const result = await entry.handler(body.args, {
            pluginId,
            workspace: pluginsWorkspace,
            ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
          });
          sendJson(response, 200, { ok: true, result });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[plugin:${pluginId}] rpc "${method}" failed:`, message);
          sendJson(response, 200, { ok: false, error: message });
        }
        return;
      }

      // 插件 UI 的命名空间 KV：GET ?key= / POST {key,value} / DELETE ?key=
      const pluginStorageMatch = /^\/plugins\/([^/]+)\/storage$/.exec(pathname);
      if (
        pluginStorageMatch &&
        (request.method === "GET" || request.method === "POST" || request.method === "DELETE")
      ) {
        const pluginId = decodeURIComponent(pluginStorageMatch[1]);
        const descriptor = pluginSystem.descriptors().find((item) => item.id === pluginId);
        if (!descriptor || !descriptor.enabled) {
          sendError(response, 404, "not_found", "plugin not found");
          return;
        }
        if (descriptor.manifest && !descriptor.manifest.permissions.includes("storage")) {
          sendError(response, 403, "forbidden", 'plugin did not declare the "storage" permission');
          return;
        }
        const storage = createPluginStorage(pluginId, homeDir);
        if (request.method === "GET") {
          const key = url.searchParams.get("key");
          if (!key) {
            sendError(response, 400, "invalid_request", "key is required");
            return;
          }
          sendJson(response, 200, { ok: true, value: await storage.get(key) });
          return;
        }
        if (request.method === "DELETE") {
          const key = url.searchParams.get("key");
          if (!key) {
            sendError(response, 400, "invalid_request", "key is required");
            return;
          }
          await storage.delete(key);
          sendJson(response, 200, { ok: true });
          return;
        }
        const body = await readJsonBody<{ key?: unknown; value?: unknown }>(request);
        if (typeof body.key !== "string" || !body.key) {
          sendError(response, 400, "invalid_request", "key is required");
          return;
        }
        await storage.set(body.key, body.value);
        sendJson(response, 200, { ok: true });
        return;
      }

      // 插件 UI 渲染/加载错误：只记录，不阻断（最近 20 条留给设置页排查）
      const pluginUiErrorMatch = /^\/plugins\/([^/]+)\/ui-error$/.exec(pathname);
      if (pluginUiErrorMatch && request.method === "POST") {
        const pluginId = decodeURIComponent(pluginUiErrorMatch[1]);
        const body = await readJsonBody<{ message?: unknown; slot?: unknown }>(request).catch(() => ({}) as {
          message?: unknown;
          slot?: unknown;
        });
        const message =
          typeof body.message === "string" && body.message ? body.message.slice(0, 2000) : "unknown ui error";
        const slot = typeof body.slot === "string" ? body.slot.slice(0, 200) : undefined;
        const list = pluginUiErrors.get(pluginId) ?? [];
        list.push({ message, at: new Date().toISOString(), ...(slot ? { slot } : {}) });
        if (list.length > 20) list.splice(0, list.length - 20);
        pluginUiErrors.set(pluginId, list);
        console.warn(`[plugin:${pluginId}] ui error${slot ? ` in ${slot}` : ""}:`, message);
        sendJson(response, 200, { ok: true });
        return;
      }

      // 插件自带的 UI 面板资源：`<pluginDir>/ui/**`。
      // 只能读已加载插件的 ui 目录，路径穿越一律拒绝；iframe 用 query token 访问。
      if (pathname.startsWith("/plugin-ui/")) {
        const rest = pathname.slice("/plugin-ui/".length);
        const slash = rest.indexOf("/");
        if (slash <= 0) {
          sendError(response, 400, "invalid_request", "expected /plugin-ui/<id>/<path>");
          return;
        }
        const pluginId = decodeURIComponent(rest.slice(0, slash));
        const relative = decodeURIComponent(rest.slice(slash + 1));
        const descriptor = pluginSystem.descriptors().find((item) => item.id === pluginId);
        if (!descriptor) {
          sendError(response, 404, "not_found", "plugin not found");
          return;
        }
        if (!descriptor.ui) {
          sendError(response, 404, "not_found", "plugin has no ui");
          return;
        }
        // descriptor.path 是入口文件；UI 面板固定在同级 ui/ 目录
        const uiDir = path.resolve(path.dirname(descriptor.path), "ui");
        const target = path.resolve(uiDir, relative);
        if (target !== uiDir && !target.startsWith(`${uiDir}${path.sep}`)) {
          sendError(response, 403, "forbidden", "path outside the plugin ui directory");
          return;
        }
        try {
          const stats = await stat(target);
          if (!stats.isFile()) {
            sendError(response, 404, "not_found", "not a file");
            return;
          }
          const buffer = await readFile(target);
          response.writeHead(200, {
            "content-type": mimeForFile(target),
            "content-length": buffer.byteLength,
            // 开发期改完 HTML 刷新即可生效
            "cache-control": "no-store",
          });
          response.end(buffer);
        } catch {
          sendError(response, 404, "not_found", "file not found");
        }
        return;
      }

      // Claude Code hooks 运行方式 / 工作区范围：只热更新 env（插件每次执行时读 env），
      // 不重启 server，运行中的回合不受影响
      if (pathname === "/config/hooks" && request.method === "POST") {
        const body = await readJsonBody<{ runMode?: unknown; includeWorkspace?: unknown }>(
          request,
        ).catch(() => ({}) as { runMode?: unknown; includeWorkspace?: unknown });
        if (body.runMode !== undefined) {
          if (body.runMode !== "auto" && body.runMode !== "ask") {
            sendError(response, 400, "invalid_request", "runMode must be auto or ask");
            return;
          }
          process.env.MEOWCODE_HOOKS_RUN_MODE = body.runMode;
        }
        if (body.includeWorkspace !== undefined) {
          if (typeof body.includeWorkspace !== "boolean") {
            sendError(response, 400, "invalid_request", "includeWorkspace must be a boolean");
            return;
          }
          process.env.MEOWCODE_CC_HOOKS_SCOPE = JSON.stringify({
            user: true,
            workspace: body.includeWorkspace,
          });
        }
        sendJson(response, 200, { ok: true });
        return;
      }

      // Claude Code hooks 配置摘要：设置页只读展示 + 打开编辑（不在 MeowCode 内写文件）
      if (pathname === "/hooks/config" && request.method === "GET") {
        const scope = parseHooksScope(process.env.MEOWCODE_CC_HOOKS_SCOPE);
        const runMode = parseRunMode(process.env.MEOWCODE_HOOKS_RUN_MODE);
        const hooksHome = process.env.MEOWCODE_CC_HOOKS_HOME || os.homedir();
        const config = await loadHooksConfig({
          homeDir: hooksHome,
          workspace: pluginsWorkspace,
          scope,
          runMode,
          fresh: true,
        });
        const summary = summarizeHooks(config);
        const descriptor = pluginSystem
          .descriptors()
          .find((plugin) => plugin.id === "claude-code-hooks");
        sendJson(response, 200, {
          enabled: descriptor?.enabled ?? false,
          ...(descriptor?.error ? { error: descriptor.error } : {}),
          ...summary,
        });
        return;
      }

      // 数据导入：探测其他应用数据 + 执行导入（只写 ~/.meowcode 与 sessions，不碰来源）
      if (pathname === "/import/sources" && request.method === "GET") {
        sendJson(response, 200, { sources: await detectImportSources(homeDir) });
        return;
      }
      if (pathname === "/import/plan" && request.method === "POST") {
        const body = await readJsonBody<{ appId?: unknown; groups?: unknown }>(request);
        const parsed = parseImportRequest(body);
        if (!parsed) {
          sendError(response, 400, "invalid_request", "appId must be qoder / qoderintl / workbuddy / workbuddyai / zcode / opencode / dsh / codex");
          return;
        }
        if (parsed.groups.length === 0) {
          sendError(response, 400, "invalid_request", "groups must contain mcp / memory / skills / tasks");
          return;
        }
        const items = await planImport(homeDir, sessionsDir, parsed.appId, parsed.groups);
        sendJson(response, 200, {
          items: items.map(({ group, name, key }) => ({ group, name, ...(key ? { key } : {}) })),
        });
        return;
      }
      if (pathname === "/import/apply-one" && request.method === "POST") {
        const body = await readJsonBody<{ appId?: unknown; group?: unknown; name?: unknown; key?: unknown }>(
          request,
        );
        const appId = body.appId;
        if (appId !== "qoder" && appId !== "qoderintl" && appId !== "workbuddy" && appId !== "workbuddyai" && appId !== "zcode" && appId !== "opencode" && appId !== "dsh" && appId !== "codex") {
          sendError(response, 400, "invalid_request", "appId must be qoder / qoderintl / workbuddy / workbuddyai / zcode / opencode / dsh / codex");
          return;
        }
        const groupId = body.group;
        if (groupId !== "mcp" && groupId !== "memory" && groupId !== "skills" && groupId !== "tasks") {
          sendError(response, 400, "invalid_request", "group must be mcp / memory / skills / tasks");
          return;
        }
        if (typeof body.name !== "string" || body.name.length === 0) {
          sendError(response, 400, "invalid_request", "name is required");
          return;
        }
        // 重新解析 plan 定位该项：不存在（已导入/已消失）按 skipped 处理
        const items = await planImport(homeDir, sessionsDir, appId, [groupId]);
        const item = items.find(
          (entry) =>
            entry.group === groupId &&
            (typeof body.key === "string" ? entry.key === body.key : entry.name === body.name),
        );
        if (!item) {
          sendJson(response, 200, { status: "skipped" });
          return;
        }
        const result = await applyImportItem(homeDir, sessionsDir, pluginsWorkspace, item);
        if (result.status === "imported" && groupId === "mcp") {
          await reloadAfterMcpChange();
        }
        if (groupId === "skills" && result.status !== "failed") {
          invalidateInstructions();
        }
        sendJson(response, 200, result);
        return;
      }
      if (pathname === "/import/apply" && request.method === "POST") {
        const body = await readJsonBody<{ appId?: unknown; groups?: unknown }>(request);
        const parsed = parseImportRequest(body);
        if (!parsed || parsed.groups.length === 0) {
          sendError(response, 400, "invalid_request", "invalid appId or groups");
          return;
        }
        const report = await applyImport(homeDir, sessionsDir, pluginsWorkspace, parsed.appId, parsed.groups);
        if (report.mcpChanged) {
          await reloadAfterMcpChange();
        }
        if ((report.groups.find((group) => group.id === "skills")?.imported.length ?? 0) > 0) {
          invalidateInstructions();
        }
        sendJson(response, 200, report);
        return;
      }

      // 已安装技能列表：输入框「+ → 技能」与 `/` 面板的数据源；cwd 跟随当前会话工作区
      if (pathname === "/skills" && request.method === "GET") {
        const query = new URL(request.url ?? "/", "http://localhost").searchParams;
        const cwd = query.get("cwd")?.trim() || pluginsWorkspace;
        const skills = await discoverSkills(
          [
            { dir: path.join(cwd, ".meowcode", "skills"), source: "project" },
            { dir: path.join(homeDir, ".meowcode", "skills"), source: "user" },
            // 内置技能（AI 自建能力等）随包分发，不需要安装
            { dir: builtinSkillsDir(), source: "builtin" },
          ],
          { allowMissingDescription: true },
        );
        sendJson(response, 200, {
          skills: await Promise.all(
            skills.map(async (skill) => {
              const iconUrl = await skillIconDataUrl(skill.path);
              return {
                id: path.basename(path.dirname(skill.path)),
                name: skill.name,
                description: skill.description,
                source: skill.source,
                ...(iconUrl ? { iconUrl } : {}),
              };
            }),
          ),
        });
        return;
      }

      // 插件启停热更新：只改禁用列表并重载，不重启 server（运行中的回合不受影响）
      if (pathname === "/plugins/disabled" && request.method === "POST") {
        const body = await readJsonBody<{ disabled?: unknown }>(request).catch(
          () => ({}) as { disabled?: unknown },
        );
        if (!Array.isArray(body.disabled)) {
          sendError(response, 400, "invalid_request", "disabled must be an array");
          return;
        }
        const disabled = body.disabled.filter(
          (item): item is string => typeof item === "string" && item.trim().length > 0,
        );
        try {
          pluginSystem.setDisabled(disabled);
          await reloadAfterMarketChange();
          sendJson(response, 200, {
            plugins: pluginSystem.descriptors(),
            errors: pluginSystem.errors(),
            mcp: pluginSystem.mcp.statuses(),
            commands: commandIndex.commands(),
          });
        } catch (error) {
          sendError(response, 500, "reload_failed", error instanceof Error ? error.message : String(error));
        }
        return;
      }

      // 开发期便利：重载插件与 MCP
      if (pathname === "/plugins/reload" && request.method === "POST") {
        try {
          const result = await pluginSystem.reload({ restartMcp: true });
          commandIndex = await loadCommandIndex({
            workspace: pluginsWorkspace,
            homeDir,
            registry: pluginSystem.registry,
          });
          runtime.rebuildToolCatalog("plugin_reload");
          sendJson(response, 200, {
            plugins: result.descriptors,
            errors: result.errors,
            mcp: pluginSystem.mcp.statuses(),
            commands: commandIndex.commands(),
          });
        } catch (error) {
          sendError(response, 500, "reload_failed", error instanceof Error ? error.message : String(error));
        }
        return;
      }

      // MCP 凭据热更新：desktop OAuth 登录后写入 env 并重连 MCP，不重启整个 agent server
      if (pathname === "/plugins/mcp-credentials" && request.method === "POST") {
        const body = await readJsonBody<{ env?: Record<string, unknown> }>(request);
        const entries = Object.entries(body.env ?? {});
        if (entries.length === 0) {
          sendError(response, 400, "invalid_request", "env is required");
          return;
        }
        for (const [name, value] of entries) {
          if (!MCP_CREDENTIAL_ENV_NAMES.has(name)) {
            sendError(response, 400, "invalid_request", `unsupported credential env: ${name}`);
            return;
          }
          if (value !== null && typeof value !== "string") {
            sendError(response, 400, "invalid_request", `${name} must be a string or null`);
            return;
          }
        }
        for (const [name, value] of entries) {
          const text = typeof value === "string" ? value.trim() : "";
          if (text) process.env[name] = text;
          else delete process.env[name];
        }
        try {
          // 凭据变了必须重连 MCP，否则子进程还拿着旧 token
          const result = await pluginSystem.reload({ restartMcp: true });
          commandIndex = await loadCommandIndex({
            workspace: pluginsWorkspace,
            homeDir,
            registry: pluginSystem.registry,
          });
          runtime.rebuildToolCatalog("plugin_reload");
          sendJson(response, 200, {
            ok: true,
            plugins: result.descriptors,
            errors: result.errors,
            mcp: pluginSystem.mcp.statuses(),
            commands: commandIndex.commands(),
          });
        } catch (error) {
          sendError(response, 500, "reload_failed", error instanceof Error ? error.message : String(error));
        }
        return;
      }

      // MCP 手动 OAuth 授权：市场「授权 / 重新授权」按钮 → 起浏览器 + 等回环回调 + 重连。
      // 同步等待（最长 5 分钟）：前端等待期间显示 pending，成功后直接拿新状态。
      if (pathname === "/plugins/mcp/authorize" && request.method === "POST") {
        const body = await readJsonBody<{ name?: unknown; force?: unknown }>(request);
        if (typeof body.name !== "string" || !body.name.trim()) {
          sendError(response, 400, "invalid_request", "name is required");
          return;
        }
        try {
          await pluginSystem.mcp.authorize(body.name.trim(), { force: body.force === true });
          runtime.rebuildToolCatalog("plugin_reload");
          sendJson(response, 200, { ok: true, mcp: pluginSystem.mcp.statuses() });
        } catch (error) {
          sendError(
            response,
            500,
            "authorize_failed",
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      }

      // MCP 解除授权：清掉本机 token 并断开连接，状态回到「需要授权」。
      // 与 authorize 相对，给「换账号 / 不想再连了」一个出口；不弹浏览器，立即返回。
      if (pathname === "/plugins/mcp/revoke" && request.method === "POST") {
        const body = await readJsonBody<{ name?: unknown }>(request);
        if (typeof body.name !== "string" || !body.name.trim()) {
          sendError(response, 400, "invalid_request", "name is required");
          return;
        }
        try {
          await pluginSystem.mcp.revoke(body.name.trim());
          runtime.rebuildToolCatalog("plugin_reload");
          sendJson(response, 200, { ok: true, mcp: pluginSystem.mcp.statuses() });
        } catch (error) {
          sendError(
            response,
            500,
            "revoke_failed",
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      }

      // 插件市场：bundles 索引 + 安装/卸载（目标固定 ~/.meowcode/）
      if (pathname === "/marketplace" && request.method === "GET") {
        const listing = await marketplace.list({ homeDir });
        sendJson(response, 200, { items: listing.entries, icons: listing.icons });
        return;
      }

      // 市场详情：skill → SKILL.md 正文；plugin → 使用说明
      if (pathname === "/marketplace/detail" && request.method === "GET") {
        const query = new URL(request.url ?? "/", "http://localhost").searchParams;
        const detailId = query.get("id") ?? "";
        const detailType = query.get("type") as "skill" | "plugin" | "mcp" | null;
        if (
          !detailId.trim() ||
          (detailType !== "skill" && detailType !== "plugin" && detailType !== "mcp")
        ) {
          sendError(response, 400, "invalid_request", "id and type (skill|plugin|mcp) are required");
          return;
        }
        try {
          sendJson(
            response,
            200,
            await marketplace.detail(detailId.trim(), detailType, { homeDir }),
          );
        } catch (error) {
          // 本地/自建技能不在市场索引里：「我的」点开详情时回退读本地 SKILL.md
          if (detailType === "skill" && error instanceof MarketplaceError && error.code === "not_found") {
            const local = await readLocalSkillDetail(homeDir, detailId.trim());
            if (local) {
              sendJson(response, 200, local);
              return;
            }
          }
          // 内置插件不在市场索引里：市场 not_found 时用 builtin manifest 兜底，
          // 桌面端点「已加载插件」里的内置行也能进详情页看使用说明
          const fallback = builtinDetailFallback(detailId.trim());
          if (fallback && error instanceof MarketplaceError && error.code === "not_found") {
            sendJson(response, 200, fallback);
            return;
          }
          sendMarketplaceError(response, error);
        }
        return;
      }

      if (pathname === "/marketplace/install" && request.method === "POST") {
        const body = await readJsonBody<{ id?: string; type?: string }>(request);
        const type = body.type;
        if (
          typeof body.id !== "string" ||
          !body.id.trim() ||
          (type !== "skill" && type !== "plugin" && type !== "mcp")
        ) {
          sendError(response, 400, "invalid_request", "id and type (skill|plugin|mcp) are required");
          return;
        }
        try {
          const result = await marketplace.install(body.id.trim(), type, { homeDir });
          if (type === "plugin") await reloadAfterMarketChange();
          // MCP 安装/卸载不阻塞响应：缺凭据或 OAuth 浏览器授权可能卡住 reload，
          // 状态由前端轮询 /plugins 与 mcp.statuses() 刷新。
          if (type === "mcp") {
            void reloadAfterMarketChange().catch((error: unknown) => {
              console.error(
                "[mcp] reload after install failed:",
                error instanceof Error ? error.message : String(error),
              );
            });
          }
          sendJson(response, 200, result);
        } catch (error) {
          sendMarketplaceError(response, error);
        }
        return;
      }

      if (pathname === "/marketplace/uninstall" && request.method === "POST") {
        const body = await readJsonBody<{ id?: string; type?: string }>(request);
        const type = body.type;
        if (
          typeof body.id !== "string" ||
          !body.id.trim() ||
          (type !== "skill" && type !== "plugin" && type !== "mcp")
        ) {
          sendError(response, 400, "invalid_request", "id and type (skill|plugin|mcp) are required");
          return;
        }
        try {
          await marketplace.uninstall(body.id.trim(), type, { homeDir });
          if (type === "plugin") await reloadAfterMarketChange();
          if (type === "mcp") {
            void reloadAfterMarketChange().catch((error: unknown) => {
              console.error(
                "[mcp] reload after uninstall failed:",
                error instanceof Error ? error.message : String(error),
              );
            });
          }
          sendJson(response, 200, { uninstalled: true });
        } catch (error) {
          sendMarketplaceError(response, error);
        }
        return;
      }

      // ---- 社区市场（GitCode 收录仓库）----

      // 社区列表：?refresh=1 强制失效缓存；官方同 id 条目被跳过
      if (pathname === "/marketplace/community" && request.method === "GET") {
        const query = new URL(request.url ?? "/", "http://localhost").searchParams;
        const refresh = query.get("refresh") === "1";
        try {
          const officialIds = await marketplace.ids();
          const listing = await communityMarket.list({ homeDir }, { refresh, officialIds });
          sendJson(response, 200, { items: listing.entries, icons: listing.icons });
        } catch (error) {
          sendError(
            response,
            502,
            "community_source_failed",
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      }

      // 社区详情：技能 → SKILL.md 正文
      if (pathname === "/marketplace/community/detail" && request.method === "GET") {
        const query = new URL(request.url ?? "/", "http://localhost").searchParams;
        const detailId = query.get("id") ?? "";
        const detailType = query.get("type") as "skill" | "plugin" | "mcp" | null;
        if (
          !detailId.trim() ||
          (detailType !== "skill" && detailType !== "plugin" && detailType !== "mcp")
        ) {
          sendError(response, 400, "invalid_request", "id and type (skill|plugin|mcp) are required");
          return;
        }
        try {
          sendJson(
            response,
            200,
            await communityMarket.detail(detailId.trim(), detailType, { homeDir }),
          );
        } catch (error) {
          sendMarketplaceError(response, error);
        }
        return;
      }

      // 社区安装：写官方同款安装标记，卸载走官方 /marketplace/uninstall
      if (pathname === "/marketplace/community/install" && request.method === "POST") {
        const body = await readJsonBody<{ id?: string; type?: string }>(request);
        const type = body.type;
        if (
          typeof body.id !== "string" ||
          !body.id.trim() ||
          (type !== "skill" && type !== "plugin" && type !== "mcp")
        ) {
          sendError(response, 400, "invalid_request", "id and type (skill|plugin|mcp) are required");
          return;
        }
        try {
          const result = await communityMarket.install(body.id.trim(), type, { homeDir });
          if (type !== "skill") await reloadAfterMarketChange();
          sendJson(response, 200, result);
        } catch (error) {
          sendMarketplaceError(response, error);
        }
        return;
      }

      // ---- 第三方市场：ClawHub + SkillHub 聚合（仅 skill）----

      // 第三方列表/搜索：?query= 搜索、?source= 只取一源、?refresh=1 强制失效缓存；
      // cursors 传上一次响应的 nextCursors 翻页
      if (pathname === "/marketplace/thirdparty" && request.method === "GET") {
        const query = new URL(request.url ?? "/", "http://localhost").searchParams;
        const source = query.get("source");
        let cursors: Partial<Record<ThirdPartySource, string>> | undefined;
        if (query.get("cursors")) {
          try {
            const parsed = JSON.parse(query.get("cursors")!) as Record<string, unknown>;
            cursors = {
              ...(typeof parsed.clawhub === "string" ? { clawhub: parsed.clawhub } : {}),
              ...(typeof parsed.skillhub === "string" ? { skillhub: parsed.skillhub } : {}),
            };
          } catch {
            sendError(response, 400, "invalid_request", "cursors must be a JSON object of source → cursor");
            return;
          }
        }
        try {
          const listing = await thirdPartyMarket.list(
            { homeDir },
            {
              ...(query.get("query") ? { query: query.get("query")! } : {}),
              ...(source === "clawhub" || source === "skillhub" ? { source: source as ThirdPartySource } : {}),
              ...(query.get("refresh") === "1" ? { refresh: true } : {}),
              ...(cursors ? { cursors } : {}),
            },
          );
          sendJson(response, 200, {
            items: listing.entries,
            sources: listing.sources,
            icons: listing.icons,
            nextCursors: listing.nextCursors,
          });
        } catch (error) {
          sendMarketplaceError(response, error);
        }
        return;
      }

      // 第三方详情：skill → SKILL.md 正文
      if (pathname === "/marketplace/thirdparty/detail" && request.method === "GET") {
        const query = new URL(request.url ?? "/", "http://localhost").searchParams;
        const detailId = query.get("id") ?? "";
        if (!detailId.trim()) {
          sendError(response, 400, "invalid_request", "id is required");
          return;
        }
        try {
          sendJson(response, 200, await thirdPartyMarket.detail(detailId.trim(), { homeDir }));
        } catch (error) {
          sendMarketplaceError(response, error);
        }
        return;
      }

      // 第三方安装：写官方同款安装标记，卸载走官方 /marketplace/uninstall
      if (pathname === "/marketplace/thirdparty/install" && request.method === "POST") {
        const body = await readJsonBody<{ id?: string }>(request);
        if (typeof body.id !== "string" || !body.id.trim()) {
          sendError(response, 400, "invalid_request", "id is required");
          return;
        }
        try {
          sendJson(response, 200, await thirdPartyMarket.install(body.id.trim(), { homeDir }));
        } catch (error) {
          sendMarketplaceError(response, error);
        }
        return;
      }

      // ---- 「我的」：手动添加的 skill / plugin / MCP（标记 manual-<type>-<id>.json）----

      // 「我的」列表：manual 标记 join 插件 descriptors 与 MCP 运行状态
      if (pathname === "/marketplace/mine" && request.method === "GET") {
        // 旧版数据导入只复制目录、没写「我的」标记：首次打开「我的」时给历史技能补一次
        if (!mineBackfillDone) {
          mineBackfillDone = true;
          await backfillSkillMarkers(homeDir).catch(() => undefined);
        }
        const base = await marketplace.mineList({ homeDir });
        const descriptors = new Map(pluginSystem.descriptors().map((d) => [d.id, d]));
        const mcpStatuses = pluginSystem.mcp.statuses();
        sendJson(response, 200, {
          skills: base.skills,
          plugins: base.plugins.map((entry) => {
            const descriptor = descriptors.get(entry.id);
            return {
              ...entry,
              displayName: descriptor?.displayName,
              description: descriptor?.description,
              enabled: descriptor?.enabled ?? false,
              error: descriptor?.error,
            };
          }),
          mcp: base.mcp.map((entry) => {
            const status = mcpStatuses[entry.id];
            return {
              ...entry,
              mcpStatus: status?.status,
              toolCount: status?.toolCount,
              error: status?.error,
              missingEnv: status?.missingEnv,
            };
          }),
        });
        return;
      }

      // 手动导入本地 skill 目录 / plugin 文件或目录
      if (pathname === "/marketplace/manual/import" && request.method === "POST") {
        const body = await readJsonBody<{ type?: string; path?: string }>(request);
        const type = body.type;
        if (
          (type !== "skill" && type !== "plugin") ||
          typeof body.path !== "string" ||
          !body.path.trim()
        ) {
          sendError(response, 400, "invalid_request", "type (skill|plugin) and path are required");
          return;
        }
        try {
          const result = await marketplace.manualImport(
            { type, sourcePath: body.path.trim() },
            { homeDir },
          );
          if (type !== "skill") await reloadAfterMarketChange();
          sendJson(response, 200, result);
        } catch (error) {
          sendMarketplaceError(response, error);
        }
        return;
      }

      // 手动添加/更新 MCP server（表单或粘贴 JSON 都归一到 {id, server}）
      if (pathname === "/marketplace/manual/mcp" && request.method === "POST") {
        const body = await readJsonBody<{ id?: string; server?: unknown }>(request);
        if (
          typeof body.id !== "string" ||
          !body.id.trim() ||
          !body.server ||
          typeof body.server !== "object" ||
          Array.isArray(body.server)
        ) {
          sendError(response, 400, "invalid_request", "id and server object are required");
          return;
        }
        try {
          const result = await marketplace.manualMcpSave(
            { id: body.id.trim(), server: body.server as Record<string, unknown> },
            { homeDir },
          );
          // OAuth 浏览器授权可能等几分钟；保存接口必须立刻回，连接状态走 /plugins 轮询。
          void reloadAfterMcpChange().catch((error: unknown) => {
            console.error(
              "[mcp] reload after manual save failed:",
              error instanceof Error ? error.message : String(error),
            );
          });
          sendJson(response, 200, result);
        } catch (error) {
          sendMarketplaceError(response, error);
        }
        return;
      }

      // 手动 MCP 启停：改 mcp.json 的 enabled 字段并 diff 重连
      if (pathname === "/marketplace/manual/mcp-toggle" && request.method === "POST") {
        const body = await readJsonBody<{ id?: string; enabled?: boolean }>(request);
        if (typeof body.id !== "string" || !body.id.trim() || typeof body.enabled !== "boolean") {
          sendError(response, 400, "invalid_request", "id and enabled are required");
          return;
        }
        try {
          const result = await marketplace.manualMcpToggle(
            { id: body.id.trim(), enabled: body.enabled },
            { homeDir },
          );
          void reloadAfterMcpChange().catch((error: unknown) => {
            console.error(
              "[mcp] reload after manual toggle failed:",
              error instanceof Error ? error.message : String(error),
            );
          });
          sendJson(response, 200, result);
        } catch (error) {
          sendMarketplaceError(response, error);
        }
        return;
      }

      // 本机已安装的全部 MCP：官方/社区通道的「已安装」分区用它补齐索引外的条目
      if (pathname === "/marketplace/mcp/installed" && request.method === "GET") {
        try {
          sendJson(response, 200, await marketplace.installedMcpList({ homeDir }));
        } catch (error) {
          sendMarketplaceError(response, error);
        }
        return;
      }

      // 删掉 mcp.json 里的本地条目（没有市场/手动标记的手写配置也能删）
      if (pathname === "/marketplace/mcp/remove" && request.method === "POST") {
        const body = await readJsonBody<{ id?: string }>(request);
        if (typeof body.id !== "string" || !body.id.trim()) {
          sendError(response, 400, "invalid_request", "id is required");
          return;
        }
        try {
          await marketplace.mcpRemoveLocal(body.id.trim(), { homeDir });
          void reloadAfterMcpChange().catch((error: unknown) => {
            console.error(
              "[mcp] reload after local remove failed:",
              error instanceof Error ? error.message : String(error),
            );
          });
          sendJson(response, 200, { id: body.id.trim() });
        } catch (error) {
          sendMarketplaceError(response, error);
        }
        return;
      }

      // 提示词美化：不依赖会话 / 仓库；side 指定侧边聊 runtime（模型选择独立）
      if (pathname === "/prompt/polish" && request.method === "POST") {
        const body = await readJsonBody<{ text?: unknown; side?: unknown }>(request);
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text) {
          sendError(response, 400, "invalid_request", "请输入要美化的提示词。");
          return;
        }
        if (text.length > MAX_POLISH_INPUT_CHARS) {
          sendError(
            response,
            400,
            "invalid_request",
            `提示词过长（最多 ${MAX_POLISH_INPUT_CHARS} 字符），请先缩短后再试。`,
          );
          return;
        }
        if (body.side !== undefined && typeof body.side !== "boolean") {
          sendError(response, 400, "invalid_request", "side must be a boolean.");
          return;
        }

        const target = body.side === true ? ensureSideRuntime() : runtime;
        const controller = new AbortController();
        // 与 commit-message 同款：内部可能重试一次（更大预算），给足 90s
        const timer = setTimeout(() => controller.abort(), 90_000);
        try {
          const polished = await target.polishPrompt(text, { signal: controller.signal });
          sendJson(response, 200, { text: polished });
        } catch (error) {
          const message = controller.signal.aborted
            ? "美化提示词超时（90 秒），请重试或缩短提示词。"
            : error instanceof Error
              ? error.message
              : String(error);
          sendError(response, 502, "prompt_polish_failed", message);
        } finally {
          clearTimeout(timer);
        }
        return;
      }

      if (pathname === "/config/providers" && request.method === "GET") {
        const activeProviderId = runtime.activeProviderId;
        sendJson(response, 200, {
          providers: runtime.providersConfig.map((provider) => ({
            id: provider.id,
            name: provider.name,
            baseUrl: provider.baseUrl,
            model: provider.model,
            displayName: provider.displayName,
            protocol: provider.protocol,
            templateId: provider.templateId,
            contextWindow: provider.contextWindow,
            maxTokens: provider.maxTokens,
            inputModalities: provider.inputModalities,
            reasoningEffort: provider.reasoningEffort,
            reasoningLevels: provider.reasoningLevels,
            thinkingBudget: provider.thinkingBudget,
            cacheTtl: provider.cacheTtl,
            reasoningSummary: provider.reasoningSummary,
            fallbackIds: provider.fallbackIds,
            nativeCompaction: provider.nativeCompaction,
            enabled: provider.enabled,
          })),
          // 用 runtime 的真实激活项，而不是环境变量列表的第一项
          activeProviderId,
          /**
           * 故障转移链（不含当前项，按尝试顺序）：前端用它显示"当前服务方 → 备用"，
           * 也方便用户确认 503 时会切到谁。最多 2 跳。
           */
          fallbackChain: planFallbacks(
            runtime.providersConfig,
            activeProviderId,
            undefined,
            runtime.providersConfig.find((provider) => provider.id === activeProviderId)
              ?.fallbackIds,
          ).map((provider) => ({
            id: provider.id,
            name: provider.name,
            model: provider.model,
          })),
        });
        return;
      }

      // 服务商列表增删改（设置页模型表）：运行中热替换，不重启 server、不中断回合。
      // 桌面端负责落盘与解密；这里只更新进程内配置（凭据随环回请求 + bearer token 传入）。
      if (pathname === "/config/providers" && request.method === "PUT") {
        const body = await readJsonBody<{ providers?: unknown; providerId?: unknown }>(request).catch(
          () => ({}) as { providers?: unknown; providerId?: unknown },
        );
        if (!Array.isArray(body.providers)) {
          sendError(response, 400, "invalid_request", "providers must be an array");
          return;
        }
        const nextProviders = body.providers.filter(
          (item): item is ProviderConfig =>
            Boolean(item) &&
            typeof item === "object" &&
            typeof (item as { id?: unknown }).id === "string" &&
            typeof (item as { baseUrl?: unknown }).baseUrl === "string" &&
            typeof (item as { model?: unknown }).model === "string",
        );
        if (nextProviders.length === 0 && body.providers.length > 0) {
          sendError(response, 400, "invalid_request", "no valid provider entries");
          return;
        }
        providers = nextProviders;
        const nextActiveId = typeof body.providerId === "string" ? body.providerId : "";
        runtime.replaceProviders(providers, nextActiveId || undefined);
        // 后台 runtime 各自保留自己的激活项；列表里找不到时内部会自动回退
        for (const instance of backgroundRuntimes.values()) instance.replaceProviders(providers);
        sendJson(response, 200, { ok: true, activeProviderId: runtime.activeProviderId });
        return;
      }

      // 记忆总开关：GET 查询；PUT 实时切换（新会话 runtime + 存活的
      // 前台/后台/侧边 runtime 全部生效）。settings.json 的落盘由桌面端负责。
      // 旧路径 /config/memory-extraction 保留为别名（当时只关蒸馏，语义是现在的子集）。
      if (
        (pathname === "/config/memory" || pathname === "/config/memory-extraction") &&
        request.method === "GET"
      ) {
        sendJson(response, 200, { enabled: memoryEnabled });
        return;
      }
      if (
        (pathname === "/config/memory" || pathname === "/config/memory-extraction") &&
        request.method === "PUT"
      ) {
        const body = await readJsonBody<{ enabled?: unknown }>(request);
        if (typeof body.enabled !== "boolean") {
          sendError(response, 400, "invalid_request", "enabled must be a boolean");
          return;
        }
        memoryEnabled = body.enabled;
        runtime.memoryEnabled = body.enabled;
        if (sideRuntime) sideRuntime.memoryEnabled = body.enabled;
        for (const instance of backgroundRuntimes.values()) {
          instance.memoryEnabled = body.enabled;
        }
        sendJson(response, 200, { enabled: memoryEnabled });
        return;
      }

      // 自我学习开关：GET 查询；PUT 实时切换（与记忆蒸馏同款：前台/侧边/后台全生效）。
      if (pathname === "/config/learning" && request.method === "GET") {
        sendJson(response, 200, { enabled: learningEnabled });
        return;
      }
      if (pathname === "/config/learning" && request.method === "PUT") {
        const body = await readJsonBody<{ enabled?: unknown }>(request);
        if (typeof body.enabled !== "boolean") {
          sendError(response, 400, "invalid_request", "enabled must be a boolean");
          return;
        }
        learningEnabled = body.enabled;
        runtime.learning = body.enabled;
        if (sideRuntime) sideRuntime.learning = body.enabled;
        for (const instance of backgroundRuntimes.values()) {
          instance.learning = body.enabled;
        }
        sendJson(response, 200, { enabled: learningEnabled });
        return;
      }
      // 供应商故障转移开关：GET 查询；PUT 实时切换（默认关闭，与记忆/学习同款全 runtime 生效）
      if (pathname === "/config/provider-fallback" && request.method === "GET") {
        sendJson(response, 200, { enabled: providerFallbackEnabled });
        return;
      }
      if (pathname === "/config/provider-fallback" && request.method === "PUT") {
        const body = await readJsonBody<{ enabled?: unknown }>(request);
        if (typeof body.enabled !== "boolean") {
          sendError(response, 400, "invalid_request", "enabled must be a boolean");
          return;
        }
        providerFallbackEnabled = body.enabled;
        runtime.providerFallbackEnabled = body.enabled;
        if (sideRuntime) sideRuntime.providerFallbackEnabled = body.enabled;
        for (const instance of backgroundRuntimes.values()) {
          instance.providerFallbackEnabled = body.enabled;
        }
        sendJson(response, 200, { enabled: providerFallbackEnabled });
        return;
      }
      // 每个主 Agent 的并行子 Agent 上限：设置页可调，运行中热切换。
      if (pathname === "/config/agent-limits" && request.method === "PUT") {
        const body = await readJsonBody<{ limits?: unknown }>(request);
        const limits = normalizeSubagentLimits(body.limits);
        runtime.subagentLimitOverrides = limits;
        if (sideRuntime) sideRuntime.subagentLimitOverrides = limits;
        for (const instance of backgroundRuntimes.values()) {
          instance.subagentLimitOverrides = limits;
        }
        sendJson(response, 200, { limits });
        return;
      }
      // 网页搜索与获取：搜索/抓取提供方与附带原问题开关，运行中热切换。
      if (pathname === "/config/web-options" && request.method === "PUT") {
        const body = await readJsonBody<{
          searchProvider?: unknown;
          fetchProvider?: unknown;
          sendOriginalQuestion?: unknown;
          deepseekApiKey?: unknown;
        }>(request);
        const next = normalizeWebConfig(runtime.webConfig, body);
        runtime.webConfig = next;
        if (sideRuntime) sideRuntime.webConfig = next;
        for (const instance of backgroundRuntimes.values()) {
          instance.webConfig = next;
        }
        // 密钥只留在 server 内存里，不回显给渲染层
        sendJson(response, 200, {
          searchProvider: next.searchProvider,
          fetchProvider: next.fetchProvider,
          sendOriginalQuestion: next.sendOriginalQuestion,
          hasDeepseekApiKey: Boolean(next.deepseekApiKey),
        });
        return;
      }
      // 网络代理：GET 查询；PUT 实时切换（下一次对外请求即生效，无需重启）。
      if (pathname === "/config/proxy" && request.method === "GET") {
        sendJson(response, 200, proxyConfig);
        return;
      }
      if (pathname === "/config/proxy" && request.method === "PUT") {
        const body = await readJsonBody<{ mode?: unknown; url?: unknown }>(request);
        if (!isProxyMode(body.mode)) {
          sendError(response, 400, "invalid_request", "mode must be direct|system|manual");
          return;
        }
        const url = typeof body.url === "string" ? body.url.trim() : "";
        // 地址允许为空/暂时不合法：用户可能刚切到手动模式还没填完。
        // 解析失败时 resolveProxyUrl 会退回直连，不会把请求打死。
        proxyConfig = { mode: body.mode as ProxyMode, url };
        setProxyConfig(proxyConfig);
        sendJson(response, 200, proxyConfig);
        return;
      }

      // 学习产物快照：用户模型 / 经验 / 技能 / 账本 / 审计
      if (pathname === "/learning/items" && request.method === "GET") {
        const snapshot = await runtime.learningSnapshot().catch(() => null);
        if (!snapshot) {
          sendError(response, 500, "snapshot_failed", "could not read learning state");
          return;
        }
        sendJson(response, 200, snapshot);
        return;
      }
      // 技能管理：删除 / 重新启用 / 回滚上一版
      if (pathname === "/learning/skill" && request.method === "POST") {
        const body = await readJsonBody<{
          action?: unknown;
          scope?: unknown;
          name?: unknown;
        }>(request);
        const action = body.action;
        const scope = body.scope;
        const name = body.name;
        if (
          (action !== "delete" && action !== "reactivate" && action !== "rollback") ||
          (scope !== "user" && scope !== "project") ||
          typeof name !== "string" ||
          !name.trim()
        ) {
          sendError(response, 400, "invalid_request", "action, scope and name are required");
          return;
        }
        const ok = await runtime.manageLearnedSkill(action, scope, name).catch(() => false);
        sendJson(response, 200, { ok });
        return;
      }
      // 清除所有学到的：两层学习根全清，不可撤销（设置页二次确认后调用）
      if (pathname === "/learning/clear" && request.method === "POST") {
        const result = await runtime.clearLearning().catch(() => ({ cleared: [] as string[] }));
        sendJson(response, 200, result);
        return;
      }
      // 立即整理：合并近义经验、蒸技能（用户手动触发，不受 30 分钟空档限制）
      if (pathname === "/learning/consolidate" && request.method === "POST") {
        const result = await runtime.consolidateLearning().catch(() => ({ applied: [] as string[] }));
        sendJson(response, 200, result);
        return;
      }

      // AGENTS.md / CLAUDE.md 导入开关：GET 查询；PUT 实时切换并清掉指令快照。
      if (pathname === "/config/instructions" && request.method === "GET") {
        sendJson(response, 200, instructionSettings);
        return;
      }
      if (pathname === "/config/instructions" && request.method === "PUT") {
        const body = await readJsonBody<{
          includeAgentsMd?: unknown;
          includeClaudeMd?: unknown;
        }>(request);
        if (
          typeof body.includeAgentsMd !== "boolean" &&
          typeof body.includeClaudeMd !== "boolean"
        ) {
          sendError(
            response,
            400,
            "invalid_request",
            "includeAgentsMd or includeClaudeMd must be a boolean",
          );
          return;
        }
        instructionSettings = {
          ...instructionSettings,
          ...(typeof body.includeAgentsMd === "boolean"
            ? { includeAgentsMd: body.includeAgentsMd }
            : {}),
          ...(typeof body.includeClaudeMd === "boolean"
            ? { includeClaudeMd: body.includeClaudeMd }
            : {}),
        };
        runtime.setInstructionSettings(instructionSettings);
        if (sideRuntime) sideRuntime.setInstructionSettings(instructionSettings);
        for (const instance of backgroundRuntimes.values()) {
          instance.setInstructionSettings(instructionSettings);
        }
        sendJson(response, 200, instructionSettings);
        return;
      }

      // 语色：GET 查询；PUT 实时切换（新会话 runtime + 存活的
      // 前台/后台/侧边 runtime 全部生效）。settings.json 的落盘由桌面端负责。
      if (pathname === "/config/speech-style" && request.method === "GET") {
        sendJson(response, 200, { style: speechStyle });
        return;
      }
      if (pathname === "/config/speech-style" && request.method === "PUT") {
        const body = await readJsonBody<{ style?: unknown }>(request);
        if (!isSpeechStyle(body.style)) {
          sendError(
            response,
            400,
            "invalid_request",
            'style must be "normal", "tafei" or "dazui"',
          );
          return;
        }
        const next = body.style;
        speechStyle = next;
        runtime.speechStyle = next;
        if (sideRuntime) sideRuntime.speechStyle = next;
        for (const instance of backgroundRuntimes.values()) {
          instance.speechStyle = next;
        }
        sendJson(response, 200, { style: speechStyle });
        return;
      }

      // 命令沙箱：GET 查询；PUT 实时切换（exec 层单例，前后台/子 agent 一起生效）。
      // 开启或新增可写根时先 probe：顺带完成首次 ACL 传播，失败绝不落配置。
      if (pathname === "/config/sandbox" && request.method === "GET") {
        sendJson(response, 200, {
          ...getSandboxSettings(),
          platform: process.platform,
          supported: process.platform === "win32",
          workspace: workspace ?? "",
        });
        return;
      }
      if (pathname === "/config/sandbox" && request.method === "PUT") {
        const body = await readJsonBody<{
          enabled?: unknown;
          writableRoots?: unknown;
          allowTemp?: unknown;
          grantTimeoutMs?: unknown;
          confirmDelete?: unknown;
        }>(request);
        if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
          sendError(response, 400, "invalid_request", "enabled must be a boolean");
          return;
        }
        if (body.confirmDelete !== undefined && typeof body.confirmDelete !== "boolean") {
          sendError(response, 400, "invalid_request", "confirmDelete must be a boolean");
          return;
        }
        const current = getSandboxSettings();
        const enabled = typeof body.enabled === "boolean" ? body.enabled : current.enabled;
        const writableRoots = Array.isArray(body.writableRoots)
          ? body.writableRoots.filter((item): item is string => typeof item === "string")
          : current.writableRoots;
        if (Array.isArray(body.writableRoots)) {
          for (const root of writableRoots) {
            if (!path.isAbsolute(root) || !existsSync(root) || !statSync(root).isDirectory()) {
              sendError(
                response,
                400,
                "invalid_request",
                `writable root is not an existing directory: ${root}`,
              );
              return;
            }
          }
        }
        const next = normalizeSandboxSettings({
          enabled,
          mode: "workspace-write",
          writableRoots,
          allowTemp:
            typeof body.allowTemp === "boolean" ? body.allowTemp : current.allowTemp,
          grantTimeoutMs:
            typeof body.grantTimeoutMs === "number"
              ? body.grantTimeoutMs
              : current.grantTimeoutMs,
          confirmDelete:
            typeof body.confirmDelete === "boolean"
              ? body.confirmDelete
              : current.confirmDelete,
        });
        if (next.enabled && process.platform !== "win32") {
          sendError(
            response,
            400,
            "sandbox_unavailable",
            "The command sandbox is only available on Windows.",
          );
          return;
        }
        const rootsChanged =
          JSON.stringify(next.writableRoots) !== JSON.stringify(current.writableRoots);
        let probeDurationMs: number | undefined;
        if (next.enabled && (!current.enabled || rootsChanged)) {
          if (!workspace) {
            sendError(response, 400, "invalid_request", "workspace is required");
            return;
          }
          const probe = await probeSandbox({ workspace, settings: next });
          if (!probe.ok) {
            sendError(
              response,
              400,
              "sandbox_unavailable",
              probe.detail ?? "sandbox probe failed",
            );
            return;
          }
          probeDurationMs = probe.durationMs;
        }
        setSandboxSettings(next);
        sendJson(response, 200, {
          ...getSandboxSettings(),
          platform: process.platform,
          supported: process.platform === "win32",
          workspace: workspace ?? "",
          ...(probeDurationMs !== undefined ? { probeDurationMs } : {}),
        });
        return;
      }
      if (pathname === "/config/sandbox/probe" && request.method === "POST") {
        if (!workspace) {
          sendError(response, 400, "invalid_request", "workspace is required");
          return;
        }
        const result = await probeSandbox({ workspace, settings: getSandboxSettings() });
        sendJson(response, 200, { ...result, backend: "windows-acl", workspace });
        return;
      }
      if (pathname === "/config/sandbox/revoke" && request.method === "POST") {
        if (!workspace) {
          sendError(response, 400, "invalid_request", "workspace is required");
          return;
        }
        const result = await revokeSandboxGrantsRemote({
          workspace,
          settings: getSandboxSettings(),
        });
        sendJson(response, 200, result);
        return;
      }

      // 服务商模型列表（设置页「获取模型列表」）：渲染端不能直连 provider，
      // 由服务端代发，密钥只在这里使用。
      if (pathname === "/provider/models" && request.method === "POST") {
        const body = await readJsonBody<{
          providerId?: string;
          baseUrl?: string;
          protocol?: string;
          apiKey?: string;
          authStyle?: "bearer" | "api-key" | "bedrock-api-key" | "none";
          extraHeaders?: Record<string, string>;
        }>(request);
        // 编辑已保存的服务商时表单不持有密钥：按 id 回退到运行时里的存档配置
        const stored = body.providerId
          ? runtime.providersConfig.find((provider) => provider.id === body.providerId)
          : undefined;
        const resolved = resolveProviderModelsOptions(body, stored);
        if (!resolved.ok) {
          sendError(response, 400, "invalid_request", resolved.error);
          return;
        }
        const result = await listProviderModels(resolved.options);
        if (!result.ok) {
          sendError(response, 502, "provider_models_failed", result.error);
          return;
        }
        sendJson(response, 200, { models: result.models });
        return;
      }

      if (pathname === "/session/model" && request.method === "PUT") {
        const body = await readJsonBody<{
          provider: string;
          modelId?: string;
          reasoningEffort?: string | null;
        }>(request);
        // 只传 provider = 切换当前激活的模型；传 modelId = 改该服务商的模型 id
        if (body.modelId) await runtime.setModel(body.provider, body.modelId);
        else runtime.setActiveProvider(body.provider);
        if (body.reasoningEffort !== undefined) {
          await runtime.setReasoningEffort(body.provider, body.reasoningEffort ?? undefined);
        }
        sendJson(response, 200, { success: true });
        return;
      }

      // ---- 侧边聊天：独立于主会话的第二会话，跑在独立 runtime 上 ----
      // 事件沿用同一条 SSE（都带 sessionId），渲染层按 sessionId 分流
      if (pathname === "/side/session/new" && request.method === "POST") {
        const body = await readJsonBody<{ cwd?: string; providerId?: string }>(request);
        const side = ensureSideRuntime();
        // 侧栏只有一个会话：运行中换会话会让旧回合永远收不回来
        if (side.isRunning) {
          sendError(response, 409, "session_busy", "侧边对话还在生成，请先停止它。");
          return;
        }
        const session = await side.newSession(body.cwd);
        // 侧边聊天默认跟随当前（主会话）选择的模型
        if (body.providerId) {
          try {
            side.setActiveProvider(body.providerId);
          } catch {
            // 指定的服务商不存在时退回默认，不影响会话创建
          }
        }
        await rememberSideSession(side.current);
        sendJson(response, 200, {
          id: session.id,
          cwd: session.cwd,
          filePath: session.filePath,
          providerId: side.activeProviderId,
        });
        return;
      }

      if (pathname === "/side/session" && request.method === "GET") {
        const session = ensureSideRuntime().current;
        if (!session) {
          sendError(response, 404, "no_session", "No side session.");
          return;
        }
        const side = ensureSideRuntime();
        sendJson(response, 200, {
          id: session.id,
          cwd: session.cwd,
          filePath: session.filePath,
          providerId: side.activeProviderId,
          approvalMode: side.currentApprovalMode,
          mode: side.currentSessionMode,
          compacting: side.isCompacting,
          lastTurn: side.lastTurn,
          recoveredPrompts: side.recoveredPrompts,
        });
        return;
      }

      if (pathname === "/side/session/messages" && request.method === "GET") {
        const session = ensureSideRuntime().current;
        sendJson(response, 200, {
          messages: session?.messages ?? [],
          compaction: session?.lastCompaction ?? null,
          compactions: session?.compactionPoints ?? [],
        });
        return;
      }

      if (pathname === "/side/session/prompt" && request.method === "POST") {
        const body = await readJsonBody<{
          message?: string;
          queueId?: string;
          images?: unknown;
          documents?: unknown;
        }>(request);
        const parsedImages = await parsePromptAttachments(body.images, body.documents);
        if (!parsedImages.ok) {
          sendError(response, 400, "invalid_request", parsedImages.error);
          return;
        }
        if (
          !body.message?.trim() &&
          !parsedImages.images.length &&
          !parsedImages.documents.length
        ) {
          sendError(response, 400, "invalid_request", "message must be a non-empty string");
          return;
        }
        const side = ensureSideRuntime();
        if (!side.current) {
          sendError(response, 409, "no_session", "No active side session. Create one first.");
          return;
        }
        if (
          body.queueId !== undefined &&
          (typeof body.queueId !== "string" || !body.queueId.trim() || body.queueId.length > 100)
        ) {
          sendError(response, 400, "invalid_request", "queueId must be a non-empty string");
          return;
        }
        if (!side.canAcceptPrompt) {
          sendError(response, 409, "session_busy", "侧边对话还在生成或压缩上下文，请稍后再试。");
          return;
        }
        if (parsedImages.images.length && !side.acceptsImages) {
          sendError(
            response,
            400,
            "vision_disabled",
            "当前模型未开启识图。请在设置 → 模型里勾选「图片」输入模态后再发送图片。",
          );
          return;
        }
        void side
          .prompt(
            body.message ?? "",
            body.queueId?.trim(),
            parsedImages.images,
            parsedImages.documents,
          )
          .catch(() => undefined);
        sendJson(response, 202, { accepted: true });
        return;
      }

      if (pathname === "/side/session/queue/remove" && request.method === "POST") {
        const body = await readJsonBody<{ id?: string }>(request);
        if (typeof body.id !== "string" || !body.id.trim()) {
          sendError(response, 400, "invalid_request", "id must be a non-empty string");
          return;
        }
        if (!ensureSideRuntime().removeQueuedPrompt(body.id)) {
          sendError(response, 404, "not_queued", "Queued prompt not found.");
          return;
        }
        sendJson(response, 200, { removed: true });
        return;
      }

      if (pathname === "/side/session/queue/reorder" && request.method === "POST") {
        const body = await readJsonBody<{ id?: string; beforeId?: string | null }>(request);
        if (typeof body.id !== "string" || !body.id.trim()) {
          sendError(response, 400, "invalid_request", "id must be a non-empty string");
          return;
        }
        if (
          body.beforeId !== undefined &&
          body.beforeId !== null &&
          (typeof body.beforeId !== "string" || !body.beforeId.trim())
        ) {
          sendError(response, 400, "invalid_request", "beforeId must be a string or null");
          return;
        }
        const side = ensureSideRuntime();
        if (!side.reorderQueuedPrompt(body.id, body.beforeId ?? null)) {
          sendError(response, 404, "not_queued", "Queued prompt not found.");
          return;
        }
        sendJson(response, 200, { reordered: true, queuedPrompts: side.queuedPrompts });
        return;
      }

      if (pathname === "/side/session/queue/edit" && request.method === "POST") {
        const body = await readJsonBody<{ id?: string; message?: string }>(request);
        if (typeof body.id !== "string" || !body.id.trim()) {
          sendError(response, 400, "invalid_request", "id must be a non-empty string");
          return;
        }
        if (typeof body.message !== "string" || !body.message.trim()) {
          sendError(response, 400, "invalid_request", "message must be a non-empty string");
          return;
        }
        const side = ensureSideRuntime();
        if (!side.editQueuedPrompt(body.id, body.message)) {
          sendError(response, 404, "not_queued", "Queued prompt not found.");
          return;
        }
        sendJson(response, 200, { edited: true, queuedPrompts: side.queuedPrompts });
        return;
      }

      if (pathname === "/side/session/recovered/discard" && request.method === "POST") {
        const body = await readJsonBody<{ id?: string }>(request);
        if (typeof body.id !== "string" || !body.id.trim()) {
          sendError(response, 400, "invalid_request", "id must be a non-empty string");
          return;
        }
        const discarded = await ensureSideRuntime().discardRecoveredPrompt(body.id);
        if (!discarded) {
          sendError(response, 404, "not_recovered", "Recovered prompt not found.");
          return;
        }
        sendJson(response, 200, { discarded: true });
        return;
      }

      if (pathname === "/side/session/steer" && request.method === "POST") {
        const body = await readJsonBody<{ id?: string }>(request);
        if (typeof body.id !== "string" || !body.id.trim()) {
          sendError(response, 400, "invalid_request", "id must be a non-empty string");
          return;
        }
        try {
          ensureSideRuntime().steerQueuedPrompt(body.id);
          sendJson(response, 200, { ok: true });
        } catch (error) {
          sendError(
            response,
            409,
            "not_steerable",
            error instanceof Error ? error.message : String(error),
          );
        }
        return;
      }

      if (pathname === "/side/session/abort" && request.method === "POST") {
        ensureSideRuntime().abort();
        sendJson(response, 200, { success: true });
        return;
      }

      if (pathname === "/side/approval/response" && request.method === "POST") {
        const body = await readJsonBody<{ callId?: string; approved?: boolean }>(request);
        ensureSideRuntime().respondToApproval(String(body.callId ?? ""), Boolean(body.approved));
        sendJson(response, 200, { success: true });
        return;
      }

      // 侧边会话的模型 / 权限 / 上下文占用 / 压缩：与主会话同款，作用在 sideRuntime 上
      if (pathname === "/side/session/model" && request.method === "PUT") {
        const body = await readJsonBody<{
          provider?: string;
          modelId?: string;
          reasoningEffort?: string | null;
        }>(request);
        const side = ensureSideRuntime();
        if (body.modelId) await side.setModel(String(body.provider ?? ""), body.modelId);
        else if (body.provider) side.setActiveProvider(body.provider);
        if (body.reasoningEffort !== undefined) {
          await side.setReasoningEffort(String(body.provider ?? ""), body.reasoningEffort ?? undefined);
        }
        sendJson(response, 200, { success: true });
        return;
      }

      if (pathname === "/side/session/permissions" && request.method === "GET") {
        sendJson(response, 200, { mode: ensureSideRuntime().currentApprovalMode });
        return;
      }

      if (pathname === "/side/session/permissions" && request.method === "PUT") {
        const body = await readJsonBody<{ mode?: string }>(request);
        if (!isApprovalMode(body.mode)) {
          sendError(
            response,
            400,
            "invalid_request",
            `mode must be "read-only", "ask", "auto", or "full", got ${body.mode}`,
          );
          return;
        }
        await ensureSideRuntime().setApprovalMode(body.mode);
        sendJson(response, 200, { mode: ensureSideRuntime().currentApprovalMode });
        return;
      }

      if (pathname === "/side/session/mode" && request.method === "PUT") {
        const body = await readJsonBody<{ mode?: string }>(request);
        if (!isSessionMode(body.mode)) {
          sendError(
            response,
            400,
            "invalid_request",
            `mode must be "default", "plan", or "goal", got ${body.mode}`,
          );
          return;
        }
        await ensureSideRuntime().setSessionMode(body.mode);
        sendJson(response, 200, { mode: ensureSideRuntime().currentSessionMode });
        return;
      }

      if (pathname === "/side/session/context" && request.method === "GET") {
        sendJson(response, 200, ensureSideRuntime().getContextUsage());
        return;
      }

      if (pathname === "/side/session/compact" && request.method === "POST") {
        if (ensureSideRuntime().isCompacting) {
          sendError(response, 409, "compaction_running", "正在压缩对话历史，请稍候。");
          return;
        }
        await ensureSideRuntime().compactSession();
        sendJson(response, 200, { success: true });
        return;
      }

      // 记忆管理（设置页数据源）：user 层在 home，project 层跟随 cwd query（与 /skills 同规约）
      if (pathname === "/memory" && request.method === "GET") {
        const query = new URL(request.url ?? "/", "http://localhost").searchParams;
        const cwd = query.get("cwd")?.trim() || pluginsWorkspace;
        const [user, project] = await Promise.all([
          listMemoryItems(memoryDirFor("user", cwd, homeDir)),
          listMemoryItems(memoryDirFor("project", cwd)),
        ]);
        sendJson(response, 200, { user, project });
        return;
      }

      if (pathname === "/memory" && request.method === "DELETE") {
        const query = new URL(request.url ?? "/", "http://localhost").searchParams;
        const scope = parseMemoryScopeParam(query.get("scope"));
        const cwd = query.get("cwd")?.trim() || pluginsWorkspace;
        if (!scope) {
          sendError(response, 400, "invalid_scope", 'scope must be "user" or "project".');
          return;
        }
        const cleared = await clearMemories(memoryDirFor(scope, cwd, homeDir));
        sendJson(response, 200, { scope, cleared });
        return;
      }

      if (pathname === "/memory/file" && request.method === "GET") {
        const query = new URL(request.url ?? "/", "http://localhost").searchParams;
        const scope = parseMemoryScopeParam(query.get("scope"));
        const name = query.get("name")?.trim() ?? "";
        const cwd = query.get("cwd")?.trim() || pluginsWorkspace;
        if (!scope) {
          sendError(response, 400, "invalid_scope", 'scope must be "user" or "project".');
          return;
        }
        if (!isValidMemoryName(name)) {
          sendError(response, 400, "invalid_name", "Memory names are lowercase kebab-case (letters, digits, hyphens).");
          return;
        }
        const record = await readMemory(memoryDirFor(scope, cwd, homeDir), name);
        if (!record) {
          sendError(response, 404, "not_found", `Memory "${name}" not found in ${scope} scope.`);
          return;
        }
        sendJson(response, 200, {
          name: record.name,
          scope,
          content: record.raw,
          created: record.created,
        });
        return;
      }

      if (pathname === "/memory/file" && request.method === "PUT") {
        const body = await readJsonBody<{
          scope?: string;
          name?: string;
          content?: string;
          cwd?: string;
        }>(request);
        const scope = parseMemoryScopeParam(typeof body.scope === "string" ? body.scope : null);
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const cwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : pluginsWorkspace;
        if (!scope) {
          sendError(response, 400, "invalid_scope", 'scope must be "user" or "project".');
          return;
        }
        if (!isValidMemoryName(name)) {
          sendError(response, 400, "invalid_name", "Memory names are lowercase kebab-case (letters, digits, hyphens).");
          return;
        }
        await writeMemoryFile(memoryDirFor(scope, cwd, homeDir), name, String(body.content ?? ""));
        sendJson(response, 200, { success: true });
        return;
      }

      if (pathname === "/memory/file" && request.method === "DELETE") {
        const query = new URL(request.url ?? "/", "http://localhost").searchParams;
        const scope = parseMemoryScopeParam(query.get("scope"));
        const name = query.get("name")?.trim() ?? "";
        const cwd = query.get("cwd")?.trim() || pluginsWorkspace;
        if (!scope) {
          sendError(response, 400, "invalid_scope", 'scope must be "user" or "project".');
          return;
        }
        if (!isValidMemoryName(name)) {
          sendError(response, 400, "invalid_name", "Memory names are lowercase kebab-case (letters, digits, hyphens).");
          return;
        }
        const removed = await deleteMemory(memoryDirFor(scope, cwd, homeDir), name);
        if (!removed) {
          sendError(response, 404, "not_found", `Memory "${name}" not found in ${scope} scope.`);
          return;
        }
        sendJson(response, 200, { success: true });
        return;
      }

      // 项目规则（设置页）：cwd 跟随当前工作区，文件落在 .meowcode/rules/*.md
      if (pathname === "/rules" && request.method === "GET") {
        const query = new URL(request.url ?? "/", "http://localhost").searchParams;
        const cwd = query.get("cwd")?.trim() || runtime.current?.cwd || pluginsWorkspace;
        sendJson(response, 200, { rules: await listRules(cwd) });
        return;
      }

      if (pathname === "/rules/file" && request.method === "GET") {
        const query = new URL(request.url ?? "/", "http://localhost").searchParams;
        const name = query.get("name")?.trim() ?? "";
        const cwd = query.get("cwd")?.trim() || runtime.current?.cwd || pluginsWorkspace;
        if (!isValidRuleName(name)) {
          sendError(
            response,
            400,
            "invalid_name",
            "Rule names are lowercase kebab-case (letters, digits, hyphens).",
          );
          return;
        }
        const rule = await readRule(cwd, name);
        if (!rule) {
          sendError(response, 404, "not_found", `Rule "${name}" not found.`);
          return;
        }
        sendJson(response, 200, rule);
        return;
      }

      if (pathname === "/rules/file" && request.method === "PUT") {
        const body = await readJsonBody<{
          cwd?: string;
          name?: string;
          content?: string;
        }>(request);
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const cwd =
          typeof body.cwd === "string" && body.cwd.trim()
            ? body.cwd.trim()
            : runtime.current?.cwd || pluginsWorkspace;
        if (!isValidRuleName(name)) {
          sendError(
            response,
            400,
            "invalid_name",
            "Rule names are lowercase kebab-case (letters, digits, hyphens).",
          );
          return;
        }
        if (typeof body.content !== "string") {
          sendError(response, 400, "invalid_request", "content must be a string");
          return;
        }
        await writeRule(cwd, name, body.content);
        invalidateInstructions();
        sendJson(response, 200, { success: true });
        return;
      }

      if (pathname === "/rules/file" && request.method === "DELETE") {
        const query = new URL(request.url ?? "/", "http://localhost").searchParams;
        const name = query.get("name")?.trim() ?? "";
        const cwd = query.get("cwd")?.trim() || runtime.current?.cwd || pluginsWorkspace;
        if (!isValidRuleName(name)) {
          sendError(
            response,
            400,
            "invalid_name",
            "Rule names are lowercase kebab-case (letters, digits, hyphens).",
          );
          return;
        }
        const removed = await deleteRule(cwd, name);
        if (!removed) {
          sendError(response, 404, "not_found", `Rule "${name}" not found.`);
          return;
        }
        invalidateInstructions();
        sendJson(response, 200, { success: true });
        return;
      }

      sendError(response, 404, "not_found", `No route for ${request.method} ${pathname}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendError(response, 400, "invalid_request", message);
    }
  });


  let shuttingDown = false;
  const collectAllRuntimes = (): AgentRuntime[] => {
    const instances = [runtime, ...backgroundRuntimes.values()];
    if (sideRuntime) instances.push(sideRuntime);
    return [...new Set(instances)];
  };

  /**
   * 优雅关停：先结束 SSE、中止所有回合，给它们 1.5s 收尾写 turn_end；
   * 超时则强制补 turn_end(aborted)，再 flush/close 每个会话文件。
   */
  const shutdown = async (_reason = "shutdown"): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (pluginWatchTimer) clearTimeout(pluginWatchTimer);
    pluginWatchTimer = null;
    for (const watcher of pluginWatchers.splice(0)) {
      try {
        watcher.close();
      } catch {
        // 已关闭
      }
    }
    for (const client of clients) {
      try {
        client.response.end();
      } catch {
        // 已断开
      }
    }
    clients.clear();
    await Promise.race([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ]);
    server.closeAllConnections?.();

    const instances = collectAllRuntimes();
    // 关停保留排队消息：用户已输入的内容下次启动继续显示为“待发送”
    for (const instance of instances) instance.shutdown();
    const deadline = Date.now() + 1_500;
    while (
      Date.now() < deadline &&
      instances.some((instance) => instance.isRunning || instance.isCompacting)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    for (const instance of instances) {
      const session = instance.current;
      if (session) {
        const openTurn = session.openTurns.at(-1);
        if (openTurn) {
          await session
            .appendTurnEnd({
              turnId: openTurn.turnId,
              status: "aborted",
              error: "The agent server shut down before this turn completed.",
            })
            .catch(() => undefined);
        }
        await session.flush().catch(() => undefined);
      }
      await instance.closeSession().catch(() => undefined);
    }
    await stateWriteChain.catch(() => undefined);
    await pluginSystem.dispose().catch(() => undefined);
    getLspManager().disposeAll();
    clearInterval(workspaceWatcherGuard);
    workspaceWatcher?.close();
    await agentLogger.close().catch(() => undefined);
  };

  const onProcessMessage = (message: unknown): void => {
    if ((message as { type?: string } | null)?.type !== "shutdown") return;
    void shutdown("ipc").finally(() => process.exit(0));
  };
  const onProcessSignal = (): void => {
    void shutdown("signal").finally(() => process.exit(0));
  };
  // 回合里很多写盘是 fire-and-forget：一次失败不该把整个 agent server 带走。
  // 未处理拒绝只记日志继续服务；真正的同步崩溃先结算回合再退出，让桌面端看到干净退出。
  const onRejection = (reason: unknown): void => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    console.error(`[meowcode] unhandled rejection: ${detail}`);
  };
  const onFatalException = (error: Error): void => {
    console.error(`[meowcode] uncaught exception: ${error.stack ?? error.message}`);
    void shutdown("uncaught-exception").finally(() => process.exit(1));
  };
  process.on("message", onProcessMessage);
  process.on("disconnect", onProcessSignal);
  process.on("SIGINT", onProcessSignal);
  process.on("SIGTERM", onProcessSignal);
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onFatalException);
  server.once("close", () => {
    process.off("message", onProcessMessage);
    process.off("disconnect", onProcessSignal);
    process.off("SIGINT", onProcessSignal);
    process.off("SIGTERM", onProcessSignal);
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onFatalException);
  });

  const port = (options.port ?? Number(process.env.MEOWCODE_SERVER_PORT ?? 0)) || 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not listen on a TCP port.");
  const url = `http://127.0.0.1:${address.port}`;
  process.stdout.write(`server listening on ${url}
`);
  process.send?.({ type: "ready", url, version: APP_VERSION });
  return Object.assign(server, { shutdown });
}

/**
 * 是否以脚本入口运行。
 *
 * 不能直接比 `import.meta.url === pathToFileURL(process.argv[1])`：MSIX 安装目录
 * `C:\Program Files\WindowsApps` 是指向真实安装盘（如 `D:\WindowsApps`）的
 * junction。Node 加载模块时 import.meta.url 已是解析后的真实路径，而 argv[1]
 * 仍是 junction 路径，字面比较会把入口判成「被 import」，server 什么都不做就
 * 以 0 退出，桌面端等到 15s 后报 "Agent server is not ready."。
 * 两边都 realpath 后再比（Windows 路径大小写不敏感）。
 */
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const current = realpathSync(fileURLToPath(import.meta.url));
    const invoked = realpathSync(entry);
    return process.platform === "win32"
      ? current.toLowerCase() === invoked.toLowerCase()
      : current === invoked;
  } catch {
    // 路径刚被删/无权限时退回字面比较
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (isEntrypoint()) {
  const envToken = process.env.MEOWCODE_SERVER_TOKEN?.trim();
  const token = envToken || randomBytes(32).toString("base64url");
  void startServer({ token })
    .then(() => {
      if (!envToken) process.stdout.write(`server token: ${token}\n`);
    })
    .catch((error) => {
      console.error(`[meowcode] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}





