import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ToolDefinition } from "./types";

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));
vi.mock("./provider.js", () => ({
  completionUrl: vi.fn(),
  streamChatCompletion: streamMock,
}));
vi.mock("./title-generator.js", () => ({
  generateSessionTitle: vi.fn().mockResolvedValue("Test title"),
}));

const { AgentRuntime } = await import("./runtime.js");
const { registerDynamicTool, unregisterDynamicTool } = await import("./tools.js");

const WRITE_TOOLS = ["write_file", "edit_file", "multi_edit", "apply_patch", "delete_file", "move_file"];

type Captured = { system: string; tools: string[] };

function makeRuntime(sessionsDir: string): InstanceType<typeof AgentRuntime> {
  return new AgentRuntime({
    providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
    sessionsDir,
  });
}

/** 记录每次模型请求看到的是哪些工具；主链与子 Agent 共用同一个 mock。 */
function captureCalls(): Captured[] {
      const captured: Captured[] = [];
      streamMock.mockImplementation(
        async (options: { messages: ChatMessage[]; tools: ToolDefinition[] }) => {
          // 指令块是第二条 system（第一条是主提示词），判定要合起来看
          const system = options.messages
            .filter((message) => message.role === "system")
            .map((message) => (typeof message.content === "string" ? message.content : ""))
            .join("\n");
          captured.push({
            system,
            tools: options.tools.map((tool) => tool.function.name),
          });
          return {
            message: { role: "assistant", content: "ok" },
            usage: { inputTokens: 10, outputTokens: 2 },
          };
        },
      );
      return captured;
}

const workspace = () => mkdtemp(path.join(tmpdir(), "meowcode-stability-ws-"));
const sessions = () => mkdtemp(path.join(tmpdir(), "meowcode-stability-s-"));

beforeEach(() => {
  streamMock.mockReset();
});

