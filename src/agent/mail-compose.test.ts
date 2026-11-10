import { describe, expect, it, vi } from "vitest";
import { ProviderRequestError } from "./provider-error.js";
import { buildMailComposeMessages, cleanGeneratedMail } from "./mail-compose.js";

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));
vi.mock("./provider.js", () => ({
  completionUrl: vi.fn(),
  streamChatCompletion: streamMock,
  utilityProvider: (provider: Record<string, unknown>, maxTokens: number) => ({
    ...provider,
    maxTokens,
    reasoningEffort: undefined,
    thinkingBudget: undefined,
  }),
}));

const { composeMail } = await import("./mail-compose.js");

describe("buildMailComposeMessages", () => {
  it("回复模式带上收件人、主题、发件人、要求与分隔标记", () => {
    const messages = buildMailComposeMessages({
      mode: "reply",
      instruction: "礼貌确认收到，下周一给方案",
      to: "alex@example.com",
      subject: "关于评审",
      original: "请下周前给一个方案。",
      draft: "您好，",
      from: { name: "猫猫", email: "me@example.com" },
    });
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain("写作任务，不是对话");
    expect(messages[0].content).toContain("<original>");
    expect(messages[1].content).toContain("模式：回复");
    expect(messages[1].content).toContain("收件人：alex@example.com");
    expect(messages[1].content).toContain("主题：关于评审");
    expect(messages[1].content).toContain("发件人：猫猫 <me@example.com>");
    expect(messages[1].content).toContain("写作要求：礼貌确认收到");
    expect(messages[1].content).toContain("<draft>\n您好，\n</draft>");
    expect(messages[1].content).toContain("<original>\n请下周前给一个方案。\n</original>");
  });

  it("没有模式时按新邮件处理", () => {
    const messages = buildMailComposeMessages({ subject: "周会" });
    expect(messages[1].content).toContain("模式：新邮件");
    expect(messages[1].content).not.toContain("<original>");
  });

  it("超长上下文保留头部并标记已截断", () => {
    const messages = buildMailComposeMessages({ original: "a".repeat(8_001) });
    expect(messages[1].content).toContain("…[内容已截断]");
    expect(messages[1].content).toContain(`${"a".repeat(8_000)}\n…[内容已截断]`);
  });
});

describe("cleanGeneratedMail", () => {
  it("普通正文原样保留", () => {
    expect(cleanGeneratedMail("您好，收到。")).toBe("您好，收到。");
  });

  it("剥掉闭合与未闭合的思考块", () => {
    expect(cleanGeneratedMail("<think>hmm</think>\n您好，收到。")).toBe("您好，收到。");
    expect(cleanGeneratedMail("您好，收到。\n<thinking>绕一圈")).toBe("您好，收到。");
  });

  it("剥掉回显的分隔标记", () => {
    expect(cleanGeneratedMail("<draft>\n您好\n</draft>")).toBe("您好");
    expect(cleanGeneratedMail("<original>\n您好\n</original>")).toBe("您好");
  });

  it("整段围栏解开但保留内部代码块", () => {
    expect(cleanGeneratedMail("```text\n您好，收到。\n```")).toBe("您好，收到。");
    expect(cleanGeneratedMail("```\n您好：\n\n```ts\nconst a = 1;\n```\n```")).toBe(
      "您好：\n\n```ts\nconst a = 1;\n```",
    );
  });

  it("容忍 JSON 包裹的 text/body/content", () => {
    expect(cleanGeneratedMail('{"text":"您好"}')).toBe("您好");
    expect(cleanGeneratedMail('{"body":"您好"}')).toBe("您好");
    expect(cleanGeneratedMail('{"content":"您好"}')).toBe("您好");
    // 与邮件无关的 JSON 不拆包
    expect(cleanGeneratedMail('{"subject":"x"}')).toBe('{"subject":"x"}');
  });

  it("剥掉前言与主题行", () => {
    expect(cleanGeneratedMail("Here is the email: 您好")).toBe("您好");
    expect(cleanGeneratedMail("以下是邮件正文：您好")).toBe("您好");
    expect(cleanGeneratedMail("正文：您好")).toBe("您好");
    expect(cleanGeneratedMail("Subject: hi\n\n您好")).toBe("您好");
  });

  it("空输出或仅思考返回 null", () => {
    expect(cleanGeneratedMail("")).toBeNull();
    expect(cleanGeneratedMail("   \n ")).toBeNull();
    expect(cleanGeneratedMail("<think>only thinking</think>")).toBeNull();
    expect(cleanGeneratedMail("```\n```")).toBeNull();
  });
});

describe("composeMail", () => {
  const provider = {
    id: "p",
    name: "P",
    baseUrl: "http://localhost",
    model: "m",
  };

  it("只调用一次模型，关闭工具与网络重试，并返回清洗后的正文", async () => {
    streamMock.mockReset();
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "您好，收到。" } });
    const text = await composeMail({
      provider,
      context: { mode: "reply", instruction: "确认收到" },
    });
    expect(text).toBe("您好，收到。");
    expect(streamMock).toHaveBeenCalledTimes(1);
    const call = streamMock.mock.calls[0][0] as {
      tools: unknown[];
      fetchAttempts?: number;
      provider: { maxTokens?: number; reasoningEffort?: unknown };
      messages: Array<{ role: string; content: string }>;
    };
    expect(call.tools).toEqual([]);
    expect(call.fetchAttempts).toBe(1);
    expect(call.provider.maxTokens).toBe(2_500);
    expect(call.provider.reasoningEffort).toBeUndefined();
    expect(call.messages[0].role).toBe("system");
    expect(call.messages[1].content).toContain("确认收到");
  });

  it("被输出上限截断时直接失败，不重试也不返回半截正文", async () => {
    streamMock.mockReset();
    streamMock.mockResolvedValueOnce({
      message: { role: "assistant", content: "您好，收" },
      finishReason: "length",
    });
    await expect(composeMail({ provider, context: { instruction: "写一封长信" } })).rejects.toThrow(
      /被截断/,
    );
    expect(streamMock).toHaveBeenCalledTimes(1);
  });

  it("报告思考量，帮助定位空输出", async () => {
    streamMock.mockReset();
    streamMock.mockImplementationOnce(
      async (options: { onThinking?: (delta: string) => void }) => {
        options.onThinking?.("想".repeat(120));
        return { message: { role: "assistant", content: "" }, finishReason: "length" };
      },
    );
    await expect(composeMail({ provider, context: { instruction: "写一封长信" } })).rejects.toThrow(
      /本次思考约 120 字符/,
    );
  });

  it("空输出抛可读错误", async () => {
    streamMock.mockReset();
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "" } });
    await expect(composeMail({ provider, context: { instruction: "写封信" } })).rejects.toThrow(
      /没有返回可用的邮件正文/,
    );
    expect(streamMock).toHaveBeenCalledTimes(1);
  });

  it("鉴权失败给友好错误，不回显网关原文", async () => {
    streamMock.mockReset();
    streamMock.mockRejectedValueOnce(new ProviderRequestError(401, "invalid api key"));
    await expect(composeMail({ provider, context: { instruction: "写封信" } })).rejects.toThrow(
      /鉴权失败/,
    );
  });

  it("用户中止原样抛出，不被包装成服务商错误", async () => {
    streamMock.mockReset();
    const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
    streamMock.mockRejectedValueOnce(aborted);
    await expect(composeMail({ provider, context: { instruction: "写封信" } })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});