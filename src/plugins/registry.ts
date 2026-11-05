import {
  registerDynamicTool,
  unregisterDynamicTool,
  type ToolRunOptions,
} from "../agent/tools.js";
import type { ToolDefinition, ToolResult } from "../agent/types.js";
import { createPluginStorage } from "./storage.js";
import type {
  PluginAPI,
  PluginCommand,
  PluginCommandInfo,
  PluginDescriptor,
  PluginHandler,
  PluginHookName,
  PluginLogger,
  PluginSource,
  PluginTool,
} from "./types.js";

/**
 * 运行时唯一插件查询入口：持有已加载插件记录、hook handler 分桶、命令索引。
 * 工具的执行本体注册进 agent/tools.ts 的动态工具表，registry 只记录归属
 * （哪个插件注册了哪些名字），reload 时按归属精确摘除。
 */
export class PluginRegistry {
  private readonly plugins = new Map<string, { source: PluginSource; path: string }>();
  private readonly hooks = new Map<PluginHookName, Array<{ pluginId: string; handler: (event: never) => unknown }>>();
  private readonly commands = new Map<string, { pluginId: string; cmd: PluginCommand }>();
  private readonly toolOwners = new Map<string, string>(); // toolName -> pluginId（仅记录经 registry 注册的）

  /** 由 loader 在注册前登记；同一 id 重复加载前应先 rollback */
  addPlugin(id: string, source: PluginSource, path: string): void {
    this.plugins.set(id, { source, path });
  }

  /** 工厂执行失败时回滚该插件的部分注册，避免半残插件留在运行时 */
  rollbackPlugin(id: string): void {
    for (const [name, owner] of this.toolOwners) {
      if (owner === id) {
        unregisterDynamicTool(name);
        this.toolOwners.delete(name);
      }
    }
    for (const [event, list] of this.hooks) {
      const kept = list.filter((h) => h.pluginId !== id);
      if (kept.length !== list.length) this.hooks.set(event, kept);
    }
    for (const [name, entry] of this.commands) {
      if (entry.pluginId === id) this.commands.delete(name);
    }
  }

  // ---- 工具 ----

  addTool(pluginId: string, tool: PluginTool): { ok: boolean; error?: string } {
    const definition: ToolDefinition = {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object",
          properties: tool.parameters.properties ?? {},
          ...(tool.parameters.required ? { required: tool.parameters.required } : {}),
          ...(tool.parameters.additionalProperties !== undefined
            ? { additionalProperties: tool.parameters.additionalProperties }
            : {}),
        },
      },
    };
    const result = registerDynamicTool(tool.name, {
      definition,
      ...(tool.requiresApproval !== undefined ? { requiresApproval: tool.requiresApproval } : {}),
      ...(tool.contract !== undefined ? { contract: tool.contract } : {}),
      execute: (input: unknown, workspace: string, options: ToolRunOptions): Promise<ToolResult> =>
        tool.execute((input ?? {}) as Record<string, unknown>, {
          workspace,
          ...(options.signal ? { signal: options.signal } : {}),
          logger: this.loggerOf(pluginId),
        }),
    });
    if (result.ok) this.toolOwners.set(tool.name, pluginId);
    return result;
  }

  toolNamesOf(pluginId: string): string[] {
    return [...this.toolOwners].filter(([, owner]) => owner === pluginId).map(([name]) => name);
  }

  // ---- hooks ----

  addHook<N extends PluginHookName>(pluginId: string, event: N, handler: PluginHandler<N>): void {
    let list = this.hooks.get(event);
    if (!list) {
      list = [];
      this.hooks.set(event, list);
    }
    list.push({ pluginId, handler: handler as (event: never) => unknown });
  }

  getHookHandlers(event: PluginHookName): ReadonlyArray<{ pluginId: string; handler: (event: never) => unknown }> {
    return this.hooks.get(event) ?? [];
  }

  hasHooks(event: PluginHookName): boolean {
    return (this.hooks.get(event)?.length ?? 0) > 0;
  }

  hookEventsOf(pluginId: string): string[] {
    return [...this.hooks]
      .filter(([, list]) => list.some((h) => h.pluginId === pluginId))
      .map(([event]) => event);
  }

  /** hook handler 抛错时由 dispatcher 调用；只记日志，不影响回合 */
  reportHandlerError(pluginId: string, hook: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[plugin:${pluginId}] hook "${hook}" handler failed:`, message);
  }

  // ---- 命令 ----

  addCommand(pluginId: string, cmd: PluginCommand): boolean {
    if (this.commands.has(cmd.name)) return false;
    this.commands.set(cmd.name, { pluginId, cmd });
    return true;
  }

  getCommand(name: string): { pluginId: string; cmd: PluginCommand } | undefined {
    return this.commands.get(name);
  }

  listCommands(): PluginCommandInfo[] {
    return [...this.commands.entries()].map(([name, { pluginId, cmd }]) => ({
      name,
      ...(cmd.description !== undefined ? { description: cmd.description } : {}),
      source: `plugin:${pluginId}`,
    }));
  }

  // ---- 描述（UI 数据源）----

  listDescriptors(): PluginDescriptor[] {
    return [...this.plugins.entries()].map(([id, meta]) => {
      const toolNames = this.toolNamesOf(id);
      const commandNames = [...this.commands]
        .filter(([, entry]) => entry.pluginId === id)
        .map(([name]) => name);
      const hookEvents = this.hookEventsOf(id);
      return {
        id,
        path: meta.path,
        source: meta.source,
        enabled: true,
        ...(toolNames.length > 0 ? { toolNames } : {}),
        ...(commandNames.length > 0 ? { commandNames } : {}),
        ...(hookEvents.length > 0 ? { hookEvents } : {}),
      };
    });
  }

  // ---- 生命周期 ----

  /** reload / dispose 时清空全部经 registry 的注册（MCP 工具由 mcp 模块自行管理） */
  unregisterAll(): void {
    for (const name of this.toolOwners.keys()) unregisterDynamicTool(name);
    this.toolOwners.clear();
    this.hooks.clear();
    this.commands.clear();
    this.plugins.clear();
  }

  // ---- 插件 API 工厂 ----

  /** 为一个插件实例构造受限 API 门面（对齐 opencode 的 Context 收窄思路） */
  createApi(pluginId: string, workspace: string, homeDir: string): PluginAPI {
    const logger = this.loggerOf(pluginId);
    return {
      registerTool: (tool: PluginTool): void => {
        const result = this.addTool(pluginId, tool);
        if (!result.ok) logger.warn(`registerTool("${tool.name}") rejected: ${result.error}`);
      },
      on: <N extends PluginHookName>(event: N, handler: PluginHandler<N>): void => {
        this.addHook(pluginId, event, handler);
      },
      registerCommand: (cmd: PluginCommand): void => {
        if (!this.addCommand(pluginId, cmd)) {
          logger.warn(`registerCommand("${cmd.name}") rejected: name already taken`);
        }
      },
      storage: createPluginStorage(pluginId, homeDir),
      logger,
      workspace,
    };
  }

  private loggerOf(pluginId: string): PluginLogger {
    return {
      info: (...args: unknown[]) => console.log(`[plugin:${pluginId}]`, ...args),
      warn: (...args: unknown[]) => console.warn(`[plugin:${pluginId}]`, ...args),
      error: (...args: unknown[]) => console.error(`[plugin:${pluginId}]`, ...args),
    };
  }
}
