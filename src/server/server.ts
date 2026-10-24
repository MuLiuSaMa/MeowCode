import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import os from "node:os";
import { mkdirSync } from "node:fs";
import { readFile, readdir, rm, stat, unlink, writeFile, cp } from "node:fs/promises";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AgentRuntime, isApprovalMode, isSessionMode } from "../agent/runtime.js";
import { AGENT_ROLE_NAMES, BUILTIN_AGENTS } from "../agent/agent-definition.js";
import {
  AGENT_PROFILES,
  AGENT_PROFILE_IDS,
  isAgentProfile,
} from "../agent/agent-profiles.js";
import { toolDefinitions } from "../agent/tools.js";
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
import { readJsonFile, writeJsonAtomic } from "../agent/atomic-json.js";
import { createBrowserHostFromEnv } from "../agent/browser-host.js";
import { displayPath, resolveWithinWorkspace } from "../agent/paths.js";
import { planFallbacks } from "../agent/provider-fallback.js";
import {
  GitError,
  createGitService,
  collectCommitContext,
  type GitErrorCode,
} from "./git.js";
import { listWorkspaceFiles } from "../agent/search.js";
import {
  createPluginSystem,
  loadCommandIndex,
  type CommandIndex,
  type PluginSystem,
} from "../plugins/index.js";
import { createMarketplaceStore, MarketplaceError } from "./marketplace.js";
import { discoverSkills } from "../plugins/skills.js";
import type {
  PendingApproval,
  ProviderConfig,
  SubagentStatus,
  SubagentSummary,
  ToolDocument,
  ToolImage,
  TurnStatus,
} from "../agent/types.js";

const APP_VERSION = "0.1.0";
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

