import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "./types";

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

function sawPlanReminder(rounds: ChatMessage[][]): boolean {
  return rounds.some((messages) =>
    messages.some(
      (message) => typeof message.content === "string" && message.content.startsWith("[plan]"),
    ),
  );
}

beforeEach(() => {
  streamMock.mockReset();
});

describe("计划清单新鲜度提醒", () => {
  it("有未完成步骤时，改动量累计到阈值未更新计划 → 轮间注入提醒", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-plan-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-planws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");

    const rounds: ChatMessage[][] = [];
    streamMock.mockImplementation(async ({ messages }: { messages: ChatMessage[] }) => {
      rounds.push([...messages]);
      const round = rounds.length;
      if (round === 1) {
        return assistantCalls(
          call("p1", "update_plan", {
            steps: [
              { title: "step one", status: "in_progress" },
              { title: "step two", status: "pending" },
            ],
          }),
        );
      }
      if (round === 2) {
        return assistantCalls(
          call("w1", "write_file", { path: "a.txt", content: "1" }),
          call("w2", "write_file", { path: "b.txt", content: "2" }),
        );
      }
      if (round === 3) {
        return assistantCalls(
          call("w3", "write_file", { path: "c.txt", content: "3" }),
          call("w4", "write_file", { path: "d.txt", content: "4" }),
        );
      }
      return assistantText("done");
    });

    await runtime.prompt("do the work");

    expect(sawPlanReminder(rounds)).toBe(true);
    await runtime.closeSession();
  }, 60_000);

  it("计划全部完成（或没有计划）时不提醒", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-plan-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-planws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");

    const rounds: ChatMessage[][] = [];
    streamMock.mockImplementation(async ({ messages }: { messages: ChatMessage[] }) => {
      rounds.push([...messages]);
      const round = rounds.length;
      if (round === 1) {
        return assistantCalls(
          call("p1", "update_plan", {
            steps: [{ title: "only step", status: "completed" }],
          }),
        );
      }
      if (round === 2) {
        return assistantCalls(
          call("w1", "write_file", { path: "a.txt", content: "1" }),
          call("w2", "write_file", { path: "b.txt", content: "2" }),
        );
      }
      if (round === 3) {
        return assistantCalls(
          call("w3", "write_file", { path: "c.txt", content: "3" }),
          call("w4", "write_file", { path: "d.txt", content: "4" }),
        );
      }
      return assistantText("done");
    });

    await runtime.prompt("do the work");

    expect(sawPlanReminder(rounds)).toBe(false);
    await runtime.closeSession();
  }, 60_000);

  it("还没建清单时，第一次文件变更后就提醒建清单（只提醒一次）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-plan-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-planws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");

    const rounds: ChatMessage[][] = [];
    streamMock.mockImplementation(async ({ messages }: { messages: ChatMessage[] }) => {
      rounds.push([...messages]);
      const round = rounds.length;
      if (round === 1) {
        return assistantCalls(
          call("w1", "write_file", { path: "a.txt", content: "1" }),
          call("w2", "write_file", { path: "b.txt", content: "2" }),
        );
      }
      if (round === 2) {
        return assistantCalls(
          call("w3", "write_file", { path: "c.txt", content: "3" }),
          call("w4", "write_file", { path: "d.txt", content: "4" }),
        );
      }
      if (round === 3) {
        return assistantCalls(
          call("p1", "update_plan", {
            steps: [
              { title: "step one", status: "completed" },
              // 全部 completed：本用例只验证「建清单提醒只发一次」，
              // 留 in_progress 会触发收尾闸多跑一轮，混入无关变量
              { title: "step two", status: "completed" },
            ],
          }),
        );
      }
      return assistantText("done");
    });

    await runtime.prompt("do the work");

    // 第 2 轮请求前就注入建清单提醒（第一次改动即触发，不再等 4 次）；
    // 注入会落进历史，所以后面几轮仍能看到它——要断言的是「只注入了一条」。
    const createNotes = (messages: ChatMessage[]) =>
      messages.filter((message) =>
        String(message.content ?? "").startsWith("[plan] No checklist"),
      ).length;
    expect(createNotes(rounds[1])).toBe(1);
    expect(createNotes(rounds[3])).toBe(1);
    expect(rounds.length).toBe(4);
    await runtime.closeSession();
  }, 60_000);

  it("回合收尾时清单未同步且改过文件 → 拦一次让模型补状态", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-plan-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-planws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");

    const rounds: ChatMessage[][] = [];
    streamMock.mockImplementation(async ({ messages }: { messages: ChatMessage[] }) => {
      rounds.push([...messages]);
      const round = rounds.length;
      if (round === 1) {
        return assistantCalls(
          call("p1", "update_plan", {
            steps: [
              { title: "step one", status: "in_progress" },
              { title: "step two", status: "pending" },
            ],
          }),
        );
      }
      if (round === 2) {
        return assistantCalls(
          call("w1", "write_file", { path: "a.txt", content: "1" }),
          call("w2", "write_file", { path: "b.txt", content: "2" }),
        );
      }
      if (round === 3) {
        return assistantText("done");
      }
      if (round === 4) {
        return assistantCalls(
          call("p2", "update_plan", {
            steps: [
              { title: "step one", status: "completed" },
              { title: "step two", status: "completed" },
            ],
          }),
        );
      }
      return assistantText("done");
    });

    await runtime.prompt("do the work");

    expect(rounds.length).toBe(5);
    expect(rounds[3].some((message) => String(message.content ?? "").startsWith("[plan] The turn is ending"))).toBe(true);
    await runtime.closeSession();
  }, 60_000);

  it("收尾提醒每回合最多拦一次：模型不照做也不再硬拦", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-plan-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-planws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");

    const rounds: ChatMessage[][] = [];
    streamMock.mockImplementation(async ({ messages }: { messages: ChatMessage[] }) => {
      rounds.push([...messages]);
      const round = rounds.length;
      if (round === 1) {
        return assistantCalls(
          call("p1", "update_plan", {
            steps: [{ title: "step one", status: "in_progress" }],
          }),
        );
      }
      if (round === 2) {
        return assistantCalls(call("w1", "write_file", { path: "a.txt", content: "1" }));
      }
      return assistantText("done");
    });

    await runtime.prompt("do the work");

    expect(rounds.length).toBe(4);
    await runtime.closeSession();
  }, 60_000);
});
