import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveWithinWorkspace } from "./paths.js";
import { executeTool } from "./tools.js";
import type { ToolResult } from "./types.js";

/**
 * 验证闭环（写后自动验证）：写类工具成功后跑 .meowcode/verify.json 声明的命令
 * （缺省启发式探测 typecheck），失败结果结构化压缩后由 runtime 附加到工具回执，
 * 模型在同一个回合内修复。所有函数都绝不 throw 阻断写流程。
 */

// ---------- 类型 ----------

export interface VerifyCommand {
  /** 固定 id：typecheck | lint | test */
  id: string;
  command: string;
}

export interface VerifyConfig {
  /** 有序验证命令；空数组 = 没有可跑的验证 */
  commands: VerifyCommand[];
  /** 每回合最多几次"失败反馈回灌"，超过后改为"如实告知用户"指令 */
  maxFeedbackPerTurn: number;
  /** 触发验证的扩展名白名单（小写、不含点）；空数组 = 整体禁用 */
  include: string[];
}

export interface VerifyStepResult {
  id: string;
  command: string;
  /** false = 验证发现错误，或命令本身没跑起来（见 commandError） */
  passed: boolean;
  /** executeTool run_command 已做 12k 截断的输出 */
  output: string;
  /** 命令无法执行/超时（spawn ENOENT、找不到命令、超时）；此时不要去"修代码" */
  commandError?: string;
}

export interface VerificationResult {
  ran: boolean;
  /** ran=false 的原因：no-commands / aborted */
  skippedReason?: "no-commands" | "aborted";
  steps: VerifyStepResult[];
  passed: boolean;
  /** 仅失败时有值：formatVerifyFeedback 产物，由 runtime 附加到 tool result */
  feedback?: string;
}

// ---------- 常量 ----------

export const DEFAULT_VERIFY_INCLUDE = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"];
export const MAX_FEEDBACK_ERRORS = 20;
const MAX_ERRORS_PER_FILE = 5;
const MAX_GENERIC_FEEDBACK_CHARS = 3000;
const GENERIC_HEAD_LINES = 20;
const VERIFY_CONFIG_RELATIVE = path.join(".meowcode", "verify.json");
const DEFAULT_MAX_FEEDBACK_PER_TURN = 2;

// ---------- 配置加载 ----------

/** verify.json 里单条命令字段的归一化：false=显式禁用；string=命令；其余=无效（回退启发式/忽略） */
function normalizeCommandSpec(value: unknown): string | false | undefined {
  if (value === false) return false;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const command = (value as { command?: unknown }).command;
    if (typeof command === "string" && command.trim()) return command.trim();
  }
  return undefined;
}

let lastConfigWarning: string | undefined;
function warnInvalidConfig(reason: string): void {
  const message = `[meowcode] .meowcode/verify.json ignored (${reason}); falling back to auto-detection.`;
  if (message === lastConfigWarning) return;
  lastConfigWarning = message;
  console.warn(message);
}

/**
 * 启发式探测 typecheck 命令（纯函数，便于单测）。优先级：
 * scripts.typecheck → scripts["type-check"] → scripts.tsc → tsconfig.json 存在时 npx tsc --noEmit。
 */
export function detectTypecheckCommand(
  scripts: Record<string, unknown> | undefined,
  hasTsconfig: boolean,
): string | undefined {
  if (scripts) {
    for (const key of ["typecheck", "type-check", "tsc"]) {
      const value = scripts[key];
      if (typeof value === "string" && value.trim()) return `npm run ${key} --silent`;
    }
  }
  if (hasTsconfig) return "npx --no-install tsc --noEmit";
  return undefined;
}

async function readPackageScripts(workspace: string): Promise<Record<string, unknown> | undefined> {
  try {
    const file = await resolveWithinWorkspace(workspace, "package.json");
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const scripts = (parsed as Record<string, unknown>).scripts;
      if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
        return scripts as Record<string, unknown>;
      }
    }
  } catch {
    // 无 package.json / 坏 JSON / 越界 → 没有 scripts 可探测
  }
  return undefined;
}

