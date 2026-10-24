import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MeowEvent, ProviderConfig } from "./types";

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
vi.mock("./title-generator.js", () => ({
  generateSessionTitle: vi.fn(async () => "title"),
}));

const { ProviderRequestError } = await import("./provider-error.js");
const { AgentRuntime } = await import("./runtime.js");

async function newRuntime(providers: ProviderConfig[]) {
  const sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-policy-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-policy-ws-"));
  const runtime = new AgentRuntime({ providers, sessionsDir });
  await runtime.newSession(workspace);
  return runtime;
}

afterEach(() => {
  streamMock.mockReset();
});

describe("thinking effort by session mode", () => {
  const provider = (patch: Partial<ProviderConfig> = {}): ProviderConfig => ({
    id: "p",
    name: "P",
    baseUrl: "http://localhost",
    model: "m",
    reasoningEffort: "low",
    reasoningLevels: ["low", "medium", "high"],
    ...patch,
  });

  it("raises the effort one level in plan mode", async () => {
    const runtime = await newRuntime([provider()]);
    streamMock.mockResolvedValue({ message: { role: "assistant", content: "ok" } });
    await runtime.setSessionMode("plan");
    await runtime.prompt("plan it");

    const request = streamMock.mock.calls[0][0] as { provider: ProviderConfig };
    expect(request.provider.reasoningEffort).toBe("medium");
  });

  it("keeps the user effort in default mode", async () => {
    const runtime = await newRuntime([provider()]);
    streamMock.mockResolvedValue({ message: { role: "assistant", content: "ok" } });
    await runtime.prompt("just do it");

    const request = streamMock.mock.calls[0][0] as { provider: ProviderConfig };
    expect(request.provider.reasoningEffort).toBe("low");
  });

  it("does not boost when an explicit thinking budget is set", async () => {
    const runtime = await newRuntime([provider({ thinkingBudget: 8000 })]);
    streamMock.mockResolvedValue({ message: { role: "assistant", content: "ok" } });
    await runtime.setSessionMode("plan");
    await runtime.prompt("plan it");

    const request = streamMock.mock.calls[0][0] as { provider: ProviderConfig };
    expect(request.provider.reasoningEffort).toBe("low");
    expect(request.provider.thinkingBudget).toBe(8000);
  });
});

describe("provider fallback in a real turn", () => {
  function provider(id: string): ProviderConfig {
    return { id, name: id, baseUrl: "http://localhost", model: `${id}-model` };
  }

  it("switches to the next enabled provider on 503 and reports the switch", async () => {
    const runtime = await newRuntime([provider("main"), provider("backup")]);
    const events: MeowEvent[] = [];
    const stop = runtime.onEvent((event: MeowEvent) => events.push(event));
    streamMock
      .mockRejectedValueOnce(new ProviderRequestError(503, "service unavailable"))
      .mockResolvedValueOnce({ message: { role: "assistant", content: "recovered" } });

    await runtime.prompt("hello");
    stop();

    const providers = streamMock.mock.calls.map(
      (call) => (call[0] as { provider: ProviderConfig }).provider.id,
    );
    expect(providers).toEqual(["main", "backup"]);
    expect(events).toContainEqual({
      type: "provider_switched",
      sessionId: runtime.current!.id,
      from: "main",
      to: "backup",
      reason: "server",
    });
    expect(runtime.lastError).toBeNull();
  });

  it("does not switch on 401", async () => {
    const runtime = await newRuntime([provider("main"), provider("backup")]);
    streamMock.mockRejectedValueOnce(new ProviderRequestError(401, "invalid api key"));

    await runtime.prompt("hello").catch(() => undefined);

    const providers = streamMock.mock.calls.map(
      (call) => (call[0] as { provider: ProviderConfig }).provider.id,
    );
    expect(providers).toEqual(["main"]);
    expect(runtime.lastError).toContain("401");
  });
});
