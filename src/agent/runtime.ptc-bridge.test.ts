import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeowEvent } from "./types";

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

async function setup(): Promise<{
  runtime: InstanceType<typeof AgentRuntime>;
  workspace: string;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "meowcode-ptc-runtime-"));
  const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ptc-ws-"));
  const runtime = new AgentRuntime({
    providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
    sessionsDir: dir,
    homeDir: dir,
  });
  await runtime.newSession(workspace);
  return { runtime, workspace };
}

/** 模型调用一次 run_code，代码里执行给定的沙箱片段。 */
function callRunCode(code: string, final = "done"): void {
  streamMock
    .mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-run",
            type: "function",
            function: { name: "run_code", arguments: JSON.stringify({ code }) },
          },
        ],
      },
    })
    .mockResolvedValueOnce({ message: { role: "assistant", content: final } });
}

function collect(runtime: InstanceType<typeof AgentRuntime>): MeowEvent[] {
  const events: MeowEvent[] = [];
  runtime.onEvent((event) => events.push(event));
  return events;
}

beforeEach(() => {
  streamMock.mockReset();
});

describe("run_code host bridge through the runtime", () => {
  it("auto 模式下工作区内写入自动放行，文件真的落盘", async () => {
    const { runtime, workspace } = await setup();
    await runtime.setApprovalMode("auto");
    const events = collect(runtime);
    callRunCode(`await meow.write("auto.txt", "written"); return "ok";`);

    await runtime.prompt("write a file");

    expect(await readFile(path.join(workspace, "auto.txt"), "utf8")).toBe("written");
    expect(events.some((event) => event.type === "approval_required")).toBe(false);
  });

  it("read-only 模式下桥调用被拒，代码拿到 ok=false 且不落盘", async () => {
    const { runtime, workspace } = await setup();
    await runtime.setApprovalMode("read-only");
    const events = collect(runtime);
    callRunCode(
      `const r = await meow.write("blocked.txt", "x"); return r.ok ? "wrote" : "denied";`,
    );

    await runtime.prompt("write a file");

    const toolOutput = events.find((event) => event.type === "tool_output");
    expect(toolOutput?.type === "tool_output" ? toolOutput.output : "").toContain("denied");
    await expect(readFile(path.join(workspace, "blocked.txt"), "utf8")).rejects.toThrow();
    expect(events.some((event) => event.type === "approval_required")).toBe(false);
  });

  it("ask 模式下弹出审批；拒绝后不写文件", async () => {
    const { runtime, workspace } = await setup();
    await runtime.setApprovalMode("ask");
    const events = collect(runtime);
    callRunCode(`const r = await meow.write("asked.txt", "x"); return r.ok ? "wrote" : "denied";`);

    const prompt = runtime.prompt("write a file");
    // 等待审批事件出现后再拒绝
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "approval_required")).toBe(true);
    });
    const approval = events.find((event) => event.type === "approval_required");
    if (approval?.type === "approval_required") {
      expect(approval.tool).toBe("write_file");
      runtime.respondToApproval(approval.callId, false);
    }
    await prompt;

    await expect(readFile(path.join(workspace, "asked.txt"), "utf8")).rejects.toThrow();
    const toolOutput = events.find((event) => event.type === "tool_output");
    expect(toolOutput?.type === "tool_output" ? toolOutput.output : "").toContain("denied");
  });

  it("ask 模式下批准后写入成功，并记录审阅 diff", async () => {
    const { runtime, workspace } = await setup();
    await runtime.setApprovalMode("ask");
    const events = collect(runtime);
    callRunCode(`await meow.write("approved.txt", "hello"); return "ok";`);

    const prompt = runtime.prompt("write a file");
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "approval_required")).toBe(true);
    });
    const approval = events.find((event) => event.type === "approval_required");
    if (approval?.type === "approval_required") runtime.respondToApproval(approval.callId, true);
    await prompt;

    expect(await readFile(path.join(workspace, "approved.txt"), "utf8")).toBe("hello");
    expect(events.some((event) => event.type === "file_changed")).toBe(true);
  });

  it("plan 模式下桥里的命令与写操作一律拒绝", async () => {
    const { runtime, workspace } = await setup();
    await runtime.setSessionMode("plan");
    const events = collect(runtime);
    callRunCode(`const r = await meow.run("echo hi"); return r.ok ? "ran" : "blocked";`);

    await runtime.prompt("plan something");

    const toolOutput = events.find((event) => event.type === "tool_output");
    expect(toolOutput?.type === "tool_output" ? toolOutput.output : "").toContain("blocked");
    expect(events.some((event) => event.type === "approval_required")).toBe(false);
    expect(workspace).toBeTruthy();
  });
});
