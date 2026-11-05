import { promises as fs } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// 类型（Claude Code settings.json 的 hooks 子集）
// ---------------------------------------------------------------------------

export type HookCommand = { type: "command"; command: string; timeout?: number };
export type HookMatcherGroup = {
  matcher?: string;
  hooks: HookCommand[];
  /** 来源文件（内部字段，不写回 CC 配置） */
  source?: string;
};
export type ClaudeSettings = { hooks?: Record<string, HookMatcherGroup[]> };

/** Claude Code 事件名 → MeowCode hook 名 */
export const EVENT_MAP = {
  PreToolUse: "tool_call",
  PostToolUse: "tool_result",
  PermissionRequest: "permission_request",
  UserPromptSubmit: "prompt_submit",
  Stop: "turn_stop",
  // SubagentStop 仍走 turn_stop：CC 支持 decision:block 让子 Agent 继续，观察类的
  // subagent_stop 做不到这一点，语义保持原样
  SubagentStop: "turn_stop",
  SessionStart: "session_start",
  SessionEnd: "session_end",
  SubagentStart: "subagent_start",
  PreCompact: "compaction_start",
  PostCompact: "compaction_end",
} as const;

export type ClaudeEvent = keyof typeof EVENT_MAP;

/** 已桥接的 CC 事件，用于设置页摘要排序 */
export const CLAUDE_EVENTS = Object.keys(EVENT_MAP) as ClaudeEvent[];

export type HooksLayer = "user" | "project" | "local";
export type HooksScope = { user: boolean; workspace: boolean };
export type HooksRunMode = "auto" | "ask";

export type SettingsLayerFile = {
  layer: HooksLayer;
  path: string;
  exists: boolean;
  error?: string;
  settings: ClaudeSettings;
};

export type HooksConfigSnapshot = {
  layers: SettingsLayerFile[];
  /** 过滤掉被 scope 排除的层之后的合并结果（执行用） */
  groups: Record<string, HookMatcherGroup[]>;
  scope: HooksScope;
  runMode: HooksRunMode;
};

export type HooksSummaryCommand = {
  event: ClaudeEvent;
  layer: HooksLayer;
  source: string;
  matcher?: string;
  command: string;
  timeout: number;
  /** 该层被 scope 排除：只展示、不执行 */
  excluded: boolean;
};

export type HooksSummary = {
  runMode: HooksRunMode;
  scope: HooksScope;
  files: Array<{
    layer: HooksLayer;
    path: string;
    exists: boolean;
    error?: string;
    excluded: boolean;
    commands: number;
  }>;
  events: Array<{ event: ClaudeEvent; commands: HooksSummaryCommand[] }>;
  totalCommands: number;
  unsupportedEvents: Array<{ event: string; count: number }>;
};

// ---------------------------------------------------------------------------
// 工具名别名 / 输入形态映射
// ---------------------------------------------------------------------------

/** MeowCode 内部工具名 → Claude Code 别名（第一个用于 stdin 的 tool_name） */
export const CC_TOOL_ALIASES: Record<string, readonly string[]> = {
  run_command: ["Bash"],
  read_file: ["Read"],
  write_file: ["Write"],
  edit_file: ["Edit"],
  multi_edit: ["MultiEdit"],
  glob: ["Glob"],
  grep: ["Grep"],
  list_dir: ["LS"],
  task: ["Task", "Agent"],
  update_plan: ["TodoWrite"],
};

export const INTERNAL_TO_CC: Record<string, string> = Object.fromEntries(
  Object.entries(CC_TOOL_ALIASES).map(([internal, aliases]) => [internal, aliases[0]]),
);

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * 内部工具参数 → CC hook 里的 tool_input。
 * 同时保留内部字段和 CC 字段，CC 脚本读 file_path / old_string 等能直接工作，
 * MeowCode 自带脚本读 path / oldString 也不受影响。
 */
