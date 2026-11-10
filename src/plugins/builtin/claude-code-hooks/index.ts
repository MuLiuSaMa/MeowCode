/**
 * Claude Code hooks 桥接（内置插件）。
 *
 * 读取 Claude Code 的 settings.json 里的 `hooks` 配置并翻译成 MeowCode 的
 * 插件 hook，让 CC 生态里现成的 hook 脚本尽量零改动可用：
 *
 *   ~/.claude/settings.json                  （user 级，默认参与）
 *   <workspace>/.claude/settings.json        （project 级，默认不执行）
 *   <workspace>/.claude/settings.local.json  （project 本地，默认不执行）
 *
 * 工作区配置是否执行由 MEOWCODE_CC_HOOKS_SCOPE 控制（默认 user=true,
 * workspace=false）；每次询问模式由 MEOWCODE_HOOKS_RUN_MODE=auto|ask 控制。
 *
 * 事件映射：
 *   PreToolUse       → tool_call          （deny → 阻止；ask → 强制人工确认；allow 不预批准）
 *   PostToolUse      → tool_result        （block/exit 2 → 原因附注到工具输出）
 *   PermissionRequest→ permission_request （allow/deny 自动应答审批弹窗）
 *   UserPromptSubmit → prompt_submit      （block → 拦截提交；additionalContext → 追加文本）
 *   Stop             → turn_stop          （根会话）
 *   SubagentStop     → turn_stop          （子 Agent，由 agentId 区分；保留 block 语义）
 *   SessionStart     → session_start      （仅根会话，观察）
 *   SessionEnd       → session_end        （观察）
 *   SubagentStart    → subagent_start     （观察）
 *   PreCompact       → compaction_start   （观察）
 *   PostCompact      → compaction_end     （观察）
 *
 * 信任模型：CC hooks 是用户自己配置的任意代码，与 run_command 的 full 模式同级，
 * 不额外沙化。工作区配置默认关闭，开启前请确认仓库可信。
 */
import { spawn } from "node:child_process";
import os from "node:os";
import type {
  HookCommandApprovalRequest,
  PluginAPI,
  PluginFactory,
  PluginHookContext,
  ToolCallHookResult,
} from "../../types.js";
import {
  CLAUDE_EVENTS,
  EVENT_MAP,
  claudeToolName,
  fromClaudeToolInput,
  groupsForTool,
  loadHooksConfig,
  parseHooksScope,
  parseRunMode,
  permissionModeFor,
  summarizeHooks,
  toClaudeToolInput,
  type ClaudeEvent,
  type HookMatcherGroup,
} from "./config.js";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 单个 command 的执行结果（已按退出码归一化的判定）。 */
export type HookVerdict = {
  block?: boolean;
  reason?: string;
  /** prompt_submit 的 additionalContext / PostToolUse 的附注文本 */
  appendText?: string;
  /** PreToolUse / PermissionRequest 的权限判定 */
  permission?: "allow" | "ask" | "deny";
  /** PreToolUse 的 updatedInput（CC 形态，待反向映射） */
  input?: Record<string, unknown>;
};

