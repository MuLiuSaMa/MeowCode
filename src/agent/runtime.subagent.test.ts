import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, MeowEvent } from "./types";
import { SessionStore } from "./session-store";
import { PluginRegistry } from "../plugins/registry.js";

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));
vi.mock("./provider.js", () => ({
  completionUrl: vi.fn(),
  streamChatCompletion: streamMock,
}));
vi.mock("./title-generator.js", () => ({
  generateSessionTitle: vi.fn().mockResolvedValue("Test title"),
}));

const { AgentRuntime, MAX_SUBAGENTS_PER_TURN } = await import("./runtime.js");

function makeRuntime(sessionsDir: string): InstanceType<typeof AgentRuntime> {
  return new AgentRuntime({
    providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
    sessionsDir,
  });
}

function isChildRequest(messages: ChatMessage[]): boolean {
  const system = messages.find((message) => message.role === "system")?.content;
  return (
    typeof system === "string" &&
    (system.includes("You are a subagent launched by MeowCode") ||
      system.includes("You are a read-only Explore subagent launched by MeowCode"))
  );
}

function taskCall(id: string, description: string, prompt?: string) {
  return {
    id,
    type: "function",
    function: {
      name: "task",
      arguments: JSON.stringify({ description, ...(prompt ? { prompt } : {}) }),
    },
  };
}

function taskCallWith(
  id: string,
  args: Record<string, unknown>,
) {
  return {
    id,
    type: "function",
    function: { name: "task", arguments: JSON.stringify(args) },
  };
}

function collectEvents(runtime: InstanceType<typeof AgentRuntime>): MeowEvent[] {
  const events: MeowEvent[] = [];
  runtime.onEvent((event) => events.push(event));
  return events;
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 3_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor timed out");
}

beforeEach(() => {
  streamMock.mockReset();
});