export function toClaudeToolInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  const set = (key: string, value: unknown): void => {
    if (value !== undefined) out[key] = value;
  };
  switch (tool) {
    case "read_file":
    case "write_file":
      set("file_path", input.path);
      break;
    case "edit_file":
      set("file_path", input.path);
      set("old_string", input.oldString);
      set("new_string", input.newString);
      set("replace_all", input.replaceAll);
      break;
    case "multi_edit": {
      set("file_path", input.path);
      const edits = Array.isArray(input.edits) ? input.edits : [];
      out.edits = edits.map((raw) => {
        const edit = recordOf(raw);
        return {
          ...edit,
          ...(edit.oldString !== undefined ? { old_string: edit.oldString } : {}),
          ...(edit.newString !== undefined ? { new_string: edit.newString } : {}),
          ...(edit.replaceAll !== undefined ? { replace_all: edit.replaceAll } : {}),
        };
      });
      if (out.file_path === undefined) {
        const first = edits.map(recordOf).find((edit) => typeof edit.path === "string");
        if (first) out.file_path = first.path;
      }
      break;
    }
    case "task":
      set("subagent_type", input.agent_type);
      break;
    case "update_plan": {
      const steps = Array.isArray(input.steps) ? input.steps : [];
      out.todos = steps.map((raw) => {
        const step = recordOf(raw);
        return {
          content: step.title,
          status: step.status,
          activeForm: step.title,
        };
      });
      break;
    }
    default:
      break;
  }
  return out;
}

/**
 * CC hook 返回的 updatedInput → 内部工具参数。
 * CC 字段优先（hook 脚本按 CC 形态改写）；未知字段原样保留，交给 runtime
 * 的 validateToolArguments 决定是否放行。
 */
export function fromClaudeToolInput(tool: string, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  const moveString = (from: string, to: string): void => {
    if (typeof out[from] === "string") out[to] = out[from];
    delete out[from];
  };
  switch (tool) {
    case "read_file":
    case "write_file":
      moveString("file_path", "path");
      break;
    case "edit_file":
      moveString("file_path", "path");
      moveString("old_string", "oldString");
      moveString("new_string", "newString");
      if (typeof out.replace_all === "boolean") out.replaceAll = out.replace_all;
      delete out.replace_all;
      break;
    case "multi_edit": {
      moveString("file_path", "path");
      const edits = Array.isArray(out.edits) ? out.edits : [];
      out.edits = edits.map((rawEdit) => {
        const edit = recordOf(rawEdit);
        const next: Record<string, unknown> = { ...edit };
        if (typeof next.old_string === "string") next.oldString = next.old_string;
        if (typeof next.new_string === "string") next.newString = next.new_string;
        if (typeof next.replace_all === "boolean") next.replaceAll = next.replace_all;
        delete next.old_string;
        delete next.new_string;
        delete next.replace_all;
        return next;
      });
      break;
    }
    case "task":
      moveString("subagent_type", "agent_type");
      break;
    case "update_plan": {
      const todos = Array.isArray(out.todos) ? out.todos : null;
      if (todos) {
        out.steps = todos.map((rawTodo) => {
          const todo = recordOf(rawTodo);
          return {
            title: todo.content,
            status: todo.status,
          };
        });
      }
      delete out.todos;
      break;
    }
    default:
      break;
  }
  return out;
}

/** 设置页展示用的 CC 工具名（未映射的工具返回原名） */
export function claudeToolName(tool: string): string {
  return INTERNAL_TO_CC[tool] ?? tool;
}

export function permissionModeFor(approvalMode: string, chatMode?: string): string {
  if (chatMode === "plan") return "plan";
  switch (approvalMode) {
    case "full":
      return "bypassPermissions";
    case "auto":
      return "acceptEdits";
    case "read-only":
      return "plan";
    default:
      return "default";
  }
}

// ---------------------------------------------------------------------------
// settings 读取 / 合并 / scope
// ---------------------------------------------------------------------------

