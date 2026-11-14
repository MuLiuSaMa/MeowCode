import type { JobManager } from "./jobs.js";

/** 后台任务退出的轮询间隔，以及通知里保留的尾部输出长度。 */
export const JOB_WATCH_INTERVAL_MS = 2_000;
export const JOB_EXIT_NOTE_CHARS = 1_500;

export type JobExit = {
  id: string;
  command: string;
  code: number | null;
  tail: string;
};

/**
 * 后台任务退出轮询：start 时 track；模型用 output/wait 读到退出就 observe（不再重复通知）；
 * 退出且未被看到时回调一次。任务被 kill / 从列表消失时静默取消。
 */
export class JobExitWatcher {
  private tracked = new Map<string, { observed: boolean }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(
    private readonly manager: JobManager,
    private readonly onExit: (job: JobExit) => void,
    private readonly intervalMs: number = JOB_WATCH_INTERVAL_MS,
  ) {}

  get size(): number {
    return this.tracked.size;
  }

  track(id: string): void {
    this.tracked.set(id, { observed: false });
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.poll();
      }, this.intervalMs);
      this.timer.unref?.();
    }
  }

  /** 模型已经通过 output/wait 看到退出：不再写通知。 */
  observe(id: string): void {
    const tracked = this.tracked.get(id);
    if (tracked) tracked.observed = true;
  }

  untrack(id: string): void {
    this.tracked.delete(id);
    this.stopIfIdle();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.tracked.clear();
  }

  private stopIfIdle(): void {
    if (this.tracked.size > 0 || !this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    if (this.polling || this.tracked.size === 0) {
      this.stopIfIdle();
      return;
    }
    this.polling = true;
    try {
      const jobs = await this.manager.list();
      const byId = new Map(jobs.map((job) => [job.id, job]));
      for (const [id, tracked] of [...this.tracked]) {
        const job = byId.get(id);
        if (!job) {
          this.tracked.delete(id);
          continue;
        }
        if (!job.exited) continue;
        this.tracked.delete(id);
        if (tracked.observed) continue;
        const chunk = await this.manager.read(id).catch(() => null);
        const tail = chunk?.data ? chunk.data.trim().slice(-JOB_EXIT_NOTE_CHARS) : "";
        this.onExit({ id, command: job.command, code: job.code ?? chunk?.code ?? null, tail });
      }
    } catch {
      // job host 暂时不可达：下一轮再试
    } finally {
      this.polling = false;
      this.stopIfIdle();
    }
  }
}