/** command 执行器：可注入（测试用假执行器）。 */
export type HookCommandRunner = (
  command: string,
  input: { payload: string; cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

type HookRunOptions = {
  approve?: (request: {
    matcher?: string;
    command: string;
    timeout: number;
    source?: string;
  }) => Promise<boolean>;
  signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// 纯函数：payload / 结果翻译 / 命令执行
// ---------------------------------------------------------------------------

/** 按 CC 的 stdin 格式构造 payload。 */
export function buildPayload(
  claudeEvent: ClaudeEvent,
  fields: Record<string, unknown>,
): string {
  return `${JSON.stringify({
    hook_event_name: claudeEvent,
    ...fields,
  })}\n`;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  const record = recordOf(value);
  return Object.keys(record).length ? record : undefined;
}

/** CC 的 additionalContext 现在是 string[]，旧脚本/旧版是 string。 */
function contextText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!Array.isArray(value)) return undefined;
  const parts = value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
  return parts.length ? parts.join("\n") : undefined;
}

function joinText(first: string | undefined, second: string | undefined): string | undefined {
  if (!first) return second;
  if (!second) return first;
  return `${first}\n\n${second}`;
}

/**
 * 退出码 + stdout/stderr → MeowCode 判定。
 * 退出码 2 的 block/deny 优先于 stdout JSON（CC 语义：2 立即阻断）。
 */
export function translateOutcome(
  claudeEvent: ClaudeEvent,
  outcome: { exitCode: number; stdout: string; stderr: string },
): HookVerdict {
  const errorReason = outcome.stderr.trim() || "blocked by Claude Code hook";
  if (outcome.exitCode === 2) {
    if (claudeEvent === "PermissionRequest") return { permission: "deny", reason: errorReason };
    if (claudeEvent === "PostToolUse") return { appendText: errorReason };
    return { block: true, reason: errorReason };
  }
  if (outcome.exitCode !== 0) {
    // 非阻断错误：与 CC 一致，只记录不拦截
    return {};
  }
  const stdout = outcome.stdout.trim();
  if (!stdout.startsWith("{")) return {};
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return {};
  }

  const specific = recordOf(parsed.hookSpecificOutput);
  const context = contextText(specific.additionalContext);
  const permission = str(specific.permissionDecision) ?? str(parsed.permissionDecision);
  const permissionReason =
    str(specific.permissionDecisionReason) ?? str(parsed.permissionDecisionReason);
  const updated = recordOrUndefined(specific.updatedInput ?? parsed.updatedInput);

  // PermissionRequest：allow/deny 自动应答审批弹窗（新格式 + 老格式）
  if (claudeEvent === "PermissionRequest") {
    const decision = recordOf(specific.decision ?? parsed.decision);
    const behavior =
      str(decision.behavior) ??
      str(specific.decision) ??
      permission ??
      str(parsed.decision);
    const message = str(decision.message) ?? permissionReason ?? str(parsed.reason);
    if (behavior === "deny") {
      return {
        permission: "deny",
        reason: joinText(message ?? "denied by PermissionRequest hook", context),
      };
    }
    if (behavior === "allow") return { permission: "allow" };
    if (parsed.decision === "block") {
      return {
        permission: "deny",
        reason: joinText(str(parsed.reason) ?? "blocked by PermissionRequest hook", context),
      };
    }
    return {};
  }

  // Stop / SubagentStop：decision:block / continue:false 都表示不让回合结束
  if (claudeEvent === "Stop" || claudeEvent === "SubagentStop") {
    if (parsed.decision === "block") {
      return {
        block: true,
        reason: joinText(str(parsed.reason) ?? "blocked by Stop hook", context),
      };
    }
    if (parsed.continue === false) {
      return {
        block: true,
        reason: joinText(str(parsed.stopReason) ?? "blocked by Stop hook", context),
      };
    }
    return {};
  }

  // UserPromptSubmit：block 拦截；additionalContext 追加进提交文本
  if (claudeEvent === "UserPromptSubmit") {
    if (parsed.decision === "block") {
      return {
        block: true,
        reason: joinText(
          str(parsed.reason) ?? "blocked by UserPromptSubmit hook",
          context,
        ),
      };
    }
    return context ? { appendText: context } : {};
  }

  // PreToolUse：新格式 permissionDecision / 老格式 decision
  if (claudeEvent === "PreToolUse") {
    if (permission === "deny") {
      return {
        block: true,
        reason: joinText(permissionReason ?? "denied by PreToolUse hook", context),
        ...(updated ? { input: updated } : {}),
      };
    }
    if (permission === "ask") {
      return {
        permission: "ask",
        reason: joinText(permissionReason ?? "The PreToolUse hook requests approval.", context),
        ...(updated ? { input: updated } : {}),
      };
    }
    if (permission === "allow") {
      return { permission: "allow", ...(updated ? { input: updated } : {}) };
    }
    if (parsed.decision === "block") {
      return {
        block: true,
        reason: joinText(str(parsed.reason) ?? "blocked by PreToolUse hook", context),
      };
    }
    return updated ? { input: updated } : {};
  }

  // PostToolUse：工具已执行，无法撤销；block 仅把原因附注到输出
  if (claudeEvent === "PostToolUse") {
    if (parsed.decision === "block") {
      return {
        appendText: joinText(
          `[Claude Code hook] ${str(parsed.reason) ?? "blocked"}`,
          context,
        ),
      };
    }
    return context ? { appendText: context } : {};
  }

  // SessionStart：观察类，additionalContext 无注入通道
  return {};
}

