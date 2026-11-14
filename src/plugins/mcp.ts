import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpOAuthProvider } from "./mcp-oauth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { hasDynamicTool, registerDynamicTool, unregisterDynamicTool } from "../agent/tools.js";
import type { ToolContract } from "../agent/tool-contract.js";
import type { ToolDefinition, ToolImage, ToolResult } from "../agent/types.js";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export type McpServerConfig = {
  /** stdio transport */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** streamable HTTP transport */
  url?: string;
  headers?: Record<string, string>;
  /**
   * OAuth（仅 streamable HTTP）：authorization_code + PKCE 公开客户端，
   * 授权码走 127.0.0.1 回环回调，token 落 ~/.meowcode/mcp-oauth/。缺省或 stdio 无此字段。
   *
   * 客户端身份：`clientId` 为非 URL 时预注册跳过 DCR；HTTPS URL 或 `clientMetadataUrl`
   * 走 CIMD（SEP-991）。都没配则默认带 MeowCode 官方 CIMD URL（仅 AS 广播支持时生效）。
   */
  auth?: {
    type: "oauth";
    scopes?: string[];
    /** 预注册 client_id；HTTPS URL 形式则作为 CIMD 文档地址 */
    clientId?: string;
    /** CIMD 文档 URL；空串关闭官方 CIMD 回退 */
    clientMetadataUrl?: string;
  };
  /** 默认 true：MCP 工具免审批直接执行；显式 false 则该 server 的工具每次调用先弹审批 */
  trust?: boolean;
  /** callTool 超时毫秒，默认 60000 */
  timeoutMs?: number;
  /** false 则跳过该 server */
  enabled?: boolean;
};

export type McpConfigFile = { mcpServers?: Record<string, McpServerConfig> };

export type McpServerState = {
  /**
   * needs_auth：远程 server 回了 401，等用户在 UI 点「授权」。
   * 这不是故障——连接期不再自动弹浏览器等回调（那会把状态卡在 connecting 最长 5 分钟）。
   */
  status: "connecting" | "ready" | "failed" | "unconfigured" | "needs_auth";
  toolCount: number;
  error?: string;
  /** unconfigured 时缺的 ${VAR} 名单（给渲染层展示「待配置 · 缺 X」） */
  missingEnv?: string[];
};

/** url / headers 值 / env 值里的 ${VAR} 用进程环境变量展开 */
export function expandEnvTemplates(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? "");
}

/**
 * 找出进程环境补不出来的 ${VAR} 占位（缺令牌/缺 env，空串也算缺）。
 * 这类 server 不该发起连接——拿着空 Bearer 去撞 401 只会刷「失败」噪音；
 * 跳过并标 unconfigured，等凭据热更新触发 reload 后自然连上。
 */
export function unresolvedEnvVars(config: McpServerConfig): string[] {
  const missing = new Set<string>();
  const scan = (value: string): void => {
    for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      const value = process.env[match[1]];
      if (value === undefined || value === "") missing.add(match[1]);
    }
  };
  if (config.command) scan(config.command);
  for (const arg of config.args ?? []) scan(arg);
  if (config.url) scan(config.url);
  for (const value of Object.values(config.headers ?? {})) scan(value);
  for (const value of Object.values(config.env ?? {})) scan(value);
  return [...missing];
}

/**
 * 读取 .meowcode/mcp.json：user 根在前、project 根在后 → 同名 server project 覆盖 user。
 * 文件不存在或 JSON 损坏 → 跳过（损坏时告警，不让一个坏文件拖垮启动）。
 */
