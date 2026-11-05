import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LoopGuard, MAX_READ_RANGES_PER_FILE } from "./loop-guard";
import type { ChatMessage, ToolCall } from "./types";

async function workspace(lines = 600): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "meowcode-guard-"));
  await writeFile(
    path.join(dir, "a.ts"),
    Array.from({ length: lines }, (_, index) => `line ${index + 1}`).join("\n"),
    "utf8",
  );
  return dir;
}

function toolMessage(callId: string, name: string, content: string): ChatMessage {
  return { role: "tool", content, tool_call_id: callId, name };
}

function readCall(id: string): ToolCall {
  return { id, type: "function", function: { name: "read_file", arguments: "{}" } };
}

/** 造一份 read_file 形态的输出：`N: content` 每行一条。 */
function readOutput(start: number, end: number): string {
  return Array.from({ length: end - start + 1 }, (_, index) => {
    const line = start + index;
    return `${line}: line ${line}`;
  }).join("\n");
}

describe("read coverage", () => {
  it("stubs a read that is fully covered by an earlier read", async () => {
    const cwd = await workspace();
    const guard = new LoopGuard();
    await guard.rememberReadRange(cwd, "c1", { path: "a.ts" }, { start: 1, end: 200, total: 600 }, false);

    const messages = [toolMessage("c1", "read_file", readOutput(1, 200))];
    const stub = await guard.repeatedReadStub(cwd, messages, readCall("c2"), { path: "a.ts", limit: 200 }, false);
    expect(stub).toContain("Unchanged since your earlier read of a.ts");
  });

  it("covers a narrower read inside a wider earlier one", async () => {
    const cwd = await workspace();
    const guard = new LoopGuard();
    await guard.rememberReadRange(cwd, "c1", { path: "a.ts" }, { start: 1, end: 400, total: 600 }, false);

    const messages = [toolMessage("c1", "read_file", readOutput(1, 400))];
    const stub = await guard.repeatedReadStub(
      cwd,
      messages,
      readCall("c2"),
      { path: "a.ts", offset: 100, limit: 50 },
      false,
    );
    expect(stub).toContain("lines 100-149");
  });

  it("returns only the uncovered tail when the head is already read", async () => {
    const cwd = await workspace();
    const guard = new LoopGuard();
    await guard.rememberReadRange(cwd, "c1", { path: "a.ts" }, { start: 1, end: 200, total: 600 }, false);

    const messages = [toolMessage("c1", "read_file", readOutput(1, 200))];
    const trimmed = await guard.trimCoveredReadPrefix(
      cwd,
      messages,
      { path: "a.ts", limit: 400 },
      readOutput(1, 400),
      false,
    );
    expect(trimmed).toContain("[Lines 1-200 unchanged");
    expect(trimmed).toContain("201: line 201");
    expect(trimmed).toContain("400: line 400");
    expect(trimmed).not.toContain("200: line 200");
  });

  it("does not trim when coverage is below half", async () => {
    const cwd = await workspace();
    const guard = new LoopGuard();
    await guard.rememberReadRange(cwd, "c1", { path: "a.ts" }, { start: 1, end: 50, total: 600 }, false);

    const messages = [toolMessage("c1", "read_file", readOutput(1, 50))];
    const trimmed = await guard.trimCoveredReadPrefix(
      cwd,
      messages,
      { path: "a.ts", limit: 400 },
      readOutput(1, 400),
      false,
    );
    expect(trimmed).toBeNull();
  });

  it("invalidates coverage when the file changes", async () => {
    const cwd = await workspace();
    const guard = new LoopGuard();
    await guard.rememberReadRange(cwd, "c1", { path: "a.ts" }, { start: 1, end: 200, total: 600 }, false);
    await writeFile(path.join(cwd, "a.ts"), "totally different content\n", "utf8");

    const messages = [toolMessage("c1", "read_file", readOutput(1, 200))];
    expect(await guard.repeatedReadStub(cwd, messages, readCall("c2"), { path: "a.ts" }, false)).toBeNull();
  });

  it("ignores coverage whose tool result was elided from context", async () => {
    const cwd = await workspace();
    const guard = new LoopGuard();
    await guard.rememberReadRange(cwd, "c1", { path: "a.ts" }, { start: 1, end: 200, total: 600 }, false);

    const elided = [toolMessage("c1", "read_file", "[read_file output elided: 4000 chars]")];
    expect(await guard.repeatedReadStub(cwd, elided, readCall("c2"), { path: "a.ts" }, false)).toBeNull();
    const summarized = [toolMessage("c1", "read_file", "[summarized] read 200 lines")];
    expect(await guard.repeatedReadStub(cwd, summarized, readCall("c2"), { path: "a.ts" }, false)).toBeNull();
  });

  it("merges adjacent ranges and caps how many are kept", async () => {
    const cwd = await workspace(2_000);
    const guard = new LoopGuard();
    await guard.rememberReadRange(cwd, "c1", { path: "a.ts" }, { start: 1, end: 100, total: 600 }, false);
    await guard.rememberReadRange(cwd, "c2", { path: "a.ts" }, { start: 101, end: 200, total: 600 }, false);

    // 两段相邻 → 合并成 1-200，一次请求即可全覆盖
    const messages = [
      toolMessage("c1", "read_file", readOutput(1, 100)),
      toolMessage("c2", "read_file", readOutput(101, 200)),
    ];
    const stub = await guard.repeatedReadStub(cwd, messages, readCall("c3"), { path: "a.ts", limit: 200 }, false);
    expect(stub).toContain("lines 1-200");

    // 再塞进超过上限的区间数：最早的区间被淘汰，不再命中
    for (let index = 0; index < MAX_READ_RANGES_PER_FILE + 2; index += 1) {
      const start = 1_000 + index * 20;
      await guard.rememberReadRange(
        cwd,
        `extra-${index}`,
        { path: "a.ts" },
        { start, end: start + 9, total: 2_000 },
        false,
      );
    }
    expect(await guard.repeatedReadStub(cwd, messages, readCall("c4"), { path: "a.ts", limit: 200 }, false)).toBeNull();
  });
});

