import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentLogger, pruneAgentLogs } from "./logging.js";

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "meowcode-log-"));
}

describe("createAgentLogger", () => {
  it("写入 JSONL 并按 50ms 批量落盘", async () => {
    const dir = await tempDir();
    const logger = createAgentLogger({ dir, flushDelayMs: 5 });
    logger.log({ level: "info", event: "span", spanId: "s1", durationMs: 12 });
    logger.log({ level: "warn", event: "span", spanId: "s2", durationMs: 900 });
    await logger.flush();
    await logger.close();

    const files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const lines = (await readFile(path.join(dir, files[0]), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0].event).toBe("span");
    expect(lines[1].level).toBe("warn");
    expect(typeof lines[0].ts).toBe("string");
  });

  it("敏感字段在落盘前脱敏", async () => {
    const dir = await tempDir();
    const logger = createAgentLogger({ dir, flushDelayMs: 5 });
    logger.log({ level: "info", event: "span", apiKey: "sk-1234567890abcdef", nested: { token: "abc" } });
    await logger.flush();

    const content = await readFile(logger.filePath(), "utf8");
    expect(content).not.toContain("sk-1234567890abcdef");
    expect(content).not.toContain("\"abc\"");
    await logger.close();
  });

  it("超过大小阈值轮转，旧档数量有界", async () => {
    const dir = await tempDir();
    const logger = createAgentLogger({ dir, maxBytes: 300, maxFiles: 3, flushDelayMs: 1 });
    for (let index = 0; index < 80; index += 1) {
      logger.log({ level: "info", event: "span", index, padding: "x".repeat(40) });
    }
    await logger.flush();
    await logger.close();

    const files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
    expect(files.length).toBeLessThanOrEqual(4);
    expect(files.some((name) => name.includes(".1."))).toBe(true);
  });

  it("清理超过保留期的日志", async () => {
    const dir = await tempDir();
    const logger = createAgentLogger({ dir, flushDelayMs: 1 });
    logger.log({ level: "info", event: "old" });
    await logger.flush();
    await logger.close();

    const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const removed = await pruneAgentLogs(dir, 7, old + 9 * 24 * 60 * 60 * 1000);
    expect(removed).toBe(0);
    const removedForReal = await pruneAgentLogs(dir, 7, Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(removedForReal).toBeGreaterThan(0);
  });
});
