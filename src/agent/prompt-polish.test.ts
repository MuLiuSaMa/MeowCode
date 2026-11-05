import { describe, expect, it, vi } from "vitest";
import { buildUserPrompt, cleanPolishedPrompt } from "./prompt-polish";

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

const { polishPrompt } = await import("./prompt-polish.js");

describe("buildUserPrompt", () => {
  it("wraps the draft in delimiters", () => {
    const prompt = buildUserPrompt("把设置页的按钮改成圆角");
    expect(prompt).toContain("<draft>");
    expect(prompt).toContain("把设置页的按钮改成圆角");
    expect(prompt).toContain("</draft>");
  });
});

describe("cleanPolishedPrompt", () => {
  it("keeps a plain prompt verbatim, including paths and constraints", () => {
    const draft = "把 desktop/src/App.tsx 里的 sendDisabled 改成 ≤ 3 行，不要动 @src/api.ts。";
    expect(cleanPolishedPrompt(draft)).toBe(draft);
  });

  it("strips think blocks, including an unclosed tail", () => {
    expect(cleanPolishedPrompt("<think>hmm</think>\n目标：修复登录")).toBe("目标：修复登录");
    expect(cleanPolishedPrompt("目标：修复登录\n<thinking>绕一圈")).toBe("目标：修复登录");
  });

  it("strips echoed draft markers", () => {
    expect(cleanPolishedPrompt("<draft>\n目标：修复登录\n</draft>")).toBe("目标：修复登录");
  });

  it("unwraps a whole-output fence but keeps inner code blocks", () => {
    expect(cleanPolishedPrompt("```markdown\n目标：修复登录\n```")).toBe("目标：修复登录");
    expect(cleanPolishedPrompt("```\n目标：\n\n```ts\nconst a = 1;\n```\n```")).toBe(
      "目标：\n\n```ts\nconst a = 1;\n```",
    );
  });

  it("accepts JSON wrappers with prompt/polished/rewritten keys", () => {
    expect(cleanPolishedPrompt('{"prompt":"目标：修复登录"}')).toBe("目标：修复登录");
    expect(cleanPolishedPrompt('{"polished":"目标：修复登录"}')).toBe("目标：修复登录");
    expect(cleanPolishedPrompt('{"rewritten":"目标：修复登录"}')).toBe("目标：修复登录");
    // 与润色无关的 JSON 不拆包，按普通文本保留
    expect(cleanPolishedPrompt('{"text":"keep"}')).toBe('{"text":"keep"}');
  });

  it("drops a leading label", () => {
    expect(cleanPolishedPrompt("Here is the rewritten prompt: 目标：修复登录")).toBe(
      "目标：修复登录",
    );
    expect(cleanPolishedPrompt("改写后的提示词：目标：修复登录")).toBe("目标：修复登录");
  });

  it("rejects empty or thinking-only output", () => {
    expect(cleanPolishedPrompt("")).toBeNull();
    expect(cleanPolishedPrompt("   \n ")).toBeNull();
    expect(cleanPolishedPrompt("<think>only thinking</think>")).toBeNull();
    expect(cleanPolishedPrompt("```\n```")).toBeNull();
  });
});

describe("polishPrompt", () => {
  const provider = {
    id: "p",
    name: "P",
    baseUrl: "http://localhost",
    model: "m",
  };

  it("calls the model once with no tools and returns the cleaned prompt", async () => {
    streamMock.mockReset();
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "目标：修复登录" } });
    const polished = await polishPrompt({ provider, text: "修复登录" });
    expect(polished).toBe("目标：修复登录");
    const call = streamMock.mock.calls[0][0] as {
      tools: unknown[];
      provider: { maxTokens?: number; reasoningEffort?: unknown };
      messages: Array<{ role: string; content: string }>;
    };
    expect(call.tools).toEqual([]);
    expect(call.provider.maxTokens).toBe(4_000);
    expect(call.provider.reasoningEffort).toBeUndefined();
    expect(call.messages[0].role).toBe("system");
    expect(call.messages[1].content).toContain("<draft>");
    expect(call.messages[1].content).toContain("修复登录");
  });

  it("retries with a bigger budget when the output is empty", async () => {
    streamMock.mockReset();
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "" } });
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "目标：修复登录" } });
    const polished = await polishPrompt({ provider, text: "修复登录" });
    expect(polished).toBe("目标：修复登录");
    expect(streamMock).toHaveBeenCalledTimes(2);
    const retry = streamMock.mock.calls[1][0] as {
      provider: { maxTokens?: number };
      messages: Array<{ role: string; content: string }>;
    };
    expect(retry.provider.maxTokens).toBe(8_000);
    expect(retry.messages.some((item) => item.content.includes("Do not think out loud"))).toBe(true);
  });

  it("never accepts a truncated result, even with partial content", async () => {
    streamMock.mockReset();
    streamMock.mockResolvedValueOnce({
      message: { role: "assistant", content: "目标：修复登" },
      finishReason: "length",
    });
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "目标：修复登录" } });
    const polished = await polishPrompt({ provider, text: "修复登录" });
    expect(polished).toBe("目标：修复登录");
    expect(streamMock).toHaveBeenCalledTimes(2);
  });

  it("throws when both attempts are truncated", async () => {
    streamMock.mockReset();
    streamMock.mockResolvedValue({
      message: { role: "assistant", content: "目标：修复登" },
      finishReason: "length",
    });
    await expect(polishPrompt({ provider, text: "修复登录" })).rejects.toThrow(/被截断/);
    expect(streamMock).toHaveBeenCalledTimes(2);
  });

  it("reports the thinking volume when even the retry stays empty", async () => {
    streamMock.mockReset();
    streamMock.mockImplementation(async (options: { onThinking?: (delta: string) => void }) => {
      options.onThinking?.("想".repeat(120));
      return { message: { role: "assistant", content: "" }, finishReason: "length" };
    });
    await expect(polishPrompt({ provider, text: "修复登录" })).rejects.toThrow(
      /被截断（本次思考约 240 字符）/,
    );
  });
});
