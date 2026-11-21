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

export type JobWaitOptions = {
  /** 从哪个 offset 之后开始看；省略 = 只看这次调用之后的新输出 */
  offset?: number;
  timeoutMs: number;
  /** exit = 攒到进程退出或到点；output = 一有新输出就返回 */
  until: "exit" | "output";
};

export type AdoptJobInput = {
  command: string;
  cwd: string;
  child: ChildProcess;
  /** 超时前已经采集到的输出（已清 ANSI） */
  stdout: Buffer;
  stderr: Buffer;
};

export type JobManager = {
  start(input: { command: string; cwd?: string }): Promise<{ id: string; shell?: string }>;
  read(id: string, offset?: number): Promise<JobChunk | null>;
  /** 阻塞等待：有新输出（until=output）、退出或到点返回；job 不存在返回 null */
  wait(id: string, options: JobWaitOptions): Promise<JobChunk | null>;
  write(id: string, data: string): Promise<void>;
  kill(id: string): Promise<void>;
  list(): Promise<JobInfo[]>;
  /** 把超时的前台进程接管成本地 job（只有进程内的 manager 支持） */
  adopt?(input: AdoptJobInput): string;
};

const JOB_BUFFER_MAX_CHARS = 256 * 1024;
const HTTP_TIMEOUT_MS = 10_000;
/** 本地 job 并发上限：每个 job 都是一个真进程，无上限等于允许模型 fork 炸弹。 */
const MAX_LOCAL_JOBS = 8;
/** 已退出 job 的保留时长：给模型留出读尾部输出的时间，之后回收。 */
const JOB_RETENTION_MS = 10 * 60 * 1000;

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
  const call = async (
    route: string,
    init: RequestInit = {},
    requestTimeoutMs = timeoutMs,
  ): Promise<Response> => {
    const response = await fetch(new URL(route, options.baseUrl), {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-meow-job-token": options.token,
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: AbortSignal.timeout(requestTimeoutMs),
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
    async wait(id, options) {
      const params = new URLSearchParams({
        id,
        timeout_ms: String(options.timeoutMs),
        until: options.until,
      });
      if (options.offset !== undefined) params.set("offset", String(options.offset));
      // 宿主自己会等到点再返回，客户端的超时要留出网络余量
      const response = await call(`/job/wait?${params.toString()}`, {}, options.timeoutMs + 5_000);
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
  /** 退出时间（毫秒）：已退出的 job 保留一段时间供模型读尾部输出，之后回收 */
  exitedAt?: number;
  /** 有新输出 / 退出时唤醒所有等待者 */
  waiters: Set<() => void>;
};

export function createLocalJobManager(): JobManager {
  const jobs = new Map<string, LocalJob>();

  // 不清空 waiters：until=exit 的等待要活到进程退出，check 自己在 finish 时摘掉
  const wake = (job: LocalJob): void => {
    for (const check of [...job.waiters]) check();
  };

  const snapshot = (job: LocalJob, offset: number | undefined): JobChunk => {
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
  const waitFor = (job: LocalJob, from: number, timeoutMs: number, until: "exit" | "output") =>
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

  /** 回收已退出且超过保留期的 job，并统计还活着的数量。 */
  const reap = (): number => {
    const now = Date.now();
    let live = 0;
    for (const [id, job] of jobs) {
      if (!job.exited) {
        live += 1;
        continue;
      }
      if (job.exitedAt !== undefined && now - job.exitedAt >= JOB_RETENTION_MS) jobs.delete(id);
    }
    return live;
  };

  const append = (job: LocalJob, chunk: Buffer | string) => {
    const text = chunk.toString();
    if (!text) return;
    job.buffer += text;
    if (job.buffer.length > JOB_BUFFER_MAX_CHARS) {
      const drop = job.buffer.length - JOB_BUFFER_MAX_CHARS;
      job.buffer = job.buffer.slice(drop);
      job.bufferStart += drop;
    }
    wake(job);
  };

  return {
    async start(input) {
      const live = reap();
      if (live >= MAX_LOCAL_JOBS) {
        throw new Error(
          `Background job limit reached: ${MAX_LOCAL_JOBS} jobs may run at once. Kill one with the job tool before starting another.`,
        );
      }
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
        waiters: new Set(),
      };
      jobs.set(id, job);
      child.stdout?.on("data", (chunk: Buffer) => append(job, chunk));
      child.stderr?.on("data", (chunk: Buffer) => append(job, chunk));
      child.on("close", (code) => {
        job.exited = true;
        job.code = code;
        job.exitedAt = Date.now();
        wake(job);
      });
      child.on("error", (error) => {
        job.exited = true;
        job.exitedAt = Date.now();
        append(job, `\n[spawn error] ${error.message}\n`);
      });
      return { id };
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

/**
 * 多个 job 来源合成一个：桌面端 PTY 任务在前，超时提升出来的本地任务在后。
 * id 由 start / adopt 现场登记归属，读不到再按顺序回退探测，避免不同来源的 id 撞车。
 */
export function combineJobManagers(...managers: JobManager[]): JobManager {
  const live = managers.filter(Boolean);
  if (live.length === 1) return live[0]!;
  const owners = new Map<string, JobManager>();
  const candidates = (id: string): JobManager[] => {
    const owner = owners.get(id);
    return owner ? [owner, ...live.filter((manager) => manager !== owner)] : live;
  };

  return {
    async start(input) {
      // 保留第一个失败原因：后面的 manager 可能根本不支持启动（比如超时提升出来的本地任务）
      let firstError: unknown;
      for (const manager of live) {
        try {
          const started = await manager.start(input);
          owners.set(started.id, manager);
          return started;
        } catch (error) {
          firstError ??= error;
        }
      }
      throw firstError instanceof Error ? firstError : new Error(String(firstError));
    },
    async read(id, offset) {
      for (const manager of candidates(id)) {
        const chunk = await manager.read(id, offset);
        if (chunk) {
          owners.set(id, manager);
          return chunk;
        }
      }
      return null;
    },
    async wait(id, options) {
      for (const manager of candidates(id)) {
        const chunk = await manager.wait(id, options);
        if (chunk) {
          owners.set(id, manager);
          return chunk;
        }
      }
      return null;
    },
    async write(id, data) {
      for (const manager of candidates(id)) {
        if (await manager.read(id)) {
          await manager.write(id, data);
          return;
        }
      }
    },
    async kill(id) {
      for (const manager of candidates(id)) {
        if (await manager.read(id)) {
          await manager.kill(id);
          owners.delete(id);
          return;
        }
      }
    },
    async list() {
      const all = await Promise.all(live.map((manager) => manager.list()));
      const seen = new Set<string>();
      return all
        .flat()
        .filter((job) => (seen.has(job.id) ? false : (seen.add(job.id), true)));
    },
    adopt(input) {
      for (const manager of live) {
        if (manager.adopt) {
          const id = manager.adopt(input);
          owners.set(id, manager);
          return id;
        }
      }
      throw new Error("No job manager can adopt a promoted command.");
    },
  };
}