function readProvidersFromEnv(): ProviderConfig[] {
  const raw = process.env.MEOWCODE_PROVIDERS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as ProviderConfig[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 实验开关（MEOWCODE_EXPERIMENTAL，JSON）：未设置/解析失败一律全关。 */
function readExperimentalFromEnv(): {
  midstreamToolExec?: boolean;
  incrementalResponses?: boolean;
  nativeCompaction?: boolean;
} | null {
  const raw = process.env.MEOWCODE_EXPERIMENTAL;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      midstreamToolExec?: boolean;
      incrementalResponses?: boolean;
      nativeCompaction?: boolean;
    };
    if (typeof parsed !== "object" || parsed === null) return null;
    const flags: {
      midstreamToolExec?: boolean;
      incrementalResponses?: boolean;
      nativeCompaction?: boolean;
    } = {};
    if (parsed.midstreamToolExec) flags.midstreamToolExec = true;
    if (parsed.incrementalResponses) flags.incrementalResponses = true;
    if (parsed.nativeCompaction) flags.nativeCompaction = true;
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

/** 市场路由错误统一映射：not_found→404、not_managed→409、invalid_id→400，其余 500 */
function sendMarketplaceError(response: http.ServerResponse, error: unknown): void {
  if (error instanceof MarketplaceError) {
    const status = error.code === "not_found" ? 404 : error.code === "not_managed" ? 409 : 400;
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

/** 预览用 MIME 映射（/workspace/raw） */
const MIME_BY_EXT: Record<string, string> = {
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
/** 允许运行时热更新的 MCP 凭据 env（desktop OAuth 登录后写入；不接受任意环境变量）。 */
const MCP_CREDENTIAL_ENV_NAMES = new Set([
  "MEOWCODE_GITHUB_TOKEN",
  "MEOWCODE_GITEE_TOKEN",
  "MEOWCODE_GITCODE_TOKEN",
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
function parsePromptAttachments(rawImages: unknown, rawDocuments: unknown): ParsedAttachments {
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
      documents.push({ mimeType, data, name: name || "document.pdf" });
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
  const providers = readProvidersFromEnv();
  // 密钥只留在内存：删掉环境变量后，模型通过 run_command 读 env 也拿不到。
  delete process.env.MEOWCODE_PROVIDERS;
  const sessionsDir = process.env.MEOWCODE_SESSIONS_DIR ?? DEFAULT_SESSIONS_DIR;
  const providerId = process.env.MEOWCODE_PROVIDER_ID;
  const workspace = process.env.MEOWCODE_WORKSPACE;
  // 实验开关（桌面端经环境变量注入；默认全关）
  const experimental = readExperimentalFromEnv();
  // 插件系统：目录发现 + jiti 加载 + MCP；desktop 经 MEOWCODE_PLUGINS 注入禁用清单
  const pluginsWorkspace = workspace ?? process.cwd();
  // MCP 不阻塞 HTTP 服务就绪：gitcode 这类 stdio MCP 走 npx 拉起，光解析包 + 启动
  // 子进程就要好几秒，没必要让窗口空等。工具就绪前会被首个回合前的 awaitMcpReady 拦住。
  const pluginSystem: PluginSystem = await createPluginSystem({
    workspace: pluginsWorkspace,
    homeDir: os.homedir(),
    blockOnMcp: false,
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
  let commandIndex: CommandIndex = await loadCommandIndex({
    workspace: pluginsWorkspace,
    homeDir: os.homedir(),
    registry: pluginSystem.registry,
  });
  // 插件市场：bundles 目录（desktop 注入 MEOWCODE_MARKETPLACE_DIR；未设置=市场功能为空）
  const marketplace = createMarketplaceStore(process.env.MEOWCODE_MARKETPLACE_DIR);
  /** plugin/mcp 安装卸载后重载插件系统与命令索引（skill 走每轮重扫，无需 reload） */
  const reloadAfterMarketChange = async (): Promise<void> => {
    await pluginSystem.reload();
    commandIndex = await loadCommandIndex({
      workspace: pluginsWorkspace,
      homeDir: os.homedir(),
      registry: pluginSystem.registry,
    });
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
    });
    instance.onEvent(broadcast);
    return instance;
  };
  let runtime = createRuntime(workspace, providers, providerId);
  /** sessionId → 后台 runtime（只在有运行/排队/审批/错误时保留） */
  const backgroundRuntimes = new Map<string, AgentRuntime>();

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
      });
      sideRuntime.onEvent((event) => broadcast({ ...event, side: true }));
    }
    return sideRuntime;
  };
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
    // /session/asset 服务于 <img> 标签，带不了 Authorization 头：允许 query token 等价鉴权
    // （token 只在本机内存里，server 只监听 127.0.0.1，泄漏面可控）
    const assetQueryToken = pathname === "/session/asset" ? url.searchParams.get("token") : null;
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

      // 本会话 Agent 改过的文件（审阅面板数据源）：按文件聚合，最新在前
      if (pathname === "/session/changes" && request.method === "GET") {        const session = runtime.current;
        type ChangeSummary = {
          path: string;
          operation: "write_file" | "edit_file";
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
            const body = await readJsonBody<{ paths?: unknown }>(request);
            await git.stage(body.paths);
            broadcast({ type: "git_changed" });
            sendJson(response, 200, { ok: true });
            return;
          }

          if (pathname === "/git/unstage" && request.method === "POST") {
            const body = await readJsonBody<{ paths?: unknown }>(request);
            await git.unstage(body.paths);
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

      if (pathname === "/session/messages" && request.method === "GET") {
        const session = runtime.current;
        if (!session) {
          sendJson(response, 200, { messages: [], compaction: null, compactions: [] });
          return;
        }
        sendJson(response, 200, {
          messages: session.messagesForClient,
          compaction: session.lastCompaction,
          compactions: session.compactionPoints,
        });
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

      if (pathname === "/session/new" && request.method === "POST") {
        const body = await readJsonBody<{ cwd?: string }>(request);
        const next = createFreshRuntime();
        const session = await next.newSession(body.cwd);
        demoteActiveRuntime();
        runtime = next;
        pruneBackgroundRuntimes(session.id);
        await rememberActiveSession(runtime.current);
        sendJson(response, 200, session);
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
        const parsedImages = parsePromptAttachments(body.images, body.documents);
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
          ? body.answers.map((item) => String(item ?? ""))
          : [String(body.answer ?? "")];
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
        const body = await readJsonBody<{ callId: string; approved: boolean }>(request);
        // 审批可能属于后台会话，也可能属于某个子 Agent；按 callId 让各 runtime 级联查找。
        let handled = false;
        for (const instance of [runtime, ...backgroundRuntimes.values()]) {
          if (instance.respondToApproval(body.callId, Boolean(body.approved))) {
            handled = true;
            break;
          }
        }
        sendJson(response, 200, { success: true, handled });
        return;
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
        // 只有保存的是当前档位的图才需要重载
        if (profile === runtime.currentAgentProfile) runtime.refreshHarness();
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

      // 已安装技能列表：输入框「+ → 技能」与 `/` 面板的数据源；cwd 跟随当前会话工作区
      if (pathname === "/skills" && request.method === "GET") {
        const query = new URL(request.url ?? "/", "http://localhost").searchParams;
        const cwd = query.get("cwd")?.trim() || pluginsWorkspace;
        const skills = await discoverSkills(
          [
            { dir: path.join(cwd, ".meowcode", "skills"), source: "project" },
            { dir: path.join(os.homedir(), ".meowcode", "skills"), source: "user" },
          ],
          { allowMissingDescription: true },
        );
        sendJson(response, 200, {
          skills: skills.map((skill) => ({
            id: path.basename(path.dirname(skill.path)),
            name: skill.name,
            description: skill.description,
            source: skill.source,
          })),
        });
        return;
      }

      // 开发期便利：重载插件与 MCP（desktop 设置页的启停走重启 server 生效，不依赖此路由）
      if (pathname === "/plugins/reload" && request.method === "POST") {
        try {
          const result = await pluginSystem.reload({ restartMcp: true });
          commandIndex = await loadCommandIndex({
            workspace: pluginsWorkspace,
            homeDir: os.homedir(),
            registry: pluginSystem.registry,
          });
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
            homeDir: os.homedir(),
            registry: pluginSystem.registry,
          });
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

      // 插件市场：bundles 索引 + 安装/卸载（目标固定 ~/.meowcode/）
      if (pathname === "/marketplace" && request.method === "GET") {
        const listing = await marketplace.list({ homeDir: os.homedir() });
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
            await marketplace.detail(detailId.trim(), detailType, { homeDir: os.homedir() }),
          );
        } catch (error) {
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
          const result = await marketplace.install(body.id.trim(), type, { homeDir: os.homedir() });
          if (type !== "skill") await reloadAfterMarketChange();
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
          await marketplace.uninstall(body.id.trim(), type, { homeDir: os.homedir() });
          if (type !== "skill") await reloadAfterMarketChange();
          sendJson(response, 200, { uninstalled: true });
        } catch (error) {
          sendMarketplaceError(response, error);
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
        const parsedImages = parsePromptAttachments(body.images, body.documents);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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





