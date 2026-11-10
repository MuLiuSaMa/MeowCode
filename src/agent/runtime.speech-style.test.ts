import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "./runtime.js";
import { SessionStore } from "./session-store.js";
import { DAZUI_SPEECH_PROMPT, TAFFY_SPEECH_PROMPT, type SpeechStyle } from "./speech-style.js";

type RuntimeAccess = {
  systemMessages(): Array<{ role: string; content: string }>;
  ensureSpeechStyleContext(session: SessionStore): Promise<void>;
};

const STYLE_PREFIX = "Runtime context: [speech style]";

async function makeRuntime(speechStyle?: SpeechStyle, systemPrompt?: string) {
  const sessionsDir = await mkdtemp(path.join(tmpdir(), "meow-speech-style-"));
  return new AgentRuntime({
    providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
    sessionsDir,
    homeDir: sessionsDir,
    injectInstructions: false,
    ...(speechStyle ? { speechStyle } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
  });
}

function systems(runtime: AgentRuntime) {
  return (runtime as unknown as RuntimeAccess).systemMessages();
}

async function makeSession() {
  const dir = await mkdtemp(path.join(tmpdir(), "meow-speech-note-"));
  return SessionStore.create(path.join(dir, "s.jsonl"), dir);
}

function styleNotes(session: SessionStore) {
  return session.effectiveMessages
    .filter(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.startsWith(STYLE_PREFIX),
    )
    .map((message) => String(message.content));
}

describe("runtime 语色", () => {
  it("普通模式不追加任何系统消息", async () => {
    const runtime = await makeRuntime();
    const messages = systems(runtime);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).not.toContain("永雏塔菲");
  });

  it("塔菲模式不污染 system，语色以尾部注记写入并支持切换", async () => {
    const runtime = await makeRuntime("tafei");
    // 语色不再是第 3 条 system：system 恒为基础提示，切换不会改变前缀字节
    expect(systems(runtime)).toHaveLength(1);
    expect(systems(runtime)[0].content).not.toContain("永雏塔菲");

    const session = await makeSession();
    await (runtime as unknown as RuntimeAccess).ensureSpeechStyleContext(session);
    const first = styleNotes(session);
    expect(first).toHaveLength(1);
    expect(first[0]).toContain("tafei");
    expect(first[0]).toContain(TAFFY_SPEECH_PROMPT);

    // 切回普通：追加一条取消注记，system 仍然不变
    runtime.speechStyle = "normal";
    await (runtime as unknown as RuntimeAccess).ensureSpeechStyleContext(session);
    expect(systems(runtime)).toHaveLength(1);
    const second = styleNotes(session);
    expect(second).toHaveLength(2);
    expect(second[1]).toContain("normal");
  });

  it("大嘴模式写入对应语色注记，重复调用不重复追加", async () => {
    const runtime = await makeRuntime("dazui");
    expect(systems(runtime)).toHaveLength(1);

    const session = await makeSession();
    await (runtime as unknown as RuntimeAccess).ensureSpeechStyleContext(session);
    const notes = styleNotes(session);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("dazui");
    expect(notes[0]).toContain(DAZUI_SPEECH_PROMPT);

    // 语色没变：幂等，不重复写
    await (runtime as unknown as RuntimeAccess).ensureSpeechStyleContext(session);
    expect(styleNotes(session)).toHaveLength(1);
  });

  it("显式 systemPrompt 的 runtime（子 Agent）即使开启语色也不写注记", async () => {
    for (const style of ["tafei", "dazui"] as const) {
      const runtime = await makeRuntime(style, "You are a reviewer.");
      expect(systems(runtime)).toEqual([{ role: "system", content: "You are a reviewer." }]);

      const session = await makeSession();
      await (runtime as unknown as RuntimeAccess).ensureSpeechStyleContext(session);
      expect(styleNotes(session)).toHaveLength(0);
    }
  });
});
