/**
 * PTC 式 code mode（run_code）：模型写一段异步 JS，在 Node vm 受限沙箱里执行，
 * 代码内部通过 `meow.*` 桥调用宿主工具。
 *
 * 省 Token 语义（参考 deepseek-harness 的 PTC，"only the outer curated result enters
 * model history"）：子工具调用的中间结果只留在沙箱内存和执行日志里，**绝不进模型上下文**；
 * 只有最终 return 值（截断后）进入对话。N 轮「grep → 读 → 再 grep」的往返合并成 1 轮，
 * 每一轮的全上下文重发随之消失。
 *
 * 桥分两级：
 *  - 只读（read / readMany / grep / glob / listDir）：沙箱自己实现，零审批；
 *  - 宿主工具（write / edit / multiEdit / run）：交给 runtime 注入的 hostToolBridge，
 *    走与普通工具调用完全相同的路径守卫与审批（AllAgent 的 call_tool 同款语义：
 *    "Each operation retains its permissions, tool budget and trace"）。没有注入
 *    桥时（例如只读子 Agent）这四个方法直接报错，不静默降级。
 *
 * 安全边界：沙箱只暴露 meow 桥和受限 console，没有 require / process / fetch / import；
 * 只读桥是白名单，写操作一律经过宿主审批。vm 超时兜住同步死循环；
 * 墙钟预算 + 桥逐次预算检查兜住异步挂起。
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { readTextFile } from "./edit-content.js";
import { canonicalPathSync, IGNORED_ENTRY_NAMES, resolveToolPath } from "./paths.js";
import { recordRead } from "./read-state.js";
import { globPaths, grepMatches } from "./search.js";
import { sweepToolOutput } from "./tool-output.js";

export const CODE_MODE_TIMEOUT_MS = 30_000;
/** 最终返回值进入对话的上限；超出截断（完整值在日志里，可按需续读）。 */
export const CODE_MODE_MAX_RESULT_CHARS = 12_000;
/** 沙箱内单文件读取上限：够分析用，又不至于让一段代码把巨型文件拖进内存。 */
export const CODE_MODE_MAX_READ_CHARS = 200_000;
/** 内部工具调用次数上限：防失控循环刷桥。 */
export const CODE_MODE_MAX_CALLS = 200;
const CODE_MODE_MAX_LOG_CHARS = 40_000;
const CONSOLE_TAIL_LINES = 8;

/**
 * 沙箱内的桥/console 工厂：必须在 vm realm 里创建宿主函数的包装器。
 * 直接把宿主函数挂进 context 会被 `fn.constructor("return process")()` 逃逸；
 * 这里宿主函数只存在于闭包里，跨边界只传 JSON 字符串。
 */
const SANDBOX_FACTORY_SOURCE = `(hostCall, hostLog) => {
  "use strict";
  const requirePayload = (raw) => {
    const result = JSON.parse(raw);
    if (!result || result.ok !== true) {
      throw new Error(result && result.error ? String(result.error) : "meow: host call failed");
    }
    return result.value;
  };
  const call = (method) => async (...args) => {
    let payload;
    try {
      payload = JSON.stringify({ method, args });
    } catch {
      throw new Error("meow: arguments are not JSON-serializable.");
    }
    return requirePayload(await hostCall(payload));
  };
  const meow = Object.create(null);
  for (const name of ["read", "readMany", "grep", "glob", "listDir", "write", "edit", "multiEdit", "run"]) {
    meow[name] = call(name);
  }
  const log = (prefix) => (...args) => {
    const parts = [];
    for (const item of args) {
      try {
        if (typeof item === "string") {
          parts.push(item.slice(0, 500));
        } else {
          const text = JSON.stringify(item);
          parts.push(text === undefined ? String(item) : text.slice(0, 500));
        }
      } catch {
        parts.push("[unprintable]");
      }
    }
    hostLog(prefix + parts.join(" ").slice(0, 4000));
  };
  const contextConsole = Object.create(null);
  contextConsole.log = log("console: ");
  contextConsole.info = log("console: ");
  contextConsole.warn = log("console.warn: ");
  contextConsole.error = log("console.error: ");
  return { meow, console: contextConsole };
}`;
const sandboxFactoryScript = new vm.Script(SANDBOX_FACTORY_SOURCE, {
  filename: "run_code_bridge.js",
});
const CODE_MODE_LOG_DIR = path.join(".meowcode", "tool-output");