export async function readMcpConfig(roots: {
  workspace: string;
  homeDir: string;
}): Promise<{ servers: Record<string, McpServerConfig>; errors: string[] }> {
  const servers: Record<string, McpServerConfig> = {};
  const errors: string[] = [];
  const files = [
    path.join(roots.homeDir, ".meowcode", "mcp.json"),
    path.join(roots.workspace, ".meowcode", "mcp.json"),
  ];
  for (const file of files) {
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      continue; // 不存在 → 正常
    }
    let parsed: McpConfigFile;
    try {
      parsed = JSON.parse(raw) as McpConfigFile;
    } catch (error) {
      errors.push(`${file}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") continue;
    for (const [name, config] of Object.entries(parsed.mcpServers)) {
      if (!config || typeof config !== "object") continue;
      servers[name] = config;
    }
  }
  return { servers, errors };
}

// ---------------------------------------------------------------------------
// MCP 工具 → ToolDefinition / ToolResult 转换
// ---------------------------------------------------------------------------

type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: unknown };
  /** MCP 规范的行为提示；只有 readOnlyHint === true 才允许并发 */
  annotations?: { readOnlyHint?: boolean };
};

type McpContentBlock = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  resource?: { uri?: string; text?: string; mimeType?: string };
};

type McpCallResult = { content?: McpContentBlock[]; isError?: boolean };

/**
 * MCP 工具描述上限：很多 server 会把整篇 README 塞进 description，每轮都随 schema 计费。
 * 240 字符 ≈ 60 token，够放下「首句 + 一条 Use when」；1000 字符时代 20 个工具就是
 * 5k token/请求，纯属替 server 的营销文案付费。
 */
const MAX_MCP_TOOL_DESCRIPTION_CHARS = 240;
/** 字段级描述上限：MCP 的 inputSchema 里每个字段常带一整段说明。 */
const MAX_MCP_PROPERTY_DESCRIPTION_CHARS = 120;
/** schema 递归深度上限：超过就只留类型，避免嵌套地狱把 schema 撑爆。 */
const MCP_SCHEMA_MAX_DEPTH = 3;

/** 说明「什么时候该用我」的句子，即使排在最后也要抢回预算。 */
const MCP_USAGE_HINT = /use (this|when)|call (this|when)|用于|当.{0,12}时|trigger/i;

/** 纯噪音的 JSON Schema 关键字：模型不读，但每轮都按 token 计费。 */
const MCP_SCHEMA_DROP_KEYS = new Set([
  "$schema",
  "$id",
  "$comment",
  "examples",
  "example",
  "deprecated",
]);

/**
 * 按句子裁剪一段说明文字，尽量保住信息量：
 * 首句必留 → 再留「何时使用」类句子 → 剩余预算按原顺序补满。
 * 整段都在预算内时逐字返回（保证同一输入永远产出同一字节，缓存前缀稳定）。
 */
export function clipMcpText(text: string, max: number): string {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (normalized.length <= max) return normalized;
  const sentences = normalized.split(/(?<=[.!?。！？])\s+|\n+/).filter(Boolean);
  if (!sentences.length) return "";
  const picked = new Set<number>();
  let length = 0;
  const take = (index: number): boolean => {
    const sentence = sentences[index];
    const cost = sentence.length + (picked.size ? 1 : 0);
    if (length + cost > max) return false;
    picked.add(index);
    length += cost;
    return true;
  };
  // 首句通常定义工具是什么，必须留；单独超限时按词边界硬切
  if (sentences[0].length + 2 > max) {
    const head = sentences[0].slice(0, max - 2);
    const cut = head.lastIndexOf(" ");
    return `${(cut > max * 0.6 ? head.slice(0, cut) : head).trimEnd()} …`;
  }
  take(0);
  for (let index = 1; index < sentences.length; index += 1) {
    if (MCP_USAGE_HINT.test(sentences[index])) take(index);
  }
  for (let index = 1; index < sentences.length; index += 1) {
    if (!picked.has(index)) take(index);
  }
  const ordered = [...picked].sort((left, right) => left - right);
  const joined = ordered.map((index) => sentences[index]).join(" ");
  return joined.length < normalized.length ? `${joined} …` : joined;
}

/**
 * 清洗 MCP 的 inputSchema：删噪音键、裁剪字段描述、限制递归深度。
 *
 * 保留 `$defs` / `$ref` / `enum` / `const` / `required` / `format` / `pattern` /
 * `minimum` / `maximum` / `default` —— 这些是模型填参数真正需要的约束。
 * `additionalProperties` 只在布尔形态下删除（对象形态表示 map，语义不能丢）。
 */
export function sanitizeMcpSchema(node: unknown, depth = 0): unknown {
  if (!node || typeof node !== "object" || Array.isArray(node)) return node;
  const source = node as Record<string, unknown>;
  if (depth >= MCP_SCHEMA_MAX_DEPTH) {
    return typeof source.type === "string" ? { type: source.type } : {};
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (MCP_SCHEMA_DROP_KEYS.has(key)) continue;
    // 布尔形态只是「禁止额外字段」的提示，模型不需要
    if (key === "additionalProperties" && typeof value === "boolean") continue;
    // title 与 description 同时存在时 title 只是重复信息
    if (key === "title" && typeof source.description === "string") continue;
    if (key === "description" && typeof value === "string") {
      out[key] = clipMcpText(value, MAX_MCP_PROPERTY_DESCRIPTION_CHARS);
      continue;
    }
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const properties: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
        properties[name] = sanitizeMcpSchema(child, depth + 1);
      }
      out.properties = properties;
      continue;
    }
    if ((key === "items" || key === "not") && value && typeof value === "object") {
      out[key] = sanitizeMcpSchema(value, depth + 1);
      continue;
    }
    if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      out[key] = value.map((item) => sanitizeMcpSchema(item, depth + 1));
      continue;
    }
    if (
      (key === "$defs" || key === "definitions") &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const defs: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
        defs[name] = sanitizeMcpSchema(child, depth + 1);
      }
      out[key] = defs;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** MCP inputSchema → ToolDefinition.parameters：缺 type 补 object，required 只留字符串 */
export function toToolDefinition(name: string, description: string, schema: McpToolInfo["inputSchema"]): ToolDefinition {
  const rawProperties =
    schema?.properties && typeof schema.properties === "object" ? schema.properties : {};
  const sanitized = sanitizeMcpSchema({ type: "object", properties: rawProperties }, 0) as {
    properties?: Record<string, unknown>;
  };
  const required = Array.isArray(schema?.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  return {
    type: "function",
    function: {
      name,
      description: clipMcpText(description, MAX_MCP_TOOL_DESCRIPTION_CHARS),
      parameters: {
        type: "object",
        properties: sanitized.properties ?? {},
        ...(required.length > 0 ? { required } : {}),
      },
    },
  };
}

/** MCP content blocks → ToolResult：text 拼接，image/audio 转附件，resource 给摘要行 */
export function mcpContentToResult(result: McpCallResult): ToolResult {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const texts: string[] = [];
  const images: ToolImage[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    } else if ((block.type === "image" || block.type === "audio") && typeof block.data === "string") {
      const mime = typeof block.mimeType === "string" ? block.mimeType : "application/octet-stream";
      images.push({ data: block.data, mimeType: mime });
      texts.push(`[${block.type}: ${mime}, ${Math.round((block.data.length * 3) / 4)} bytes]`);
    } else if (block.type === "resource" && block.resource) {
      if (typeof block.resource.text === "string") texts.push(block.resource.text);
      else texts.push(`[resource: ${block.resource.uri ?? "unknown"}]`);
    } else if (block.type === "resource_link" && typeof block.uri === "string") {
      texts.push(`[resource link: ${block.uri}${block.name ? ` (${block.name})` : ""}]`);
    } else {
      texts.push(`[${block.type || "unknown"} block]`);
    }
  }
  return { output: texts.join("\n") || "(empty response)", ok: result.isError !== true, ...(images.length > 0 ? { images } : {}) };
}

// ---------------------------------------------------------------------------
// McpManager
// ---------------------------------------------------------------------------

/** 测试注入用：给定配置返回已连接的 client（默认实现内部建 transport 并 connect） */
export type McpClientFactory = (config: McpServerConfig, serverName?: string) => Promise<McpClientLike>;

export type McpClientLike = {
  listTools: (params?: undefined, options?: { timeout?: number }) => Promise<{ tools: McpToolInfo[] }>;
  callTool: (
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { timeout?: number; signal?: AbortSignal },
  ) => Promise<McpCallResult>;
  close: () => Promise<void>;
  /** transport 断开时由 SDK 触发；用于崩溃检测 */
  onclose?: (() => void) | undefined;
};

const LIST_TOOLS_TIMEOUT_MS = 10_000;
const CALL_TOOL_DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RECONNECTS = 3;

/** JSON 形状的深度相等（键序不敏感）：restart 时判断 server 配置是否变化 */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => jsonEqual(item, b[index]))
    );
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const recordA = a as Record<string, unknown>;
    const recordB = b as Record<string, unknown>;
    const keysA = Object.keys(recordA);
    const keysB = Object.keys(recordB);
    return (
      keysA.length === keysB.length &&
      keysA.every((key) => key in recordB && jsonEqual(recordA[key], recordB[key]))
    );
  }
  return false;
}

/** server 凭据指纹：env/headers 里 ${VAR} 按当前进程环境展开后的值集合。
 *  mcp.json 不变但令牌热更新（OAuth 刷新/手动令牌换/清）时指纹变化 → restart 必须重连。 */
function expansionFingerprint(config: McpServerConfig): string {
  const env = Object.entries(config.env ?? {})
    .map(([key, value]) => `${key}=${expandEnvTemplates(value)}`)
    .sort();
  const headers = Object.entries(config.headers ?? {})
    .map(([key, value]) => `${key}=${expandEnvTemplates(value)}`)
    .sort();
  return JSON.stringify([env, headers]);
}

export class McpManager {
  private readonly servers = new Map<
    string,
    {
      config: McpServerConfig;
      client: McpClientLike | null;
      state: McpServerState;
      toolNames: string[];
      reconnects: number;
      /** 断线重连计时器：拆连接时清除，防止已废弃的 entry 再起进程 */
      reconnectTimer?: ReturnType<typeof setTimeout>;
      /** 连接成功时的凭据指纹（见 expansionFingerprint） */
      envFingerprint?: string;
    }
  >();
  private disposed = false;
  /** 拆连接中：拆出来的 close 事件不能再触发重连，否则会多起一个同款 server 进程 */
  private tearingDown = false;
  /**
   * 生命周期串行链：start / restart / dispose 排队执行。
   * 之前并发 start 与 restart 会互相踩：restart 拆掉正在连接中的 client，
   * 那个 client 的 close 事件又触发一次重连 → 同一个 server 起两个进程，
   * 第二份工具注册被「already registered」跳过 → 状态变成 ready: 0 tools。
   */
  private lifecycle: Promise<void> = Promise.resolve();
  private log: (level: "info" | "warn" | "error", ...args: unknown[]) => void = () => undefined;
  private reconnectDelays: number[] = [1_000, 4_000, 16_000];

  constructor(private readonly clientFactory: McpClientFactory = createStdioOrHttpClient) {}

  /** 连接全部启用的 server 并注册工具；单 server 失败不影响其他 server */
  async start(
    servers: Record<string, McpServerConfig>,
    logger?: (level: "info" | "warn" | "error", ...args: unknown[]) => void,
  ): Promise<void> {
    return this.serialize(() => this.startInternal(servers, logger));
  }

  private async startInternal(
    servers: Record<string, McpServerConfig>,
    logger?: (level: "info" | "warn" | "error", ...args: unknown[]) => void,
  ): Promise<void> {
    if (logger) this.log = logger;
    this.disposed = false;
    for (const [name, config] of Object.entries(servers)) {
      if (config.enabled === false) continue;
      this.servers.set(name, { config, client: null, state: { status: "connecting", toolCount: 0 }, toolNames: [], reconnects: 0 });
    }
    await Promise.all([...this.servers.keys()].map((name) => this.connectServer(name)));
  }

  /** 把任务挂到生命周期链上：前一个完成后才跑下一个。 */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.lifecycle.then(task, task);
    this.lifecycle = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  statuses(): Record<string, McpServerState> {
    return Object.fromEntries([...this.servers].map(([name, entry]) => [name, { ...entry.state }]));
  }

  /**
   * 手动发起 OAuth 授权（UI「授权 / 重新授权」按钮的落点）。
   *
   * 连接时的 401 自动授权只在 transport 首次 connect 失败那一刻触发一次；失败后 entry 停在
   * failed 不会自己重来，用户也没有重试入口——所以需要这条显式通道。
   * force：先清掉本机 token。ensureAuthorized 见到已有 token 会直接返回，不清就弹不出授权页。
   */
  async authorize(name: string, options: { force?: boolean } = {}): Promise<void> {
    const entry = this.servers.get(name);
    if (!entry) throw new Error(`unknown MCP server "${name}"`);
    if (typeof entry.config.url !== "string" || entry.config.url.length === 0) {
      throw new Error(`MCP server "${name}" is not an HTTP server; OAuth does not apply`);
    }
    const homeDir = process.env.MEOWCODE_HOME_DIR || os.homedir();
    const provider = createMcpOAuthProvider(entry.config, name, homeDir);
    // prepare() 先起回环监听：redirectUrl 缺位时 SDK 会走 non-interactive 换 token，首次授权必败
    await provider.prepare();
    try {
      if (options.force) await provider.clearTokens();
      await provider.ensureAuthorized();
    } finally {
      await provider.close();
    }
    // 授权完成才进生命周期链重连：等用户点浏览器期间不该堵住 reload 和其他 server
    await this.serialize(async () => {
      const current = this.servers.get(name);
      if (!current) return; // 授权期间被卸载/停用了
      await this.teardownServer(name);
      current.reconnects = 0;
      current.state = { status: "connecting", toolCount: 0 };
      await this.connectServer(name);
    });
  }

  /**
   * 解除授权：清掉本机保存的 token 并断开连接，状态回到 needs_auth。
   * 与 authorize 相对，给「换个账号 / 不想再连了」一个出口。
   * 只清 tokens 与 codeVerifier（保留 DCR 的 clientInformation，下次授权不必重新注册）。
   */
  async revoke(name: string): Promise<void> {
    const entry = this.servers.get(name);
    if (!entry) throw new Error(`unknown MCP server "${name}"`);
    if (typeof entry.config.url !== "string" || entry.config.url.length === 0) {
      throw new Error(`MCP server "${name}" is not an HTTP server; OAuth does not apply`);
    }
    const homeDir = process.env.MEOWCODE_HOME_DIR || os.homedir();
    await createMcpOAuthProvider(entry.config, name, homeDir).clearTokens();
    // 断开也进生命周期链：别和并发的 reload / 授权抢同一个 server
    await this.serialize(async () => {
      const current = this.servers.get(name);
      if (!current) return; // 解除期间被卸载/停用了
      await this.teardownServer(name);
      current.reconnects = 0;
      current.state = { status: "needs_auth", toolCount: 0 };
      this.log("info", `mcp server "${name}" authorization revoked`);
    });
  }

  async callTool(
    server: string,
    tool: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const entry = this.servers.get(server);
    if (!entry?.client) {
      return { output: `MCP server "${server}" is not connected.`, ok: false };
    }
    const timeoutMs = entry.config.timeoutMs ?? CALL_TOOL_DEFAULT_TIMEOUT_MS;
    try {
      const result = await entry.client.callTool(
        { name: tool, arguments: input },
        undefined,
        { timeout: timeoutMs, ...(signal ? { signal } : {}) },
      );
      return mcpContentToResult(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { output: `MCP tool call failed: ${message}`, ok: false };
    }
  }

  /** 全部断开（stdio 会连带 kill 子进程）；3s 兜底强关 */
  async dispose(): Promise<void> {
    await this.serialize(async () => {
      this.disposed = true;
      await this.teardown();
      for (const entry of this.servers.values()) {
        entry.state = { status: "failed", toolCount: 0, error: "disposed" };
      }
    });
  }

  /**
   * 重载（diff 式）：配置未变的 server 原样保留——不拆连接不重连，工具不闪断；
   * 只拆「被移除 / 被禁用 / 配置变化 / 凭据指纹变化」的，只连「新增 / 变化 / 此前失败」的。
   * 市场装/卸载单个 MCP 不再让其余 npx server 全部重启（每个都要付冷启动成本）；
   * 令牌热更新（OAuth 刷新、手动令牌换/清）不改 mcp.json，靠指纹变化触发重连。
   */
  async restart(servers: Record<string, McpServerConfig>): Promise<void> {
    await this.serialize(async () => {
      this.disposed = false;
      for (const name of this.servers.keys()) {
        const entry = this.servers.get(name)!;
        const next = servers[name];
        if (
          !next ||
          next.enabled === false ||
          !jsonEqual(entry.config, next) ||
          (entry.client !== null && entry.envFingerprint !== expansionFingerprint(next))
        ) {
          await this.teardownServer(name);
          this.servers.delete(name);
        }
      }
      const toConnect: string[] = [];
      for (const [name, config] of Object.entries(servers)) {
        if (config.enabled === false) continue;
        const entry = this.servers.get(name);
        if (!entry) {
          this.servers.set(name, {
            config,
            client: null,
            state: { status: "connecting", toolCount: 0 },
            toolNames: [],
            reconnects: 0,
          });
          toConnect.push(name);
        } else if (!entry.client && entry.state.status !== "connecting") {
          // 此前失败/已断开且没有连接在途：借 reload 的机会重试
          entry.state = { status: "connecting", toolCount: 0 };
          toConnect.push(name);
        }
      }
      await Promise.all(toConnect.map((name) => this.connectServer(name)));
    });
  }

  /** 拆单个 server：摘工具 + 清重连计时器 + 关连接（3s 兜底）；预期内的关闭不触发重连 */
  private async teardownServer(name: string): Promise<void> {
    const entry = this.servers.get(name);
    if (!entry) return;
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = undefined;
    }
    for (const toolName of entry.toolNames) unregisterDynamicTool(toolName);
    entry.toolNames = [];
    const client = entry.client;
    entry.client = null;
    if (!client) return;
    client.onclose = undefined;
    try {
      await Promise.race([
        client.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("close timeout")), 3_000)),
      ]);
    } catch {
      this.log("warn", `mcp client "${name}" close did not finish in time; ignoring`);
    }
  }

  private async teardown(): Promise<void> {
    this.tearingDown = true;
    try {
      await Promise.all([...this.servers.keys()].map((name) => this.teardownServer(name)));
    } finally {
      this.tearingDown = false;
    }
  }

  private async connectServer(name: string): Promise<void> {
    const entry = this.servers.get(name);
    if (!entry || this.disposed) return;
    // 缺凭据（${VAR} 展开为空）不发起连接：拿着空 Bearer 去撞 401 只会刷失败噪音，等热更新补齐再连
    const missing = unresolvedEnvVars(entry.config);
    if (missing.length > 0) {
      entry.client = null;
      entry.state = { status: "unconfigured", toolCount: 0, missingEnv: missing };
      this.log("info", `mcp server "${name}" waiting for credentials: ${missing.join(", ")}`);
      return;
    }
    entry.state = { status: "connecting", toolCount: 0 };
    try {
      const client = await this.clientFactory(entry.config, name);
      client.onclose = () => this.handleClose(name);
      // 连接期间可能已被 restart/dispose 拆掉（entry 被删除或整体替换）：别再注册，关掉走人
      if (this.disposed || this.tearingDown || this.servers.get(name) !== entry) {
        client.onclose = undefined;
        await client.close().catch(() => undefined);
        return;
      }
      entry.client = client;
      entry.envFingerprint = expansionFingerprint(entry.config);
      const { tools } = await client.listTools(undefined, { timeout: LIST_TOOLS_TIMEOUT_MS });
      const registered: string[] = [];
      for (const tool of tools) {
        const dynamicName = `mcp__${name}__${tool.name}`;
        if (hasDynamicTool(dynamicName)) {
          this.log("warn", `tool "${dynamicName}" already registered; skipped`);
          continue;
        }
        const definition = toToolDefinition(
          dynamicName,
          tool.description ?? `(MCP tool ${name}/${tool.name})`,
          tool.inputSchema,
        );
        // annotations 是服务端自述，不可全信：只有 readOnlyHint 明确为 true 才并发；
        // 未声明时按「有副作用、串行」处理。超时用 server 配置（默认 60s）。
        const readOnly = tool.annotations?.readOnlyHint === true;
        const contract: ToolContract = {
          readOnly,
          parallelSafe: readOnly,
          sideEffects: readOnly ? "network" : "system",
          timeoutMs: entry.config.timeoutMs ?? CALL_TOOL_DEFAULT_TIMEOUT_MS,
        };
        registerDynamicTool(dynamicName, {
          definition,
          requiresApproval: entry.config.trust === false,
          contract,
          execute: async (input, _workspace, options) =>
            this.callTool(name, tool.name, (input ?? {}) as Record<string, unknown>, options.signal),
        });
        registered.push(dynamicName);
      }
      entry.toolNames = registered;
      entry.state = { status: "ready", toolCount: registered.length };
      this.log("info", `mcp server "${name}" ready: ${registered.length} tools`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entry.client = null;
      // 401 不是故障：等用户点「授权」。标成 failed 会显示红色失败徽标，也容易让人以为要重装
      if (error instanceof McpAuthRequiredError) {
        // 401 不是故障：标 needs_auth 等用户在市场 MCP 行点「授权」（协议内 OAuth，
        // 起浏览器 + 等回环回调）。连接期绝不自动弹浏览器——启动时被强拉授权页
        // 对不需要该 server 的用户是骚扰；状态徽标 + 「授权」按钮足够引导。
        entry.state = { status: "needs_auth", toolCount: 0, error: message };
        this.log("info", `mcp server "${name}" needs authorization`);
        return;
      }
      entry.state = { status: "failed", toolCount: 0, error: message };
      this.log("error", `mcp server "${name}" failed: ${message}`);
    }
  }

  /** stdio 进程退出 / HTTP 连接断开：摘除工具并指数退避重连，超限标 failed */
  private handleClose(name: string): void {
    const entry = this.servers.get(name);
    if (!entry || this.disposed || this.tearingDown) return;
    for (const toolName of entry.toolNames) unregisterDynamicTool(toolName);
    entry.toolNames = [];
    entry.client = null;
    const attempts = entry.reconnects;
    if (attempts >= MAX_RECONNECTS) {
      entry.state = { status: "failed", toolCount: 0, error: "connection lost; reconnect attempts exhausted" };
      this.log("error", `mcp server "${name}" marked failed after ${attempts} reconnect attempts`);
      return;
    }
    const delay = this.reconnectDelays[Math.min(attempts, this.reconnectDelays.length - 1)];
    entry.reconnects = attempts + 1;
    entry.state = { status: "connecting", toolCount: 0 };
    this.log("warn", `mcp server "${name}" disconnected; reconnect #${attempts + 1} in ${delay}ms`);
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = undefined;
      void this.connectServer(name);
    }, delay);
  }
}

