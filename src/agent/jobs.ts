import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { killProcessTree } from "./exec/process-tree.js";
import { commandEnv } from "./exec/env.js";

/**
 * 后台任务（job）：桌面端由主进程的 job-host 持有 PTY（用户可在终端页签接管），
 * 无桌面环境（CLI/测试）回落到本地子进程管理器，接口一致。
 * 输出只保留尾部 256KB；模型用 offset 增量读，不重复回灌。
 */
export type JobInfo = {
  id: string;
  command: string;
  cwd?: string;
  startedAt?: string;
  exited: boolean;
  code: number | null;
};

export type JobChunk = {
  data: string;
  offset: number;
  bufferStart: number;
  truncated: boolean;
  exited: boolean;
  code: number | null;
};

export type JobManager = {
  start(input: { command: string; cwd?: string }): Promise<{ id: string; shell?: string }>;
  read(id: string, offset?: number): Promise<JobChunk | null>;
  write(id: string, data: string): Promise<void>;
  kill(id: string): Promise<void>;
  list(): Promise<JobInfo[]>;
};

const JOB_BUFFER_MAX_CHARS = 256 * 1024;
const HTTP_TIMEOUT_MS = 10_000;

function tailOf(text: string, start: number): JobChunk["data"] {
  return text.slice(Math.max(0, start));
}

export function createJobManager(env: NodeJS.ProcessEnv = process.env): JobManager {
  const baseUrl = env.MEOWCODE_JOB_HOST;
  const token = env.MEOWCODE_JOB_HOST_TOKEN;
  if (baseUrl && token) return createHttpJobManager({ baseUrl, token });
  return createLocalJobManager();
}

export function createHttpJobManager(options: {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}): JobManager {
  const timeoutMs = options.timeoutMs ?? HTTP_TIMEOUT_MS;
  const call = async (route: string, init: RequestInit = {}): Promise<Response> => {
    const response = await fetch(new URL(route, options.baseUrl), {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-meow-job-token": options.token,
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response;
  };
  const json = async <T>(response: Response): Promise<T> => {
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`job host ${response.status}: ${detail.slice(0, 300)}`);
    }
    return (await response.json()) as T;
  };

  return {
    async start(input) {
      const response = await call("/job/start", {
        method: "POST",
        body: JSON.stringify({
          command: input.command,
          ...(input.cwd ? { cwd: input.cwd } : {}),
        }),
      });
      return json<{ id: string; shell?: string }>(response);
    },
    async read(id, offset) {
      const query = offset === undefined ? "" : `&offset=${encodeURIComponent(String(offset))}`;
      const response = await call(`/job/read?id=${encodeURIComponent(id)}${query}`);
      if (response.status === 404) return null;
      return json<JobChunk>(response);
    },
    async write(id, data) {
      await json(
        await call("/job/input", {
          method: "POST",
          body: JSON.stringify({ id, data }),
        }),
      );
    },
    async kill(id) {
      await json(
        await call("/job/kill", {
          method: "POST",
          body: JSON.stringify({ id }),
        }),
      );
    },
    async list() {
      const result = await json<{ jobs: JobInfo[] }>(await call("/job/list"));
      return result.jobs;
    },
  };
}

type LocalJob = {
  id: string;
  command: string;
  cwd: string;
  startedAt: string;
  child: ChildProcess;
  buffer: string;
  bufferStart: number;
  exited: boolean;
  code: number | null;
};

export function createLocalJobManager(): JobManager {
  const jobs = new Map<string, LocalJob>();

  const append = (job: LocalJob, chunk: Buffer | string) => {
    job.buffer += chunk.toString();
    if (job.buffer.length > JOB_BUFFER_MAX_CHARS) {
      const drop = job.buffer.length - JOB_BUFFER_MAX_CHARS;
      job.buffer = job.buffer.slice(drop);
      job.bufferStart += drop;
    }
  };

  return {
    async start(input) {
      const id = `job-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
      const cwd = input.cwd && input.cwd.trim() ? input.cwd : process.cwd();
      const child = spawn(input.command, {
        shell: true,
        cwd,
        windowsHide: true,
        env: commandEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      const job: LocalJob = {
        id,
        command: input.command,
        cwd,
        startedAt: new Date().toISOString(),
        child,
        buffer: "",
        bufferStart: 0,
        exited: false,
        code: null,
      };
      jobs.set(id, job);
      child.stdout?.on("data", (chunk: Buffer) => append(job, chunk));
      child.stderr?.on("data", (chunk: Buffer) => append(job, chunk));
      child.on("close", (code) => {
        job.exited = true;
        job.code = code;
      });
      child.on("error", (error) => {
        job.exited = true;
        append(job, `\n[spawn error] ${error.message}\n`);
      });
      return { id };
    },
    async read(id, offset) {
      const job = jobs.get(id);
      if (!job) return null;
      return {
        data: tailOf(job.buffer, offset ?? job.bufferStart),
        offset: job.bufferStart + job.buffer.length,
        bufferStart: job.bufferStart,
        truncated: (offset ?? job.bufferStart) < job.bufferStart,
        exited: job.exited,
        code: job.code,
      };
    },
    async write(id, data) {
      const job = jobs.get(id);
      if (!job || job.exited) return;
      job.child.stdin?.write(data);
    },
    async kill(id) {
      const job = jobs.get(id);
      if (!job) return;
      if (!job.exited) killProcessTree(job.child);
      jobs.delete(id);
    },
    async list() {
      return [...jobs.values()].map((job) => ({
        id: job.id,
        command: job.command,
        cwd: job.cwd,
        startedAt: job.startedAt,
        exited: job.exited,
        code: job.code,
      }));
    },
  };
}
