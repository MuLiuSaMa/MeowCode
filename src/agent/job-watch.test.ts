import { afterEach, describe, expect, it, vi } from "vitest";
import { JobExitWatcher, type JobExit } from "./job-watch.js";
import type { JobChunk, JobInfo, JobManager } from "./jobs.js";

const EXITED_CHUNK: JobChunk = {
  data: "build done\n",
  offset: 11,
  bufferStart: 0,
  truncated: false,
  exited: true,
  code: 0,
};

function stubJobs(overrides: Partial<JobManager> = {}): JobManager {
  return {
    start: async () => ({ id: "job-1" }),
    read: async () => EXITED_CHUNK,
    write: async () => undefined,
    kill: async () => undefined,
    list: async () => [],
    ...overrides,
  };
}

function running(): JobInfo[] {
  return [{ id: "job-1", command: "pnpm build", exited: false, code: null }];
}

function exited(): JobInfo[] {
  return [{ id: "job-1", command: "pnpm build", exited: true, code: 0 }];
}

afterEach(() => {
  vi.useRealTimers();
});

describe("JobExitWatcher", () => {
  it("notifies once when a tracked job exits", async () => {
    vi.useFakeTimers();
    const exits: JobExit[] = [];
    let jobs = running();
    const manager = stubJobs({ list: async () => jobs });
    const watcher = new JobExitWatcher(manager, (job) => exits.push(job), 1000);

    watcher.track("job-1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(exits).toHaveLength(0);

    jobs = exited();
    await vi.advanceTimersByTimeAsync(1000);
    expect(exits).toEqual([
      { id: "job-1", command: "pnpm build", code: 0, tail: "build done" },
    ]);

    await vi.advanceTimersByTimeAsync(3000);
    expect(exits).toHaveLength(1);
    expect(watcher.size).toBe(0);
  });

  it("does not notify a job the model already saw exit", async () => {
    vi.useFakeTimers();
    const exits: JobExit[] = [];
    const manager = stubJobs({ list: async () => exited() });
    const watcher = new JobExitWatcher(manager, (job) => exits.push(job), 1000);

    watcher.track("job-1");
    watcher.observe("job-1");
    await vi.advanceTimersByTimeAsync(5000);
    expect(exits).toEqual([]);
    expect(watcher.size).toBe(0);
  });

  it("drops a job that was killed or reaped", async () => {
    vi.useFakeTimers();
    const exits: JobExit[] = [];
    const manager = stubJobs({ list: async () => [] });
    const watcher = new JobExitWatcher(manager, (job) => exits.push(job), 1000);

    watcher.track("job-1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(watcher.size).toBe(0);

    watcher.track("job-2");
    watcher.untrack("job-2");
    await vi.advanceTimersByTimeAsync(3000);
    expect(exits).toEqual([]);
    expect(watcher.size).toBe(0);
  });

  it("stops polling once nothing is tracked", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const manager = stubJobs({
      list: async () => {
        calls += 1;
        return running();
      },
    });
    const watcher = new JobExitWatcher(manager, () => undefined, 1000);

    watcher.track("job-1");
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBeGreaterThan(0);

    watcher.untrack("job-1");
    const after = calls;
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(after);
  });
});
