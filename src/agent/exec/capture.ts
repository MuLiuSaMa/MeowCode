import { spawn, type ChildProcess } from "node:child_process";
import { createOutputSink } from "./encoding.js";
import { killProcessTree } from "./process-tree.js";
import type { ExecResult, ExecSpec } from "./types.js";

/**
 * 唯一 spawn + 采集实现：退出码、超时、abort、上限、截断标志。
 * 不负责解码/截断/落盘——那些属于工具适配层，避免执行面认识 ToolResult。
 */
export function runCapture(spec: ExecSpec): Promise<ExecResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const stdout = createOutputSink(spec.maxCaptureBytes);
    const stderr = createOutputSink(spec.maxCaptureBytes);
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let child: ChildProcess | undefined;

    const settle = (outcome: {
      code: number | null;
      timedOut: boolean;
      aborted: boolean;
      spawnError?: string;
    }): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      spec.signal?.removeEventListener("abort", onAbort);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      resolve({
        stdout: stdout.buffer(),
        stderr: stderr.buffer(),
        code: outcome.code,
        timedOut: outcome.timedOut,
        aborted: outcome.aborted,
        capped: stdout.capped || stderr.capped,
        ...(outcome.spawnError !== undefined ? { spawnError: outcome.spawnError } : {}),
        durationMs: Date.now() - startedAt,
      });
    };
    const onAbort = (): void => {
      if (child) killProcessTree(child);
      settle({ code: null, timedOut: false, aborted: true });
    };

    child = spawn(spec.file, spec.args, {
      cwd: spec.cwd,
      windowsHide: spec.windowsHide ?? true,
      // POSIX 上 killProcessTree 依赖进程组；Windows 下 detached 反而会多一个控制台
      detached: process.platform !== "win32",
      env: spec.env,
      // closeStdin 时 stdin 直接 EOF，避免命令读 stdin 一直挂到超时
      stdio: spec.closeStdin ? ["ignore", "pipe", "pipe"] : "pipe",
    });

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) =>
      settle({ code: null, timedOut: false, aborted: false, spawnError: error.message }),
    );
    child.on("close", (code) => settle({ code, timedOut: false, aborted: false }));

    spec.signal?.addEventListener("abort", onAbort, { once: true });
    if (spec.signal?.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(() => {
      if (child) killProcessTree(child);
      settle({ code: null, timedOut: true, aborted: false });
    }, spec.timeoutMs);
  });
}