async function hasTsconfig(workspace: string): Promise<boolean> {
  try {
    const file = await resolveWithinWorkspace(workspace, "tsconfig.json");
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

export async function detectTypecheckCommandInWorkspace(
  workspace: string,
): Promise<string | undefined> {
  return detectTypecheckCommand(await readPackageScripts(workspace), await hasTsconfig(workspace));
}

/**
 * 读取并归一化 .meowcode/verify.json。每次验证时重读（配置改动下一笔写即生效）。
 * 缺失 → 启发式探测；坏 JSON / 非 object / 越界 symlink → 回退启发式并 console.warn。
 * 单字段类型错只丢该字段，其余照常生效。绝不 throw。
 */
export async function loadVerifyConfig(workspace: string): Promise<VerifyConfig> {
  let raw: Record<string, unknown> | undefined;
  try {
    const file = await resolveWithinWorkspace(workspace, VERIFY_CONFIG_RELATIVE);
    if ((await fs.stat(file)).isFile()) {
      const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      } else {
        warnInvalidConfig("not a JSON object");
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnInvalidConfig(error instanceof Error ? error.message : String(error));
    }
  }

  // typecheck：显式 false=禁用；合法命令=直接用；缺省/无效=启发式
  const typecheckSpec = raw ? normalizeCommandSpec(raw.typecheck) : undefined;
  let typecheck: string | undefined;
  if (typecheckSpec === false) {
    typecheck = undefined;
  } else if (typeof typecheckSpec === "string") {
    typecheck = typecheckSpec;
  } else {
    typecheck = await detectTypecheckCommandInWorkspace(workspace);
  }

  // lint / test：无启发式，只认显式配置
  const lintSpec = raw ? normalizeCommandSpec(raw.lint) : undefined;
  const testSpec = raw ? normalizeCommandSpec(raw.test) : undefined;
  const commands: VerifyCommand[] = [];
  if (typecheck) commands.push({ id: "typecheck", command: typecheck });
  if (typeof lintSpec === "string") commands.push({ id: "lint", command: lintSpec });
  if (typeof testSpec === "string") commands.push({ id: "test", command: testSpec });

  let include = DEFAULT_VERIFY_INCLUDE;
  const rawInclude = raw?.include;
  if (rawInclude !== undefined) {
    if (Array.isArray(rawInclude) && rawInclude.every((item) => typeof item === "string")) {
      include = (rawInclude as string[])
        .map((item) => item.trim().replace(/^\./, "").toLowerCase())
        .filter(Boolean);
    } else {
      warnInvalidConfig("include must be an array of strings");
    }
  }

  let maxFeedbackPerTurn = DEFAULT_MAX_FEEDBACK_PER_TURN;
  const rawMax = raw?.maxFeedbackPerTurn;
  if (rawMax !== undefined) {
    if (typeof rawMax === "number" && Number.isInteger(rawMax) && rawMax >= 0 && rawMax <= 5) {
      maxFeedbackPerTurn = rawMax;
    } else {
      warnInvalidConfig("maxFeedbackPerTurn must be an integer between 0 and 5");
    }
  }

  return { commands, maxFeedbackPerTurn, include };
}

// ---------- 输出解析 ----------

export interface TscDiagnostic {
  file: string;
  line: number;
  col: number;
  code: string;
  msg: string;
}

/**
 * tsc 诊断行：`file(line,col): error TS1234: message`（Windows 反斜杠路径同样命中）。
 * 靠 `(N,N): error/warning TS\d+: ` 结构性前缀区分正文里的 foo(1,2)；文件名须长得像路径
 * （含分隔符或带扩展名）防误匹配。
 */
const TSC_DIAGNOSTIC_LINE =
  /^(?<file>.+?)\((?<line>\d+),(?<col>\d+)\):\s*(?:error|warning)\s+(?<code>TS\d+):\s*(?<msg>.+)$/;

function looksLikePath(file: string): boolean {
  return /[\\/]/.test(file) || /\.[A-Za-z0-9]+$/.test(file);
}

export function parseTscErrors(output: string): TscDiagnostic[] {
  const seen = new Set<string>();
  const diagnostics: TscDiagnostic[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = TSC_DIAGNOSTIC_LINE.exec(line);
    if (!match || !match.groups) continue;
    const { file, line: lineStr, col: colStr, code, msg } = match.groups;
    if (!looksLikePath(file)) continue;
    const key = `${file}|${lineStr}|${colStr}|${code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push({ file, line: Number(lineStr), col: Number(colStr), code, msg: msg.trim() });
  }
  return diagnostics;
}

/** 命令"没跑起来"的特征：spawn 失败、找不到命令、超时——这些不该让模型去改源码。 */
const COMMAND_NOT_RUN_PATTERN =
  /Command timed out|spawn .+ENOENT|is not recognized|is not recognized as|Command not found|无法将|无法识别|not recognized as an internal or external command/i;

function clipText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}... [truncated]`;
}

/** 无结构化诊断的失败输出（lint/test/未知格式）：头尾保留 + 中段省略。 */
function clipGenericOutput(output: string): string {
  const lines = output.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length <= GENERIC_HEAD_LINES * 2) {
    return clipText(lines.join("\n"), MAX_GENERIC_FEEDBACK_CHARS);
  }
  const head = lines.slice(0, GENERIC_HEAD_LINES);
  const tail = lines.slice(-GENERIC_HEAD_LINES);
  const omitted = lines.length - head.length - tail.length;
  return clipText(
    [...head, `... [${omitted} lines omitted]`, ...tail].join("\n"),
    MAX_GENERIC_FEEDBACK_CHARS,
  );
}

// ---------- 反馈格式化 ----------

/**
 * 把失败步骤压成可直接附加到 tool result 的文本：
 * tsc 诊断按文件分组（每文件 ≤5 条、全局 ≤20 条），无结构的走通用兜底，
 * 命令没跑起来的明确告诉模型"别修代码，如实告知用户"。
 */
export function formatVerifyFeedback(failed: VerifyStepResult[]): string {
  const sections: string[] = [];
  for (const step of failed) {
    const lines: string[] = [`--- auto-verify: ${step.id} FAILED (${step.command}) ---`];
    if (step.commandError) {
      // 命令没跑起来：引导模型报告环境问题，而不是去"修代码"
      lines.push(
        "Verification command could not run:",
        clipText(step.commandError, 500),
        "Do not attempt to fix source code for this. If it is an environment problem, tell the user.",
      );
    } else {
      const diagnostics = parseTscErrors(step.output);
      if (diagnostics.length) {
        const perFile = new Map<string, number>();
        const kept: TscDiagnostic[] = [];
        for (const diag of diagnostics) {
          if (kept.length >= MAX_FEEDBACK_ERRORS) break;
          const count = perFile.get(diag.file) ?? 0;
          if (count >= MAX_ERRORS_PER_FILE) continue;
          perFile.set(diag.file, count + 1);
          kept.push(diag);
        }
        for (const diag of kept) {
          lines.push(`${diag.file}(${diag.line},${diag.col}): ${diag.code}: ${diag.msg}`);
        }
        const keptKeys = new Set(kept.map((diag) => `${diag.file}|${diag.line}|${diag.col}|${diag.code}`));
        const omittedDiags = diagnostics.filter(
          (diag) => !keptKeys.has(`${diag.file}|${diag.line}|${diag.col}|${diag.code}`),
        );
        if (omittedDiags.length) {
          const omittedFiles = new Set(omittedDiags.map((diag) => diag.file)).size;
          lines.push(
            `... [${omittedDiags.length} more error${omittedDiags.length === 1 ? "" : "s"} in ${omittedFiles} file${
              omittedFiles === 1 ? "" : "s"
            } omitted; re-run the command for the full list]`,
          );
        }
        lines.push("[Automatic verification feedback. Fix these errors in this turn before finishing.]");
      } else {
        lines.push(clipGenericOutput(step.output));
        lines.push("[Automatic verification feedback. Fix these errors in this turn before finishing.]");
      }
    }
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
}

// ---------- 执行 ----------

function stepFromResult(id: string, command: string, result: ToolResult): VerifyStepResult {
  if (result.ok) return { id, command, passed: true, output: result.output };
  const output = result.output;
  if (output.startsWith("Command timed out")) {
    return {
      id,
      command,
      passed: false,
      output,
      commandError: "Verification command timed out after 120s and was terminated.",
    };
  }
  if (COMMAND_NOT_RUN_PATTERN.test(output)) {
    return { id, command, passed: false, output, commandError: clipText(output, 500) };
  }
  return { id, command, passed: false, output };
}

/**
 * 串行跑全部验证命令（复用 run_command 的超时/进程树 kill/UTF-8/截断/落盘）。
 * 回合中止立即放弃（中止不算验证结果）。失败的步骤压成 feedback。
 */
export async function runVerification(
  config: VerifyConfig,
  workspace: string,
  signal?: AbortSignal,
): Promise<VerificationResult> {
  if (!config.commands.length) {
    return { ran: false, skippedReason: "no-commands", steps: [], passed: true };
  }
  if (signal?.aborted) {
    return { ran: false, skippedReason: "aborted", steps: [], passed: true };
  }
  const steps: VerifyStepResult[] = [];
  for (const { id, command } of config.commands) {
    let result: ToolResult;
    try {
      result = await executeTool("run_command", { command }, workspace, { signal });
    } catch (error) {
      if (signal?.aborted) {
        return { ran: false, skippedReason: "aborted", steps: [], passed: true };
      }
      steps.push({
        id,
        command,
        passed: false,
        output: "",
        commandError: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (signal?.aborted) {
      return { ran: false, skippedReason: "aborted", steps: [], passed: true };
    }
    steps.push(stepFromResult(id, command, result));
  }
  const failed = steps.filter((step) => !step.passed);
  return {
    ran: true,
    steps,
    passed: failed.length === 0,
    feedback: failed.length ? formatVerifyFeedback(failed) : undefined,
  };
}
