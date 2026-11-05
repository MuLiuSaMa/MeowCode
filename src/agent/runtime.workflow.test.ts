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

function systemText(messages: ChatMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => message.content ?? "")
    .join("\n");
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

function collectEvents(runtime: InstanceType<typeof AgentRuntime>): MeowEvent[] {
  const events: MeowEvent[] = [];
  runtime.onEvent((event) => events.push(event));
  return events;
}

function toolOutput(events: MeowEvent[], callId: string): string {
  const found = events.find(
    (event) => event.type === "tool_output" && event.callId === callId,
  ) as Extract<MeowEvent, { type: "tool_output" }> | undefined;
  return found?.output ?? "";
}

beforeEach(() => {
  streamMock.mockReset();
});

describe("治理层集成（goal 模式，T1 全流程）", () => {
  it("admit 前写被拦 → admit → 根侧 G4 → reviewer G5 → verifier G6 → 完成", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-gov-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-govws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");
    await runtime.setSessionMode("goal");
    const events = collectEvents(runtime);
    const streams: ChatMessage[][] = [];

    streamMock.mockImplementation(async ({ messages }: { messages: ChatMessage[] }) => {
      streams.push(messages);
      const system = systemText(messages);
      if (system.includes("Reviewer subagent")) {
        return {
          message: {
            role: "assistant",
            content:
              'Checked the diff.\n```json\n{"status": "completed", "summary": "reviewed, no critical issues", "findings": []}\n```',
          },
        };
      }
      if (system.includes("Verifier subagent")) {
        const ran = messages.some((message) => message.role === "tool");
        if (!ran) {
          return assistantCalls(call("v-run", "run_command", { command: "exit 0" }));
        }
        return {
          message: {
            role: "assistant",
            content:
              'All commands passed.\n```json\n{"status": "completed", "summary": "verification passed"}\n```',
          },
        };
      }
      // 父会话按最近的工具结果决定下一步
      const lastTool = [...messages].reverse().find((message) => message.role === "tool");
      const content = typeof lastTool?.content === "string" ? lastTool.content : "";
      if (!content) {
        return assistantCalls(call("w-before", "write_file", { path: "early.txt", content: "x" }));
      }
      if (content.includes("governance gate")) {
        return assistantCalls(call("adm-1", "admit", { tier: "T1", task_shape: "add feature X" }));
      }
      if (content.includes("Governed run admitted")) {
        return assistantCalls(call("w-1", "write_file", { path: "out.txt", content: "hello" }));
      }
      if (content.includes("out.txt") || content.includes("G4 passed")) {
        return assistantCalls(
          call("rev-1", "task", {
            description: "review the change",
            agent_type: "reviewer",
            lane_id: "main",
            prompt: "Review the recent change to out.txt.",
          }),
        );
      }
      if (content.includes("G5 passed")) {
        return assistantCalls(
          call("ver-1", "task", {
            description: "verify the change",
            agent_type: "verifier",
            lane_id: "main",
            prompt: "Run verification: exit 0.",
          }),
        );
      }
      return assistantText("Feature X is done and verified.");
    });

    await runtime.prompt("add feature X");

    // 1) admit 之前写工具被门禁拦截
    expect(toolOutput(events, "w-before")).toContain("admit first");
    // 2) admit 成功
    expect(toolOutput(events, "adm-1")).toContain("Governed run admitted (T1");
    // 3) admit 后写放行且根侧观测自动过 G4
    expect(toolOutput(events, "w-1")).not.toContain("governance gate");
    // 4) reviewer 关 G5（宿主校验后的 gate 消息回灌）
    expect(toolOutput(events, "rev-1")).toContain("[workflow] Gate G5 passed");
    // 5) verifier 真实跑了命令并关 G6
    expect(toolOutput(events, "ver-1")).toContain("[workflow] Gate G6 passed");
    // 6) 治理 run 完成：不再有续命注入
    const complete = events.find((event) => event.type === "message_complete" && !event.agentId) as
      | Extract<MeowEvent, { type: "message_complete" }>
      | undefined;
    expect(complete?.text).toContain("done and verified");
    expect(
      streams.some((messages) =>
        messages.some(
          (message) =>
            message.role === "user" && message.content.includes("governed run is still active"),
        ),
      ),
    ).toBe(false);
    // 7) 事件协议：admitted / gate / roadmap / child_result 全链路可见
    const admitted = events.find((event) => event.type === "workflow_admitted") as
      | Extract<MeowEvent, { type: "workflow_admitted" }>
      | undefined;
    expect(admitted?.tier).toBe("T1");
    expect(admitted?.lanes[0]?.id).toBe("main");
    const gateEvents = events.filter((event) => event.type === "workflow_gate");
    expect(gateEvents.map((event) => (event as { gate: string }).gate)).toEqual(["G4", "G5", "G6"]);
    const roadmaps = events.filter((event) => event.type === "workflow_roadmap");
    const lastRoadmap = roadmaps.at(-1) as
      | Extract<MeowEvent, { type: "workflow_roadmap" }>
      | undefined;
    expect(lastRoadmap?.completed).toBe(true);
    expect(lastRoadmap?.lanes[0]?.gates.G6).toBe("passed");
    const childResults = events.filter((event) => event.type === "child_result");
    expect(childResults.map((event) => (event as { role: string }).role).sort()).toEqual([
      "reviewer",
      "verifier",
    ]);
    expect(
      childResults.every((event) => (event as { result: { valid: boolean } }).result.valid),
    ).toBe(true);
    await runtime.closeSession();
  }, 60_000);

  it("模型谎报完成触发宿主续命：注入 frontier 后继续，最多 2 次", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-gov-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-govws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");
    await runtime.setSessionMode("goal");
    const _events = collectEvents(runtime);
    const streams: ChatMessage[][] = [];

    streamMock.mockImplementation(async ({ messages }: { messages: ChatMessage[] }) => {
      streams.push(messages);
      const lastTool = [...messages].reverse().find(
        (message) => message.role === "tool" || (message.role === "user" && message.content.includes("[workflow]")),
      );
      const content =
        typeof lastTool?.content === "string"
          ? lastTool.content
          : lastTool?.role === "user"
            ? lastTool.content
            : "";
      if (!content) {
        return assistantCalls(call("adm-1", "admit", { tier: "T1", task_shape: "task Y" }));
      }
      if (content.includes("Governed run admitted")) {
        return assistantText("All done, task Y complete!"); // 谎报：run 仍活跃
      }
      if (content.includes("governed run is still active")) {
        return assistantText("Really done now."); // 第二次谎报
      }
      return assistantText("Final answer.");
    });

    await runtime.prompt("do task Y");

    // 续命注入发生且被模型看到（context_note 持久化 + 下一 runTurn 携带）
    const injections = streams.filter((messages) =>
      messages.some(
        (message) => message.role === "user" && message.content.includes("governed run is still active"),
      ),
    );
    expect(injections.length).toBeGreaterThanOrEqual(2);
    expect(injections.length).toBeLessThanOrEqual(3); // 主回合 + 2 次续命封顶
    // 会话文件里留下 workflow 上下文痕迹
    const session = runtime.current;
    expect(session?.effectiveMessages.some((message) => typeof message.content === "string" && message.content.includes("[workflow] The governed run is still active"))).toBe(true);
    await runtime.closeSession();
  }, 60_000);

  it("default 模式不触发治理：不 admit 也能直接写", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-gov-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-govws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");
    const events = collectEvents(runtime);

    streamMock.mockImplementation(async ({ messages }: { messages: ChatMessage[] }) => {
      const hasTool = messages.some((message) => message.role === "tool");
      if (!hasTool) {
        return assistantCalls(call("w-free", "write_file", { path: "free.txt", content: "x" }));
      }
      return assistantText("written");
    });

    await runtime.prompt("just write the file");

    expect(toolOutput(events, "w-free")).not.toContain("governance gate");
    const complete = events.find((event) => event.type === "message_complete" && !event.agentId) as
      | Extract<MeowEvent, { type: "message_complete" }>
      | undefined;
    expect(complete?.text).toBe("written");
    await runtime.closeSession();
  });
});