/** 各 settings 文件路径（顺序 = 优先级从低到高）。 */
export function settingsPaths(homeDir: string, workspace: string): string[] {
  return settingsLayers(homeDir, workspace).map((entry) => entry.path);
}

export function settingsLayers(
  homeDir: string,
  workspace: string,
): Array<{ layer: HooksLayer; path: string }> {
  return [
    { layer: "user", path: path.join(homeDir, ".claude", "settings.json") },
    { layer: "project", path: path.join(workspace, ".claude", "settings.json") },
    { layer: "local", path: path.join(workspace, ".claude", "settings.local.json") },
  ];
}

/** 读一份 settings.json；不存在 / 解析失败都返回 {}（CC 对坏文件是跳过并告警）。 */
export async function readClaudeSettings(file: string): Promise<ClaudeSettings> {
  const result = await readSettingsFile(file);
  return result.settings;
}

export async function readSettingsFile(
  file: string,
): Promise<{ exists: boolean; settings: ClaudeSettings; error?: string }> {
  try {
    const raw = await fs.readFile(file, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return {
        exists: true,
        settings: {},
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const record = recordOf(parsed);
    if (!record.hooks) return { exists: true, settings: {} };
    return { exists: true, settings: { hooks: record.hooks as Record<string, HookMatcherGroup[]> } };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { exists: false, settings: {} };
    return {
      exists: false,
      settings: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 合并多份 settings 的 hooks 配置：数组按传入顺序拼接（调用方保证
 * user → project → local），同一事件的全部 group 都会执行。
 */
export function mergeHookGroups(
  ...settingsList: ClaudeSettings[]
): Record<string, HookMatcherGroup[]> {
  const merged: Record<string, HookMatcherGroup[]> = {};
  for (const settings of settingsList) {
    const hooks = settings.hooks;
    if (!hooks) continue;
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue;
      merged[event] = [...(merged[event] ?? []), ...groups];
    }
  }
  return merged;
}

/** matcher 是工具名正则（仅工具类事件）；空 / "*" / 缺失 = 全部匹配。 */
export function groupsForTool(groups: HookMatcherGroup[], toolName: string): HookMatcherGroup[] {
  const aliases = CC_TOOL_ALIASES[toolName] ?? [];
  const candidates = [toolName, ...aliases];
  const matched: HookMatcherGroup[] = [];
  for (const group of groups) {
    const matcher = group.matcher?.trim();
    if (!matcher || matcher === "*") {
      matched.push(group);
      continue;
    }
    try {
      const regex = new RegExp(matcher);
      if (candidates.some((name) => regex.test(name))) matched.push(group);
    } catch {
      // 非法正则：跳过该组（与 CC 一致——配置错误不该放大成全部放行/全部拦截）
    }
  }
  return matched;
}

export function parseHooksScope(raw: string | undefined): HooksScope {
  const fallback: HooksScope = { user: true, workspace: false };
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as { user?: unknown; workspace?: unknown };
    return {
      user: parsed?.user !== false,
      workspace: parsed?.workspace === true,
    };
  } catch {
    return fallback;
  }
}

export function parseRunMode(raw: string | undefined): HooksRunMode {
  return raw === "ask" ? "ask" : "auto";
}

export function scopeAllows(layer: HooksLayer, scope: HooksScope): boolean {
  return layer === "user" ? scope.user : scope.workspace;
}

// ---------------------------------------------------------------------------
// 带缓存的加载 + 设置页摘要
// ---------------------------------------------------------------------------

type CacheEntry = {
  signature: string;
  loadedAt: number;
  layers: SettingsLayerFile[];
};

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 2_000;

async function signatureOf(files: Array<{ path: string }>): Promise<string> {
  const parts: string[] = [];
  for (const file of files) {
    try {
      const stat = await fs.stat(file.path);
      parts.push(`${file.path}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      parts.push(`${file.path}:missing`);
    }
  }
  return parts.join("|");
}

/** 供测试清缓存 */
export function clearHooksConfigCache(): void {
  cache.clear();
}

export async function loadHooksConfig(options: {
  homeDir: string;
  workspace: string;
  scope: HooksScope;
  runMode: HooksRunMode;
  fresh?: boolean;
}): Promise<HooksConfigSnapshot> {
  const entries = settingsLayers(options.homeDir, options.workspace);
  const key = entries.map((entry) => entry.path).join("|");
  const signature = await signatureOf(entries);
  const cached = cache.get(key);
  const now = Date.now();
  let layers: SettingsLayerFile[];
  if (!options.fresh && cached && cached.signature === signature && now - cached.loadedAt < CACHE_TTL_MS) {
    layers = cached.layers;
  } else {
    layers = await Promise.all(
      entries.map(async ({ layer, path: file }) => {
        const read = await readSettingsFile(file);
        return {
          layer,
          path: file,
          exists: read.exists,
          ...(read.error ? { error: read.error } : {}),
          settings: read.settings,
        };
      }),
    );
    cache.set(key, { signature, loadedAt: now, layers });
  }

  const executable = layers.filter((layer) => scopeAllows(layer.layer, options.scope));
  const groups: Record<string, HookMatcherGroup[]> = {};
  for (const layer of executable) {
    for (const [event, list] of Object.entries(layer.settings.hooks ?? {})) {
      if (!Array.isArray(list)) continue;
      groups[event] = [
        ...(groups[event] ?? []),
        ...list.map((group) => ({ ...group, source: layer.path })),
      ];
    }
  }
  return { layers, groups, scope: options.scope, runMode: options.runMode };
}

export function summarizeHooks(config: HooksConfigSnapshot): HooksSummary {
  const events: HooksSummary["events"] = [];
  const unsupported = new Map<string, number>();
  let totalCommands = 0;
  const perLayer = new Map<HooksLayer, number>();

  for (const layer of config.layers) {
    const excluded = !scopeAllows(layer.layer, config.scope);
    let layerCount = 0;
    for (const [event, groups] of Object.entries(layer.settings.hooks ?? {})) {
      if (!Array.isArray(groups)) continue;
      let entry = events.find((item) => item.event === event);
      if (!(event in EVENT_MAP)) {
        const count = groups.reduce((sum, group) => sum + (group.hooks?.length ?? 0), 0);
        layerCount += count;
        unsupported.set(event, (unsupported.get(event) ?? 0) + count);
        continue;
      }
      if (!entry) {
        entry = { event: event as ClaudeEvent, commands: [] };
        events.push(entry);
      }
      for (const group of groups) {
        for (const command of group.hooks ?? []) {
          if (command.type !== "command" || !command.command) continue;
          layerCount += 1;
          if (!excluded) totalCommands += 1;
          entry.commands.push({
            event: event as ClaudeEvent,
            layer: layer.layer,
            source: layer.path,
            ...(group.matcher ? { matcher: group.matcher } : {}),
            command: command.command,
            timeout: command.timeout ?? 60,
            excluded,
          });
        }
      }
    }
    perLayer.set(layer.layer, layerCount);
  }

  return {
    runMode: config.runMode,
    scope: config.scope,
    files: config.layers.map((layer) => ({
      layer: layer.layer,
      path: layer.path,
      exists: layer.exists,
      ...(layer.error ? { error: layer.error } : {}),
      excluded: !scopeAllows(layer.layer, config.scope),
      commands: perLayer.get(layer.layer) ?? 0,
    })),
    events: events.sort(
      (a, b) => CLAUDE_EVENTS.indexOf(a.event) - CLAUDE_EVENTS.indexOf(b.event),
    ),
    totalCommands,
    unsupportedEvents: [...unsupported].map(([event, count]) => ({ event, count })),
  };
}