/**
 * 顺序执行一组 command：
 *  - deny 立即短路（后面的 hook 不再跑）；
 *  - ask/allow 继续收集，最终 deny > ask > allow；
 *  - appendText 拼接所有命令的结果（不再只保留第一条）。
 */
export async function runGroups(
  claudeEvent: ClaudeEvent,
  groups: HookMatcherGroup[],
  fields: Record<string, unknown>,
  cwd: string,
  runner: HookCommandRunner,
  log: (message: string) => void,
  options?: HookRunOptions,
): Promise<HookVerdict> {
  const payload = buildPayload(claudeEvent, fields);
  const annotations: string[] = [];
  let permission: "allow" | "ask" | "deny" | undefined;
  let reason: string | undefined;
  let input: Record<string, unknown> | undefined;

  const finalize = (): HookVerdict => ({
    ...(permission ? { permission } : {}),
    ...(reason ? { reason } : {}),
    ...(input ? { input } : {}),
    ...(annotations.length ? { appendText: annotations.join("\n\n") } : {}),
  });

  for (const group of groups) {
    for (const command of group.hooks ?? []) {
      if (command.type !== "command" || !command.command) continue;
      if (options?.signal?.aborted) return finalize();
      const timeoutSec = Math.max(1, command.timeout ?? 60);
      const timeoutMs = timeoutSec * 1000;

      if (options?.approve) {
        let ok = false;
        try {
          ok = await options.approve({
            ...(group.matcher ? { matcher: group.matcher } : {}),
            command: command.command,
            timeout: timeoutSec,
            ...(group.source ? { source: group.source } : {}),
          });
        } catch (error) {
          log(
            `approval failed: ${command.command} — ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          ok = false;
        }
        if (!ok) {
          log(`skipped by user: ${command.command}`);
          continue;
        }
      }

      let outcome: { exitCode: number; stdout: string; stderr: string };
      try {
        outcome = await runner(command.command, {
          payload,
          cwd,
          timeoutMs,
          ...(options?.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        // 执行器自身失败（spawn 失败等）：按非阻断错误处理
        log(
          `command failed: ${command.command} — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }
      if (outcome.exitCode !== 0 && outcome.exitCode !== 2 && outcome.exitCode !== 130) {
        log(
          `non-blocking error (exit ${outcome.exitCode}): ${command.command} — ${outcome.stderr.trim()}`,
        );
      }
      const verdict = translateOutcome(claudeEvent, outcome);
      if (verdict.block) return verdict;
      if (verdict.permission === "deny") return verdict;
      if (verdict.permission === "ask") {
        if (permission !== "ask") {
          permission = "ask";
          if (verdict.reason && !reason) reason = verdict.reason;
        }
      } else if (verdict.permission === "allow") {
        if (!permission) permission = "allow";
      }
      if (verdict.input) input = verdict.input;
      if (verdict.appendText) annotations.push(verdict.appendText);
    }
  }
  return finalize();
}

// ---------------------------------------------------------------------------
// 默认执行器：shell 子进程（posix sh / Windows cmd）
// ---------------------------------------------------------------------------

export const shellRunner: HookCommandRunner = (command, { payload, cwd, timeoutMs, signal }) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve({ exitCode: 130, stdout: "", stderr: "" });
      return;
    }
    const child = spawn(command, {
      shell: true,
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      child.kill();
      finish({ exitCode: 130, stdout: stdout.join(""), stderr: stderr.join("") });
    };
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (result: { exitCode: number; stdout: string; stderr: string }): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      child.kill();
      // 超时按非阻断错误处理（记日志后放行），与 CC 的 timeout 行为对齐
      finish({ exitCode: 124, stdout: stdout.join(""), stderr: stderr.join("") });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      finish({ exitCode: code ?? -1, stdout: stdout.join(""), stderr: stderr.join("") });
    });
    child.stdin?.end(payload);
  });

// ---------------------------------------------------------------------------
// 插件装配
// ---------------------------------------------------------------------------