describe("AgentRuntime subagents", () => {
  it("runs a task in an isolated child session and returns its report", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-subagents-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-subws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");
    const parentId = runtime.current!.id;
    const events = collectEvents(runtime);

    streamMock.mockImplementation(async ({
      messages,
      onToolCall,
    }: {
      messages: ChatMessage[];
      onToolCall?: (progress: {
        count: number;
        tool?: string;
        names?: string[];
        chars: number;
      }) => void;
    }) => {
      if (isChildRequest(messages)) {
        return {
          message: { role: "assistant", content: "child report" },
          usage: { inputTokens: 10, outputTokens: 2 },
        };
      }
      const hasToolResult = messages.some((message) => message.role === "tool");
      if (!hasToolResult) {
        onToolCall?.({ count: 1, tool: "task", names: ["task"], chars: 120 });
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [taskCall("task-1", "Inspect the repo", "Look at the files and report.")],
          },
          usage: { inputTokens: 100, outputTokens: 5 },
        };
      }
      return {
        message: { role: "assistant", content: "parent final" },
        usage: { inputTokens: 120, outputTokens: 7 },
      };
    });

    await runtime.prompt("delegate");

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_call_progress",
        sessionId: parentId,
        count: 1,
        names: ["task"],
      }),
    );

    const started = events.find(
      (event) => event.type === "subagent_started" && event.agentId,
    ) as Extract<MeowEvent, { type: "subagent_started" }>;
    expect(started).toMatchObject({
      sessionId: parentId,
      parentSessionId: parentId,
      callId: "task-1",
      description: "Inspect the repo",
    });

    const childMessage = events.find(
      (event) => event.type === "message_complete" && event.agentId && event.text === "child report",
    ) as Extract<MeowEvent, { type: "message_complete" }>;
    expect(childMessage.sessionId).toBe(started.agentId);
    expect(childMessage.parentSessionId).toBe(parentId);

    const completed = events.find(
      (event) => event.type === "subagent_completed",
    ) as Extract<MeowEvent, { type: "subagent_completed" }>;
    expect(completed).toMatchObject({
      sessionId: parentId,
      agentId: started.agentId,
      callId: "task-1",
      status: "completed",
      usage: { inputTokens: 10, outputTokens: 2 },
    });

    expect(runtime.current?.subagents).toMatchObject([
      {
        agentId: started.agentId,
        callId: "task-1",
        description: "Inspect the repo",
        status: "completed",
      },
    ]);
    expect(runtime.liveSubagentIds).toEqual([]);
    expect(runtime.current?.usageTotals).toMatchObject({
      inputTokens: 220,
      outputTokens: 12,
    });

    const childFile = path.join(dir, "subagents", parentId, `${started.agentId}.jsonl`);
    const header = JSON.parse((await readFile(childFile, "utf8")).split(/\r?\n/)[0]);
    expect(header).toMatchObject({
      id: started.agentId,
      agentKind: "subagent",
      parentSessionId: parentId,
      parentCallId: "task-1",
      description: "Inspect the repo",
    });
    const childStore = await SessionStore.load(childFile);
    expect(childStore.messages.at(-1)).toEqual({ role: "assistant", content: "child report" });
    await childStore.close();

    const childRequest = streamMock.mock.calls
      .map((call) => call[0] as { messages: ChatMessage[]; tools: Array<{ function: { name: string } }> })
      .find((request) => isChildRequest(request.messages));
    expect(childRequest).toBeTruthy();
    // 标准档允许再嵌套一层（depth 1 < max 2）；深度用尽由执行器拒绝，见 runtime.subagent-modes
    expect(childRequest!.tools.map((tool) => tool.function.name)).toContain("task");

    const parentRequest = streamMock.mock.calls[0][0] as {
      tools: Array<{ function: { name: string } }>;
    };
    expect(parentRequest.tools.map((tool) => tool.function.name)).toContain("task");
    const taskResult = runtime.current?.messages.find(
      (message) => message.role === "tool" && message.name === "task",
    );
    expect(taskResult?.content).toContain("child report");

    await runtime.closeSession();
  });

  it("injects plugins into the child runtime and scopes turn_stop with agentId", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-subagents-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-subws-"));
    const plugins = new PluginRegistry();
    const stops: Array<{ sessionId: string; agentId?: string }> = [];
    plugins.addHook("obs", "turn_stop", (event) => {
      stops.push({
        sessionId: event.sessionId,
        ...(event.agentId ? { agentId: event.agentId } : {}),
      });
    });
    const runtime = new AgentRuntime({
      providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
      sessionsDir: dir,
      plugins,
    });
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");
    const parentId = runtime.current!.id;

    streamMock.mockImplementation(async ({ messages }: { messages: ChatMessage[] }) => {
      if (isChildRequest(messages)) {
        return { message: { role: "assistant", content: "child report" } };
      }
      const hasToolResult = messages.some((message) => message.role === "tool");
      if (!hasToolResult) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [taskCall("task-1", "Inspect", "Look around.")],
          },
        };
      }
      return { message: { role: "assistant", content: "parent final" } };
    });

    await runtime.prompt("delegate");
    expect(stops.some((stop) => stop.agentId && stop.sessionId !== parentId)).toBe(true);
    expect(stops.some((stop) => !stop.agentId && stop.sessionId === parentId)).toBe(true);
    await runtime.closeSession();
  });

  it("builds the child prompt from the parent request when prompt is omitted", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-subagents-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-subws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");
    const events = collectEvents(runtime);
    let parentCalls = 0;
    let childPrompt = "";

    streamMock.mockImplementation(async ({ messages }: { messages: ChatMessage[] }) => {
      if (isChildRequest(messages)) {
        childPrompt = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
        return { message: { role: "assistant", content: "child done" } };
      }
      parentCalls += 1;
      if (parentCalls === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [taskCall("task-auto", "Inspect the repository")],
          },
        };
      }
      return { message: { role: "assistant", content: "parent done" } };
    });

    await runtime.prompt("compare the main projects and summarize differences");

    expect(childPrompt).toContain("compare the main projects and summarize differences");
    expect(childPrompt).toContain("Your assigned task:\nInspect the repository");
    const started = events.find(
      (event) => event.type === "subagent_started",
    ) as Extract<MeowEvent, { type: "subagent_started" }>;
    expect(started.prompt).toContain("Your assigned task:\nInspect the repository");
    await runtime.closeSession();
  });

  it("starts tasks in parallel even when update_plan shares the same message", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-subagents-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-subws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");
    const events = collectEvents(runtime);
    let parentCalls = 0;
    let childStarts = 0;
    const childPrompts: string[] = [];
    let releaseChildren!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChildren = resolve;
    });

    streamMock.mockImplementation(async ({ messages }: { messages: ChatMessage[] }) => {
      if (isChildRequest(messages)) {
        childStarts += 1;
        childPrompts.push(
          [...messages].reverse().find((message) => message.role === "user")?.content ?? "",
        );
        if (childStarts === 2) releaseChildren();
        await childGate;
        return { message: { role: "assistant", content: "child done" } };
      }
      parentCalls += 1;
      if (parentCalls === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "plan-1",
                type: "function",
                function: {
                  name: "update_plan",
                  arguments: JSON.stringify({
                    steps: [
                      { title: "Child A", status: "in_progress" },
                      { title: "Child B", status: "in_progress" },
                    ],
                  }),
                },
              },
              taskCall("task-a", "Task A"),
              taskCall("task-b", "Task B"),
            ],
          },
        };
      }
      return { message: { role: "assistant", content: "parent done" } };
    });

    const promptPromise = runtime.prompt("delegate with a plan");
    try {
      // 旧逻辑会因为 update_plan 不在只读并发集合里而串行执行：只启动第一个 task，
      // 第二个 task 要等第一个结束后才启动，这里会超时。
      await vi.waitFor(() => expect(childStarts).toBe(2), { timeout: 3000 });
    } finally {
      // 失败时也放行已启动的子 Agent，避免测试悬挂
      releaseChildren();
    }
    await promptPromise;

    const started = events.filter((event) => event.type === "subagent_started");
    expect(started).toHaveLength(2);
    expect(runtime.current?.currentPlan?.steps.map((step) => step.title)).toEqual([
      "Child A",
      "Child B",
    ]);
    // 省略 prompt 时，子 Agent 应拿到同一批里刚更新的计划
    expect(childPrompts.some((prompt) => prompt.includes("Current plan:") && prompt.includes("Child A"))).toBe(true);
    expect(childPrompts.some((prompt) => prompt.includes("Current plan:") && prompt.includes("Child B"))).toBe(true);
    await runtime.closeSession();
  });

  it("runs several tasks from one assistant message in parallel", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-subagents-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-subws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");
    const events = collectEvents(runtime);
    let parentCalls = 0;

    streamMock.mockImplementation(async ({ messages }: { messages: ChatMessage[] }) => {
      if (isChildRequest(messages)) {
        const lastUser = [...messages].reverse().find((message) => message.role === "user");
        return { message: { role: "assistant", content: `report:${lastUser?.content ?? ""}` } };
      }
      parentCalls += 1;
      if (parentCalls === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              taskCall("task-a", "Task A", "prompt A"),
              taskCall("task-b", "Task B", "prompt B"),
            ],
          },
        };
      }
      return { message: { role: "assistant", content: "parent done" } };
    });

    await runtime.prompt("delegate both");

    const completed = events.filter(
      (event) => event.type === "subagent_completed",
    ) as Array<Extract<MeowEvent, { type: "subagent_completed" }>>;
    expect(completed).toHaveLength(2);
    expect(completed.map((event) => event.callId).sort()).toEqual(["task-a", "task-b"]);
    expect(completed.every((event) => event.status === "completed")).toBe(true);
    expect(runtime.current?.subagents).toHaveLength(2);
    const toolResults = runtime.current?.messages.filter(
      (message) => message.role === "tool" && message.name === "task",
    );
    expect(toolResults?.map((message) => message.content).join("\n")).toContain("report:prompt A");
    expect(toolResults?.map((message) => message.content).join("\n")).toContain("report:prompt B");

    await runtime.closeSession();
  });

  it("caps subagent dispatches per turn to control token cost", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-subagents-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-subws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");
    const events = collectEvents(runtime);
    let parentCalls = 0;

    streamMock.mockImplementation(async ({ messages }: { messages: ChatMessage[] }) => {
      if (isChildRequest(messages)) {
        return { message: { role: "assistant", content: "child done" } };
      }
      parentCalls += 1;
      if (parentCalls === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: Array.from({ length: MAX_SUBAGENTS_PER_TURN + 1 }, (_, index) =>
              taskCall(`task-${index + 1}`, `Task ${index + 1}`, `Prompt ${index + 1}`),
            ),
          },
        };
      }
      return { message: { role: "assistant", content: "parent done" } };
    });

    await runtime.prompt("delegate too much");

    const started = events.filter((event) => event.type === "subagent_started");
    expect(started).toHaveLength(MAX_SUBAGENTS_PER_TURN);
    expect(runtime.current?.subagents).toHaveLength(MAX_SUBAGENTS_PER_TURN);
    const taskResults = runtime.current?.messages.filter(
      (message) => message.role === "tool" && message.name === "task",
    );
    expect(taskResults).toHaveLength(MAX_SUBAGENTS_PER_TURN + 1);
    expect(
      taskResults?.filter((message) => message.content.includes("Subagent limit reached")),
    ).toHaveLength(1);
    expect(
      taskResults?.filter((message) =>
        message.content.includes(
          `Subagent starts left this turn: 0/${MAX_SUBAGENTS_PER_TURN}.`,
        ),
      ),
    ).toHaveLength(MAX_SUBAGENTS_PER_TURN);
    expect(
      taskResults?.find((message) => message.content.includes("Subagent limit reached"))?.content,
    ).toContain("Do not retry this turn");

    await runtime.closeSession();
  });

  it("counts model-initiated resume against the per-turn budget", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-subagents-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-subws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");
    await runtime.setAgentProfile("minimal");
    const events = collectEvents(runtime);
    let parentCalls = 0;
    let resumeTarget = "";

    streamMock.mockImplementation(async ({ messages }: { messages: ChatMessage[] }) => {
      if (isChildRequest(messages)) {
        return { message: { role: "assistant", content: "child done" } };
      }
      parentCalls += 1;
      if (parentCalls === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [taskCallWith("spawn-1", { description: "first pass" })],
          },
        };
      }
      if (parentCalls === 2) {
        resumeTarget = runtime.current?.subagents[0]?.agentId ?? "";
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              taskCallWith("resume-1", {
                description: "go deeper",
                mode: "resume",
                agent_id: resumeTarget,
                prompt: "go deeper",
              }),
            ],
          },
        };
      }
      return { message: { role: "assistant", content: "parent done" } };
    });

    await runtime.prompt("delegate once, then resume");

    expect(resumeTarget).not.toBe("");
    const results = (runtime.current?.messages ?? [])
      .filter((message) => message.role === "tool" && message.name === "task")
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .join("\n");
    expect(results).toContain("Subagent limit reached");
    expect(events.some((event) => event.type === "subagent_resumed")).toBe(false);
    expect(runtime.current?.subagents).toHaveLength(1);

    await runtime.closeSession();
  });

  it("runs explore agents with a read-only tool set and no AGENTS.md", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-subagents-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-subws-"));
    await writeFile(path.join(workspace, "AGENTS.md"), "SECRET PROJECT RULE");
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");
    let childTools: string[] = [];
    let childSystem = "";
    let parentCalls = 0;

    streamMock.mockImplementation(async ({
      messages,
      tools,
    }: {
      messages: ChatMessage[];
      tools: Array<{ function: { name: string } }>;
    }) => {
      if (isChildRequest(messages)) {
        childTools = tools.map((tool) => tool.function.name).sort();
        childSystem = messages
          .filter((message) => message.role === "system")
          .map((message) => message.content ?? "")
          .join("\n");
        return { message: { role: "assistant", content: "explore report" } };
      }
      parentCalls += 1;
      if (parentCalls === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              taskCallWith("explore-1", {
                description: "Find the relevant files",
                agent_type: "explore",
              }),
            ],
          },
        };
      }
      return { message: { role: "assistant", content: "parent done" } };
    });

    const events = collectEvents(runtime);
    await runtime.prompt("search the repo");

    expect(childTools).toEqual([
      "context_status",
      "diagnostics",
      "git",
      "glob",
      "grep",
      "list_dir",
      "read_file",
      "read_many",
      "run_code",
      "web_fetch",
    ]);
    expect(childSystem).not.toContain("SECRET PROJECT RULE");
    const started = events.find(
      (event) => event.type === "subagent_started",
    ) as Extract<MeowEvent, { type: "subagent_started" }>;
    expect(started.agentType).toBe("explore");
    expect(runtime.current?.subagents[0]?.agentType).toBe("explore");
    await runtime.closeSession();
  });

  it("returns from a background task before the child finishes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-subagents-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-subws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");
    const events = collectEvents(runtime);
    let parentCalls = 0;
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });

    streamMock.mockImplementation(async ({ messages }: { messages: ChatMessage[] }) => {
      if (isChildRequest(messages)) {
        await childGate;
        return { message: { role: "assistant", content: "background report" } };
      }
      parentCalls += 1;
      if (parentCalls === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              taskCallWith("bg-1", { description: "Background research", background: true }),
            ],
          },
        };
      }
      return { message: { role: "assistant", content: "parent done" } };
    });

    await runtime.prompt("delegate in background");
    // 父回合先结束，子 Agent 仍在运行
    expect(runtime.current?.messages.some((message) => message.content === "parent done")).toBe(true);
    expect(runtime.hasLiveSubagents).toBe(true);
    const started = events.find(
      (event) => event.type === "subagent_started",
    ) as Extract<MeowEvent, { type: "subagent_started" }>;
    expect(started.background).toBe(true);

    releaseChild();
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "subagent_completed")).toBe(true);
    }, { timeout: 5_000 });
    const completed = events.find(
      (event) => event.type === "subagent_completed",
    ) as Extract<MeowEvent, { type: "subagent_completed" }>;
    expect(completed.status).toBe("completed");
    expect(completed.report).toContain("background report");
    expect(runtime.hasLiveSubagents).toBe(false);
    expect(
      runtime.current?.entries.some(
        (entry) =>
          entry.type === "context_note" &&
          entry.source === "subagent" &&
          entry.content.includes("background report"),
      ),
    ).toBe(true);
    await runtime.closeSession();
  });

  it("stops a single background subagent without touching the parent turn", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-subagents-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-subws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");
    const events = collectEvents(runtime);
    let parentCalls = 0;

    streamMock.mockImplementation(async ({
      messages,
      signal,
    }: {
      messages: ChatMessage[];
      signal?: AbortSignal;
    }) => {
      if (isChildRequest(messages)) {
        return new Promise((_resolve, reject) => {
          const fail = () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (signal?.aborted) fail();
          else signal?.addEventListener("abort", fail, { once: true });
        });
      }
      parentCalls += 1;
      if (parentCalls === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              taskCallWith("bg-stop", { description: "Long background", background: true }),
            ],
          },
        };
      }
      return { message: { role: "assistant", content: "parent done" } };
    });

    await runtime.prompt("start background");
    const started = events.find(
      (event) => event.type === "subagent_started",
    ) as Extract<MeowEvent, { type: "subagent_started" }>;
    expect(runtime.abortSubagent(started.agentId)).toBe(true);
    await vi.waitFor(() => {
      const completed = events.find(
        (event) => event.type === "subagent_completed",
      ) as Extract<MeowEvent, { type: "subagent_completed" }> | undefined;
      expect(completed?.status).toBe("aborted");
    }, { timeout: 5_000 });
    // 事件先发、live 表在收尾里清理：等清理完成，别在两者之间的窗口里断言
    await vi.waitFor(() => expect(runtime.hasLiveSubagents).toBe(false), { timeout: 5_000 });
    expect(runtime.abortSubagent(started.agentId)).toBe(false);
    await runtime.closeSession();
  });

  it("continues a completed subagent with a follow-up message", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-subagents-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-subws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");
    const events = collectEvents(runtime);
    let parentCalls = 0;
    let childCalls = 0;

    streamMock.mockImplementation(async ({ messages }: { messages: ChatMessage[] }) => {
      if (isChildRequest(messages)) {
        childCalls += 1;
        return {
          message: {
            role: "assistant",
            content: childCalls === 1 ? "first report" : "second report",
          },
        };
      }
      parentCalls += 1;
      if (parentCalls === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [taskCallWith("continue-1", { description: "First pass" })],
          },
        };
      }
      return { message: { role: "assistant", content: "parent done" } };
    });

    await runtime.prompt("first pass");
    const started = events.find(
      (event) => event.type === "subagent_started",
    ) as Extract<MeowEvent, { type: "subagent_started" }>;
    await runtime.continueSubagent(started.agentId, "please go deeper");
    await vi.waitFor(() => {
      expect(
        events.filter((event) => event.type === "subagent_completed"),
      ).toHaveLength(2);
    }, { timeout: 5_000 });
    const resumed = events.find(
      (event) => event.type === "subagent_resumed",
    ) as Extract<MeowEvent, { type: "subagent_resumed" }>;
    expect(resumed.prompt).toBe("please go deeper");

    const childFile = path.join(
      dir,
      "subagents",
      runtime.current!.id,
      `${started.agentId}.jsonl`,
    );
    const childStore = await SessionStore.load(childFile);
    expect(
      childStore.messages.some(
        (message) => message.role === "user" && message.content === "please go deeper",
      ),
    ).toBe(true);
    expect(
      childStore.messages.some(
        (message) => message.role === "assistant" && message.content === "second report",
      ),
    ).toBe(true);
    await childStore.close();
    await runtime.closeSession();
  });

  it("routes a child approval to the parent session and aggregates file changes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-subagents-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-subws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    // 子 Agent 继承父模式；验证"子审批上报"需要每次询问模式
    await runtime.setApprovalMode("ask");
    const parentId = runtime.current!.id;
    const events = collectEvents(runtime);

    streamMock.mockImplementation(async ({ messages }: { messages: ChatMessage[] }) => {
      if (isChildRequest(messages)) {
        if (!messages.some((message) => message.role === "tool")) {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "child-write",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({ path: "delegated.txt", content: "from child" }),
                  },
                },
              ],
            },
          };
        }
        return { message: { role: "assistant", content: "wrote the file" } };
      }
      const hasToolResult = messages.some((message) => message.role === "tool");
      if (!hasToolResult) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [taskCall("task-write", "Write file", "Write delegated.txt.")],
          },
        };
      }
      return { message: { role: "assistant", content: "parent done" } };
    });

    const promptPromise = runtime.prompt("delegate write");
    await vi.waitFor(() => {
      expect(runtime.pendingApprovalList).toHaveLength(1);
    }, { timeout: 5_000 });
    const pending = runtime.pendingApprovalList[0];
    expect(pending).toMatchObject({
      sessionId: parentId,
      parentSessionId: parentId,
      agentDescription: "Write file",
      tool: "write_file",
    });
    expect(pending.agentId).toBeTruthy();
    expect(runtime.respondToApproval(pending.callId, true)).toBe(true);
    await promptPromise;

    expect(await readFile(path.join(workspace, "delegated.txt"), "utf8")).toBe("from child");
    expect(runtime.current?.fileChanges.map((entry) => entry.path)).toContain("delegated.txt");
    const completed = events.find(
      (event) => event.type === "subagent_completed",
    ) as Extract<MeowEvent, { type: "subagent_completed" }>;
    expect(completed.status).toBe("completed");
    await runtime.closeSession();
  });

  it("aborts every child when the parent turn is stopped", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-subagents-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-subws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");
    const events = collectEvents(runtime);
    let parentCalls = 0;

    streamMock.mockImplementation(
      async ({ messages, signal }: { messages: ChatMessage[]; signal?: AbortSignal }) => {
        if (isChildRequest(messages)) {
          return new Promise((_resolve, reject) => {
            const fail = () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            };
            if (signal?.aborted) fail();
            else signal?.addEventListener("abort", fail, { once: true });
          });
        }
        if (signal?.aborted) {
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        }
        parentCalls += 1;
        if (parentCalls === 1) {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [taskCall("task-abort", "Long task", "Keep working.")],
            },
          };
        }
        return { message: { role: "assistant", content: "unexpected" } };
      },
    );

    const promptPromise = runtime.prompt("start long task");
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "subagent_started")).toBe(true);
    }, { timeout: 5_000 });
    runtime.abort();
    await promptPromise;

    const completed = events.find(
      (event) => event.type === "subagent_completed",
    ) as Extract<MeowEvent, { type: "subagent_completed" }>;
    expect(completed.status).toBe("aborted");
    expect(runtime.liveSubagentIds).toEqual([]);
    expect(runtime.lastTurn?.status).toBe("aborted");
    await runtime.closeSession();
  });

  it("spawns implementer/reviewer/verifier roles with registry prompts and tool sets", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-subagents-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-subws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");
    // 按回合依次派发三个角色，记录每个子会话的 system 提示与工具表
    const captures: Array<{ system: string; tools: string[]; type: string }> = [];
    const events = collectEvents(runtime);
    let parentCalls = 0;
    const dispatches: Array<{ id: string; role: string }> = [
      { id: "impl-1", role: "implementer" },
      { id: "rev-1", role: "reviewer" },
      { id: "ver-1", role: "verifier" },
    ];

    streamMock.mockImplementation(async ({
      messages,
      tools,
    }: {
      messages: ChatMessage[];
      tools: Array<{ function: { name: string } }>;
    }) => {
      const system = messages
        .filter((message) => message.role === "system")
        .map((message) => message.content ?? "")
        .join("\n");
      if (system.includes("launched by MeowCode's main agent")) {
        const type = system.includes("Implementer")
          ? "implementer"
          : system.includes("Reviewer")
            ? "reviewer"
            : system.includes("Verifier")
              ? "verifier"
              : "other";
        captures.push({
          system,
          tools: tools.map((tool) => tool.function.name).sort(),
          type,
        });
        return { message: { role: "assistant", content: `${type} report` } };
      }
      parentCalls += 1;
      const dispatch = dispatches[parentCalls - 1];
      if (dispatch) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              taskCallWith(dispatch.id, {
                description: `work as ${dispatch.role}`,
                agent_type: dispatch.role,
              }),
            ],
          },
        };
      }
      return { message: { role: "assistant", content: "parent done" } };
    });

    await runtime.prompt("use roles");

    expect(captures).toHaveLength(3);
    const readOnlyTools = [
      "context_status",
      "diagnostics",
      "git",
      "glob",
      "grep",
      "list_dir",
      "read_file",
      "read_many",
      "run_code",
      "web_fetch",
    ];
    const implementer = captures.find((item) => item.type === "implementer")!;
    expect(implementer.system).toContain("Implementer subagent");
    expect(implementer.tools).toEqual(
      [
        ...readOnlyTools,
        "apply_patch",
        "delete_file",
        "edit_file",
        "move_file",
        "multi_edit",
        "run_command",
        "write_file",
      ].sort(),
    );
    expect(implementer.tools).not.toContain("task");

    const reviewer = captures.find((item) => item.type === "reviewer")!;
    expect(reviewer.system).toContain("Reviewer subagent");
    expect(reviewer.tools).toEqual(readOnlyTools);

    const verifier = captures.find((item) => item.type === "verifier")!;
    expect(verifier.system).toContain("Verifier subagent");
    expect(verifier.tools).toEqual([...readOnlyTools, "run_command"].sort());

    const startedTypes = events
      .filter((event) => event.type === "subagent_started")
      .map((event) => (event as Extract<MeowEvent, { type: "subagent_started" }>).agentType);
    expect([...startedTypes].sort()).toEqual(["implementer", "reviewer", "verifier"]);
    expect([...(runtime.current?.subagents.map((item) => item.agentType) ?? [])].sort()).toEqual([
      "implementer",
      "reviewer",
      "verifier",
    ]);
    await runtime.closeSession();
  });

  it("applies harness role tool/prompt overrides to the child runtime", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-subagents-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-subws-"));
    const harnessDir = path.join(workspace, ".meowcode");
    await mkdir(harnessDir, { recursive: true });
    await writeFile(
      path.join(harnessDir, "harness.json"),
      JSON.stringify({
        version: 1,
        nodes: [
          {
            id: "implementer",
            type: "role",
            data: {
              id: "implementer",
              name: "实现",
              systemPrompt: "CUSTOM IMPLEMENTER PROMPT",
              tools: ["read_file"],
            },
          },
        ],
        edges: [],
      }),
      "utf8",
    );
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");

    let childSystem = "";
    let childTools: string[] = [];
    streamMock.mockImplementation(async ({
      messages,
      tools,
    }: {
      messages: ChatMessage[];
      tools: Array<{ function: { name: string } }>;
    }) => {
      const system = messages
        .filter((message) => message.role === "system")
        .map((message) => message.content ?? "")
        .join("\n");
      if (system.includes("CUSTOM IMPLEMENTER PROMPT")) {
        childSystem = system;
        childTools = tools.map((tool) => tool.function.name).sort();
        return { message: { role: "assistant", content: "override report" } };
      }
      const hasToolResult = messages.some((message) => message.role === "tool");
      if (!hasToolResult) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              taskCallWith("override-task", {
                description: "override role",
                agent_type: "implementer",
              }),
            ],
          },
        };
      }
      return { message: { role: "assistant", content: "parent done" } };
    });

    await runtime.prompt("use override");

    expect(childSystem).toContain("CUSTOM IMPLEMENTER PROMPT");
    expect(childSystem).not.toContain("Implementer subagent");
    expect(childTools).toEqual(["read_file"]);
    await runtime.closeSession();
  });

  it("collects host observations and appends a host-verified ChildResult for implementer", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-subagents-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-subws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");
    const events = collectEvents(runtime);
    let childCalls = 0;

    streamMock.mockImplementation(async ({ messages }: { messages: ChatMessage[] }) => {
      const system = messages
        .filter((message) => message.role === "system")
        .map((message) => message.content ?? "")
        .join("\n");
      if (system.includes("Implementer subagent")) {
        childCalls += 1;
        if (childCalls === 1) {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "w1",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({ path: "out.txt", content: "hello" }),
                  },
                },
              ],
            },
          };
        }
        return {
          message: {
            role: "assistant",
            content:
              'Wrote the file.\n```json\n{"status": "completed", "summary": "wrote out.txt"}\n```',
          },
        };
      }
      const hasToolResult = messages.some((message) => message.role === "tool");
      if (!hasToolResult) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              taskCallWith("task-impl", {
                description: "write out.txt",
                agent_type: "implementer",
                prompt: "Create out.txt with hello.",
              }),
            ],
          },
        };
      }
      return { message: { role: "assistant", content: "parent done" } };
    });

    await runtime.prompt("delegate writing");

    const taskOutput = events.find(
      (event) => event.type === "tool_output" && event.callId === "task-impl",
    ) as Extract<MeowEvent, { type: "tool_output" }>;
    expect(taskOutput).toBeDefined();
    expect(taskOutput.output).toContain("Child result (host-verified):");
    // 宿主观测的文件改动（而非模型自述）进入结果
    expect(taskOutput.output).toContain("out.txt");
    expect(taskOutput.output).toContain('"valid":true');
    expect(taskOutput.output).toContain('"status":"completed"');
    await runtime.closeSession();
  });

  it("steers a running subagent at the next safe step", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-subagents-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-subws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");
    const events = collectEvents(runtime);

    let releaseFirstChild!: () => void;
    const firstChildGate = new Promise<void>((resolve) => {
      releaseFirstChild = resolve;
    });
    let childCalls = 0;

    streamMock.mockImplementation(async ({ messages }: { messages: ChatMessage[] }) => {
      if (isChildRequest(messages)) {
        childCalls += 1;
        if (childCalls === 1) {
          await firstChildGate;
          return { message: { role: "assistant", content: "first child answer" } };
        }
        return { message: { role: "assistant", content: "child report after steer" } };
      }
      const hasToolResult = messages.some((message) => message.role === "tool");
      if (!hasToolResult) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [taskCall("task-steer", "Inspect", "Inspect the repo.")],
          },
        };
      }
      return { message: { role: "assistant", content: "parent final" } };
    });

    const parentPrompt = runtime.prompt("delegate");
    await waitFor(() => (childCalls > 0 ? true : undefined));
    const agentId = runtime.liveSubagentIds[0];
    runtime.steerSubagent(agentId, "Also inspect the tests");
    expect(
      events.some((event) => event.type === "subagent_steer_queued" && event.agentId === agentId),
    ).toBe(true);

    releaseFirstChild();
    await parentPrompt;

    const childRequests = streamMock.mock.calls
      .map((call) => call[0] as { messages: ChatMessage[] })
      .filter((request) => isChildRequest(request.messages));
    expect(childRequests).toHaveLength(2);
    expect(childRequests[1].messages).toContainEqual({
      role: "user",
      content: "Also inspect the tests",
    });
    expect(
      events.some((event) => event.type === "subagent_steer_delivered" && event.agentId === agentId),
    ).toBe(true);

    const childFile = path.join(dir, "subagents", runtime.current!.id, `${agentId}.jsonl`);
    const child = await SessionStore.load(childFile);
    expect(child.messages).toContainEqual({ role: "user", content: "Also inspect the tests" });
    await child.close();
    await runtime.closeSession();
  });

  it("injects a steer after the current tool batch", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-subagents-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-subws-"));
    await writeFile(path.join(workspace, "README.md"), "hello\n");
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");
    const events = collectEvents(runtime);

    let releaseFirstChild!: () => void;
    const firstChildGate = new Promise<void>((resolve) => {
      releaseFirstChild = resolve;
    });
    let childCalls = 0;

    streamMock.mockImplementation(async ({ messages }: { messages: ChatMessage[] }) => {
      if (isChildRequest(messages)) {
        childCalls += 1;
        if (childCalls === 1) {
          await firstChildGate;
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "read-1",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: JSON.stringify({ path: "README.md" }),
                  },
                },
              ],
            },
          };
        }
        return { message: { role: "assistant", content: "child report after tool" } };
      }
      const hasToolResult = messages.some((message) => message.role === "tool");
      if (!hasToolResult) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [taskCall("task-tool-steer", "Inspect", "Inspect the repo.")],
          },
        };
      }
      return { message: { role: "assistant", content: "parent final" } };
    });

    const parentPrompt = runtime.prompt("delegate");
    await waitFor(() => (childCalls > 0 ? true : undefined));
    const agentId = runtime.liveSubagentIds[0];
    runtime.steerSubagent(agentId, "Now summarize the README");
    releaseFirstChild();
    await parentPrompt;

    const childRequests = streamMock.mock.calls
      .map((call) => call[0] as { messages: ChatMessage[] })
      .filter((request) => isChildRequest(request.messages));
    expect(childRequests).toHaveLength(2);
    const second = childRequests[1].messages;
    const toolIndex = second.findIndex((message) => message.role === "tool");
    const steerIndex = second.findIndex(
      (message) => message.role === "user" && message.content === "Now summarize the README",
    );
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(steerIndex).toBeGreaterThan(toolIndex);
    expect(
      events.some(
        (event) => event.type === "subagent_steer_delivered" && event.agentId === agentId,
      ),
    ).toBe(true);
    await runtime.closeSession();
  });

  it("drops a pending steer when the subagent is stopped", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-subagents-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-subws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("full");
    const events = collectEvents(runtime);

    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let childCalls = 0;

    streamMock.mockImplementation(
      async ({ messages, signal }: { messages: ChatMessage[]; signal?: AbortSignal }) => {
        if (isChildRequest(messages)) {
          childCalls += 1;
          await childGate;
          if (signal?.aborted) throw new Error("Aborted");
          return { message: { role: "assistant", content: "child done" } };
        }
        const hasToolResult = messages.some((message) => message.role === "tool");
        if (!hasToolResult) {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [taskCall("task-drop", "Inspect", "Inspect the repo.")],
            },
          };
        }
        return { message: { role: "assistant", content: "parent final" } };
      },
    );

    const parentPrompt = runtime.prompt("delegate");
    await waitFor(() => (childCalls > 0 ? true : undefined));
    const agentId = runtime.liveSubagentIds[0];
    runtime.steerSubagent(agentId, "Too late");
    expect(runtime.abortSubagent(agentId)).toBe(true);
    releaseChild();
    await parentPrompt;

    expect(
      events.some(
        (event) =>
          event.type === "subagent_steer_dropped" &&
          event.agentId === agentId &&
          event.reason === "aborted",
      ),
    ).toBe(true);
    const childFile = path.join(dir, "subagents", runtime.current!.id, `${agentId}.jsonl`);
    const child = await SessionStore.load(childFile);
    expect(child.messages).not.toContainEqual({ role: "user", content: "Too late" });
    await child.close();
    await runtime.closeSession();
  });
});
