import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCapture } from "../exec/capture.js";
import { decodeCommandOutput } from "../exec/encoding.js";
import { commandEnv } from "../exec/env.js";
import type { ExecSpec } from "../exec/types.js";
import { sandboxErrorMessage, type SandboxConfigErrorCode } from "./errors.js";
import { buildRunnerArgv, resolveExecutableOnPath } from "./runner-args.js";
import type { SandboxSettings } from "./types.js";

const MAX_TEMP_AGE_MS = 24 * 60 * 60 * 1000;

export type SandboxProbeResult = {
  ok: boolean;
  detail?: string;
  durationMs: number;
};

export type SandboxRevokeResult = SandboxProbeResult & {
  revoked: boolean;
};

function unavailable(code: SandboxConfigErrorCode, detail: string): {
  unavailable: { code: string; detail: string };
} {
  return {
    unavailable: {
      code,
      detail: `${sandboxErrorMessage(code)}${detail ? ` (${detail})` : ""}`,
    },
  };
}

export function defaultSandboxTempRoot(): string {
  return join(process.env.LOCALAPPDATA ?? tmpdir(), "MeowCode", "sandbox-temp");
}

export function sandboxRunnerPath(): string {
  return (
    process.env.MEOWCODE_SANDBOX_RUNNER ??
    fileURLToPath(new URL("./windows/runner.js", import.meta.url))
  );
}

function sandboxNodePath(): string {
  return process.env.MEOWCODE_SANDBOX_NODE ?? process.execPath;
}

function runnerEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    // 桌面端 process.execPath 是 MeowCode.exe；没有它 runner 会再弹一个应用窗口
    ELECTRON_RUN_AS_NODE: "1",
    NODE_NO_WARNINGS: "1",
    ...(process.env.MEOWCODE_SANDBOX_KOFFI
      ? { MEOWCODE_SANDBOX_KOFFI: process.env.MEOWCODE_SANDBOX_KOFFI }
      : {}),
    ...(process.env.MEOWCODE_SANDBOX_DEBUG
      ? { MEOWCODE_SANDBOX_DEBUG: process.env.MEOWCODE_SANDBOX_DEBUG }
      : {}),
  };
}

let cleanedTempDirs = false;