export const claudeCodeHooksPlugin: PluginFactory = (api: PluginAPI): void => {
  const workspace = api.workspace;
  const homeDir = process.env.MEOWCODE_CC_HOOKS_HOME || os.homedir();
  // 每次执行都读 env：设置页改「询问模式 / 工作区范围」后 server 热更新 env，不重启进程
  const currentScope = () => parseHooksScope(process.env.MEOWCODE_CC_HOOKS_SCOPE);
  const currentRunMode = () => parseRunMode(process.env.MEOWCODE_HOOKS_RUN_MODE);
  const runner = shellRunner;
  const log = (message: string) => api.logger.info(`[claude-code-hooks] ${message}`);

  /** root session → 已批准的 hook 命令；重启后重新询问 */
  const approvedCommands = new Map<string, Set<string>>();

  const rootSessionIdOf = (event: { rootSessionId?: string; sessionId: string }): string =>
    event.rootSessionId ?? event.sessionId;

  const baseFields = (event: {
    sessionId: string;
    rootSessionId?: string;
    agentId?: string;
    agentType?: string;
    parentSessionId?: string;
  }): Record<string, unknown> => ({
    session_id: event.sessionId,
    ...(event.rootSessionId ? { root_session_id: event.rootSessionId } : {}),
    cwd: workspace,
    ...(event.agentId ? { agent_id: event.agentId } : {}),
    ...(event.agentType ? { agent_type: event.agentType } : {}),
    ...(event.parentSessionId ? { parent_session_id: event.parentSessionId } : {}),
  });

  const permissionMode = (ctx?: PluginHookContext): string =>
    permissionModeFor(ctx?.permissionMode ?? "default", ctx?.chatMode);

  const approver = (
    claudeEvent: ClaudeEvent,
    event: { rootSessionId?: string; sessionId: string },
    ctx?: PluginHookContext,
  ): HookRunOptions["approve"] => {
    const rootSessionId = rootSessionIdOf(event);
    return async (request: {
      matcher?: string;
      command: string;
      timeout: number;
      source?: string;
    }) => {
      if (currentRunMode() !== "ask") return true;
      const approved = approvedCommands.get(rootSessionId) ?? new Set<string>();
      if (approved.has(request.command)) return true;
      if (!ctx?.requestApproval) {
        log(`ask mode has no approver; skipping: ${request.command}`);
        return false;
      }
      const approval: HookCommandApprovalRequest = {
        event: claudeEvent,
        command: request.command,
        timeout: request.timeout,
        ...(request.matcher ? { matcher: request.matcher } : {}),
        ...(request.source ? { source: request.source } : {}),
      };
      const ok = await ctx.requestApproval(approval);
      if (!ok) {
        log(`skipped by user: ${request.command}`);
        return false;
      }
      approved.add(request.command);
      approvedCommands.set(rootSessionId, approved);
      if (approvedCommands.size > 50) {
        const oldest = approvedCommands.keys().next().value;
        if (oldest !== undefined) approvedCommands.delete(oldest);
      }
      return true;
    };
  };

  const loadGroups = async (claudeEvent: ClaudeEvent): Promise<HookMatcherGroup[]> => {
    const config = await loadHooksConfig({
      homeDir,
      workspace,
      scope: currentScope(),
      runMode: currentRunMode(),
    });
    return config.groups[claudeEvent] ?? [];
  };

  // PreToolUse → tool_call
  api.on("tool_call", async (event, ctx) => {
    const groups = await loadGroups("PreToolUse");
    if (!groups.length) return;
    const matched = groupsForTool(groups, event.tool);
    if (!matched.length) return;
    const verdict = await runGroups(
      "PreToolUse",
      matched,
      {
        ...baseFields(event),
        permission_mode: permissionMode(ctx),
        tool_name: claudeToolName(event.tool),
        meow_tool_name: event.tool,
        tool_use_id: event.callId,
        tool_input: toClaudeToolInput(event.tool, event.input),
      },
      workspace,
      runner,
      log,
      { approve: approver("PreToolUse", event, ctx), signal: ctx?.signal },
    );
    if (verdict.block) return { block: true, reason: verdict.reason };
    if (verdict.permission === "deny") {
      return { block: true, reason: verdict.reason ?? "denied by PreToolUse hook" };
    }
    const result: ToolCallHookResult = {};
    if (verdict.permission === "ask") {
      result.permission = "ask";
      result.reason = verdict.reason ?? "The PreToolUse hook requests approval.";
    } else if (verdict.permission === "allow") {
      // 门禁单调性：allow 只表示 CC 的"跳过提示"，在 MeowCode 不预批准。
      log("PreToolUse allow ignored (allow does not bypass approvals)");
    }
    if (verdict.input) result.input = fromClaudeToolInput(event.tool, verdict.input);
    if (verdict.appendText) {
      log(`PreToolUse additionalContext has no allow/ask channel: ${verdict.appendText}`);
    }
    return Object.keys(result).length ? result : undefined;
  });

  // PostToolUse → tool_result
  api.on("tool_result", async (event, ctx) => {
    const groups = await loadGroups("PostToolUse");
    if (!groups.length) return;
    const matched = groupsForTool(groups, event.tool);
    if (!matched.length) return;
    const verdict = await runGroups(
      "PostToolUse",
      matched,
      {
        ...baseFields(event),
        permission_mode: permissionMode(ctx),
        tool_name: claudeToolName(event.tool),
        meow_tool_name: event.tool,
        tool_use_id: event.callId,
        tool_input: toClaudeToolInput(event.tool, event.input),
        tool_response: event.output,
        tool_response_ok: event.ok,
      },
      workspace,
      runner,
      log,
      { approve: approver("PostToolUse", event, ctx), signal: ctx?.signal },
    );
    if (verdict.appendText) return { output: `${event.output}\n\n${verdict.appendText}` };
    return;
  });

  // PermissionRequest → permission_request
  api.on("permission_request", async (event, ctx) => {
    const groups = await loadGroups("PermissionRequest");
    if (!groups.length) return;
    const matched = groupsForTool(groups, event.tool);
    if (!matched.length) return;
    const verdict = await runGroups(
      "PermissionRequest",
      matched,
      {
        ...baseFields(event),
        permission_mode: permissionMode(ctx),
        tool_name: claudeToolName(event.tool),
        meow_tool_name: event.tool,
        tool_input: toClaudeToolInput(event.tool, event.input),
      },
      workspace,
      runner,
      log,
      { approve: approver("PermissionRequest", event, ctx), signal: ctx?.signal },
    );
    if (verdict.block || verdict.permission === "deny") {
      return { permission: "deny", ...(verdict.reason ? { reason: verdict.reason } : {}) };
    }
    if (verdict.permission === "allow") return { permission: "allow" };
    return;
  });

  // UserPromptSubmit → prompt_submit
  api.on("prompt_submit", async (event, ctx) => {
    if (event.agentId) return;
    const groups = await loadGroups("UserPromptSubmit");
    if (!groups.length) return;
    const verdict = await runGroups(
      "UserPromptSubmit",
      groups,
      {
        ...baseFields(event),
        permission_mode: permissionMode(ctx),
        prompt: event.text,
      },
      workspace,
      runner,
      log,
      { approve: approver("UserPromptSubmit", event, ctx), signal: ctx?.signal },
    );
    if (verdict.block) return { block: true, reason: verdict.reason };
    if (verdict.appendText) return { text: `${event.text}\n\n${verdict.appendText}` };
    return;
  });

  // Stop / SubagentStop → turn_stop
  api.on("turn_stop", async (event, ctx) => {
    const claudeEvent: ClaudeEvent = event.agentId ? "SubagentStop" : "Stop";
    const groups = await loadGroups(claudeEvent);
    if (!groups.length) return;
    const verdict = await runGroups(
      claudeEvent,
      groups,
      {
        ...baseFields(event),
        permission_mode: permissionMode(ctx),
        stop_hook_active: event.stopHookActive,
        last_assistant_message: event.text,
      },
      workspace,
      runner,
      log,
      { approve: approver(claudeEvent, event, ctx), signal: ctx?.signal },
    );
    if (verdict.block) return { block: true, reason: verdict.reason };
    return;
  });

  // SessionStart → session_start（仅根会话）
  api.on("session_start", async (event, ctx) => {
    if (event.agentId) return;
    const groups = await loadGroups("SessionStart");
    if (!groups.length) return;
    await runGroups(
      "SessionStart",
      groups,
      {
        ...baseFields(event),
        permission_mode: permissionMode(ctx),
        source: "startup",
      },
      workspace,
      runner,
      log,
      { approve: approver("SessionStart", event, ctx), signal: ctx?.signal },
    );
  });

  // SessionEnd → session_end（CC 的 reason: clear/logout/exit；这里按我们的枚举翻译）
  api.on("session_end", async (event, ctx) => {
    const groups = await loadGroups("SessionEnd");
    if (!groups.length) return;
    await runGroups(
      "SessionEnd",
      groups,
      {
        ...baseFields(event),
        permission_mode: permissionMode(ctx),
        reason: event.reason === "shutdown" ? "exit" : event.reason,
      },
      workspace,
      runner,
      log,
      { approve: approver("SessionEnd", event, ctx), signal: ctx?.signal },
    );
  });

  // SubagentStart → subagent_start（CC 侧只做观察，同样不产出决定）
  api.on("subagent_start", async (event, ctx) => {
    if (!event.agentId) return;
    const groups = await loadGroups("SubagentStart");
    if (!groups.length) return;
    await runGroups(
      "SubagentStart",
      groups,
      {
        ...baseFields(event),
        permission_mode: permissionMode(ctx),
        agent_id: event.agentId,
        agent_type: event.agentType ?? "",
        description: event.description,
      },
      workspace,
      runner,
      log,
      { approve: approver("SubagentStart", event, ctx), signal: ctx?.signal },
    );
  });

  // PreCompact / PostCompact → compaction_start / compaction_end（观察）
  api.on("compaction_start", async (event, ctx) => {
    const groups = await loadGroups("PreCompact");
    if (!groups.length) return;
    await runGroups(
      "PreCompact",
      groups,
      {
        ...baseFields(event),
        permission_mode: permissionMode(ctx),
        trigger: event.reason === "manual" ? "manual" : "auto",
      },
      workspace,
      runner,
      log,
      { approve: approver("PreCompact", event, ctx), signal: ctx?.signal },
    );
  });

  api.on("compaction_end", async (event, ctx) => {
    const groups = await loadGroups("PostCompact");
    if (!groups.length) return;
    await runGroups(
      "PostCompact",
      groups,
      {
        ...baseFields(event),
        permission_mode: permissionMode(ctx),
        status: event.status,
      },
      workspace,
      runner,
      log,
      { approve: approver("PostCompact", event, ctx), signal: ctx?.signal },
    );
  });

  // 斜杠命令：/cc-hooks 展开当前生效的 hooks 配置摘要（发送后模型可知悉 hook 环境）
  api.registerCommand({
    name: "cc-hooks",
    description:
      "查看当前生效的 Claude Code hooks 配置（~/.claude 与工作区 .claude；工作区默认不执行）",
    run: async () => {
      const scope = currentScope();
      const runMode = currentRunMode();
      const config = await loadHooksConfig({ homeDir, workspace, scope, runMode, fresh: true });
      const summary = summarizeHooks(config);
      const lines: string[] = [
        `[Claude Code hooks] 当前生效的 hook 配置（user=${scope.user ? "on" : "off"}, workspace=${
          scope.workspace ? "on" : "off"
        }, run mode=${runMode}）：`,
      ];
      for (const claudeEvent of CLAUDE_EVENTS) {
        const entry = summary.events.find((item) => item.event === claudeEvent);
        const count = entry?.commands.filter((command) => !command.excluded).length ?? 0;
        lines.push(`- ${claudeEvent} → ${EVENT_MAP[claudeEvent]}：${count} 条命令`);
      }
      if (!summary.totalCommands) {
        lines.push(
          "当前没有可执行的 Claude Code hooks。可在 ~/.claude/settings.json 或工作区 .claude/settings.json 的 hooks 字段配置。",
        );
      }
      const excluded = summary.files.filter((file) => file.excluded && file.commands > 0);
      if (excluded.length) {
        lines.push(
          `工作区 .claude 配置未启用（${excluded.reduce((sum, file) => sum + file.commands, 0)} 条命令）：设置 → Hooks 打开「包含工作区配置」。`,
        );
      }
      if (summary.unsupportedEvents.length) {
        lines.push(
          `未桥接事件：${summary.unsupportedEvents
            .map((item) => `${item.event}(${item.count})`)
            .join(", ")}`,
        );
      }
      lines.push("说明：PreToolUse 的 allow 不会跳过审批；ask 会强制人工确认。");
      return lines.join("\n");
    },
  });
};

export default claudeCodeHooksPlugin;

// 兼容旧测试/调用方：纯函数从 config 模块统一导出
export {
  EVENT_MAP,
  groupsForTool,
  mergeHookGroups,
  readClaudeSettings,
  settingsPaths,
} from "./config.js";
export type {
  ClaudeEvent,
  ClaudeSettings,
  HookMatcherGroup,
  HooksLayer,
  HooksRunMode,
  HooksScope,
} from "./config.js";
