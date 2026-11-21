import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createPromotedJobStore } from "./promoted-jobs.js";

function spawnNode(script: string) {
  return spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
}

describe("promoted job store", () => {
  it("接管前台进程后继续读输出，wait 到退出带回退出码", async () => {
    const store = createPromotedJobStore();
    const child = spawnNode("setTimeout(() => { console.log('late'); process.exit(7); }, 200)");
    const id = store.adopt({
      command: "pnpm build",
      cwd: process.cwd(),
      child,
      stdout: Buffer.from("early\n"),
      stderr: Buffer.from("warn\n"),
    });

    const chunk = await store.wait(id, { offset: 0, timeoutMs: 8_000, until: "exit" });
    expect(chunk?.exited).toBe(true);
    expect(chunk?.code).toBe(7);
    expect(chunk?.data).toContain("early");
    expect(chunk?.data).toContain("late");
    expect(chunk?.data).toContain("warn");
  });

  it("until=output 在新输出到达时提前返回，不等退出", async () => {
    const store = createPromotedJobStore();
    const child = spawnNode("setTimeout(() => { console.log('progress'); }, 100); setTimeout(() => {}, 5000)");
    const id = store.adopt({
      command: "long task",
      cwd: process.cwd(),
      child,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });

    const chunk = await store.wait(id, { timeoutMs: 8_000, until: "output" });
    expect(chunk?.data).toContain("progress");
    expect(chunk?.exited).toBe(false);
    await store.kill(id);
    expect(await store.read(id, 0)).toBeNull();
  });

  it("list 列出接管的任务与命令", async () => {
    const store = createPromotedJobStore();
    const child = spawnNode("setTimeout(() => {}, 5000)");
    const id = store.adopt({
      command: "Start-Sleep 100",
      cwd: process.cwd(),
      child,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
    const jobs = await store.list();
    expect(jobs.find((job) => job.id === id)?.command).toBe("Start-Sleep 100");
    await store.kill(id);
  });

  it("不能直接 start（只有 run_command 超时才会接管）", async () => {
    const store = createPromotedJobStore();
    await expect(store.start({ command: "x" })).rejects.toThrow(/cannot be started/);
  });
});
