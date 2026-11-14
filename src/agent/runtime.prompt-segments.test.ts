import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #4 提示词分段：架构图主 Agent 的自定义提示词走「基线 + 边界后增量段」。
 *
 * 以前是整体替换：改一次自定义提示词，tools 之后整段前缀跟着重写。
 * 现在它排在 instructions 之后、缓存断点之外——改它只重写它自己那一小段。
 */

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));
vi.mock("./provider.js", () => ({
  completionUrl: vi.fn(),
  streamChatCompletion: streamMock,
  utilityProvider: (provider: Record<string, unknown>, maxTokens: number) => ({
    ...provider,
    maxTokens,
  }),
}));
vi.mock("./title-generator.js", () => ({
  generateSessionTitle: vi.fn().mockResolvedValue("Segments"),
}));

const { AgentRuntime } = await import("./runtime.js");

beforeEach(() => {
  streamMock.mockReset();
  streamMock.mockResolvedValue({ message: { role: "assistant", content: "ok" } });
});

/** 写一份带自定义主提示词的架构图，返回临时工作区。 */
async function workspaceWithHarness(systemPrompt: string): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-segments-"));
  const dir = path.join(workspace, ".meowcode", "harness");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "standard.json"),
    JSON.stringify({
      version: 1,
      nodes: [
        { id: "main", type: "agent", data: { id: "main", name: "Main", systemPrompt } },
      ],
      edges: [],
    }),
    "utf8",
  );
  return workspace;
}

async function createRuntime(workspace: string) {
  const sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-segments-sessions-"));
  const runtime = new AgentRuntime({
    providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
    sessionsDir,
    homeDir: sessionsDir,
    workspace,
  });
  await runtime.newSession(workspace);
  runtime.setApprovalMode("full");
  return runtime;
}

async function systemTexts(runtime: AgentRuntime): Promise<string[]> {
  streamMock.mockClear();
  await runtime.prompt("hello");
  const request = streamMock.mock.calls[0][0] as {
    messages: Array<{ role: string; content: string | null }>;
  };
  return request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content ?? "");
}

describe("prompt segments", () => {
  it("自定义提示词以独立分段排在基线与 instructions 之后", async () => {
    const workspace = await workspaceWithHarness("Custom workflow rules for this repo.");
    const runtime = await createRuntime(workspace);
    const texts = await systemTexts(runtime);

    expect(texts.length).toBeGreaterThanOrEqual(2);
    // 基线仍是档位提示词，没有被替换
    expect(texts[0]).not.toContain("Custom workflow rules");
    // 分段单独成一条 system，且排在基线之后
    const segmentIndex = texts.findIndex((text) => text.includes("Custom workflow rules"));
    expect(segmentIndex).toBeGreaterThan(0);
  });

  it("改自定义提示词时基线字节不变（增量段各自独立）", async () => {
    const workspaceA = await workspaceWithHarness("Segment version A.");
    const workspaceB = await workspaceWithHarness("Segment version B is completely different.");
    const textsA = await systemTexts(await createRuntime(workspaceA));
    const textsB = await systemTexts(await createRuntime(workspaceB));

    // 两个工作区的基线与 instructions 逐字节一致；只有分段不同
    expect(textsA[0]).toBe(textsB[0]);
    if (textsA.length > 2 && textsB.length > 2) {
      expect(textsA[1]).toBe(textsB[1]);
    }
    expect(textsA.find((text) => text.includes("Segment version A."))).toBeDefined();
    expect(textsB.find((text) => text.includes("Segment version B is completely different."))).toBeDefined();
    // A 的分段内容没有泄漏进 B
    expect(textsB.some((text) => text.includes("Segment version A."))).toBe(false);
  });

  it("显式 systemPrompt（子 Agent / 测试）仍然整体生效，分段不叠加", async () => {
    const workspace = await workspaceWithHarness("Custom workflow rules for this repo.");
    const sessionsDir = await mkdtemp(path.join(tmpdir(), "meowcode-segments-custom-"));
    const runtime = new AgentRuntime({
      providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
      sessionsDir,
      homeDir: sessionsDir,
      workspace,
      systemPrompt: "Explicit caller prompt wins.",
    });
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    const texts = await systemTexts(runtime);

    expect(texts[0]).toBe("Explicit caller prompt wins.");
    expect(texts.some((text) => text.includes("Custom workflow rules"))).toBe(false);
  });
});
