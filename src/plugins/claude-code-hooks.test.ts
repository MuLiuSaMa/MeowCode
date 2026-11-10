import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPayload,
  claudeCodeHooksPlugin,
  groupsForTool,
  mergeHookGroups,
  readClaudeSettings,
  runGroups,
  settingsPaths,
  translateOutcome,
  type HookCommandRunner,
} from "./builtin/claude-code-hooks/index.js";
import {
  clearHooksConfigCache,
  fromClaudeToolInput,
  loadHooksConfig,
  parseHooksScope,
  parseRunMode,
  summarizeHooks,
  toClaudeToolInput,
} from "./builtin/claude-code-hooks/config.js";
import type { PluginAPI, PluginCommand, PluginHandler } from "./types.js";
import { PLUGIN_PERMISSIONS } from "./types.js";

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

describe("settings 读取 / 合并 / scope", () => {
  it("文件不存在 / 坏 JSON / 无 hooks 键都返回空", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-cc-"));
    expect(await readClaudeSettings(path.join(dir, "nope.json"))).toEqual({});
    const bad = path.join(dir, "bad.json");
    await fs.writeFile(bad, "{not json", "utf8");
    expect(await readClaudeSettings(bad)).toEqual({});
    const empty = path.join(dir, "empty.json");
    await fs.writeFile(empty, JSON.stringify({ theme: "dark" }), "utf8");
    expect(await readClaudeSettings(empty)).toEqual({});
  });

  it("按传入顺序拼接同一事件的组", () => {
    const user = { hooks: { Stop: [{ hooks: [{ type: "command" as const, command: "a" }] }] } };
    const local = { hooks: { Stop: [{ hooks: [{ type: "command" as const, command: "b" }] }] } };
    const merged = mergeHookGroups(user, {}, local);
    expect(merged.Stop).toHaveLength(2);
    expect(merged.Stop[1].hooks[0].command).toBe("b");
  });

  it("settingsPaths 三层顺序 user → project → local", () => {
    expect(settingsPaths("/home/u", "/ws")).toEqual([
      path.join("/home/u", ".claude", "settings.json"),
      path.join("/ws", ".claude", "settings.json"),
      path.join("/ws", ".claude", "settings.local.json"),
    ]);
  });

  it("scope / run mode 解析：工作区默认关闭，运行方式默认 auto", () => {
    expect(parseHooksScope(undefined)).toEqual({ user: true, workspace: false });
    expect(parseHooksScope(JSON.stringify({ user: false, workspace: true }))).toEqual({
      user: false,
      workspace: true,
    });
    expect(parseHooksScope("{bad")).toEqual({ user: true, workspace: false });
    expect(parseRunMode(undefined)).toBe("auto");
    expect(parseRunMode("ask")).toBe("ask");
    expect(parseRunMode("nonsense")).toBe("auto");
  });

  it("loadHooksConfig 按 scope 过滤执行层，并标注来源", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "mc-cc-home-"));
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "mc-cc-ws-"));
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    await fs.mkdir(path.join(ws, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "user" }] }] } }),
    );
    await fs.writeFile(
      path.join(ws, ".claude", "settings.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "project" }] }] } }),
    );
    const config = await loadHooksConfig({
      homeDir: home,
      workspace: ws,
      scope: { user: true, workspace: false },
      runMode: "auto",
      fresh: true,
    });
    expect(config.groups.Stop).toHaveLength(1);
    expect(config.groups.Stop[0].source).toBe(path.join(home, ".claude", "settings.json"));
    const summary = summarizeHooks(config);
    expect(summary.totalCommands).toBe(1);
    expect(summary.files.find((file) => file.layer === "project")?.excluded).toBe(true);
    expect(summary.events[0]?.commands.find((c) => c.layer === "project")?.excluded).toBe(true);
    clearHooksConfigCache();
  });
});