/** 判断连接错误是不是「需要授权」（SDK UnauthorizedError 或 StreamableHTTPError 401）。 */
export function isUnauthorizedError(error: unknown): boolean {
  if (!error) return false;
  const name = (error as { constructor?: { name?: string } })?.constructor?.name;
  if (name === "UnauthorizedError") return true;
  const code = (error as { code?: unknown }).code;
  if (code === 401) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b401\b|unauthorized/i.test(message);
}

/**
 * 按 server 配置构造 OAuth provider。
 * 连接时 401 自动授权与 UI 手动授权共用同一套客户端身份规则（auth 字段缺省 = 探测 CIMD，再退 DCR）。
 */
export function createMcpOAuthProvider(
  config: McpServerConfig,
  serverName: string,
  homeDir: string,
): McpOAuthProvider {
  const url = new URL(expandEnvTemplates(config.url ?? ""));
  return new McpOAuthProvider({
    serverName,
    serverUrl: url.toString(),
    homeDir,
    ...(config.auth?.type === "oauth" && config.auth.scopes?.length ? { scopes: config.auth.scopes } : {}),
    ...(config.auth?.type === "oauth" && config.auth.clientId !== undefined
      ? { clientId: config.auth.clientId }
      : {}),
    ...(config.auth?.type === "oauth" && config.auth.clientMetadataUrl !== undefined
      ? { clientMetadataUrl: config.auth.clientMetadataUrl }
      : {}),
    probeCimd: true,
  });
}

