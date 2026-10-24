import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "./session-store";
import type { NativeCompactionPayload } from "./types";

const payload = (overrides: Partial<NativeCompactionPayload> = {}): NativeCompactionPayload => ({
  providerId: "openai",
  endpoint: "https://api.openai.com/v1",
  model: "gpt-5.1",
  protocol: "openai-responses",
  items: [{ type: "compaction", id: "cmp_1", encrypted_content: "gAAAA" }],
  ...overrides,
});

async function makeStore(): Promise<SessionStore> {
  const dir = await mkdtemp(path.join(tmpdir(), "meowcode-native-compaction-"));
  return SessionStore.create(path.join(dir, "session.jsonl"), "D:/work");
}

describe("SessionStore native compaction", () => {
  it("把更早历史挡在重放之外，只回放加密 item 与之后的消息", async () => {
    const session = await makeStore();
    await session.appendMessage({ role: "user", content: "before" });
    await session.appendMessage({ role: "assistant", content: "working" });
    await session.appendNativeCompaction("server-side checkpoint", payload());
    await session.appendMessage({ role: "user", content: "after" });

    const effective = session.effectiveMessages;
    expect(effective).toHaveLength(2);
    expect(effective[0]).toMatchObject({
      role: "native_compaction",
      content: "server-side checkpoint",
    });
    expect(effective[1]).toEqual({ role: "user", content: "after" });
    // 完整历史仍留在 JSONL 里（可回退）
    expect(session.messages.map((message) => message.content)).toEqual([
      "before",
      "working",
      "after",
    ]);
  });

  it("不可回放时退回完整原始历史", async () => {
    const session = await makeStore();
    await session.appendMessage({ role: "user", content: "before" });
    await session.appendNativeCompaction("checkpoint", payload());
    await session.appendMessage({ role: "user", content: "after" });

    session.nativeCompactionReplayable = false;
    expect(session.effectiveMessages.map((message) => message.content)).toEqual([
      "before",
      "after",
    ]);
  });

  it("压缩点计数与 UI 摘要沿用同一套逻辑", async () => {
    const session = await makeStore();
    await session.appendMessage({ role: "user", content: "one" });
    await session.appendNativeCompaction("checkpoint text", payload());
    expect(session.currentCompactionSummary).toBe("checkpoint text");
    expect(session.lastCompaction).toEqual({ messageIndex: 1, summary: "checkpoint text" });
    expect(session.lastNativeCompaction?.native.items).toHaveLength(1);
  });

  it("重载后原生压缩点仍可回放", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-native-compaction-"));
    const filePath = path.join(dir, "session.jsonl");
    const session = await SessionStore.create(filePath, "D:/work");
    await session.appendMessage({ role: "user", content: "before" });
    await session.appendNativeCompaction("checkpoint", payload());

    const loaded = await SessionStore.load(filePath);
    expect(loaded.lastNativeCompaction?.native.endpoint).toBe("https://api.openai.com/v1");
    expect(loaded.effectiveMessages[0]).toMatchObject({ role: "native_compaction" });
  });

  it("原生压缩点的加密 item 计入上下文占用", async () => {
    const session = await makeStore();
    await session.appendMessage({ role: "user", content: "before" });
    await session.appendNativeCompaction("checkpoint", payload());
    const { estimateMessagesTokens } = await import("./context");
    // 加密 item 本身要占 token：估算值必须大于纯说明文本
    expect(estimateMessagesTokens(session.effectiveMessages)).toBeGreaterThan(
      estimateMessagesTokens([{ role: "user", content: "checkpoint" }]),
    );
  });
});