describe("CC 工具别名与输入映射", () => {
  const group = (matcher?: string, command = "c") => ({
    ...(matcher !== undefined ? { matcher } : {}),
    hooks: [{ type: "command" as const, command }],
  });

  it("空 / 星号匹配全部；CC 别名与内部名都匹配", () => {
    expect(groupsForTool([group()], "run_command")).toHaveLength(1);
    expect(groupsForTool([group("*")], "run_command")).toHaveLength(1);
    expect(groupsForTool([group("Bash|Edit")], "run_command")).toHaveLength(1);
    expect(groupsForTool([group("Bash|Edit")], "edit_file")).toHaveLength(1);
    expect(groupsForTool([group("Bash|Edit")], "read_file")).toHaveLength(0);
    expect(groupsForTool([group("^run_")], "run_command")).toHaveLength(1);
    expect(groupsForTool([group("Task|Agent")], "task")).toHaveLength(1);
  });

  it("非法正则跳过而不是误放行", () => {
    expect(groupsForTool([group("([")], "run_command")).toHaveLength(0);
  });

  it("内部参数 → CC tool_input 同时保留两套字段", () => {
    expect(toClaudeToolInput("read_file", { path: "a.ts", offset: 2 })).toMatchObject({
      path: "a.ts",
      file_path: "a.ts",
      offset: 2,
    });
    expect(
      toClaudeToolInput("edit_file", {
        path: "a.ts",
        oldString: "old",
        newString: "new",
        replaceAll: true,
      }),
    ).toMatchObject({
      file_path: "a.ts",
      old_string: "old",
      new_string: "new",
      replace_all: true,
    });
    expect(
      toClaudeToolInput("update_plan", {
        steps: [{ title: "one", status: "in_progress" }],
      }),
    ).toMatchObject({ todos: [{ content: "one", status: "in_progress" }] });
  });

  it("updatedInput 反向映射回内部字段", () => {
    expect(fromClaudeToolInput("read_file", { file_path: "b.ts" })).toEqual({ path: "b.ts" });
    expect(
      fromClaudeToolInput("edit_file", {
        file_path: "b.ts",
        old_string: "a",
        new_string: "b",
      }),
    ).toEqual({ path: "b.ts", oldString: "a", newString: "b" });
    expect(
      fromClaudeToolInput("multi_edit", {
        file_path: "b.ts",
        edits: [{ old_string: "a", new_string: "b" }],
      }),
    ).toEqual({ path: "b.ts", edits: [{ oldString: "a", newString: "b" }] });
    expect(
      fromClaudeToolInput("update_plan", { todos: [{ content: "one", status: "completed" }] }),
    ).toEqual({ steps: [{ title: "one", status: "completed" }] });
  });
});

describe("buildPayload", () => {
  it("CC stdin 格式：hook_event_name + 字段，带换行", () => {
    const payload = buildPayload("PreToolUse", {
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    expect(payload.endsWith("\n")).toBe(true);
    expect(JSON.parse(payload)).toEqual({
      hook_event_name: "PreToolUse",
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
  });
});

describe("translateOutcome", () => {
  it("退出码 2 → block / PermissionRequest deny / PostToolUse 附注", () => {
    expect(translateOutcome("PreToolUse", { exitCode: 2, stdout: "", stderr: "  deny  " })).toEqual({
      block: true,
      reason: "deny",
    });
    expect(translateOutcome("PermissionRequest", { exitCode: 2, stdout: "", stderr: "no" })).toEqual({
      permission: "deny",
      reason: "no",
    });
    expect(translateOutcome("PostToolUse", { exitCode: 2, stdout: "", stderr: "warn" })).toEqual({
      appendText: "warn",
    });
    expect(translateOutcome("Stop", { exitCode: 2, stdout: "", stderr: "" })).toEqual({
      block: true,
      reason: "blocked by Claude Code hook",
    });
  });

  it("退出码非 0/2 与非 JSON stdout → 非阻断", () => {
    expect(translateOutcome("PreToolUse", { exitCode: 1, stdout: "", stderr: "boom" })).toEqual({});
    expect(translateOutcome("PreToolUse", { exitCode: 0, stdout: "ok", stderr: "" })).toEqual({});
  });

  it("PreToolUse：deny / ask / allow / legacy / updatedInput / additionalContext", () => {
    expect(
      translateOutcome("PreToolUse", {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: "no rm",
            additionalContext: ["policy A", "policy B"],
          },
        }),
        stderr: "",
      }),
    ).toEqual({ block: true, reason: "no rm\n\npolicy A\npolicy B" });

    expect(
      translateOutcome("PreToolUse", {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            permissionDecision: "ask",
            permissionDecisionReason: "please confirm",
            updatedInput: { file_path: "b.ts" },
          },
        }),
        stderr: "",
      }),
    ).toEqual({
      permission: "ask",
      reason: "please confirm",
      input: { file_path: "b.ts" },
    });

    expect(
      translateOutcome("PreToolUse", {
        exitCode: 0,
        stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } }),
        stderr: "",
      }),
    ).toEqual({ permission: "allow" });

    expect(
      translateOutcome("PreToolUse", {
        exitCode: 0,
        stdout: JSON.stringify({ decision: "block", reason: "legacy" }),
        stderr: "",
      }),
    ).toEqual({ block: true, reason: "legacy" });
  });

  it("PermissionRequest：新格式 allow/deny 与顶层 legacy", () => {
    expect(
      translateOutcome("PermissionRequest", {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: "deny", message: "not this one" },
          },
        }),
        stderr: "",
      }),
    ).toEqual({ permission: "deny", reason: "not this one" });
    expect(
      translateOutcome("PermissionRequest", {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: { decision: { behavior: "allow" } },
        }),
        stderr: "",
      }),
    ).toEqual({ permission: "allow" });
    expect(
      translateOutcome("PermissionRequest", {
        exitCode: 0,
        stdout: JSON.stringify({ permissionDecision: "deny", reason: "legacy" }),
        stderr: "",
      }),
    ).toEqual({ permission: "deny", reason: "legacy" });
  });

  it("Stop / SubagentStop / UserPromptSubmit / PostToolUse", () => {
    for (const event of ["Stop", "SubagentStop"] as const) {
      expect(
        translateOutcome(event, {
          exitCode: 0,
          stdout: JSON.stringify({ decision: "block", reason: "run tests" }),
          stderr: "",
        }),
      ).toEqual({ block: true, reason: "run tests" });
    }
    expect(
      translateOutcome("Stop", {
        exitCode: 0,
        stdout: JSON.stringify({ continue: false, stopReason: "not yet" }),
        stderr: "",
      }),
    ).toEqual({ block: true, reason: "not yet" });
    expect(
      translateOutcome("UserPromptSubmit", {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: { additionalContext: ["today is friday", "repo uses pnpm"] },
        }),
        stderr: "",
      }),
    ).toEqual({ appendText: "today is friday\nrepo uses pnpm" });
    expect(
      translateOutcome("PostToolUse", {
        exitCode: 0,
        stdout: JSON.stringify({ decision: "block", reason: "check output" }),
        stderr: "",
      }),
    ).toEqual({ appendText: "[Claude Code hook] check output" });
  });

  it("坏 JSON → 放行", () => {
    expect(translateOutcome("Stop", { exitCode: 0, stdout: "{broken", stderr: "" })).toEqual({});
  });
});

