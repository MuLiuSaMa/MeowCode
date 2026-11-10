import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderRequestError } from "./provider-error";
import { estimateMessagesTokens } from "./context";
import type { ChatMessage } from "./types";

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));
vi.mock("./provider.js", () => ({
  completionUrl: vi.fn(),
  streamChatCompletion: streamMock,
  utilityProvider: (provider: Record<string, unknown>, maxTokens: number) => ({
    ...provider,
    maxTokens,
    reasoningEffort: undefined,
  }),
}));

const {
  buildCompactionInstruction,
  compactionSummaryMaxTokens,
  createCompactionSummary,
  isContextOverflow,
  summarizeToolOutputs,
} = await import("./compaction.js");

beforeEach(() => {
  streamMock.mockClear();
});

describe("isContextOverflow", () => {
  it("detects 413 responses", () => {
    expect(isContextOverflow(new ProviderRequestError(413, "payload too large"))).toBe(true);
  });

  it("detects overflow wording in the response body", () => {
    expect(isContextOverflow(new ProviderRequestError(400, "This model's maximum context length is 8192 tokens"))).toBe(true);
    expect(isContextOverflow(new ProviderRequestError(400, "prompt is too long"))).toBe(true);
  });

  it("does not classify max_tokens rejections or rate limits as overflow", () => {
    // 输出上限参数被拒：压缩输入救不了，绝不能误判成溢出去丢历史
    expect(isContextOverflow(new ProviderRequestError(400, "max_tokens must be less than 16384"))).toBe(false);
    expect(isContextOverflow(new ProviderRequestError(400, "invalid max_tokens value"))).toBe(false);
    expect(isContextOverflow(new ProviderRequestError(400, "max_tokens exceeds the model limit"))).toBe(false);
    expect(isContextOverflow(new ProviderRequestError(429, "rate limit exceeded, too many requests"))).toBe(false);
  });

  it("still classifies genuine prompt-overflow wordings", () => {
    expect(
      isContextOverflow(
        new ProviderRequestError(400, "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens. Please reduce the length of the messages."),
      ),
    ).toBe(true);
    expect(isContextOverflow(new ProviderRequestError(400, "prompt is too long: 200000 tokens > 180000 maximum"))).toBe(true);
    expect(isContextOverflow(new ProviderRequestError(400, "input is too long for requested model"))).toBe(true);
  });

  it("ignores unrelated provider errors", () => {
    expect(isContextOverflow(new ProviderRequestError(401, "invalid api key"))).toBe(false);
  });

  it("falls back to the error message when it is not a ProviderRequestError", () => {
    expect(isContextOverflow(new Error("context window exceeded"))).toBe(true);
    expect(isContextOverflow(new Error("network down"))).toBe(false);
    expect(isContextOverflow(undefined)).toBe(false);
  });
});

describe("createCompactionSummary", () => {
  it("summarizes non-system messages and trims the result", async () => {
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "  handoff summary  " } });
    const summary = await createCompactionSummary({
      provider: {
        id: "p",
        name: "P",
        baseUrl: "http://localhost",
        model: "m",
        reasoningEffort: "xhigh",
        maxTokens: 64_000,
      },
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "fix the bug" },
        { role: "assistant", content: "done" },
      ],
    });
    expect(summary).toBe("handoff summary");
    const call = streamMock.mock.calls[0][0];
    expect(call.tools).toEqual([]);
    expect(call.messages[0].role).toBe("system");
    expect(call.messages.filter((message: { role: string }) => message.role === "system")).toHaveLength(1);
    expect(call.messages.map((message: { role: string }) => message.role)).toEqual(["system", "user", "assistant"]);
    // 摘要属于工具型调用：不继承主对话的推理强度，输出有 2–4k 预算
    expect(call.provider.reasoningEffort).toBeUndefined();
    expect(call.provider.maxTokens).toBe(4_096);
  });
});

describe("compactionSummaryMaxTokens", () => {
  it("按窗口 2% 取 2–4k，并服从 provider 更小的输出上限", () => {
    expect(compactionSummaryMaxTokens({ id: "p", name: "P", baseUrl: "http://localhost", model: "m" })).toBe(4_096);
    expect(
      compactionSummaryMaxTokens({
        id: "p",
        name: "P",
        baseUrl: "http://localhost",
        model: "m",
        contextWindow: 48_000,
      }),
    ).toBe(2_048);
    expect(
      compactionSummaryMaxTokens({
        id: "p",
        name: "P",
        baseUrl: "http://localhost",
        model: "m",
        contextWindow: 200_000,
      }),
    ).toBe(4_000);
    expect(
      compactionSummaryMaxTokens({
        id: "p",
        name: "P",
        baseUrl: "http://localhost",
        model: "m",
        contextWindow: 200_000,
        maxTokens: 1_024,
      }),
    ).toBe(1_024);
  });
});

