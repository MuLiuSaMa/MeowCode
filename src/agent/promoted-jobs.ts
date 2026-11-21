import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import { createAnsiStripper, type AnsiStripper } from "./exec/ansi.js";
import { killProcessTree } from "./exec/process-tree.js";
import type { JobChunk, JobInfo, JobManager } from "./jobs.js";

/**
 * 超时被「提升」为后台任务的前台命令。
 *
 * 前台命令超时后不杀进程：capture 把还活着的子进程连同已采集的输出交出来，
 * 这里接着读它的 stdout/stderr，对外表现得和普通 job 一样（offset 增量读、wait、kill），
 * 这样模型可以用 job 工具继续等它，而不是白等两分钟拿一个失败。
 *
 * 只存在于 agent 进程内：这些进程不是 PTY，用户看不到终端页签，也没有 stdin。
 */

const BUFFER_MAX_CHARS = 256 * 1024;
const JOB_RETENTION_MS = 10 * 60 * 1000;
const MAX_PROMOTED_JOBS = 8;

type PromotedJob = {
  id: string;
  command: string;
  cwd: string;
  startedAt: string;
  child: ChildProcess;
  buffer: string;
  bufferStart: number;
  exited: boolean;
  code: number | null;
  exitedAt?: number;
  /** 有新输出 / 退出时唤醒所有等待者 */
  waiters: Set<() => void>;
  stdout: StringDecoder;
  stderr: StringDecoder;
  stdoutAnsi: AnsiStripper;
  stderrAnsi: AnsiStripper;
};

export type PromotedJobStore = JobManager & {
  /** 接管一个超时的前台进程，返回它的 job id */
  adopt(input: {
    command: string;
    cwd: string;
    child: ChildProcess;
    stdout: Buffer;
    stderr: Buffer;
  }): string;
};

export function createPromotedJobStore(): PromotedJobStore {
  const jobs = new Map<string, PromotedJob>();

  const reap = (): void => {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (job.exited && job.exitedAt !== undefined && now - job.exitedAt >= JOB_RETENTION_MS) {
        jobs.delete(id);
      }
    }
  };

  // 不清空 waiters：until=exit 的等待要活到进程退出，check 自己在 finish 时摘掉
  const wake = (job: PromotedJob): void => {
    for (const check of [...job.waiters]) check();
  };

  const append = (job: PromotedJob, text: string): void => {
    if (!text) return;
    job.buffer += text;
    if (job.buffer.length > BUFFER_MAX_CHARS) {
      const drop = job.buffer.length - BUFFER_MAX_CHARS;
      job.buffer = job.buffer.slice(drop);
      job.bufferStart += drop;
    }
    wake(job);
  };

  const snapshot = (job: PromotedJob, offset: number | undefined): JobChunk => {
    const requested = offset === undefined ? job.bufferStart : Math.max(0, Math.floor(offset));
    const from = Math.max(requested, job.bufferStart);
    return {
      data: job.buffer.slice(from - job.bufferStart),
      offset: job.bufferStart + job.buffer.length,
      bufferStart: job.bufferStart,
      truncated: requested < job.bufferStart,
      exited: job.exited,
      code: job.code,
    };
  };

  /** 等到有新输出、进程退出或到点；返回时的 chunk 覆盖 from 之后的全部内容 */
  const waitFor = (job: PromotedJob, from: number, timeoutMs: number, until: "exit" | "output") =>
    new Promise<JobChunk>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        job.waiters.delete(check);
        resolve(snapshot(job, from));
      };
      const check = (): void => {
        const chunk = snapshot(job, from);
        if (chunk.exited || (until === "output" && chunk.data.length)) finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      job.waiters.add(check);
      check();
    });

  return {
    async start() {
      throw new Error("Promoted jobs cannot be started directly; use run_command.");
    },
    adopt({ command, cwd, child, stdout, stderr }) {
      reap();
      if (jobs.size >= MAX_PROMOTED_JOBS) {
        const oldest = [...jobs.values()].find((job) => job.exited) ?? [...jobs.values()][0];
        if (oldest) jobs.delete(oldest.id);
      }
      const id = `job-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
      const job: PromotedJob = {
        id,
        command,
        cwd,
        startedAt: new Date().toISOString(),
        child,
        buffer: "",
        bufferStart: 0,
        exited: false,
        code: null,
        waiters: new Set(),
        stdout: new StringDecoder("utf8"),
        stderr: new StringDecoder("utf8"),
        stdoutAnsi: createAnsiStripper(),
        stderrAnsi: createAnsiStripper(),
      };
      jobs.set(id, job);
      append(job, stdout.toString("utf8"));
      if (stderr.length) append(job, `\n--- stderr ---\n${stderr.toString("utf8")}`);

      child.stdout?.on("data", (chunk: Buffer) => {
        append(job, job.stdout.write(job.stdoutAnsi.push(chunk)));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        append(job, job.stderr.write(job.stderrAnsi.push(chunk)));
      });
      child.on("close", (code) => {
        append(job, job.stdout.end() + job.stderr.end());
        job.exited = true;
        job.code = code;
        job.exitedAt = Date.now();
        wake(job);
      });
      child.on("error", (error) => {
        append(job, `\n[spawn error] ${error.message}\n`);
        job.exited = true;
        job.exitedAt = Date.now();
        wake(job);
      });
      return id;
    },
    async read(id, offset) {
      const job = jobs.get(id);
      return job ? snapshot(job, offset) : null;
    },
    async wait(id, options) {
      const job = jobs.get(id);
      if (!job) return null;
      const from =
        options.offset === undefined ? job.bufferStart + job.buffer.length : Math.max(0, options.offset);
      return await waitFor(job, from, options.timeoutMs, options.until);
    },
    async write() {
      // 前台命令没有 stdin：提升出来的任务也不接受输入
    },
    async kill(id) {
      const job = jobs.get(id);
      if (!job) return;
      if (!job.exited) killProcessTree(job.child);
      jobs.delete(id);
    },
    async list() {
      reap();
      return [...jobs.values()].map(
        (job): JobInfo => ({
          id: job.id,
          command: job.command,
          cwd: job.cwd,
          startedAt: job.startedAt,
          exited: job.exited,
          code: job.code,
        }),
      );
    },
  };
}
