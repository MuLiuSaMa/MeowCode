import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { executeTool } from "./tools.js";
import { combineJobManagers, createLocalJobManager } from "./jobs.js";
import { createPromotedJobStore } from "./promoted-jobs.js";

function runtimeJobs() {
  return combineJobManagers(createLocalJobManager(), createPromotedJobStore());
}

describe("run_command timeout promotion", () => {
  it("超时不杀进程，转成后台 job 并带着 job id 返回", async () => {
    const jobs = runtimeJobs();
    const started = Date.now();
    const result = await executeTool(
      "run_command",
      { command: "Start-Sleep -Seconds 5; Write-Output 'finished'", timeout_ms: 700 },
      tmpdir(),
      { jobs },
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(650);
    expect(elapsed).toBeLessThan(5_000);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("still running");
    const match = result.output.match(/job-(?:term-)?[a-z0-9-]+/);
    expect(match).toBeTruthy();
    const jobId = match![0];

    // 进程还在跑：立刻读得到它，等到退出能拿到退出码
    const chunk = await jobs.wait(jobId, { timeoutMs: 15_000, until: "exit" });
    expect(chunk?.exited).toBe(true);
    expect(chunk?.code).toBe(0);
    expect(chunk?.data).toContain("finished");
  });

  it("命令在超时前跑完就照常返回，不产生后台任务", async () => {
    const jobs = runtimeJobs();
    const result = await executeTool(
      "run_command",
      { command: "Write-Output 'quick'", timeout_ms: 30_000 },
      tmpdir(),
      { jobs },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("quick");
    expect(result.output).not.toContain("still running");
    expect(await jobs.list()).toEqual([]);
  });

  it("timeout_ms 超上限时按 10 分钟截断", async () => {
    const jobs = runtimeJobs();
    const result = await executeTool(
      "run_command",
      { command: "Write-Output 'quick'", timeout_ms: 10_000_000 },
      tmpdir(),
      { jobs },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("quick");
  });

  it("命令里长 sleep 时给出改用后台任务的提示", async () => {
    const jobs = runtimeJobs();
    const result = await executeTool(
      "run_command",
      { command: "Start-Sleep -Seconds 3; Write-Output 'done'", timeout_ms: 30_000 },
      tmpdir(),
      { jobs },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("[hint]");
    expect(result.output).toContain("background=true");
  });
});
