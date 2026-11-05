import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "./session-store.js";

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "meowcode-session-"));
  return path.join(dir, "s.jsonl");
}

describe("SessionStore traceId", () => {
  it("新建会话可显式指定 traceId，子 Agent 用同一链路", async () => {
    const parent = await SessionStore.create(await tempFile(), tmpdir());
    const parentTrace = parent.traceId;
    expect(parentTrace).toBe(parent.id);

    const childFile = await tempFile();
    const child = await SessionStore.create(childFile, tmpdir(), { traceId: parentTrace });
    expect(child.traceId).toBe(parentTrace);
    expect(child.traceId).not.toBe(child.id);
  });

  it("旧会话没有 traceId 字段时回落到会话 id", async () => {
    const store = await SessionStore.create(await tempFile(), tmpdir());
    expect(store.traceId).toBe(store.id);
  });
});
