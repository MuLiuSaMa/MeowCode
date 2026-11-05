import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TraceSpan } from "./trace";

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
vi.mock("./title-generator.js", () => ({
  generateSessionTitle: vi.fn().mockResolvedValue("Test title"),
}));

const { AgentRuntime } = await import("./runtime.js");

function makeRuntime(sessionsDir: string, traceSink?: (span: TraceSpan) => void) {
  return new AgentRuntime({
    providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
    sessionsDir,
    homeDir: sessionsDir,
    ...(traceSink ? { traceSink } : {}),
  });
}

beforeEach(() => {
  streamMock.mockReset();
});

describe("runtime trace", () => {
  it("回合结束后留下 turn 与 llm span，并带上用量属性", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-trace-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    streamMock.mockResolvedValueOnce({
      message: { role: "assistant", content: "hi" },
      usage: { inputTokens: 120, outputTokens: 8, cacheReadTokens: 64 },
    });

    await runtime.prompt("go");

    expect(runtime.getTraceId()).toBe(runtime.current?.id);
    const spans = runtime.getTraceSpans();
    const llm = spans.find((span) => span.kind === "llm");
    const turn = spans.find((span) => span.kind === "turn");
    expect(llm?.attributes?.inputTokens).toBe(120);
    expect(llm?.attributes?.cacheReadTokens).toBe(64);
    expect(turn?.status).toBe("ok");
    expect(runtime.getTraceSummary().total).toBeGreaterThanOrEqual(2);
  });

  it("span 通过 sink 交给外部日志", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-trace-"));
    const seen: string[] = [];
    const runtime = makeRuntime(dir, (span) => seen.push(span.kind));
    await runtime.newSession();
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "ok" } });

    await runtime.prompt("go");
    expect(seen).toContain("llm");
    expect(seen).toContain("turn");
  });
});
