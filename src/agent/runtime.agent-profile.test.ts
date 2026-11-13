import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, MeowEvent, ToolDefinition } from "./types";

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));
vi.mock("./provider.js", () => ({
  completionUrl: vi.fn(),
  streamChatCompletion: streamMock,
}));
vi.mock("./title-generator.js", () => ({
  generateSessionTitle: vi.fn().mockResolvedValue("Test title"),
}));

const { AgentRuntime } = await import("./runtime.js");

type Captured = {
  system: string;
  tools: string[];
  taskDescription: string;
  messages: ChatMessage[];
};

function taskDescription(tools: ToolDefinition[]): string {
  return tools.find((tool) => tool.function.name === "task")?.function.description ?? "";
}

function makeRuntime(sessionsDir: string): InstanceType<typeof AgentRuntime> {
  return new AgentRuntime({
    providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
    sessionsDir,
  });
}

function captureCalls(): Captured[] {
  const captured: Captured[] = [];
  streamMock.mockImplementation(
    async (options: { messages: ChatMessage[]; tools: ToolDefinition[] }) => {
      const system = options.messages.find((message) => message.role === "system");
      captured.push({
        system: typeof system?.content === "string" ? system.content : "",
        tools: options.tools.map((tool) => tool.function.name),
        taskDescription: taskDescription(options.tools),
        messages: options.messages,
      });
      return {
        message: { role: "assistant", content: "ok" },
        usage: { inputTokens: 10, outputTokens: 2 },
      };
    },
  );
  return captured;
}

function taskCall(id: string, args: Record<string, unknown>) {
  return {
    id,
    type: "function",
    function: { name: "task", arguments: JSON.stringify(args) },
  };
}

function toolResults(messages: ChatMessage[]): string[] {
  return messages
    .filter((message) => message.role === "tool")
    .map((message) => (typeof message.content === "string" ? message.content : ""));
}

function agentTypeEnum(tools: ToolDefinition[]): string[] {
  const task = tools.find((tool) => tool.function.name === "task");
  const agentType = task?.function.parameters.properties.agent_type as
    | { enum?: string[] }
    | undefined;
  return agentType?.enum ?? [];
}

beforeEach(() => {
  streamMock.mockReset();
});