export type CodeModeResult = { output: string; ok: boolean };

/** 宿主工具执行结果：与普通工具调用同一套 ok/output 语义。 */
export type HostToolResult = { ok: boolean; output: string };

/**
 * 宿主工具桥：runtime 注入，负责路径守卫、审批与真实执行。
 * tool 取值固定为 write_file / edit_file / multi_edit / run_command。
 */
export type HostToolBridge = (
  tool: "write_file" | "edit_file" | "multi_edit" | "run_command",
  args: Record<string, unknown>,
) => Promise<HostToolResult>;

type SandboxBridge = {
  read: (target: string) => Promise<string>;
  readMany: (targets: string[]) => Promise<Array<{ path: string; content?: string; error?: string }>>;
  grep: (
    pattern: string,
    options?: { fixed?: boolean; caseSensitive?: boolean; maxResults?: number; path?: string },
  ) => Promise<Array<{ path: string; line: number; text: string }>>;
  glob: (pattern: string, options?: { path?: string; maxResults?: number }) => Promise<string[]>;
  listDir: (target?: string) => Promise<Array<{ name: string; type: "dir" | "file" }>>;
  write: (target: string, content: string, options?: { force?: boolean }) => Promise<HostToolResult>;
  edit: (
    target: string,
    oldString: string,
    newString: string,
    options?: { replaceAll?: boolean },
  ) => Promise<HostToolResult>;
  multiEdit: (edits: Array<Record<string, unknown>>) => Promise<HostToolResult>;
  run: (command: string) => Promise<HostToolResult>;
};

