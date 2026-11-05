/**
 * server 与 runner 共用的 argv 编解码；`--` 之后永远是完整 argv 数组。
 * buildWindowsCommandLine 的 MSVCRT 引用规则移植自 deepseek-harness
 * packages/subprocess/win32-process/src/process.ts（MIT, Copyright (c) 2026 DeepSeek）。
 */

import { existsSync, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";

export class SandboxRunnerArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxRunnerArgumentError";
  }
}

export type RunnerRunInvocation = {
  action: "run";
  workspace: string;
  writableRoots: string[];
  /** null = --no-temp（不授予私有临时目录） */
  tempRoot: string | null;
  mode: "workspace-write" | "read-only";
  executable: string;
  args: string[];
};

export type RunnerRevokeInvocation = {
  action: "revoke";
  workspace: string;
  writableRoots: string[];
};

export type RunnerInvocation = RunnerRunInvocation | RunnerRevokeInvocation;

export function buildRunnerArgv(invocation: RunnerInvocation): string[] {
  const argv = ["--workspace", invocation.workspace];
  for (const root of invocation.writableRoots) {
    argv.push("--writable", root);
  }
  if (invocation.action === "revoke") {
    argv.push("--revoke");
    return argv;
  }
  if (invocation.tempRoot === null) {
    argv.push("--no-temp");
  } else {
    argv.push("--temp", invocation.tempRoot);
  }
  argv.push("--mode", invocation.mode, "--", invocation.executable, ...invocation.args);
  return argv;
}

export function parseRunnerArgv(argv: string[]): RunnerInvocation {
  let workspace: string | undefined;
  let mode: string | undefined;
  let revoke = false;
  let tempRoot: string | null | undefined;
  const writableRoots: string[] = [];
  let command: string[] = [];
  let index = 0;

  for (; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      command = argv.slice(index + 1);
      break;
    }
    if (token === "--revoke") {
      revoke = true;
      continue;
    }
    if (token === "--no-temp") {
      tempRoot = null;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) {
      throw new SandboxRunnerArgumentError(`missing value after ${token}`);
    }
    index += 1;
    switch (token) {
      case "--workspace":
        workspace = value;
        break;
      case "--writable":
        writableRoots.push(value);
        break;
      case "--temp":
        tempRoot = value;
        break;
      case "--mode":
        mode = value;
        break;
      default:
        throw new SandboxRunnerArgumentError(`unknown argument: ${token}`);
    }
  }

  if (workspace === undefined) {
    throw new SandboxRunnerArgumentError("missing --workspace");
  }
  if (revoke) {
    return { action: "revoke", workspace, writableRoots };
  }
  if (mode !== "workspace-write" && mode !== "read-only") {
    throw new SandboxRunnerArgumentError(`unknown mode: ${String(mode)}`);
  }
  if (tempRoot === undefined) {
    throw new SandboxRunnerArgumentError("missing --temp or --no-temp");
  }
  const executable = command[0];
  if (executable === undefined) {
    throw new SandboxRunnerArgumentError("missing command after --");
  }
  return {
    action: "run",
    workspace,
    writableRoots,
    tempRoot,
    mode,
    executable,
    args: command.slice(1),
  };
}

/** 在 PATH 里解析可执行文件；沙箱 runner 的 CreateProcessAsUserW 需要绝对路径。 */
export function resolveExecutableOnPath(
  file: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!file) return undefined;
  const candidates: string[] = [];
  if (isAbsolute(file) || file.includes("/") || file.includes("\\")) {
    candidates.push(file);
  } else {
    const pathValue = env.PATH ?? env.Path ?? "";
    for (const dir of pathValue.split(delimiter).filter(Boolean)) {
      candidates.push(join(dir, file));
      if (platform === "win32" && !extname(file)) {
        candidates.push(join(dir, `${file}.exe`));
      }
    }
    if (platform === "win32") {
      const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
      if (systemRoot) {
        candidates.push(join(systemRoot, "System32", file));
        if (!extname(file)) {
          candidates.push(join(systemRoot, "System32", `${file}.exe`));
        }
        // Windows PowerShell 5.1 不在 System32 根下，PATH 偶尔也不带它
        candidates.push(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", file));
        if (!extname(file)) {
          candidates.push(
            join(systemRoot, "System32", "WindowsPowerShell", "v1.0", `${file}.exe`),
          );
        }
      }
    }
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // 无权限/瞬时消失的候选继续看下一个
    }
  }
  return undefined;
}

/** MSVCRT 引用规则：argv 数组 → 命令行字符串，绝不做 shell 插值。 */
export function buildWindowsCommandLine(file: string, args: readonly string[]): string {
  return [file, ...args].map(quoteWindowsArg).join(" ");
}

function quoteWindowsArg(arg: string): string {
  if (arg.length > 0 && !/[\s"]/u.test(arg)) return arg;
  let result = '"';
  let backslashes = 0;
  for (const char of arg) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      result += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    result += "\\".repeat(backslashes) + char;
    backslashes = 0;
  }
  result += "\\".repeat(backslashes * 2) + '"';
  return result;
}
