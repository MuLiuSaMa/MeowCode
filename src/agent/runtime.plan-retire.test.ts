import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, MeowEvent } from "./types";

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));
vi.mock("./provider.js", () => ({
  completionUrl: vi.fn(),
  streamChatCompletion: streamMock,
}));
vi.mock("./title-generator.js", () => ({
  generateSessionTitle: vi.fn().mockResolvedValue("Test title"),
}));

const { AgentRuntime } = await import("./runtime.js");

function makeRuntime(sessionsDir: string): InstanceType<typeof AgentRuntime> {
  return new AgentRuntime({
    providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
    sessionsDir,
  });
}

function call(id: string, name: string, args: Record<string, unknown>) {
  return {
    id,
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

function assistantText(content: string) {
  return { message: { role: "assistant" as const, content } };
}

function assistantCalls(...calls: ReturnType<typeof call>[]) {
  return { message: { role: "assistant" as const, content: null, tool_calls: calls } };
}

const RETIRE_PREFIX = "[plan] The previous checklist is fully completed and archived.";

function sawRetireNote(messages: ChatMessage[]): boolean {
  return messages.some(
    (message) => typeof message.content === "string" && message.content.startsWith(RETIRE_PREFIX),
  );
}

beforeEach(() => {
  streamMock.mockReset();
});

describe("新回合归档已完成的清单", () => {
  it("旧清单全部终结时归档，新清单只包含本轮步骤", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-plan-retire-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-plan-retire-ws-"));
    const runtime = makeRuntime(dir);
    const events: MeowEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");

    const rounds: ChatMessage[][] = [];
    streamMock.mockImplementation(async ({ messages }: { messages: ChatMessage[] }) => {
      rounds.push([...messages]);
      if (rounds.length === 1) {
        return assistantCalls(
          call("p1", "update_plan", {
            steps: [
              { title: "old done", status: "completed" },
              { title: "old dropped", status: "cancelled" },
            ],
          }),
        );
      }
      if (rounds.length === 3) {
        return assistantCalls(
          call("p2", "update_plan", {
            steps: [{ title: "fresh step", status: "in_progress" }],
          }),
        );
      }
      return assistantText("done");
    });

    await runtime.prompt("first task");
    expect(
      runtime.current?.currentPlan?.steps.map((step) => step.title),
    ).toEqual(["old done", "old dropped"]);

    const beforeSecondTurn = rounds.length;
    await runtime.prompt("second task");

    // 新回合第一次请求必须带上归档注记，模型才知道不能沿用旧清单
    expect(sawRetireNote(rounds[beforeSecondTurn])).toBe(true);
    // UI 侧收到空清单广播，旧胶囊立即收起
    expect(
      events.some(
        (event) =>
          event.type === "plan_updated" && event.steps.length === 0 && event.sessionId,
      ),
    ).toBe(true);
    // 当前清单只剩本轮步骤，旧的 completed/cancelled 不再出现
    expect(runtime.current?.currentPlan?.steps.map((step) => step.title)).toEqual([
      "fresh step",
    ]);

    await runtime.closeSession();
  }, 60_000);

  it("旧清单还有未完成步骤时保留，不注入归档注记", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-plan-keep-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-plan-keep-ws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");

    const rounds: ChatMessage[][] = [];
    streamMock.mockImplementation(async ({ messages }: { messages: ChatMessage[] }) => {
      rounds.push([...messages]);
      if (rounds.length === 1) {
        return assistantCalls(
          call("p1", "update_plan", {
            steps: [
              { title: "done part", status: "completed" },
              { title: "still open", status: "pending" },
            ],
          }),
        );
      }
      return assistantText("done");
    });

    await runtime.prompt("first task");
    const beforeSecondTurn = rounds.length;
    await runtime.prompt("continue");

    expect(sawRetireNote(rounds[beforeSecondTurn])).toBe(false);
    expect(
      runtime.current?.currentPlan?.steps.map((step) => step.title),
    ).toEqual(["done part", "still open"]);

    await runtime.closeSession();
  }, 60_000);
});