describe("AgentRuntime agent profiles", () => {
  it("minimal narrows the tool set to read_file / run_command plus the orchestration channel", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-profile-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(await mkdtemp(path.join(tmpdir(), "meowcode-ws-")));
    await runtime.setAgentProfile("minimal");

    const captured = captureCalls();
    await runtime.prompt("hello");

    expect(captured).toHaveLength(1);
    expect(captured[0].tools.sort()).toEqual(["admit", "read_file", "run_command", "task"]);
    expect(captured[0].system).toContain("minimal mode");
    expect(captured[0].taskDescription).toContain("At most 1 foreground subagent may run at once");
  });

  it("standard keeps the full tool set and every subagent role", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-profile-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(await mkdtemp(path.join(tmpdir(), "meowcode-ws-")));

    const captured = captureCalls();
    await runtime.prompt("hello");

    expect(captured[0].tools).toContain("write_file");
    expect(captured[0].tools).toContain("multi_edit");
    expect(captured[0].system).toContain("You are MeowCode, a local coding agent");
    expect(captured[0].taskDescription).toContain("At most 3 foreground subagents may run at once");
  });

  it("complex keeps every tool and adds the orchestration prompt", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-profile-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(await mkdtemp(path.join(tmpdir(), "meowcode-ws-")));
    await runtime.setAgentProfile("complex");

    const captured = captureCalls();
    await runtime.prompt("hello");

    expect(captured[0].tools).toContain("write_file");
    expect(captured[0].system).toContain("Complex mode is active");
    expect(captured[0].taskDescription).toContain("At most 5 foreground subagents may run at once");
  });

  it("minimal narrows task.agent_type to general / explore", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-profile-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(await mkdtemp(path.join(tmpdir(), "meowcode-ws-")));
    await runtime.setAgentProfile("minimal");

    let tools: ToolDefinition[] = [];
    streamMock.mockImplementation(
      async (options: { messages: ChatMessage[]; tools: ToolDefinition[] }) => {
        tools = options.tools;
        return {
          message: { role: "assistant", content: "ok" },
          usage: { inputTokens: 10, outputTokens: 2 },
        };
      },
    );
    await runtime.prompt("hello");

    expect(agentTypeEnum(tools)).toEqual(["general", "explore"]);
  });

  it("rejects roles the profile does not include", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-profile-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(await mkdtemp(path.join(tmpdir(), "meowcode-ws-")));
    await runtime.setAgentProfile("minimal");
    await runtime.setApprovalMode("full");

    const captured: Captured[] = [];
    streamMock.mockImplementation(
      async (options: { messages: ChatMessage[]; tools: ToolDefinition[] }) => {
        const system = options.messages.find((message) => message.role === "system");
        captured.push({
          system: typeof system?.content === "string" ? system.content : "",
          tools: options.tools.map((tool) => tool.function.name),
          taskDescription: taskDescription(options.tools),
          messages: options.messages,
        });
        if (!options.messages.some((message) => message.role === "tool")) {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [taskCall("task-1", { description: "ship it", agent_type: "implementer" })],
            },
            usage: { inputTokens: 10, outputTokens: 2 },
          };
        }
        return {
          message: { role: "assistant", content: "done" },
          usage: { inputTokens: 12, outputTokens: 2 },
        };
      },
    );
    await runtime.prompt("delegate");

    // 只有父回合的两次请求：被拒的角色不会拉起子 runtime
    expect(captured).toHaveLength(2);
    const results = toolResults(captured[1].messages);
    expect(results.join("\n")).toContain("cannot dispatch agent_type");
    expect(runtime.liveSubagentIds).toEqual([]);
  });

  it("intersects the profile tool set into subagent runtimes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-profile-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(await mkdtemp(path.join(tmpdir(), "meowcode-ws-")));
    await runtime.setAgentProfile("minimal");
    await runtime.setApprovalMode("full");

    const childTools: string[][] = [];
    streamMock.mockImplementation(
      async (options: { messages: ChatMessage[]; tools: ToolDefinition[] }) => {
        const system = options.messages.find((message) => message.role === "system");
        const prompt = typeof system?.content === "string" ? system.content : "";
        if (prompt.includes("You are a subagent launched by MeowCode")) {
          childTools.push(options.tools.map((tool) => tool.function.name));
          return {
            message: { role: "assistant", content: "child report" },
            usage: { inputTokens: 5, outputTokens: 2 },
          };
        }
        if (!options.messages.some((message) => message.role === "tool")) {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [taskCall("task-1", { description: "look around", agent_type: "general" })],
            },
            usage: { inputTokens: 10, outputTokens: 2 },
          };
        }
        return {
          message: { role: "assistant", content: "done" },
          usage: { inputTokens: 12, outputTokens: 2 },
        };
      },
    );
    await runtime.prompt("delegate");

    expect(childTools).toHaveLength(1);
    expect(childTools[0].sort()).toEqual(["read_file", "run_command"]);
  });

  it("mentions the profile concurrency cap in the task description", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-profile-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(await mkdtemp(path.join(tmpdir(), "meowcode-ws-")));
    await runtime.setAgentProfile("minimal");
    await runtime.setApprovalMode("full");

    const captured: Captured[] = [];
    streamMock.mockImplementation(
      async (options: { messages: ChatMessage[]; tools: ToolDefinition[] }) => {
        const system = options.messages.find((message) => message.role === "system");
        const prompt = typeof system?.content === "string" ? system.content : "";
        if (prompt.includes("You are a subagent launched by MeowCode")) {
          return {
            message: { role: "assistant", content: "child report" },
            usage: { inputTokens: 5, outputTokens: 2 },
          };
        }
        captured.push({
          system: prompt,
          tools: options.tools.map((tool) => tool.function.name),
          taskDescription: taskDescription(options.tools),
          messages: options.messages,
        });
        if (!options.messages.some((message) => message.role === "tool")) {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                taskCall("task-1", { description: "first", agent_type: "general" }),
                taskCall("task-2", { description: "second", agent_type: "general" }),
              ],
            },
            usage: { inputTokens: 10, outputTokens: 2 },
          };
        }
        return {
          message: { role: "assistant", content: "done" },
          usage: { inputTokens: 12, outputTokens: 2 },
        };
      },
    );
    await runtime.prompt("delegate");

    expect(captured[captured.length - 1].taskDescription).toContain(
      "At most 1 foreground subagent may run at once",
    );
    expect(captured[captured.length - 1].taskDescription).toContain(
      "finished slots can be reused in the same turn",
    );
  });

  it("persists the profile in the session and restores it on switch", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-profile-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(await mkdtemp(path.join(tmpdir(), "meowcode-ws-")));
    const events: MeowEvent[] = [];
    runtime.onEvent((event) => events.push(event));

    await runtime.setAgentProfile("complex");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "agent_profile", profile: "complex" }),
    );

    const filePath = runtime.current!.filePath;
    const reopened = makeRuntime(dir);
    await reopened.switchSession(filePath);
    expect(reopened.currentAgentProfile).toBe("complex");

    const fresh = makeRuntime(dir);
    await fresh.newSession(await mkdtemp(path.join(tmpdir(), "meowcode-ws-")));
    expect(fresh.currentAgentProfile).toBe("standard");
  });
});
