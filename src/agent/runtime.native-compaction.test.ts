import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderRequestError } from "./provider-error";
import type { MeowEvent } from "./types";

const { streamMock, nativeModeMock, nativeRequestMock } = vi.hoisted(() => ({
  streamMock: vi.fn(),
  nativeModeMock: vi.fn(),
  nativeRequestMock: vi.fn(),
}));

vi.mock("./provider.js", () => ({
  completionUrl: vi.fn(),
  streamChatCompletion: streamMock,
  utilityProvider: (provider: Record<string, unknown>, maxTokens: number) => ({
    ...provider,
    maxTokens,
    reasoningEffort: undefined,
  }),
}));
vi.mock("./native-compaction.js", async () => {
  const actual =
    await vi.importActual<typeof import("./native-compaction.js")>("./native-compaction.js");
  return {
    ...actual,
    nativeCompactionMode: nativeModeMock,
    requestNativeCompaction: nativeRequestMock,
  };
});
vi.mock("./title-generator.js", () => ({
  generateSessionTitle: vi.fn().mockResolvedValue("Test title"),
}));

const { AgentRuntime } = await import("./runtime.js");

function makeRuntime(sessionsDir: string): InstanceType<typeof AgentRuntime> {
  return new AgentRuntime({
    providers: [
      {
        id: "p",
        name: "P",
        baseUrl: "https://api.anthropic.com/v1",
        model: "m",
        protocol: "anthropic-messages",
      },
    ],
    sessionsDir,
    homeDir: sessionsDir,
  });
}

async function collectEvents(runtime: InstanceType<typeof AgentRuntime>): Promise<MeowEvent[]> {
  const events: MeowEvent[] = [];
  runtime.onEvent((event) => events.push(event));
  return events;
}

beforeEach(() => {
  streamMock.mockReset();
  nativeModeMock.mockReset();
  nativeRequestMock.mockReset();
  nativeModeMock.mockReturnValue("anthropic-inband");
});

describe("runtime native compaction", () => {
  it("服务端原生摘要成功时不再发本地摘要请求", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-native-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    const events = await collectEvents(runtime);
    nativeRequestMock.mockResolvedValueOnce({ summary: "SERVER SUMMARY" });
    streamMock
      .mockRejectedValueOnce(new ProviderRequestError(413, "prompt is too long"))
      .mockResolvedValueOnce({ message: { role: "assistant", content: "FINAL" } });

    await runtime.prompt("do the thing");

    expect(nativeRequestMock).toHaveBeenCalledTimes(1);
    // 溢出 + 重试：摘要完全由服务端完成，没有第三次本地摘要调用
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(
      events.some(
        (event) => event.type === "compaction_completed" && event.summary === "SERVER SUMMARY",
      ),
    ).toBe(true);
    expect(runtime.current?.currentCompactionSummary).toBe("SERVER SUMMARY");
    expect(runtime.current?.effectiveMessages.map((message) => message.content)).toEqual([
      "Earlier conversation summary:\nSERVER SUMMARY",
      "FINAL",
    ]);
  });

  it("OpenAI 加密 item 落成 native_compaction 并进入后续请求", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-native-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    nativeRequestMock.mockResolvedValueOnce({
      summary: "",
      native: {
        providerId: "p",
        endpoint: "https://api.anthropic.com/v1",
        model: "m",
        protocol: "anthropic-messages",
        items: [{ type: "compaction", encrypted_content: "gAAAA" }],
      },
    });
    streamMock
      .mockRejectedValueOnce(new ProviderRequestError(413, "prompt is too long"))
      .mockResolvedValueOnce({ message: { role: "assistant", content: "FINAL" } });

    await runtime.prompt("do the thing");

    const entry = runtime.current?.lastNativeCompaction;
    expect(entry?.native.items).toEqual([{ type: "compaction", encrypted_content: "gAAAA" }]);
    expect(runtime.current?.effectiveMessages[0]).toMatchObject({ role: "native_compaction" });
  });

  it("原生压缩不可用时退回本地摘要", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-native-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    const events = await collectEvents(runtime);
    nativeRequestMock.mockRejectedValueOnce(new Error("gateway does not support it"));
    streamMock
      .mockRejectedValueOnce(new ProviderRequestError(413, "prompt is too long"))
      .mockResolvedValueOnce({ message: { role: "assistant", content: "LOCAL SUMMARY" } })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "FINAL" } });

    await runtime.prompt("do the thing");

    expect(streamMock).toHaveBeenCalledTimes(3);
    expect(runtime.current?.currentCompactionSummary).toBe("LOCAL SUMMARY");
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("连续失败两次后不再尝试原生压缩，避免每轮白撞同一堵墙", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-native-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    nativeRequestMock.mockRejectedValue(new Error("unsupported"));
    const overflow = new ProviderRequestError(413, "prompt is too long");
    streamMock
      .mockRejectedValueOnce(overflow)
      .mockResolvedValueOnce({ message: { role: "assistant", content: "S1" } })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "F1" } })
      .mockRejectedValueOnce(overflow)
      .mockResolvedValueOnce({ message: { role: "assistant", content: "S2" } })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "F2" } })
      .mockRejectedValueOnce(overflow)
      .mockResolvedValueOnce({ message: { role: "assistant", content: "S3" } })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "F3" } });

    await runtime.prompt("one");
    await runtime.prompt("two");
    await runtime.prompt("three");

    // 前两次各试一次原生压缩，第三次直接走本地摘要
    expect(nativeRequestMock).toHaveBeenCalledTimes(2);
  });

  it("协议不支持时不产生任何原生压缩请求", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-native-runtime-"));
    nativeModeMock.mockReturnValue(null);
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    streamMock
      .mockRejectedValueOnce(new ProviderRequestError(413, "prompt is too long"))
      .mockResolvedValueOnce({ message: { role: "assistant", content: "LOCAL" } })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "FINAL" } });

    await runtime.prompt("go");

    expect(nativeRequestMock).not.toHaveBeenCalled();
    expect(runtime.current?.currentCompactionSummary).toBe("LOCAL");
  });
});