export async function runCodeInSandbox(input: {
  workspace: string;
  code: string;
  allowOutsideWorkspace?: boolean;
  signal?: AbortSignal;
  /** 宿主写/命令桥；缺省时 meow.write/edit/multiEdit/run 直接报错（只读上下文） */
  hostToolBridge?: HostToolBridge;
  /** 测试覆盖用：默认 CODE_MODE_TIMEOUT_MS */
  timeoutMs?: number;
}): Promise<CodeModeResult> {
  const { workspace } = input;
  const allowOutside = Boolean(input.allowOutsideWorkspace);
  const budgetMs = input.timeoutMs ?? CODE_MODE_TIMEOUT_MS;
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const timer = setTimeout(abort, budgetMs);
  function abort(): void {
    controller.abort();
  }

  const logLines: string[] = [];
  const pushLog = (line: string): void => {
    if (logLines.length < 400) logLines.push(line);
  };
  let calls = 0;

  /** 每次桥调用前的预算闸：外部中止 / 墙钟超限 / 调用数超限都会抛进沙箱代码。 */
  const assertBudget = (): void => {
    if (input.signal?.aborted) throw new Error("run_code aborted.");
    if (Date.now() >= deadline) {
      throw new Error(`run_code ${Math.round(budgetMs / 1000)}s time budget exhausted.`);
    }
    calls += 1;
    if (calls > CODE_MODE_MAX_CALLS) {
      throw new Error(`run_code internal call cap (${CODE_MODE_MAX_CALLS}) reached.`);
    }
  };

  const requireString = (value: unknown, label: string): string => {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`meow: ${label} expects a non-empty string.`);
    }
    return value;
  };

  const describeReadFailure = (
    target: unknown,
    outcome: Extract<Awaited<ReturnType<typeof readTextFile>>, { ok: false }>,
  ): string => {
    const name = String(target);
    switch (outcome.reason) {
      case "missing":
        return `meow.read: file not found: ${name}`;
      case "directory":
        return `meow.read: ${name} is a directory, not a file.`;
      case "binary":
        return `meow.read: ${name} looks like a binary file; only UTF-8 text is supported.`;
      case "not-utf8":
        return `meow.read: ${name} is not valid UTF-8 text.`;
      case "too-large":
        return `meow.read: ${name} is ${outcome.size} bytes, above the text reader limit.`;
    }
  };

  const readOne = async (target: string): Promise<string> => {
    const file = await resolveToolPath(workspace, target, allowOutside);
    const outcome = await readTextFile(file, { headOnly: true });
    if (!outcome.ok) throw new Error(describeReadFailure(target, outcome));
    let { content } = outcome.file;
    if (content.length > CODE_MODE_MAX_READ_CHARS) {
      content = `${content.slice(0, CODE_MODE_MAX_READ_CHARS)}\n... [truncated at ${CODE_MODE_MAX_READ_CHARS} chars]`;
    }
    // 与 read_file 同口径登记读取：沙箱看过这一版，后续 edit 的过期检查才有基准
    await recordRead(file).catch(() => undefined);
    return content;
  };

  /**
   * 转发一次宿主写/命令调用：预算照常扣、日志照常记，但执行权在 runtime
   * （路径守卫、只读/计划模式拦截、审批弹窗、审阅记录都在那边，沙箱不复制这些规则）。
   */
  const runHost = async (
    label: string,
    tool: "write_file" | "edit_file" | "multi_edit" | "run_command",
    args: Record<string, unknown>,
  ): Promise<HostToolResult> => {
    assertBudget();
    const host = input.hostToolBridge;
    if (!host) {
      throw new Error(
        `meow.${label}: host write/command tools are unavailable in this context (read-only run_code).`,
      );
    }
    const result = await host(tool, args);
    pushLog(`${label}(${String(args.path ?? args.command ?? "")}) -> ${result.ok ? "ok" : "failed"}`);
    return { ok: result.ok, output: result.output };
  };

  const bridge: SandboxBridge = {
    read: async (target: unknown) => {
      assertBudget();
      const path0 = requireString(target, "read(path)");
      const content = await readOne(path0);
      pushLog(`read(${path0}) -> ${content.length} chars`);
      return content;
    },
    readMany: async (targets: unknown) => {
      assertBudget();
      if (!Array.isArray(targets)) {
        throw new Error("meow.readMany expects an array of path strings.");
      }
      const list = targets.slice(0, 50).map((item) => String(item));
      const results = await Promise.all(
        list.map(async (target) => {
          try {
            const content = await readOne(target);
            pushLog(`readMany -> ${target}: ${content.length} chars`);
            return { path: target, content };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            pushLog(`readMany -> ${target}: ERROR ${message}`);
            return { path: target, error: message };
          }
        }),
      );
      return results;
    },
    grep: async (pattern: unknown, options?: unknown) => {
      assertBudget();
      const opts = (options ?? {}) as Record<string, unknown>;
      const matches = await grepMatches(
        workspace,
        typeof opts.path === "string" && opts.path.trim() ? opts.path : ".",
        requireString(pattern, "grep(pattern)"),
        {
          fixed: opts.fixed === true,
          caseSensitive: opts.caseSensitive !== false,
          maxResults: typeof opts.maxResults === "number" ? opts.maxResults : undefined,
        },
        controller.signal,
        allowOutside,
      );
      pushLog(
        `grep(${JSON.stringify(pattern).slice(0, 120)}) -> ${matches.length} matches`,
      );
      return matches;
    },
    glob: async (pattern: unknown, options?: unknown) => {
      assertBudget();
      const opts = (options ?? {}) as Record<string, unknown>;
      const files = await globPaths(
        workspace,
        typeof opts.path === "string" && opts.path.trim() ? opts.path : ".",
        requireString(pattern, "glob(pattern)"),
        typeof opts.maxResults === "number" ? opts.maxResults : undefined,
        controller.signal,
        allowOutside,
      );
      pushLog(`glob(${JSON.stringify(pattern).slice(0, 120)}) -> ${files.length} paths`);
      return files;
    },
    listDir: async (target?: unknown) => {
      assertBudget();
      const dir = await resolveToolPath(
        workspace,
        typeof target === "string" && target.trim() ? target : ".",
        allowOutside,
      );
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const visible = entries
        .filter((entry) => !IGNORED_ENTRY_NAMES.has(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
        .map((entry) => ({
          name: entry.name,
          type: (entry.isDirectory() ? "dir" : "file") as "dir" | "file",
        }));
      pushLog(`listDir(${String(target ?? ".")}) -> ${visible.length} entries`);
      return visible;
    },
    // ---- 宿主写/命令桥：路径守卫与审批都在 runtime，沙箱只负责转发 ----
    write: async (target: unknown, content: unknown, options?: unknown) => {
      const opts = (options ?? {}) as Record<string, unknown>;
      return runHost("write", "write_file", {
        path: requireString(target, "write(path)"),
        content: typeof content === "string" ? content : String(content ?? ""),
        ...(opts.force === true ? { force: true } : {}),
      });
    },
    edit: async (target: unknown, oldString: unknown, newString: unknown, options?: unknown) => {
      const opts = (options ?? {}) as Record<string, unknown>;
      return runHost("edit", "edit_file", {
        path: requireString(target, "edit(path)"),
        oldString: requireString(oldString, "edit(oldString)"),
        newString: typeof newString === "string" ? newString : String(newString ?? ""),
        ...(opts.replaceAll === true ? { replaceAll: true } : {}),
      });
    },
    multiEdit: async (edits: unknown) => {
      if (!Array.isArray(edits) || !edits.length) {
        throw new Error("meow.multiEdit expects a non-empty array of { path, oldString, newString }.");
      }
      return runHost("multiEdit", "multi_edit", {
        edits: edits.slice(0, 50).map((item) => ({ ...(item as Record<string, unknown>) })),
      });
    },
    run: async (command: unknown) =>
      runHost("run", "run_command", {
        command: requireString(command, "run(command)"),
      }),
  };

  /** 宿主 dispatcher：只接受/返回 JSON 字符串，宿主函数与对象完全不进入 vm realm。 */
  const dispatchHostCall = async (payload: unknown): Promise<string> => {
    try {
      if (typeof payload !== "string") throw new Error("meow: invalid call payload.");
      const request = JSON.parse(payload) as { method?: unknown; args?: unknown };
      const method = typeof request.method === "string" ? request.method : "";
      const args = Array.isArray(request.args) ? (request.args as unknown[]) : [];
      const fn = (bridge as unknown as Record<string, (...values: unknown[]) => unknown>)[method];
      if (typeof fn !== "function") throw new Error(`meow: unknown method ${method}.`);
      const value = await fn(...args);
      return JSON.stringify({ ok: true, value });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return JSON.stringify({ ok: false, error: message });
    }
  };

  // Object.create(null) 做载体：contextify 的全局代理会把属性查找回落到载体对象
  // 的原型链上，普通对象会把宿主 realm 的 Object/Function 构造器泄漏进沙箱。
  // 空原型载体只放原始值与 context realm 内创建的桥/console；codegen（字符串
  // 与 wasm）在 context 内禁用，`fn.constructor("return process")()` 无法再编译。
  const sandbox: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  sandbox.process = undefined;
  sandbox.require = undefined;
  sandbox.module = undefined;
  sandbox.exports = undefined;
  sandbox.global = undefined;
  sandbox.globalThis = undefined;
  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });

  const sandboxRuntime = sandboxFactoryScript.runInContext(context) as (
    hostCall: (payload: string) => Promise<string>,
    hostLog: (line: string) => void,
  ) => { meow: Record<string, unknown>; console: Record<string, unknown> };
  const runtimeGlobals = sandboxRuntime(
    (payload) => dispatchHostCall(payload),
    (line) => {
      if (typeof line === "string") pushLog(line);
    },
  );
  sandbox.meow = runtimeGlobals.meow;
  sandbox.console = runtimeGlobals.console;

  const seconds = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

  let pending: Promise<unknown> | null = null;

  const finishError = async (error: unknown): Promise<CodeModeResult> => {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onOuterAbort);
    controller.abort(); // 让仍在跑的 rg / 读取尽快退出
    if (pending) void Promise.resolve(pending).catch(() => undefined); // 挂起沙箱的后续 rejection 不外泄
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const logPath = await persistLog(workspace, logLines);
    const tail = logLines.slice(-CONSOLE_TAIL_LINES).join("\n");
    return {
      ok: false,
      output:
        `[run_code] failed after ${calls} internal call(s) in ${seconds()}: ${message}` +
        (tail ? `\nRecent sandbox output:\n${tail}` : "") +
        (logPath ? `\nFull log: ${logPath}` : ""),
    };
  };

  try {
    const script = new vm.Script(`(async () => {\n${input.code}\n})()`, {
      filename: "run_code.js",
    });
    // vm timeout 只管同步执行（死循环在这里抛）；异步挂起由下面的墙钟竞速兜底
    pending = script.runInContext(context, {
      timeout: budgetMs,
      breakOnSigint: true,
    }) as Promise<unknown>;
  } catch (error) {
    return finishError(error);
  }

  let value: unknown;
  try {
    value = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        const raceTimer = setTimeout(
          () => reject(new Error(`run_code exceeded the ${Math.round(budgetMs / 1000)}s limit`)),
          Math.max(deadline - Date.now(), 0),
        );
        (raceTimer as NodeJS.Timeout).unref?.();
      }),
    ]);
  } catch (error) {
    return finishError(error);
  }

  clearTimeout(timer);
  input.signal?.removeEventListener("abort", onOuterAbort);
  void Promise.resolve(pending).catch(() => undefined);

  const logPath = await persistLog(workspace, logLines);
  const serialized = serializeResultValue(value);
  const clamped =
    serialized.length > CODE_MODE_MAX_RESULT_CHARS
      ? `${serialized.slice(0, CODE_MODE_MAX_RESULT_CHARS)}\n... [returned value truncated at ${CODE_MODE_MAX_RESULT_CHARS} chars${logPath ? `; full log: ${logPath}` : ""}]`
      : serialized;
  return {
    ok: true,
    output:
      `[run_code] ${calls} internal call(s) in ${seconds()}; internal outputs stayed out of context` +
      (logPath ? `; log: ${logPath}` : "") +
      `\n${clamped}`,
  };
}

function serializeResultValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "(no return value)";
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

/** 执行日志落盘到与工具输出同一目录；失败不影响主结果（返回 null 表示无日志可提）。 */
async function persistLog(workspace: string, lines: string[]): Promise<string | null> {
  try {
    if (!lines.length) return null;
    let text = lines.join("\n");
    if (text.length > CODE_MODE_MAX_LOG_CHARS) {
      text = `${text.slice(0, CODE_MODE_MAX_LOG_CHARS)}\n... [log truncated]`;
    }
    const dir = await resolveToolPath(workspace, CODE_MODE_LOG_DIR);
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `run_code-${stamp}-${randomUUID().slice(0, 8)}.log`);
    await fs.writeFile(file, text, "utf8");
    // 与其它工具输出共用 7 天保留策略：日志目录会随长会话无限增长
    await sweepToolOutput(workspace);
    return path.relative(canonicalPathSync(workspace), file).split(path.sep).join("/");
  } catch {
    return null;
  }
}
