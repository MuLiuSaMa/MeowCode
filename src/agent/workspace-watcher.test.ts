import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkspaceWatcher, type WorkspaceChange } from "./workspace-watcher.js";

async function waitFor<T>(probe: () => T | null | undefined, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("waitFor timed out");
}

describe("createWorkspaceWatcher", () => {
  it("合并文件变化并忽略依赖目录", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-watch-"));
    const changes: WorkspaceChange[] = [];
    const watcher = createWorkspaceWatcher({
      root,
      debounceMs: 30,
      onChange: (change) => changes.push(change),
    });
    try {
      await writeFile(path.join(root, "a.txt"), "one");
      const first = await waitFor(() => changes.find((c) => c.paths.length));
      expect(first.paths).toContain("a.txt");

      changes.length = 0;
      await mkdir(path.join(root, "node_modules"));
      await writeFile(path.join(root, "node_modules", "hidden.txt"), "x");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(changes.every((change) => !change.paths.some((p) => p.includes("node_modules")))).toBe(
        true,
      );
    } finally {
      watcher.close();
    }
  });

  it("close 后不再收到事件", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-watch-"));
    const changes: WorkspaceChange[] = [];
    const watcher = createWorkspaceWatcher({
      root,
      debounceMs: 20,
      onChange: (change) => changes.push(change),
    });
    watcher.close();
    await writeFile(path.join(root, "after-close.txt"), "x");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(changes).toEqual([]);
  });
});
