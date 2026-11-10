import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LoopGuard } from "./loop-guard";
import type { ChatMessage, ToolCall } from "./types";

/**
 * 已读区间表的落盘/恢复。
 *
 * 单独成文件而不是塞进 loop-guard.test.ts：后者是混合换行（正文 CRLF、尾部 LF），
 * 任何整文件改写都会把尾部整块算成改动，diff 噪声比测试本身还大。
 */

async function workspace(lines = 600): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "meowcode-readstate-"));
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

function readOutput(start: number, end: number): string {
  return Array.from({ length: end - start + 1 }, (_, index) => {
    const line = start + index;
    return `${line}: line ${line}`;
  }).join("\n");
}

describe("read coverage persistence", () => {
  it("round-trips the snapshot so a restart still stubs a covered read", async () => {
    const cwd = await workspace();
    const guard = new LoopGuard();
    await guard.rememberReadRange(cwd, "c1", { path: "a.ts" }, { start: 1, end: 200, total: 600 }, false);

    const snapshot = guard.exportCoverage();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].ranges).toEqual([{ start: 1, end: 200 }]);

    // 模拟重启：新实例只有落盘快照
    const revived = new LoopGuard();
    await revived.restoreCoverage(snapshot);
    const messages = [toolMessage("c1", "read_file", readOutput(1, 200))];
    const stub = await revived.repeatedReadStub(
      cwd,
      messages,
      readCall("c2"),
      { path: "a.ts", limit: 200 },
      false,
    );
    expect(stub).toContain("Unchanged since your earlier read of a.ts");
  });

  it("drops entries whose file changed while the process was down", async () => {
    const cwd = await workspace();
    const guard = new LoopGuard();
    await guard.rememberReadRange(cwd, "c1", { path: "a.ts" }, { start: 1, end: 200, total: 600 }, false);
    const snapshot = guard.exportCoverage();

    await writeFile(path.join(cwd, "a.ts"), "rewritten\n", "utf8");

    const revived = new LoopGuard();
    await revived.restoreCoverage(snapshot);
    // 版本对不上就丢弃：宁可重读，也不给出过期正文
    expect(revived.exportCoverage()).toHaveLength(0);
  });
});
