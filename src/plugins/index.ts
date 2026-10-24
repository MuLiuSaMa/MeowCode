import { loadPlugins } from "./loader.js";
import { McpManager, readMcpConfig } from "./mcp.js";
import { PluginRegistry } from "./registry.js";
import type { LoadPluginsResult, PluginDescriptor } from "./types.js";

export { PluginRegistry } from "./registry.js";
export { runHook } from "./hooks.js";
export { discoverPlugins, importPluginFactory } from "./loader.js";
export { loadCommandIndex } from "./commands.js";
export type { CommandIndex } from "./commands.js";
export { McpManager, readMcpConfig } from "./mcp.js";
export type { McpServerConfig, McpServerState } from "./mcp.js";
export * from "./types.js";

/**
 * 插件系统门面：server 启动时创建一次，registry 注入每个 AgentRuntime。
 * 组成：进程内 TS 插件（loader/registry）+ MCP 外部工具（mcp）。
 */
export type PluginSystem = {
  registry: PluginRegistry;
  /** MCP server 状态（/plugins 路由数据源） */
  mcp: McpManager;
  /** MCP 工具就绪（后台启动模式下用它做首个回合前的等待；永不 reject） */
  mcpReady: Promise<void>;
  descriptors(): PluginDescriptor[];
  errors(): NonNullable<LoadPluginsResult["errors"]>;
  mcpErrors(): string[];
  /** 重载：清空全部插件注册 → 重新发现加载 → 按需重连 MCP（运行中回合不受影响） */
  reload(options?: { restartMcp?: boolean }): Promise<LoadPluginsResult>;
  dispose(): Promise<void>;
};

export type CreatePluginSystemOptions = {
  workspace: string;
  homeDir: string;
  /** 禁用插件 id 列表（MEOWCODE_PLUGINS / desktop settings） */
  disabled?: readonly string[];
  /**
   * MCP 是否阻塞创建（默认 true）。
   * false 时 createPluginSystem 立刻返回，MCP 在后台连接；调用方应在真正需要
   * 工具列表之前 await `mcpReady`（启动阶段的 MCP 拉起通常是秒级：npx 下载/解析
   * 包 + 子进程启动，没必要让整个 HTTP 服务等它）。
   */
  blockOnMcp?: boolean;
};

export async function createPluginSystem(options: CreatePluginSystemOptions): Promise<PluginSystem> {
  const registry = new PluginRegistry();
  const mcp = new McpManager();
  let last = await loadPlugins({ ...options, registry });

  const mcpConfig = await readMcpConfig(options);
  let currentMcpServers = mcpConfig.servers;
  let currentMcpErrors = mcpConfig.errors;
  const logMcp = (level: "error" | "info" | "warn", ...args: unknown[]): void =>
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)("[mcp]", ...args);
  const startMcp = async (): Promise<void> => {
    if (!Object.keys(mcpConfig.servers).length) return;
    try {
      await mcp.start(mcpConfig.servers, logMcp);
    } catch (error) {
      // 后台启动失败不能变成未处理拒绝：/plugins 会从 mcp.statuses() 显示失败原因
      console.error(`[mcp] background start failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  // mcpReady 永远 resolve：调用方 await 它只是"等工具就绪"，不是"等一个可能失败的操作"
  const mcpReady: Promise<void> = startMcp();
  if (options.blockOnMcp !== false) await mcpReady;

  return {
    registry,
    mcp,
    mcpReady,
    descriptors: () => last.descriptors,
    errors: () => last.errors,
    mcpErrors: () => currentMcpErrors,
    reload: async (reloadOptions?: { restartMcp?: boolean }): Promise<LoadPluginsResult> => {
      registry.unregisterAll();
      last = await loadPlugins({ ...options, registry });
      const nextMcp = await readMcpConfig(options);
      currentMcpErrors = nextMcp.errors;
      // 插件安装/卸载只改 plugins/，没必要重连全部 MCP（npx 启动很慢）；
      // 凭据变更或手动 reload 传 restartMcp 强制重连。
      const configChanged = JSON.stringify(nextMcp.servers) !== JSON.stringify(currentMcpServers);
      if (reloadOptions?.restartMcp || configChanged) {
        currentMcpServers = nextMcp.servers;
        await mcp.restart(nextMcp.servers);
      }
      return last;
    },
    dispose: async (): Promise<void> => {
      registry.unregisterAll();
      await mcp.dispose();
    },
  };
}
