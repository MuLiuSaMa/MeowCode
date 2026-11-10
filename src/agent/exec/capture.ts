import { spawn, type ChildProcess } from "node:child_process";
import { createAnsiStripper } from "./ansi.js";
import { createOutputSink } from "./encoding.js";
import { killProcessTree } from "./process-tree.js";
import type { ExecResult, ExecSpec } from "./types.js";

/**
 * 等 taskkill 收工的上限。杀进程树要真等到位（否则孙进程成孤儿），
 * 但也不能让 settle 无限期挂住 —— 300ms 之后按已尽力处理。
 */
const KILL_GRACE_MS = 300;

/**
 * 唯一 spawn + 采集实现：退出码、超时、abort、上限、截断标志。
 * 不负责解码/截断/落盘——那些属于工具适配层，避免执行面认识 ToolResult。
 */
export function runCapture(spec: ExecSpec): Promise<ExecResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const stdout = createOutputSink(spec.maxCaptureBytes);
    const stderr = createOutputSink(spec.maxCaptureBytes);
    // ANSI 清理放在采集之前：ESC 序列全是 ASCII，先清再攒不会破坏多字节字符，
    // 也让 1MB 上限算的是真正有意义的字节。
    const stdoutAnsi = createAnsiStripper();
    const stderrAnsi = createAnsiStripper();
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let child: ChildProcess | undefined;

    const settle = (outcome: {
      code: number | null;
      timedOut: boolean;
      aborted: boolean;
      spawnError?: string;
      /** true = 先等进程树杀干净再回执（超时/取消） */
      kill?: boolean;
    }): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      spec.signal?.removeEventListener("abort", onAbort);
      const done = (): void => {
        stdoutAnsi.flush();
        stderrAnsi.flush();
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        resolve({
          stdout: stdout.buffer(),
          stderr: stderr.buffer(),
          stdoutTail: stdout.tail(),
          stderrTail: stderr.tail(),
          stdoutOmittedBytes: stdout.omittedBytes,
          stderrOmittedBytes: stderr.omittedBytes,
          code: outcome.code,
          timedOut: outcome.timedOut,
          aborted: outcome.aborted,
          capped: stdout.capped || stderr.capped,
          ...(outcome.spawnError !== undefined ? { spawnError: outcome.spawnError } : {}),
          durationMs: Date.now() - startedAt,
          timeoutMs: spec.timeoutMs,
        });
      };
      if (!outcome.kill || !child) {
        done();
        return;
      }
      // 超时/取消：等 taskkill 真的把整棵树带走再回执（有上限，不会一直等）
      void Promise.race([killProcessTree(child), new Promise((r) => setTimeout(r, KILL_GRACE_MS))])
        .catch(() => undefined)
        .finally(done);
    };
    const onAbort = (): void => {
      settle({ code: null, timedOut: false, aborted: true, kill: true });
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

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(stdoutAnsi.push(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(stderrAnsi.push(chunk)));
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
      settle({ code: null, timedOut: true, aborted: false, kill: true });
    }, spec.timeoutMs);
  });
}
