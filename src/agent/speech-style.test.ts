import { afterEach, describe, expect, it } from "vitest";
import {
  DAZUI_SPEECH_PROMPT,
  isSpeechStyle,
  normalizeSpeechStyle,
  readSpeechStyleFromEnv,
  speechStylePrompt,
  TAFFY_SPEECH_PROMPT,
} from "./speech-style.js";

const original = process.env.MEOWCODE_SPEECH_STYLE;

afterEach(() => {
  if (original === undefined) delete process.env.MEOWCODE_SPEECH_STYLE;
  else process.env.MEOWCODE_SPEECH_STYLE = original;
});

describe("语色归一化", () => {
  it("只接受已注册语色，未知值回落 normal", () => {
    expect(normalizeSpeechStyle("normal")).toBe("normal");
    expect(normalizeSpeechStyle("tafei")).toBe("tafei");
    expect(normalizeSpeechStyle("dazui")).toBe("dazui");
    expect(normalizeSpeechStyle("Taffy")).toBe("normal");
    expect(normalizeSpeechStyle("")).toBe("normal");
    expect(normalizeSpeechStyle(undefined)).toBe("normal");
    expect(normalizeSpeechStyle(true)).toBe("normal");
    expect(isSpeechStyle("dazui")).toBe(true);
    expect(isSpeechStyle("unknown")).toBe(false);
  });

  it("从 env 读取并容忍大小写与空白", () => {
    process.env.MEOWCODE_SPEECH_STYLE = " TAFEI ";
    expect(readSpeechStyleFromEnv()).toBe("tafei");
    process.env.MEOWCODE_SPEECH_STYLE = "DAZUI";
    expect(readSpeechStyleFromEnv()).toBe("dazui");
    process.env.MEOWCODE_SPEECH_STYLE = "normal";
    expect(readSpeechStyleFromEnv()).toBe("normal");
    process.env.MEOWCODE_SPEECH_STYLE = "unknown";
    expect(readSpeechStyleFromEnv()).toBe("normal");
    delete process.env.MEOWCODE_SPEECH_STYLE;
    expect(readSpeechStyleFromEnv()).toBe("normal");
  });
});

describe("语色提示词", () => {
  it("普通模式不追加任何内容", () => {
    expect(speechStylePrompt("normal")).toBeNull();
  });

  it("塔菲模式带口癖，同时明确代码/JSON/摘要保持中性", () => {
    const prompt = speechStylePrompt("tafei");
    expect(prompt).toBe(TAFFY_SPEECH_PROMPT);
    expect(prompt).toContain("喵");
    expect(prompt).toContain("关注永雏塔菲喵");
    expect(prompt).toContain("不像写报告");
    expect(prompt).toContain("代码块");
    expect(prompt).toContain("JSON");
    expect(prompt).toContain("压缩摘要");
    expect(prompt).toContain("子 Agent 报告");
  });

  it("大嘴模式带结巴与吹牛梗，同时限制编造事实", () => {
    const prompt = speechStylePrompt("dazui");
    expect(prompt).toBe(DAZUI_SPEECH_PROMPT);
    expect(prompt).toContain("这个这个");
    expect(prompt).toContain("遥遥领先");
    expect(prompt).toContain("一千万以内最好的");
    expect(prompt).toContain("我 C！");
    expect(prompt).toContain("咋不早点告诉我");
    expect(prompt).toContain("1000 万以内最好的 Agent");
    expect(prompt).toContain("镇住了");
    expect(prompt).toContain("即使对方说");
    expect(prompt).toContain("不像写报告");
    expect(prompt).toContain("每条回复至少出现一次");
    expect(prompt).toContain("开场示例");
    expect(prompt).toContain("发送前自检");
    expect(prompt).toContain("必须真实");
    expect(prompt).toContain("代码块");
    expect(prompt).toContain("JSON");
    expect(prompt).toContain("压缩摘要");
    expect(prompt).toContain("子 Agent 报告");
  });
});
