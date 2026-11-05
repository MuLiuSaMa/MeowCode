import { describe, expect, it } from "vitest";
import { runCapture } from "./capture.js";
import { commandEnv } from "./env.js";

function node(spec: {
  script: string;
  timeoutMs?: number;
  maxCaptureBytes?: number;
  closeStdin?: boolean;
  signal?: AbortSignal;
}) {
  return runCapture({
    file: process.execPath,
    args: ["-e", spec.script],
    cwd: process.cwd(),
    env: commandEnv(),
    timeoutMs: spec.timeoutMs ?? 10_000,
    maxCaptureBytes: spec.maxCaptureBytes ?? 1_000_000,
    closeStdin: spec.closeStdin ?? false,
    ...(spec.signal ? { signal: spec.signal } : {}),
  });
}

describe("runCapture", () => {
  it("returns raw stdout/stderr and the exit code", async () => {
    const result = await node({
      script: "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)",
    });
    expect(result.stdout.toString()).toBe("out");
    expect(result.stderr.toString()).toBe("err");
    expect(result.code).toBe(3);
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.capped).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps multi-byte UTF-8 bytes intact", async () => {
    const result = await node({ script: "process.stdout.write('中文输出')" });
    expect(result.stdout.toString("utf8")).toBe("中文输出");
  });

  it("caps each stream at maxCaptureBytes", async () => {
    const result = await node({
      script: "process.stdout.write('a'.repeat(100))",
      maxCaptureBytes: 10,
    });
    expect(result.capped).toBe(true);
    expect(result.stdout.length).toBe(10);
  });

  it("settles on timeout with the partial output", async () => {
    const result = await node({
      script: "process.stdout.write('started'); setInterval(() => {}, 1000)",
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    expect(result.stdout.toString()).toBe("started");
  });

  it("settles on abort", async () => {
    const controller = new AbortController();
    const pending = node({
      script: "setInterval(() => {}, 1000)",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(result.code).toBeNull();
  });

  it("gives the child EOF on stdin when closeStdin is set", async () => {
    const result = await node({
      script:
        "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('EOF'));",
      closeStdin: true,
      timeoutMs: 5_000,
    });
    expect(result.stdout.toString()).toBe("EOF");
    expect(result.timedOut).toBe(false);
  });

  it("reports a spawn error instead of throwing", async () => {
    const result = await runCapture({
      file: "meowcode-definitely-missing-binary",
      args: [],
      cwd: process.cwd(),
      env: commandEnv(),
      timeoutMs: 5_000,
      maxCaptureBytes: 1_000,
      closeStdin: true,
    });
    expect(result.spawnError).toBeTruthy();
    expect(result.code).toBeNull();
  });
});