describe("createCompactionSummary cache reuse", () => {
  it("复用主请求的 system/tools/消息前缀，只在末尾追加压缩指令", async () => {
    streamMock.mockResolvedValueOnce({
      message: { role: "assistant", content: "handoff" },
      usage: { inputTokens: 1_000, cacheReadTokens: 900, outputTokens: 20 },
    });
    const system: ChatMessage = { role: "system", content: "main system prompt" };
    const messages: ChatMessage[] = [
      system,
      { role: "user", content: "fix the bug" },
      { role: "assistant", content: "working" },
    ];
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "read_file",
          description: "Read a file.",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    const onUsage = vi.fn();
    const summary = await createCompactionSummary({
      provider: {
        id: "p",
        name: "P",
        baseUrl: "http://localhost",
        model: "m",
        reasoningEffort: "high",
      },
      messages,
      reusePrefix: true,
      systemMessages: [system],
      tools,
      onUsage,
    });

    expect(summary).toBe("handoff");
    const call = streamMock.mock.calls[0][0];
    expect(call.tools).toBe(tools);
    expect(call.toolChoice).toBe("none");
    expect(call.provider.reasoningEffort).toBeUndefined();
    expect(call.messages[0]).toEqual(system);
    expect(call.messages).toHaveLength(messages.length + 1);
    expect(call.messages.at(-1)?.role).toBe("user");
    expect(call.messages.at(-1)?.content).toContain("handoff summary");
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ cacheReadTokens: 900 }),
    );
  });

  it("promptCaching=false 时直接走专用摘要路径", async () => {
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "dedicated" } });
    const system: ChatMessage = { role: "system", content: "main system prompt" };
    const summary = await createCompactionSummary({
      provider: {
        id: "p",
        name: "P",
        baseUrl: "http://localhost",
        model: "m",
        promptCaching: false,
      },
      messages: [system, { role: "user", content: "hello" }],
      reusePrefix: true,
      systemMessages: [system],
    });
    expect(summary).toBe("dedicated");
    const call = streamMock.mock.calls[0][0];
    expect(call.tools).toEqual([]);
    expect(call.toolChoice).toBeUndefined();
    expect(call.messages[0].content).toContain("compact handoff summary");
  });

  it("复用输入塞不进窗口时回退到专用摘要路径", async () => {
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "fallback" } });
    const system: ChatMessage = { role: "system", content: "s".repeat(5_000) };
    const summary = await createCompactionSummary({
      provider: {
        id: "p",
        name: "P",
        baseUrl: "http://localhost",
        model: "m",
        contextWindow: 2_000,
      },
      messages: [system, { role: "user", content: "x".repeat(5_000) }],
      reusePrefix: true,
      systemMessages: [system],
    });
    expect(summary).toBe("fallback");
    const call = streamMock.mock.calls[0][0];
    expect(call.tools).toEqual([]);
    expect(call.messages[0]).toMatchObject({ role: "system" });
    expect(call.messages[0].content).toContain("compact handoff summary");
  });

  it("摘要输入仍塞不进窗口时逐档降级，旧工具输出压成单行", async () => {
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "ladder" } });
    const messages: ChatMessage[] = [{ role: "user", content: "start" }];
    for (let index = 0; index < 30; index += 1) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          { id: `c${index}`, type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      });
      messages.push({
        role: "tool",
        name: "read_file",
        tool_call_id: `c${index}`,
        content: `body ${index}\n${"z".repeat(3_000)}`,
      });
    }
    const summary = await createCompactionSummary({
      provider: { id: "p", name: "P", baseUrl: "http://localhost", model: "m", contextWindow: 8_000 },
      messages,
      reusePrefix: false,
    });
    expect(summary).toBe("ladder");
    const call = streamMock.mock.calls[0][0];
    const input = (call.messages as ChatMessage[]).filter((message) => message.role !== "system");
    // 落进预算：窗口 8000 − 摘要输出 2048 − 1024 余量
    expect(estimateMessagesTokens(input)).toBeLessThanOrEqual(8_000 - 2_048 - 1_024);
    // 第 2 档生效：旧工具输出变成单行标注
    expect(
      input.some(
        (message) => typeof message.content === "string" && message.content.includes("output omitted"),
      ),
    ).toBe(true);
  });
});