describe("cross-turn result dedupe", () => {
  it("replaces an identical result from an earlier turn", () => {
    const guard = new LoopGuard();
    guard.reset("s");
    const output = "src/a.ts\nsrc/b.ts";
    expect(guard.dedupeRepeatedResult("glob", { pattern: "*.ts" }, output, "c1", [])).toBeNull();

    guard.reset("s");
    const messages = [toolMessage("c1", "glob", output)];
    const stub = guard.dedupeRepeatedResult("glob", { pattern: "*.ts" }, output, "c2", messages);
    expect(stub).toContain("Identical to your glob result");
  });

  it("never dedupes commands, writes or side-effecting tools", () => {
    const guard = new LoopGuard();
    guard.reset("s");
    const output = "done";
    for (const tool of ["run_command", "run_code", "write_file", "edit_file", "task", "mcp__x__y"]) {
      guard.dedupeRepeatedResult(tool, { a: 1 }, output, "c1", []);
      guard.reset("s");
      expect(guard.dedupeRepeatedResult(tool, { a: 1 }, output, "c2", [toolMessage("c1", tool, output)])).toBeNull();
      guard.reset("s");
    }
  });

  it("expires after the dedupe window", () => {
    const guard = new LoopGuard();
    guard.reset("s");
    const output = "same";
    guard.dedupeRepeatedResult("grep", { pattern: "x" }, output, "c1", []);
    for (let index = 0; index < 7; index += 1) guard.reset("s");
    expect(
      guard.dedupeRepeatedResult("grep", { pattern: "x" }, output, "c2", [
        toolMessage("c1", "grep", output),
      ]),
    ).toBeNull();
  });

  it("requires the earlier result to still be visible", () => {
    const guard = new LoopGuard();
    guard.reset("s");
    const output = "same";
    guard.dedupeRepeatedResult("grep", { pattern: "x" }, output, "c1", []);
    guard.reset("s");
    expect(
      guard.dedupeRepeatedResult("grep", { pattern: "x" }, output, "c2", [
        toolMessage("c1", "grep", "[summarized] 3 matches"),
      ]),
    ).toBeNull();
  });
});

describe("fully covered files", () => {
  it("is false before anything was read", async () => {
    const cwd = await workspace();
    const guard = new LoopGuard();
    expect(await guard.fullyCovered(cwd, [], "a.ts", false)).toBe(false);
  });

  it("is true after the whole file was read", async () => {
    const cwd = await workspace(20);
    const guard = new LoopGuard();
    await guard.rememberReadRangeAt(cwd, "c1", "a.ts", { start: 1, end: 20, total: 20 }, false);
    const messages = [toolMessage("c1", "read_file", readOutput(1, 20))];
    expect(await guard.fullyCovered(cwd, messages, "a.ts", false)).toBe(true);
  });

  it("is false when the read stopped short of the end", async () => {
    const cwd = await workspace(20);
    const guard = new LoopGuard();
    await guard.rememberReadRangeAt(cwd, "c1", "a.ts", { start: 1, end: 10, total: 20 }, false);
    const messages = [toolMessage("c1", "read_file", readOutput(1, 10))];
    expect(await guard.fullyCovered(cwd, messages, "a.ts", false)).toBe(false);
  });

  it("is false after the file changed", async () => {
    const cwd = await workspace(20);
    const guard = new LoopGuard();
    await guard.rememberReadRangeAt(cwd, "c1", "a.ts", { start: 1, end: 20, total: 20 }, false);
    await writeFile(path.join(cwd, "a.ts"), "changed\n", "utf8");
    const messages = [toolMessage("c1", "read_file", readOutput(1, 20))];
    expect(await guard.fullyCovered(cwd, messages, "a.ts", false)).toBe(false);
  });

  it("is false when the covering result was elided", async () => {
    const cwd = await workspace(20);
    const guard = new LoopGuard();
    await guard.rememberReadRangeAt(cwd, "c1", "a.ts", { start: 1, end: 20, total: 20 }, false);
    const messages = [toolMessage("c1", "read_file", "[read_file output elided: 900 chars]")];
    expect(await guard.fullyCovered(cwd, messages, "a.ts", false)).toBe(false);
  });
});