describe("runGroups", () => {
  const fields = { session_id: "s" };
  const log = () => {};

  it("deny 立即短路，后续命令不再执行", async () => {
    const seen: string[] = [];
    const runner: HookCommandRunner = async (command) => {
      seen.push(command);
      return { exitCode: 2, stdout: "", stderr: "first denied" };
    };
    const verdict = await runGroups(
      "PreToolUse",
      [
        { hooks: [{ type: "command", command: "one" }] },
        { hooks: [{ type: "command", command: "two" }] },
      ],
      fields,
      "/ws",
      runner,
      log,
    );
    expect(verdict).toEqual({ block: true, reason: "first denied" });
    expect(seen).toEqual(["one"]);
  });

  it("ask/allow 折叠：ask 优先；appendText 全部拼接", async () => {
    const runner: HookCommandRunner = async (command) => {
      if (command === "allow") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            hookSpecificOutput: { permissionDecision: "allow", additionalContext: "ctx1" },
          }),
          stderr: "",
        };
      }
      if (command === "ask") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "confirm" },
          }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const verdict = await runGroups(
      "PreToolUse",
      [{ hooks: [{ type: "command", command: "allow" }, { type: "command", command: "ask" }] }],
      fields,
      "/ws",
      runner,
      log,
    );
    expect(verdict.permission).toBe("ask");
    expect(verdict.reason).toBe("confirm");
  });

  it("per-command timeout 换算毫秒（默认 60s）", async () => {
    const timeouts: number[] = [];
    const runner: HookCommandRunner = async (_command, { timeoutMs }) => {
      timeouts.push(timeoutMs);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await runGroups(
      "Stop",
      [{ hooks: [{ type: "command", command: "a", timeout: 5 }, { type: "command", command: "b" }] }],
      fields,
      "/ws",
      runner,
      log,
    );
    expect(timeouts).toEqual([5000, 60000]);
  });

  it("执行器抛错按非阻断继续；审批拒绝跳过该条", async () => {
    const ran: string[] = [];
    const runner: HookCommandRunner = async (command) => {
      if (command === "boom") throw new Error("spawn failed");
      ran.push(command);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const approve = vi.fn(async (request: { command: string }) => request.command !== "skip");
    const verdict = await runGroups(
      "Stop",
      [
        {
          hooks: [
            { type: "command", command: "boom" },
            { type: "command", command: "skip" },
            { type: "command", command: "ok" },
          ],
        },
      ],
      fields,
      "/ws",
      runner,
      log,
      { approve },
    );
    expect(verdict).toEqual({});
    expect(ran).toEqual(["ok"]);
    expect(approve).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// 集成：工厂注册 + 真实 spawn
// ---------------------------------------------------------------------------

type FakeApi = PluginAPI & {
  handlers: Map<string, PluginHandler<never>[]>;
  commands: PluginCommand[];
};

function createFakeApi(workspace: string): FakeApi {
  const handlers = new Map<string, PluginHandler<never>[]>();
  const commands: PluginCommand[] = [];
  return {
    workspace,
    handlers,
    commands,
    registerTool: () => {},
    registerCommand: (cmd) => commands.push(cmd),
    registerRpc: () => {},
    on: (<N extends string>(event: N, handler: PluginHandler<never>) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }) as PluginAPI["on"],
    storage: { get: async () => undefined, set: async () => {}, delete: async () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    manifest: { id: "fake", version: "0.0.0", apiVersion: 2, permissions: [...PLUGIN_PERMISSIONS] },
    permissions: new Set(PLUGIN_PERMISSIONS),
  } as FakeApi;
}

const node = JSON.stringify(process.execPath);
const originalHome = process.env.MEOWCODE_CC_HOOKS_HOME;
const originalScope = process.env.MEOWCODE_CC_HOOKS_SCOPE;
const originalRunMode = process.env.MEOWCODE_HOOKS_RUN_MODE;

async function writeSettings(dir: string, settings: unknown, file = "settings.json"): Promise<void> {
  await fs.mkdir(path.join(dir, ".claude"), { recursive: true });
  await fs.writeFile(path.join(dir, ".claude", file), JSON.stringify(settings), "utf8");
}

async function makePlugin(
  workspace: string,
  home: string,
  options: { scope?: { user: boolean; workspace: boolean }; runMode?: "auto" | "ask" } = {},
): Promise<FakeApi> {
  process.env.MEOWCODE_CC_HOOKS_HOME = home;
  process.env.MEOWCODE_CC_HOOKS_SCOPE = JSON.stringify(
    options.scope ?? { user: true, workspace: true },
  );
  if (options.runMode) process.env.MEOWCODE_HOOKS_RUN_MODE = options.runMode;
  clearHooksConfigCache();
  const api = createFakeApi(workspace);
  claudeCodeHooksPlugin(api);
  return api;
}

beforeEach(() => {
  clearHooksConfigCache();
});

afterEach(() => {
  clearHooksConfigCache();
  if (originalHome === undefined) delete process.env.MEOWCODE_CC_HOOKS_HOME;
  else process.env.MEOWCODE_CC_HOOKS_HOME = originalHome;
  if (originalScope === undefined) delete process.env.MEOWCODE_CC_HOOKS_SCOPE;
  else process.env.MEOWCODE_CC_HOOKS_SCOPE = originalScope;
  if (originalRunMode === undefined) delete process.env.MEOWCODE_HOOKS_RUN_MODE;
  else process.env.MEOWCODE_HOOKS_RUN_MODE = originalRunMode;
});

describe("claudeCodeHooksPlugin 集成", () => {
  let workspace: string;
  let home: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mc-cc-ws-"));
    home = await fs.mkdtemp(path.join(os.tmpdir(), "mc-cc-home-"));
  });

  it("注册 10 个桥接事件与 /cc-hooks 命令", async () => {
    const api = await makePlugin(workspace, home);
    expect([...api.handlers.keys()].sort()).toEqual([
      "compaction_end",
      "compaction_start",
      "permission_request",
      "prompt_submit",
      "session_end",
      "session_start",
      "subagent_start",
      "tool_call",
      "tool_result",
      "turn_stop",
    ]);
    expect(api.commands.map((cmd) => cmd.name)).toContain("cc-hooks");
  });

  it("PreToolUse deny 用内部工具名 + CC matcher 命中", async () => {
    await writeSettings(home, {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: `${node} -e "process.stderr.write('no rm');process.exit(2)"`,
              },
            ],
          },
        ],
      },
    });
    const api = await makePlugin(workspace, home);
    const handler = api.handlers.get("tool_call")![0]!;
    const result = await handler(
      {
        hook: "tool_call",
        sessionId: "s1",
        rootSessionId: "s1",
        callId: "c1",
        tool: "run_command",
        input: { command: "rm -rf /" },
      } as never,
      undefined,
    );
    expect(result).toEqual({ block: true, reason: "no rm" });
  });

  it("PreToolUse updatedInput → 返回内部字段，由 runtime 重校验", async () => {
    await writeSettings(home, {
      hooks: {
        PreToolUse: [
          {
            matcher: "Read",
            hooks: [
              {
                type: "command",
                command: `${node} -e "process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:'allow',updatedInput:{file_path:'b.ts'}}}))"`,
              },
            ],
          },
        ],
      },
    });
    const api = await makePlugin(workspace, home);
    const handler = api.handlers.get("tool_call")![0]!;
    const result = await handler({
      hook: "tool_call",
      sessionId: "s1",
      callId: "c1",
      tool: "read_file",
      input: { path: "a.ts" },
    } as never);
    // allow 不预批准：bridge 只把 updatedInput 映射回内部字段
    expect(result).toEqual({ input: { path: "b.ts" } });
  });

  it("PermissionRequest allow / deny", async () => {
    await writeSettings(home, {
      hooks: {
        PermissionRequest: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: `${node} -e "process.stdout.write(JSON.stringify({hookSpecificOutput:{decision:{behavior:'allow'}}}))"`,
              },
            ],
          },
        ],
      },
    });
    const api = await makePlugin(workspace, home);
    const handler = api.handlers.get("permission_request")![0]!;
    const result = await handler({
      hook: "permission_request",
      sessionId: "s1",
      callId: "c1",
      tool: "run_command",
      input: { command: "ls" },
    } as never);
    expect(result).toEqual({ permission: "allow" });
  });

  it("SubagentStop 与 Stop 分开：agentId 触发 SubagentStop 组", async () => {
    await writeSettings(workspace, {
      hooks: {
        SubagentStop: [
          {
            hooks: [
              {
                type: "command",
                command: `${node} -e "process.stdout.write(JSON.stringify({decision:'block',reason:'child not done'}))"`,
              },
            ],
          },
        ],
      },
    });
    const api = await makePlugin(workspace, home);
    const handler = api.handlers.get("turn_stop")![0]!;
    expect(
      await handler({
        hook: "turn_stop",
        sessionId: "child",
        rootSessionId: "root",
        agentId: "a1",
        agentType: "general",
        parentSessionId: "root",
        turnId: "t1",
        stopHookActive: false,
        text: "done",
      } as never),
    ).toEqual({ block: true, reason: "child not done" });
  });

  it("工作区配置默认排除：scope.workspace=false 时不执行", async () => {
    await writeSettings(workspace, {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: `${node} -e "process.stdout.write(JSON.stringify({decision:'block',reason:'project'}))"`,
              },
            ],
          },
        ],
      },
    });
    const api = await makePlugin(workspace, home, {
      scope: { user: true, workspace: false },
    });
    const handler = api.handlers.get("turn_stop")![0]!;
    expect(
      await handler({
        hook: "turn_stop",
        sessionId: "s1",
        turnId: "t1",
        stopHookActive: false,
        text: "done",
      } as never),
    ).toBeUndefined();
  });

  it("每次询问：每 root session 每条命令只确认一次；拒绝跳过该命令", async () => {
    await writeSettings(home, {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: `${node} -e "process.stderr.write('ran');process.exit(2)"`,
              },
            ],
          },
        ],
      },
    });
    const api = await makePlugin(workspace, home, { runMode: "ask" });
    const handler = api.handlers.get("tool_call")![0]!;
    const requestApproval = vi.fn(async () => true);
    const event = {
      hook: "tool_call",
      sessionId: "s1",
      rootSessionId: "root",
      callId: "c1",
      tool: "run_command",
      input: { command: "echo hi" },
    } as never;
    // 批准后命令执行（exit 2 → block）
    expect(await handler(event, { requestApproval })).toEqual({ block: true, reason: "ran" });
    expect(requestApproval).toHaveBeenCalledTimes(1);
    // 同 root session 第二次不再询问
    expect(await handler(event, { requestApproval })).toEqual({ block: true, reason: "ran" });
    expect(requestApproval).toHaveBeenCalledTimes(1);
    // 新 root session 重新询问；拒绝后命令不执行
    requestApproval.mockResolvedValueOnce(false);
    expect(
      await handler(
        { ...event, rootSessionId: "root-2", callId: "c2" } as never,
        { requestApproval },
      ),
    ).toBeUndefined();
    expect(requestApproval).toHaveBeenCalledTimes(2);
  });

  it("/cc-hooks 摘要包含 scope / runMode / 事件计数", async () => {
    await writeSettings(home, {
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "check" }] },
        ],
      },
    });
    const api = await makePlugin(workspace, home, { runMode: "ask" });
    const command = api.commands.find((cmd) => cmd.name === "cc-hooks")!;
    const output = await command.run("");
    expect(output).toContain("workspace=on");
    expect(output).toContain("run mode=ask");
    expect(output).toContain("PreToolUse");
    expect(output).toContain("allow 不会跳过审批");
  });
});