describe("summarizeToolOutputs", () => {
  const provider = { id: "p", name: "P", baseUrl: "http://localhost", model: "m" };

  it("按 <id>: <digest> 行解析纪要，忽略未知 id 与空行", async () => {
    streamMock.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content:
          "call-1: read src/main.ts (240 lines); exports run()\nunknown-id: should be ignored\n\ncall-2: grep found 3 matches in src/util.ts",
      },
    });
    const digests = await summarizeToolOutputs({
      provider,
      outputs: [
        { callId: "call-1", tool: "read_file", content: "x".repeat(2_000) },
        { callId: "call-2", tool: "grep", content: "y".repeat(2_000) },
      ],
    });
    expect(digests.get("call-1")).toContain("src/main.ts");
    expect(digests.get("call-2")).toContain("3 matches");
    expect(digests.has("unknown-id")).toBe(false);
    expect(digests.size).toBe(2);
    // 摘要请求不带工具定义，输出上限受控，且不继承主对话推理强度
    const call = streamMock.mock.calls[0][0];
    expect(call.tools).toEqual([]);
    expect(call.provider.maxTokens).toBeLessThanOrEqual(2_048);
    expect(call.provider.reasoningEffort).toBeUndefined();
  });

  it("模型没有产出可用纪要时返回空 Map，调用方进入下一档", async () => {
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "I cannot summarize." } });
    const digests = await summarizeToolOutputs({
      provider,
      outputs: [{ callId: "call-1", tool: "read_file", content: "x".repeat(2_000) }],
    });
    expect(digests.size).toBe(0);
  });

  it("超大单条输出按 TOOL_DIGEST_ENTRY_CHARS 截断后参与摘要（预算按实际发送量算）", async () => {
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "c1: many lines" } });
    const digests = await summarizeToolOutputs({
      provider, // 未声明 contextWindow → 默认 48k → token 预算 ~19.2k
      outputs: [{ callId: "c1", tool: "read_file", content: "x".repeat(100_000) }],
    });
    // 请求里只有前 6000 字符，按 token 估约 1.5k，预算完全放得下 —— 不该整体跳过。
    // 旧实现拿未截断的 100k 字符判预算，于是把一条本该被压成两行的输出丢掉了。
    expect(digests.get("c1")).toBe("many lines");
    const sent = streamMock.mock.calls.at(-1)?.[0] as { messages: Array<{ content: string }> };
    expect(sent.messages[1].content.length).toBeLessThan(7_000);
  });

  it("截断后仍塞不进预算时整体跳过（不发请求）", async () => {
    const callsBefore = streamMock.mock.calls.length;
    // 中文 6000 字 ≈ 6000 token，超过最低预算 2000 —— 截断也救不了，只能跳过
    const digests = await summarizeToolOutputs({
      provider: { ...provider, contextWindow: 1_000 },
      outputs: [{ callId: "c1", tool: "read_file", content: "测".repeat(100_000) }],
    });
    expect(digests.size).toBe(0);
    expect(streamMock.mock.calls.length).toBe(callsBefore);
  });

  it("预算按 token 算：中文正文不会被放大四倍塞进摘要请求", async () => {
    // 旧实现把 window*0.4 当成字符预算再 ×4：中文 1 字 ≈ 1 token，
    // 于是 4 倍正文被放进请求 —— 这一层压缩反而制造溢出。
    const window = 8_000; // token 预算 = 3200
    const cjk = "测".repeat(4_000); // ≈4000 token，明显超预算
    const callsBefore = streamMock.mock.calls.length;
    const digests = await summarizeToolOutputs({
      provider: { ...provider, contextWindow: window },
      outputs: [{ callId: "c1", tool: "read_file", content: cjk }],
    });
    expect(digests.size).toBe(0);
    expect(streamMock.mock.calls.length).toBe(callsBefore);
  });

  it("空输出列表直接返回空 Map", async () => {
    const callsBefore = streamMock.mock.calls.length;
    expect((await summarizeToolOutputs({ provider, outputs: [] })).size).toBe(0);
    expect(streamMock.mock.calls.length).toBe(callsBefore);
  });
});

describe("buildCompactionInstruction", () => {
  it("普通模式与原文逐字节一致", async () => {
    const { COMPACTION_INSTRUCTION } = await import("./compaction.js");
    expect(buildCompactionInstruction()).toBe(COMPACTION_INSTRUCTION);
    expect(buildCompactionInstruction(false)).toBe(COMPACTION_INSTRUCTION);
  });

  it("语色开启时追加中性要求", () => {
    const instruction = buildCompactionInstruction(true);
    expect(instruction).toContain("persona");
    expect(instruction).toContain("neutral technical language");
    expect(instruction).toContain("喵");
  });
});