/** 清掉被硬杀后遗留超过 24h 的私有 temp；正常路径 runner 自己会删。 */
export function cleanupOldSandboxTempDirs(now = Date.now()): number {
  const root = defaultSandboxTempRoot();
  let removed = 0;
  try {
    for (const name of readdirSync(root)) {
      if (!name.startsWith("mb-")) continue;
      const target = join(root, name);
      try {
        if (now - statSync(target).mtimeMs > MAX_TEMP_AGE_MS) {
          rmSync(target, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        // 目录被并发清理/占用：留给下一次
      }
    }
  } catch {
    // temp 根还不存在
  }
  return removed;
}

function cleanupOldTempDirsOnce(): void {
  if (cleanedTempDirs) return;
  cleanedTempDirs = true;
  cleanupOldSandboxTempDirs();
}

/**
 * 把普通 PowerShell ExecSpec 换成「node runner.js -- ... pwsh」。
 * runner 缺失 / 不可解析时返回 unavailable：绝不回退无沙箱执行。
 */
export function wrapExecSpec(
  spec: ExecSpec,
  settings: SandboxSettings,
): { spec: ExecSpec } | { unavailable: { code: string; detail: string } } {
  if (process.platform !== "win32") return unavailable("not_win32", process.platform);
  const runner = sandboxRunnerPath();
  if (!existsSync(runner)) return unavailable("runner_missing", runner);
  const node = sandboxNodePath();
  if (!existsSync(node)) return unavailable("runner_missing", node);
  const executable = resolveExecutableOnPath(spec.file);
  if (executable === undefined) return unavailable("runner_missing", spec.file);

  const argv = buildRunnerArgv({
    action: "run",
    workspace: spec.cwd,
    writableRoots: settings.writableRoots,
    tempRoot: settings.allowTemp ? defaultSandboxTempRoot() : null,
    mode: "workspace-write",
    executable,
    args: spec.args,
  });
  cleanupOldTempDirsOnce();
  return {
    spec: {
      ...spec,
      file: node,
      args: [runner, ...argv],
      env: runnerEnv(spec.env),
      closeStdin: true,
      windowsHide: true,
    },
  };
}

function runnerCaptureSpec(options: {
  workspace: string;
  runnerArgv: string[];
  timeoutMs: number;
  baseEnv?: NodeJS.ProcessEnv;
}): ExecSpec {
  return {
    file: sandboxNodePath(),
    args: [sandboxRunnerPath(), ...options.runnerArgv],
    cwd: options.workspace,
    env: runnerEnv(options.baseEnv ?? commandEnv()),
    timeoutMs: options.timeoutMs,
    maxCaptureBytes: 64 * 1024,
    closeStdin: true,
    windowsHide: true,
  };
}

function failureDetail(result: {
  code: number | null;
  timedOut: boolean;
  spawnError?: string;
  stdout: Buffer;
  stderr: Buffer;
}): string {
  if (result.timedOut) return "timed out";
  if (result.spawnError) return result.spawnError;
  const stderr = decodeCommandOutput(result.stderr).trim();
  const stdout = decodeCommandOutput(result.stdout).trim();
  return (stderr || stdout || `exit ${String(result.code)}`).slice(0, 400);
}

/** 跑一次 `cmd /d /s /c exit 0`：同时完成首次 ACL 传播与能力探测。 */
export async function probeSandbox(options: {
  workspace: string;
  settings: SandboxSettings;
  timeoutMs?: number;
}): Promise<SandboxProbeResult> {
  if (process.platform !== "win32") {
    return { ok: false, detail: sandboxErrorMessage("not_win32"), durationMs: 0 };
  }
  const runner = sandboxRunnerPath();
  if (!existsSync(runner)) {
    return { ok: false, detail: `${sandboxErrorMessage("runner_missing")}: ${runner}`, durationMs: 0 };
  }
  const cmd =
    resolveExecutableOnPath(process.env.ComSpec ?? "cmd.exe") ??
    resolveExecutableOnPath("cmd.exe");
  if (cmd === undefined) {
    return { ok: false, detail: "cannot resolve cmd.exe", durationMs: 0 };
  }
  const runnerArgv = buildRunnerArgv({
    action: "run",
    workspace: options.workspace,
    writableRoots: options.settings.writableRoots,
    tempRoot: options.settings.allowTemp ? defaultSandboxTempRoot() : null,
    mode: "workspace-write",
    executable: cmd,
    args: ["/d", "/s", "/c", "exit 0"],
  });
  const startedAt = Date.now();
  const result = await runCapture(
    runnerCaptureSpec({
      workspace: options.workspace,
      runnerArgv,
      timeoutMs: options.timeoutMs ?? options.settings.grantTimeoutMs,
    }),
  );
  const durationMs = Date.now() - startedAt;
  if (result.code === 0 && !result.timedOut && result.spawnError === undefined) {
    cleanupOldSandboxTempDirs();
    return { ok: true, durationMs };
  }
  return { ok: false, detail: failureDetail(result), durationMs };
}

/** 完整撤销工作区 + 额外可写根；runner 输出 revoked/no-grant。 */
export async function revokeSandboxGrantsRemote(options: {
  workspace: string;
  settings: SandboxSettings;
  timeoutMs?: number;
}): Promise<SandboxRevokeResult> {
  if (process.platform !== "win32") {
    return { ok: false, revoked: false, detail: sandboxErrorMessage("not_win32"), durationMs: 0 };
  }
  const runner = sandboxRunnerPath();
  if (!existsSync(runner)) {
    return {
      ok: false,
      revoked: false,
      detail: `${sandboxErrorMessage("runner_missing")}: ${runner}`,
      durationMs: 0,
    };
  }
  const runnerArgv = buildRunnerArgv({
    action: "revoke",
    workspace: options.workspace,
    writableRoots: options.settings.writableRoots,
  });
  const startedAt = Date.now();
  const result = await runCapture(
    runnerCaptureSpec({
      workspace: options.workspace,
      runnerArgv,
      timeoutMs: options.timeoutMs ?? options.settings.grantTimeoutMs,
    }),
  );
  const durationMs = Date.now() - startedAt;
  if (result.code === 0 && !result.timedOut && result.spawnError === undefined) {
    return {
      ok: true,
      revoked: decodeCommandOutput(result.stdout).trim() === "revoked",
      durationMs,
    };
  }
  return { ok: false, revoked: false, detail: failureDetail(result), durationMs };
}
