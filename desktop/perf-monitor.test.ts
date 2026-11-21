import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const requireFromTest = createRequire(import.meta.url);
const { createPerfMonitor } = requireFromTest("./perf-monitor.cjs");

type Handler = (...args: unknown[]) => void;

function fakeApp(metrics: unknown[] = []) {
  const handlers = new Map<string, Handler>();
  return {
    getAppMetrics: () => metrics,
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
    },
    emit: (name: string, ...args: unknown[]) => handlers.get(name)?.(...args),
    handlerCount: () => handlers.size,
  };
}

const silent = { warn: () => undefined };

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("perf monitor", () => {
  it("aggregates process metrics and flushes one line per sample", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "meow-perf-"));
    const app = fakeApp([
      { pid: 1, type: "Browser", cpu: { percentCPUUsage: 1.2 }, memory: { workingSetSize: 2048 } },
      { pid: 2, type: "Tab", cpu: { percentCPUUsage: 3.4 }, memory: { workingSetSize: 1024 } },
    ]);
    const monitor = createPerfMonitor({ app, dir, isEnabled: () => true, log: silent });

    monitor.sample();
    const [row] = monitor.snapshot();
    expect(row.cpu).toBeCloseTo(4.6);
    // workingSetSize 是 KB：2048 + 1024 = 3MB
    expect(row.rssMB).toBe(3);
    expect(row.procs).toHaveLength(2);
    expect(row.procs[1]).toMatchObject({ pid: 2, type: "Tab", rssMB: 1 });

    await monitor.flush();
    const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const lines = readFileSync(path.join(dir, files[0]), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).procs).toHaveLength(2);
  });

  it("keeps the ring buffer bounded", () => {
    dir = mkdtempSync(path.join(tmpdir(), "meow-perf-"));
    const app = fakeApp([
      { pid: 1, type: "Browser", cpu: { percentCPUUsage: 0 }, memory: { workingSetSize: 0 } },
    ]);
    const monitor = createPerfMonitor({ app, dir, isEnabled: () => true, log: silent });
    for (let index = 0; index < 400; index += 1) monitor.sample();
    expect(monitor.snapshot()).toHaveLength(360);
  });

  it("marks sustained high CPU but not a single spike", () => {
    dir = mkdtempSync(path.join(tmpdir(), "meow-perf-"));
    const metrics = [
      { pid: 1, type: "Browser", cpu: { percentCPUUsage: 40 }, memory: { workingSetSize: 0 } },
    ];
    const app = fakeApp(metrics);
    const monitor = createPerfMonitor({ app, dir, isEnabled: () => true, log: silent });

    monitor.sample();
    monitor.sample();
    expect(monitor.snapshot().at(-1).note).toBeUndefined();
    monitor.sample();
    expect(monitor.snapshot().at(-1).note).toBe("cpu-high");
  });

  it("skips sampling when telemetry is off", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "meow-perf-"));
    const app = fakeApp([
      { pid: 1, type: "Browser", cpu: { percentCPUUsage: 9 }, memory: { workingSetSize: 1024 } },
    ]);
    const monitor = createPerfMonitor({ app, dir, isEnabled: () => false, log: silent });
    monitor.sample();
    expect(monitor.snapshot()).toHaveLength(0);
    await monitor.flush();
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("records renderer crashes and rate-limits reload", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "meow-perf-"));
    const app = fakeApp();
    const monitor = createPerfMonitor({ app, dir, isEnabled: () => true, log: silent });
    monitor.start();

    const reload = vi.fn();
    const contents = { reload, getOSProcessId: () => 42 };
    app.emit("render-process-gone", {}, contents, { reason: "crashed", exitCode: 1 });
    app.emit("render-process-gone", {}, contents, { reason: "crashed", exitCode: 1 });
    await monitor.stop();

    expect(reload).toHaveBeenCalledTimes(1);
    const crashLog = readFileSync(path.join(dir, "crashes.jsonl"), "utf8");
    const rows = crashLog.trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.filter((row) => row.kind === "render-process-gone")).toHaveLength(2);
    expect(rows.some((row) => row.kind === "renderer-reload")).toBe(true);
  });

  it("does not reload on a clean exit", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "meow-perf-"));
    const app = fakeApp();
    const monitor = createPerfMonitor({ app, dir, isEnabled: () => true, log: silent });
    monitor.start();
    const reload = vi.fn();
    app.emit("render-process-gone", {}, { reload }, { reason: "clean-exit", exitCode: 0 });
    await monitor.stop();
    expect(reload).not.toHaveBeenCalled();
  });
});
