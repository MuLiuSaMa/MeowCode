import { promises as fs } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { hasDynamicTool, registerDynamicTool, unregisterDynamicTool } from "../agent/tools.js";
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
  /** 默认 true：MCP 工具免审批直接执行；显式 false 则该 server 的工具每次调用先弹审批 */
  trust?: boolean;
  /** callTool 超时毫秒，默认 60000 */
  timeoutMs?: number;
  /** false 则跳过该 server */
  enabled?: boolean;
};

export type McpConfigFile = { mcpServers?: Record<string, McpServerConfig> };

export type McpServerState = {
  status: "connecting" | "ready" | "failed";
  toolCount: number;
  error?: string;
};

/** url / headers 值 / env 值里的 ${VAR} 用进程环境变量展开 */
export function expandEnvTemplates(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? "");
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

/** MCP 工具描述上限：很多 server 会把整篇 README 塞进 description，每轮都随 schema 计费。 */
const MAX_MCP_TOOL_DESCRIPTION_CHARS = 1_000;

/** MCP inputSchema → ToolDefinition.parameters：缺 type 补 object，required 只留字符串 */
export function toToolDefinition(name: string, description: string, schema: McpToolInfo["inputSchema"]): ToolDefinition {
  const properties =
    schema?.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = Array.isArray(schema?.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  const clippedDescription =
    description.length > MAX_MCP_TOOL_DESCRIPTION_CHARS
      ? `${description.slice(0, MAX_MCP_TOOL_DESCRIPTION_CHARS)}… [description truncated]`
      : description;
  return {
    type: "function",
    function: {
      name,
      description: clippedDescription,
      parameters: {
        type: "object",
        properties,
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
export type McpClientFactory = (config: McpServerConfig) => Promise<McpClientLike>;

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

export class McpManager {
  private readonly servers = new Map<
    string,
    { config: McpServerConfig; client: McpClientLike | null; state: McpServerState; toolNames: string[]; reconnects: number }
  >();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
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

  /** 重载：断开全部 → 重置状态 → 按新配置重连（保持实例引用稳定） */
  async restart(servers: Record<string, McpServerConfig>): Promise<void> {
    await this.serialize(async () => {
      await this.teardown();
      this.servers.clear();
      await this.startInternal(servers, this.log);
    });
  }

  private async teardown(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.tearingDown = true;
    await Promise.all(
      [...this.servers.values()].map(async (entry) => {
        if (!entry.client) return;
        const client = entry.client;
        entry.client = null;
        try {
          await Promise.race([
            client.close(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("close timeout")), 3_000)),
          ]);
        } catch {
          this.log("warn", "mcp client close did not finish in time; ignoring");
        }
      }),
    );
    for (const entry of this.servers.values()) {
      for (const toolName of entry.toolNames) unregisterDynamicTool(toolName);
      entry.toolNames = [];
    }
    this.tearingDown = false;
  }

  private async connectServer(name: string): Promise<void> {
    const entry = this.servers.get(name);
    if (!entry || this.disposed) return;
    entry.state = { status: "connecting", toolCount: 0 };
    try {
      const client = await this.clientFactory(entry.config);
      client.onclose = () => this.handleClose(name);
      // 连接期间可能已被 restart/dispose 拆掉：这时别再注册工具，否则会留下孤儿工具
      if (this.disposed || this.tearingDown) {
        await client.close().catch(() => undefined);
        return;
      }
      entry.client = client;
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
        registerDynamicTool(dynamicName, {
          definition,
          requiresApproval: entry.config.trust === false,
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
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.connectServer(name);
    }, delay);
    this.timers.add(timer);
  }
}

/** 默认工厂：stdio（spawn 子进程）或 streamable HTTP；env/headers 展开 ${VAR} */
export const createStdioOrHttpClient: McpClientFactory = async (config): Promise<McpClientLike> => {
  const client = new Client({ name: "meowcode", version: "0.1.0" });
  if (typeof config.url === "string" && config.url.length > 0) {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.headers ?? {})) {
      headers[key] = expandEnvTemplates(value);
    }
    const transport = new StreamableHTTPClientTransport(new URL(expandEnvTemplates(config.url)), {
      requestInit: { headers },
    });
    await client.connect(transport);
    return client as unknown as McpClientLike;
  }
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
      ...(config.args ? { args: config.args } : {}),
      env,
    });
    await client.connect(transport);
    return client as unknown as McpClientLike;
  }
  throw new Error(`MCP server config needs either "command" (stdio) or "url" (http)`);
};
