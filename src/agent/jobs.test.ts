import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { combineJobManagers, createLocalJobManager, type JobManager } from "./jobs.js";

async function waitFor<T>(
  probe: () => Promise<T | null | undefined> | T | null | undefined,
  timeoutMs = 8000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("waitFor timed out");
}

describe("local job manager (CLI/test fallback)", () => {
  it("启动命令、增量读取输出与退出码", async () => {
    const manager = createLocalJobManager();
    const { id } = await manager.start({ command: "node -e \"console.log(12345)\"", cwd: tmpdir() });
    const chunk = await waitFor(async () => {
      const current = await manager.read(id, 0);
      return current && current.data.includes("12345") ? current : null;
    });
    expect(chunk.data).toContain("12345");
    expect(chunk.offset).toBeGreaterThanOrEqual(5);

    const exited = await waitFor(async () => {
      const current = await manager.read(id, chunk.offset);
      return current?.exited ? current : null;
    });
    expect(exited.code).toBe(0);
  });

  it("kill 后从列表消失", async () => {
    const manager = createLocalJobManager();
    const { id } = await manager.start({
      command: "node -e \"setTimeout(()=>{}, 60000)\"",
      cwd: tmpdir(),
    });
    expect((await manager.list()).map((job) => job.id)).toContain(id);
    await manager.kill(id);
    expect((await manager.list()).map((job) => job.id)).not.toContain(id);
    expect(await manager.read(id, 0)).toBeNull();
  });
});

describe("local job manager wait", () => {
  it("until=exit 攒到进程退出，一次带回全部输出与退出码", async () => {
    const manager = createLocalJobManager();
    const { id } = await manager.start({
      command: "node -e \"setTimeout(()=>{console.log('done')}, 120)\"",
      cwd: tmpdir(),
    });
    const chunk = await manager.wait(id, { timeoutMs: 8_000, until: "exit" });
    expect(chunk?.exited).toBe(true);
    expect(chunk?.code).toBe(0);
    expect(chunk?.data).toContain("done");
  });

  it("until=output 一有输出就返回，不等退出", async () => {
    const manager = createLocalJobManager();
    const { id } = await manager.start({
      command: "node -e \"console.log('first'); setTimeout(()=>{}, 5000)\"",
      cwd: tmpdir(),
    });
    const chunk = await manager.wait(id, { timeoutMs: 8_000, until: "output" });
    expect(chunk?.data).toContain("first");
    expect(chunk?.exited).toBe(false);
    await manager.kill(id);
  });

  it("到点未退出时返回 running 与已经产生的输出", async () => {
    const manager = createLocalJobManager();
    const { id } = await manager.start({
      command: "node -e \"console.log('tick'); setTimeout(()=>{}, 5000)\"",
      cwd: tmpdir(),
    });
    const startedAt = Date.now();
    const chunk = await manager.wait(id, { timeoutMs: 400, until: "exit" });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(350);
    expect(chunk?.exited).toBe(false);
    expect(chunk?.data).toContain("tick");
    await manager.kill(id);
  });

  it("已退出的 job 立即返回", async () => {
    const manager = createLocalJobManager();
    const { id } = await manager.start({ command: "node -e \"process.exit(2)\"", cwd: tmpdir() });
    await waitFor(async () => (await manager.read(id, 0))?.exited);
    const chunk = await manager.wait(id, { timeoutMs: 5_000, until: "exit" });
    expect(chunk?.exited).toBe(true);
    expect(chunk?.code).toBe(2);
  });
});

describe("combineJobManagers", () => {
  const fake = (id: string, extra: Partial<JobManager> = {}): JobManager => ({
    start: async () => ({ id }),
    read: async (jobId) => (jobId === id ? { data: id, offset: 1, bufferStart: 0, truncated: false, exited: false, code: null } : null),
    wait: async (jobId) =>
      jobId === id ? { data: id, offset: 1, bufferStart: 0, truncated: false, exited: true, code: 0 } : null,
    write: async () => undefined,
    kill: async () => undefined,
    list: async () => [{ id, command: id, exited: false, code: null }],
    ...extra,
  });

  it("start 落到第一个 manager，读/等按 id 路由", async () => {
    const first = fake("pty-1");
    const second = fake("job-2");
    const manager = combineJobManagers(first, second);
    const started = await manager.start({ command: "x" });
    expect(started.id).toBe("pty-1");
    expect((await manager.read("job-2", 0))?.data).toBe("job-2");
    expect((await manager.wait("job-2", { timeoutMs: 10, until: "exit" }))?.exited).toBe(true);
    expect((await manager.read("missing", 0))).toBeNull();
  });

  it("list 合并去重，adopt 落到支持接管的 manager", async () => {
    const promoted: string[] = [];
    const first = fake("pty-1");
    const second = fake("job-2", {
      adopt: () => {
        const id = "job-promoted";
        promoted.push(id);
        return id;
      },
    });
    const manager = combineJobManagers(first, second);
    const ids = (await manager.list()).map((job) => job.id);
    expect(ids).toEqual(["pty-1", "job-2"]);
    expect(manager.adopt!({ command: "x", cwd: ".", child: {} as never, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) })).toBe("job-promoted");
    expect(promoted).toEqual(["job-promoted"]);
  });
});
