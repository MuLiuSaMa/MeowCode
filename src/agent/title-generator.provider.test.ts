import { describe, expect, it, vi } from "vitest";

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));
vi.mock("./provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provider.js")>();
  return { ...actual, streamChatCompletion: streamMock };
});

const { generateSessionTitle, TITLE_MAX_TOKENS, TITLE_RETRY_MAX_TOKENS } = await import(
  "./title-generator.js"
);

describe("generateSessionTitle", () => {
  it("用无推理强度、固定小输出预算的辅助请求", async () => {
    streamMock.mockResolvedValueOnce({
      message: { role: "assistant", content: '{"title":"修复登录页"}' },
    });
    const title = await generateSessionTitle({
      provider: {
        id: "p",
        name: "P",
        baseUrl: "http://localhost",
        model: "m",
        reasoningEffort: "xhigh",
        maxTokens: 64_000,
      },
      userMessage: "fix the login page",
    });

    expect(title).toBe("修复登录页");
    const call = streamMock.mock.calls[0][0];
    expect(call.tools).toEqual([]);
    expect(call.provider.maxTokens).toBe(TITLE_MAX_TOKENS);
    expect(call.provider.reasoningEffort).toBeUndefined();
  });
});

describe("generateSessionTitle 思考型模型", () => {
  it("正文为空时用更大预算重试一次", async () => {
    streamMock.mockReset();
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "" } });
    streamMock.mockResolvedValueOnce({
      message: { role: "assistant", content: '{"title":"补上重试"}' },
    });
    const title = await generateSessionTitle({
      provider: { id: "p", name: "P", baseUrl: "http://localhost", model: "m" },
      userMessage: "重试一下",
    });
    expect(title).toBe("补上重试");
    expect(streamMock).toHaveBeenCalledTimes(2);
    const retry = streamMock.mock.calls[1][0] as { provider: { maxTokens?: number } };
    expect(retry.provider.maxTokens).toBe(TITLE_RETRY_MAX_TOKENS);
  });

  it("两次都空才抛错", async () => {
    streamMock.mockReset();
    streamMock.mockResolvedValue({ message: { role: "assistant", content: "" } });
    await expect(
      generateSessionTitle({
        provider: { id: "p", name: "P", baseUrl: "http://localhost", model: "m" },
        userMessage: "空的",
      }),
    ).rejects.toThrow(/empty output/);
    expect(streamMock).toHaveBeenCalledTimes(2);
  });
});
