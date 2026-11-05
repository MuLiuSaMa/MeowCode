import { describe, expect, it } from "vitest";
import { executeJobTool, startBackgroundCommand } from "./job-tools.js";
import type { JobManager } from "./jobs.js";

function stubManager(overrides: Partial<JobManager> = {}): JobManager {
  return {
    start: async () => ({ id: "job-1" }),
    read: async () => ({
      data: "server listening on :5173\n",
      offset: 26,
      bufferStart: 0,
      truncated: false,
      exited: false,
      code: null,
    }),
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
        read: async () => ({
          data: long,
          offset: 500,
          bufferStart: 0,
          truncated: false,
          exited: true,
          code: 0,
        }),
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
  });
});