describe("工具目录在回合边界重建", () => {
  it("下线的动态工具下一回合不再出现在请求里", async () => {
    const name = "mcp__stability__gone_tool";
    registerDynamicTool(name, {
      definition: {
        type: "function",
        function: {
          name,
          description: "temporary",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: async () => ({ output: "ok", ok: true }),
    });

    try {
      const runtime = makeRuntime(await sessions());
      await runtime.newSession(await workspace());
      const captured = captureCalls();

      await runtime.prompt("first");
      expect(captured[0]?.tools).toContain(name);

      // 插件/市场停用：目录这时只把它标成 removed，字节仍留着保缓存
      unregisterDynamicTool(name);
      await runtime.prompt("second");
      // 回合边界重建：模型不该再看到一个已经不存在的工具
      expect(captured[1]?.tools).not.toContain(name);
    } finally {
      unregisterDynamicTool(name);
    }
  });
});

describe("验证类角色不能写文件", () => {
  it("架构图给 verifier 节点配了 write_file 也开不了写权限", async () => {
    const ws = await workspace();
    // 用户可以在 .meowcode/harness.json 里给角色节点覆盖工具白名单 ——
    // writeDenied 必须是角色不变量，不能靠"注册表恰好没写"来兜底。
    const { builtinHarnessSeed } = await import("./harness-document.js");
    const doc = builtinHarnessSeed("complex");
    for (const node of doc.nodes) {
      if (node.type !== "role") continue;
      const data = node.data as Record<string, unknown> | undefined;
      const role = typeof data?.role === "string" ? data.role : node.id;
      if (role === "verifier" || role === "fresh-verifier") {
        // tool_search 是 verifier 注册表里没有、但恒定注册的工具：它出现 = 覆盖生效了。
        // write_file / edit_file 同时出现 = 用来验证 writeDenied 把它们剔掉了。
        data!.tools = ["read_file", "run_command", "tool_search", "write_file", "edit_file"];
      }
    }
    await mkdir(path.join(ws, ".meowcode", "harness"), { recursive: true });
    await writeFile(
      path.join(ws, ".meowcode", "harness", "complex.json"),
      JSON.stringify(doc, null, 2),
      "utf8",
    );

    const runtime = makeRuntime(await sessions());
    await runtime.newSession(ws);
    await runtime.setAgentProfile("complex");
    const captured = captureCalls();

    streamMock.mockImplementationOnce(async () => ({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "task",
              arguments: JSON.stringify({ description: "run the checks", agent_type: "verifier" }),
            },
          },
        ],
      },
      usage: { inputTokens: 10, outputTokens: 2 },
    }));

    await runtime.prompt("verify this");
    const child = captured.find((entry) => entry.system.includes("Verifier subagent"));
    expect(child, "verifier 子 Agent 应该发起过请求").toBeDefined();
    // 先证明架构图覆盖生效：tool_search 不在 VERIFIER_TOOLS 里
    expect(child?.tools).toContain("tool_search");
    // 再证明 writeDenied 把同一次覆盖里的写类工具剔掉了
    for (const tool of WRITE_TOOLS) {
      expect(child?.tools, tool).not.toContain(tool);
    }
  });

  it("verifier 子 Agent 的工具表里没有写类工具", async () => {
    const runtime = makeRuntime(await sessions());
    await runtime.newSession(await workspace());
    const captured = captureCalls();

    // 第一次请求抛一个 task 调用，宿主会按角色实例化子 runtime
    streamMock.mockImplementationOnce(async () => ({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "task",
              arguments: JSON.stringify({
                description: "run the checks",
                agent_type: "verifier",
              }),
            },
          },
        ],
      },
      usage: { inputTokens: 10, outputTokens: 2 },
    }));

    await runtime.prompt("verify this");
    // 子 Agent 的请求带自己的 system（不是主提示词）
    const child = captured.find((entry) => entry.system.includes("Verifier subagent"));
    expect(child, "verifier 子 Agent 应该发起过请求").toBeDefined();
    for (const tool of WRITE_TOOLS) {
      expect(child?.tools, tool).not.toContain(tool);
    }
    // 但验证必须能跑命令
    expect(child?.tools).toContain("run_command");
  });

  it("verifier 用 run_code 的 meow.write 桥写文件被拒（工具表拦不住这条后门）", async () => {
    const runtime = makeRuntime(await sessions());
    await runtime.newSession(await workspace());
    const events: Array<{ type: string; callId?: string; output?: string }> = [];
    runtime.onEvent((event) => events.push(event as never));

    let childCalls = 0;
    streamMock.mockImplementation(async (options: { messages: ChatMessage[] }) => {
      const system = options.messages
        .filter((message) => message.role === "system")
        .map((message) => (typeof message.content === "string" ? message.content : ""))
        .join("\n");
      if (system.includes("Verifier subagent")) {
        childCalls += 1;
        if (childCalls === 1) {
          // run_code 在 verifier 的白名单里（批量只读搜索要用它），
          // 但它的宿主写桥必须被 writeDenied 拦住。
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "child-rc",
                  type: "function",
                  function: {
                    name: "run_code",
                    arguments: JSON.stringify({
                      code: 'const r = await meow.write("evil.ts", "tampered"); return JSON.stringify(r);',
                    }),
                  },
                },
              ],
            },
            usage: { inputTokens: 10, outputTokens: 2 },
          };
        }
        return {
          message: {
            role: "assistant",
            content:
              'Blocked, reporting.\n```json\n{"status": "failed", "summary": "write bridge denied", "checked": ["run_code"]}\n```',
          },
          usage: { inputTokens: 10, outputTokens: 2 },
        };
      }
      if (system.includes("You are MeowCode")) {
        // 主 Agent：先派 verifier，拿到报告后收尾
        const sawChild = options.messages.some(
          (message) => message.role === "tool" && String(message.content).includes("Child result"),
        );
        if (!sawChild) {
          return {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "task",
                    arguments: JSON.stringify({
                      description: "run the checks",
                      agent_type: "verifier",
                    }),
                  },
                },
              ],
            },
            usage: { inputTokens: 10, outputTokens: 2 },
          };
        }
      }
      return { message: { role: "assistant", content: "done" }, usage: { inputTokens: 10, outputTokens: 2 } };
    });

    await runtime.prompt("verify this");

    const toolOutput = events
      .filter((event) => event.type === "tool_output")
      .map((event) => event.output ?? "")
      .join("\n");
    expect(toolOutput).toContain("must not modify files");
  });
});

describe("AGENTS.md 会话内改了就生效", () => {
  it("规则文本变化后下一回合注入新内容", async () => {
    const ws = await workspace();
    const file = path.join(ws, "AGENTS.md");
    await writeFile(file, "# Rules\n\nRULE-ALPHA\n", "utf8");

    const runtime = makeRuntime(await sessions());
    await runtime.newSession(ws);
    const captured = captureCalls();

    await runtime.prompt("first");
    expect(captured[0]?.system).toContain("RULE-ALPHA");

    // 会话内改规则：mtime 精度可能只有几十毫秒，等一下再写
    await new Promise((resolve) => setTimeout(resolve, 30));
    await writeFile(file, "# Rules\n\nRULE-BETA\n", "utf8");

    await runtime.prompt("second");
    expect(captured[1]?.system).toContain("RULE-BETA");
    expect(captured[1]?.system).not.toContain("RULE-ALPHA");
  });
});
