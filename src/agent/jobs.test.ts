import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createLocalJobManager } from "./jobs.js";

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
