import { describe, expect, it } from "vitest";
import { executeJobTool, startBackgroundCommand } from "./job-tools.js";
import type { JobChunk, JobManager, JobWaitOptions } from "./jobs.js";

const chunk = (overrides: Partial<JobChunk> = {}): JobChunk => ({
  data: "",
  offset: 0,
  bufferStart: 0,
  truncated: false,
  exited: false,
  code: null,
  ...overrides,
});

function stubManager(overrides: Partial<JobManager> = {}): JobManager {
  return {
    start: async () => ({ id: "job-1" }),
    read: async () =>
      chunk({ data: "server listening on :5173\n", offset: 26 }),
    wait: async () => chunk({ data: "server listening on :5173\n", offset: 26 }),
    write: async () => undefined,
    kill: async () => undefined,
    list: async () => [
      { id: "job-1", command: "pnpm dev", exited: false, code: null },
      { id: "job-2", command: "pnpm test", exited: true, code: 1 },
    ],
    ...overrides,
  };
}

describe("job tool", () => {
  it("list 展示状态与命令", async () => {
    const result = await executeJobTool(stubManager(), { action: "list" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("job-1 [running] pnpm dev");
    expect(result.output).toContain("job-2 [exited 1] pnpm test");
  });

  it("output 返回增量与下一次 offset", async () => {
    const result = await executeJobTool(stubManager(), {
      action: "output",
      job_id: "job-1",
      offset: 0,
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("server listening");
    expect(result.output).toContain("next offset 26");
  });

  it("output 超长时保留尾部", async () => {
    const long = "x".repeat(500);
    const result = await executeJobTool(
      stubManager({
        read: async () => chunk({ data: long, offset: 500, exited: true, code: 0 }),
      }),
      { action: "output", job_id: "job-1", max_chars: 200 },
    );
    expect(result.output).toContain("[earlier output truncated]");
    expect(result.output).toContain("exited (code 0)");
  });

  it("缺少 job_id 或 job 不存在时给出明确错误", async () => {
    expect((await executeJobTool(stubManager(), { action: "output" })).ok).toBe(false);
    const missing = await executeJobTool(stubManager({ read: async () => null }), {
      action: "output",
      job_id: "nope",
    });
    expect(missing.ok).toBe(false);
    expect(missing.output).toContain("not found");
  });

  it("background 启动回传 job id 与后续用法", async () => {
    const result = await startBackgroundCommand(stubManager(), "pnpm dev", process.cwd());
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Started background job job-1");
    expect(result.output).toContain("job {action:\"output\"");
    expect(result.output).toContain("job {action:\"wait\"");
  });

  it("wait 默认等到退出：把整段输出和退出码一起带回", async () => {
    const seen: JobWaitOptions[] = [];
    const result = await executeJobTool(
      stubManager({
        wait: async (_id, options) => {
          seen.push(options);
          return chunk({ data: "tests passed\n", offset: 13, exited: true, code: 0 });
        },
      }),
      { action: "wait", job_id: "job-1" },
    );
    expect(seen[0]).toEqual({ timeoutMs: 60_000, until: "exit" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("tests passed");
    expect(result.output).toContain("exited (code 0)");
  });

  it("wait until=output 一有新输出就返回", async () => {
    const seen: JobWaitOptions[] = [];
    const result = await executeJobTool(
      stubManager({
        wait: async (_id, options) => {
          seen.push(options);
          return chunk({ data: "server listening\n", offset: 16 });
        },
      }),
      { action: "wait", job_id: "job-1", until: "output", timeout_ms: 5000 },
    );
    expect(seen[0]).toEqual({ timeoutMs: 5000, until: "output" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("server listening");
  });

  it("wait 到点仍在跑时说明已等时长", async () => {
    const result = await executeJobTool(
      stubManager({ wait: async () => chunk({ offset: 26 }) }),
      { action: "wait", job_id: "job-1", timeout_ms: 1000 },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("running");
    expect(result.output).toContain("still running after");
  });

  it("wait 把 offset 原样传给 manager，省略时不传", async () => {
    const seen: JobWaitOptions[] = [];
    const manager = stubManager({
      wait: async (_id, options) => {
        seen.push(options);
        return chunk({ data: "x", offset: 1 });
      },
    });
    await executeJobTool(manager, { action: "wait", job_id: "job-1", offset: 7 });
    await executeJobTool(manager, { action: "wait", job_id: "job-1" });
    expect(seen[0].offset).toBe(7);
    expect(seen[1].offset).toBeUndefined();
  });

  it("wait 超过上限时按 300s 截断，低于下限按 1s", async () => {
    const seen: JobWaitOptions[] = [];
    const manager = stubManager({
      wait: async (_id, options) => {
        seen.push(options);
        return chunk({ data: "x", offset: 1 });
      },
    });
    await executeJobTool(manager, { action: "wait", job_id: "job-1", timeout_ms: 900_000 });
    await executeJobTool(manager, { action: "wait", job_id: "job-1", timeout_ms: 10 });
    expect(seen[0].timeoutMs).toBe(300_000);
    expect(seen[1].timeoutMs).toBe(1_000);
  });

  it("wait 找不到 job 时报错", async () => {
    const result = await executeJobTool(stubManager({ wait: async () => null }), {
      action: "wait",
      job_id: "nope",
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("not found");
  });
});

describe("job output 清洗", () => {
  it("把 PTY 的 ANSI 控制序列清掉再给模型看", async () => {
    const result = await executeJobTool(
      stubManager({
        wait: async () =>
          chunk({ data: "\u001b[?9001h\u001b[2J\u001b[Hready to serve\u001b[?25h", offset: 40 }),
      }),
      { action: "wait", job_id: "job-1" },
    );
    expect(result.output).toContain("ready to serve");
    expect(result.output).not.toContain("\u001b");
  });
});