/**
 * 远程 server 回了 401：需要用户点「授权」走交互式 OAuth。
 * 单独成类型，好让 McpManager 标成 needs_auth 而不是 failed——它不是故障。
 */
export class McpAuthRequiredError extends Error {
  constructor(readonly serverName: string) {
    super(`MCP server "${serverName}" requires authorization`);
    this.name = "McpAuthRequiredError";
  }
}

/** 默认工厂：stdio（spawn 子进程）或 streamable HTTP；env/headers 展开 ${VAR}。
 *  HTTP 401 不在这里弹浏览器：交互式授权由 McpManager.authorize 显式触发（UI「授权」按钮）。
 *  连接期等回环回调最长 5 分钟，会把状态一直挂在 connecting 上。
 */
export const createStdioOrHttpClient: McpClientFactory = async (config, serverName): Promise<McpClientLike> => {
  if (typeof config.url === "string" && config.url.length > 0) {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.headers ?? {})) {
      headers[key] = expandEnvTemplates(value);
    }
    const url = new URL(expandEnvTemplates(config.url));
    // config 里写死的 Authorization 优先，且 401 一律当失败（token 由桌面端刷新）
    const hasAuthHeader = Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
    // 已授权的 token 直接当 Bearer 带上，不传 authProvider：
    // SDK 拿到 authProvider 后遇 401 会走 auth() 弹浏览器并等回环回调，连接就卡死了。
    if (!hasAuthHeader) {
      const homeDir = process.env.MEOWCODE_HOME_DIR || os.homedir();
      const tokens = await createMcpOAuthProvider(config, serverName ?? url.host, homeDir)
        .tokens()
        .catch(() => undefined);
      if (tokens?.access_token) headers.Authorization = `Bearer ${tokens.access_token}`;
    }
    const client = new Client({ name: "meowcode", version: "1.4.0" });
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
    try {
      // 裸连：Firecrawl 这类免 key HTTP MCP 直接通
      await client.connect(transport);
      return client as unknown as McpClientLike;
    } catch (error) {
      if (hasAuthHeader || !isUnauthorizedError(error)) throw error;
      throw new McpAuthRequiredError(serverName ?? url.host);
    }
  }
  const client = new Client({ name: "meowcode", version: "1.2.0" });
  if (typeof config.command === "string" && config.command.length > 0) {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    for (const [key, value] of Object.entries(config.env ?? {})) {
      env[key] = expandEnvTemplates(value);
    }
    const transport = new StdioClientTransport({
      command: config.command,
      // args 里的 ${VAR} 也要展开（unresolvedEnvVars 同样扫 args，两者必须对称）
      ...(config.args ? { args: config.args.map((arg) => expandEnvTemplates(arg)) } : {}),
      env,
    });
    await client.connect(transport);
    return client as unknown as McpClientLike;
  }
  throw new Error(`MCP server config needs either "command" (stdio) or "url" (http)`);
};
