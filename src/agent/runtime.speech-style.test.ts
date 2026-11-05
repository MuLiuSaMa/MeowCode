import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "./runtime.js";
import { DAZUI_SPEECH_PROMPT, TAFFY_SPEECH_PROMPT, type SpeechStyle } from "./speech-style.js";

type SystemMessagesAccess = {
  systemMessages(): Array<{ role: string; content: string }>;
};

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
  return (runtime as unknown as SystemMessagesAccess).systemMessages();
}

describe("runtime 语色", () => {
  it("普通模式不追加任何系统消息", async () => {
    const runtime = await makeRuntime();
    const messages = systems(runtime);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).not.toContain("永雏塔菲");
  });

  it("塔菲模式追加独立的语色消息，并支持运行时切换", async () => {
    const runtime = await makeRuntime("tafei");
    let messages = systems(runtime);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ role: "system", content: TAFFY_SPEECH_PROMPT });

    runtime.speechStyle = "normal";
    messages = systems(runtime);
    expect(messages).toHaveLength(1);
  });

  it("大嘴模式追加对应语色消息，并支持运行时切换", async () => {
    const runtime = await makeRuntime("dazui");
    let messages = systems(runtime);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ role: "system", content: DAZUI_SPEECH_PROMPT });

    runtime.speechStyle = "tafei";
    messages = systems(runtime);
    expect(messages[1]).toEqual({ role: "system", content: TAFFY_SPEECH_PROMPT });
  });

  it("显式 systemPrompt 的 runtime（子 Agent）即使开启语色也不追加", async () => {
    for (const style of ["tafei", "dazui"] as const) {
      const runtime = await makeRuntime(style, "You are a reviewer.");
      expect(systems(runtime)).toEqual([{ role: "system", content: "You are a reviewer." }]);
    }
  });
});
