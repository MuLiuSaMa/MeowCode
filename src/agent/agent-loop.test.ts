import { describe, expect, it } from "vitest";
import {
  MAX_TURN_STOP_BLOCKS,
  READ_ONLY_PARALLEL_TOOLS,
  runAgentLoop,
  type AgentLoopHost,
  type AgentLoopHooks,
} from "./agent-loop.js";
import { ProviderRequestError } from "./provider-error.js";
import type { ChatMessage, ProviderConfig, ToolCall } from "./types.js";

function toolCall(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function assistant(text: string, calls: ToolCall[] = []): ChatMessage {
  return {
    role: "assistant",
    content: text,
    ...(calls.length ? { tool_calls: calls } : {}),
  } as ChatMessage;
}

type ScriptItem =
  | {
      message: ChatMessage;
      responseId?: string;
      finishReason?: string;
      usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };
    }
  | Error;

/** 可断言的循环观测记录：宿主各回调的调用轨迹。 */
type LoopTrace = {
  streams: ChatMessage[][];
  executedTools: string[];
  executedReadOnly: string[];
  executedTasks: string[];
  pushedToolMessages: Array<{ callId: string; content: string }>;
  pushedUserMessages: string[];
  completed: string[];
  errors: string[];
  metrics: number;
  escalateCalls: number[];
};

/**
 * 逐条回放的假宿主：script 是每轮流式请求的既定结果（Error 表示该轮抛错）。
 * 返回宿主与其观测记录，便于断言循环行为。
 */
function createMockHost(options?: {
  script?: ScriptItem[];
  hooks?: AgentLoopHooks;
  isParallelSafe?: (toolName: string) => boolean;
  turnBudget?: () => { maxRounds?: number; maxTokens?: number | null };
}): AgentLoopHost & { trace: LoopTrace } {
  const script = [...(options?.script ?? [])];
  const trace: LoopTrace = {
    streams: [],
    executedTools: [],
    executedReadOnly: [],
    executedTasks: [],
    pushedToolMessages: [],
    pushedUserMessages: [],
    completed: [],
    errors: [],
    metrics: 0,
    escalateCalls: [],
  };
  const provider = { id: "test", model: "m", baseUrl: "http://127.0.0.1" } as ProviderConfig;

  const host: AgentLoopHost & { trace: LoopTrace } = {
    trace,
    initialMessages: () => [{ role: "user", content: "hi" }],
    provider: () => provider,
    tools: () => [],
    usageAnchor: () => null,
    aborted: () => false,
    abortSignal: () => undefined,
    incremental: () => ({ enabled: false, signature: "" }),
    resolveRequestProvider: ({ maxTokens }) => ({ ...provider, maxTokens }),
    commitResponseChain: () => {},
    onRoundStart: () => {},
    onDelta: () => {},
    onThinking: () => {},
    onToolCallProgress: () => {},
    onToolCallComplete: () => {},
    stream: (streamOptions) => {
      trace.streams.push(streamOptions.messages);
      const next = script.shift();
      if (!next) throw new Error("mock script exhausted");
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve({
        message: next.message,
        ...(next.responseId ? { responseId: next.responseId } : {}),
        ...(next.finishReason ? { finishReason: next.finishReason } : {}),
        ...(next.usage ? { usage: next.usage } : {}),
      });
    },
    ...(options?.turnBudget ? { turnBudget: options.turnBudget } : {}),
    persistAssistantMessage: async () => {},
    recordUsage: async () => {},
    onMessageComplete: (result) => trace.completed.push(result.message.content ?? ""),
    onError: (message) => trace.errors.push(message),
    persistMetrics: async () => {
      trace.metrics += 1;
    },
    escalateOnOverflow: async (messages, stage) => {
      trace.escalateCalls.push(stage);
      return {
        messages: [...messages, { role: "user", content: "[compacted]" } as ChatMessage],
        stage: 3,
      };
    },
    executeToolCall: async (call, messages) => {
      trace.executedTools.push(call.function.name);
      const message = {
        role: "tool" as const,
        content: `ok:${call.function.name}`,
        tool_call_id: call.id,
        name: call.function.name,
      };
      messages.push(message);
      return message;
    },
    executeTaskToolCall: async (call) => {
      trace.executedTasks.push(call.function.name);
      return {
        role: "tool" as const,
        content: "task done",
        tool_call_id: call.id,
        name: call.function.name,
      };
    },
    executeReadOnlyToolCall: async (call) => {
      trace.executedReadOnly.push(call.function.name);
      return {
        role: "tool" as const,
        content: `ro:${call.function.name}`,
        tool_call_id: call.id,
        name: call.function.name,
      };
    },
    pushToolMessage: async (messages, message) => {
      messages.push(message);
      trace.pushedToolMessages.push({ callId: message.tool_call_id, content: message.content });
    },
    pushUserMessage: async (messages, content) => {
      messages.push({ role: "user", content });
      trace.pushedUserMessages.push(content);
    },
    earlyRun: () => undefined,
    ...(options?.isParallelSafe ? { isParallelSafe: options.isParallelSafe } : {}),
    ...(options?.hooks ? { hooks: options.hooks } : {}),
  };
  return host;
}

describe("runAgentLoop 薄循环", () => {
  it("无工具调用：流一次→落盘→message_complete→metrics，结束", async () => {
    const host = createMockHost({ script: [{ message: assistant("hello") }] });
    await runAgentLoop(host);
    expect(host.trace.streams).toHaveLength(1);
    expect(host.trace.completed).toEqual(["hello"]);
    expect(host.trace.errors).toEqual([]);
    expect(host.trace.metrics).toBe(1);
  });

  it("工具调用：执行并回填结果，下一轮请求包含工具消息", async () => {
    const host = createMockHost({
      script: [
        { message: assistant("", [toolCall("c1", "edit_file")]) },
        { message: assistant("done") },
      ],
    });
    await runAgentLoop(host);
    expect(host.trace.executedTools).toEqual(["edit_file"]);
    // 串行工具由 executeToolCall 直接把结果推进消息列表（不经 loop 的 pushToolMessage）
    expect(
      host.trace.streams[1].some((m) => m.role === "tool" && m.content === "ok:edit_file"),
    ).toBe(true);
    expect(host.trace.completed).toEqual(["done"]);
  });

  it("只读并发批：全部经 executeReadOnlyToolCall 并发执行", async () => {
    expect(READ_ONLY_PARALLEL_TOOLS.has("read_file")).toBe(true);
    const host = createMockHost({
      script: [
        { message: assistant("", [toolCall("r1", "read_file"), toolCall("r2", "grep")]) },
        { message: assistant("done") },
      ],
    });
    await runAgentLoop(host);
    expect(host.trace.executedReadOnly.sort()).toEqual(["grep", "read_file"]);
    expect(host.trace.executedTools).toEqual([]);
    expect(host.trace.completed).toEqual(["done"]);
  });

  it("宿主的契约判定接管并发批：契约外工具仍串行，契约内动态工具可并发", async () => {
    const host = createMockHost({
      isParallelSafe: (name) => name === "mcp__demo__read",
      script: [
        {
          message: assistant("", [
            toolCall("m1", "mcp__demo__read"),
            toolCall("m2", "mcp__demo__read"),
          ]),
        },
        { message: assistant("done") },
      ],
    });
    await runAgentLoop(host);
    expect(host.trace.executedReadOnly).toEqual(["mcp__demo__read", "mcp__demo__read"]);
    expect(host.trace.executedTools).toEqual([]);
  });

  it("task 批：update_plan 先串行执行，task 结果最后统一落盘", async () => {
    const host = createMockHost({
      script: [
        {
          message: assistant("", [
            toolCall("t1", "task", { description: "x" }),
            toolCall("p1", "update_plan"),
          ]),
        },
        { message: assistant("done") },
      ],
    });
    await runAgentLoop(host);
    expect(host.trace.executedTasks).toEqual(["task"]);
    expect(host.trace.executedTools).toEqual(["update_plan"]);
    // update_plan 先落盘（经 executeToolCall 直推），task 结果由循环收集时统一 push：
    // 下一轮请求里 update_plan 的结果必须排在 task 结果之前
    const secondRound = host.trace.streams[1];
    const planIndex = secondRound.findIndex((m) => m.role === "tool" && m.content === "ok:update_plan");
    const taskIndex = secondRound.findIndex((m) => m.role === "tool" && m.content === "task done");
    expect(planIndex).toBeGreaterThanOrEqual(0);
    expect(taskIndex).toBeGreaterThan(planIndex);
  });

  it("beforeToolCall 拦截：不执行工具，原因作为工具结果回填", async () => {
    const host = createMockHost({
      script: [
        { message: assistant("", [toolCall("c1", "edit_file")]) },
        { message: assistant("stopped") },
      ],
      hooks: {
        beforeToolCall: async () => ({ block: true, reason: "admission required" }),
      },
    });
    await runAgentLoop(host);
    expect(host.trace.executedTools).toEqual([]);
    expect(host.trace.pushedToolMessages[0]?.content).toContain("admission required");
    // 拦截不是终止：循环继续，模型看到拦截结果后正常收尾
    expect(host.trace.completed).toEqual(["stopped"]);
  });

  it("afterToolCall：每次工具消息进入上下文后触发", async () => {
    const seen: string[] = [];
    const host = createMockHost({
      script: [
        { message: assistant("", [toolCall("c1", "edit_file")]) },
        { message: assistant("done") },
      ],
      hooks: {
        afterToolCall: async (call, message) => {
          seen.push(`${call.id}:${message.content}`);
        },
      },
    });
    await runAgentLoop(host);
    expect(seen).toEqual(["c1:ok:edit_file"]);
  });

  it("prepareNextTurn：宿主可在两轮之间追加上下文", async () => {
    const host = createMockHost({
      script: [
        { message: assistant("", [toolCall("c1", "grep")]) },
        { message: assistant("done") },
      ],
      hooks: {
        prepareNextTurn: async (messages) => [
          ...messages,
          { role: "user", content: "[workflow]" } as ChatMessage,
        ],
      },
    });
    await runAgentLoop(host);
    expect(
      host.trace.streams[1].some((m) => m.role === "user" && m.content === "[workflow]"),
    ).toBe(true);
  });

  it("shouldStopAfterTurn：批次结束后宿主要求终止，不再发起下一轮", async () => {
    const host = createMockHost({
      script: [{ message: assistant("", [toolCall("c1", "edit_file")]) }],
      hooks: {
        shouldStopAfterTurn: async () => true,
      },
    });
    await runAgentLoop(host);
    expect(host.trace.streams).toHaveLength(1);
    expect(host.trace.executedTools).toEqual(["edit_file"]);
    expect(host.trace.metrics).toBe(1);
  });

  it("上下文溢出：触发降级并携带压缩后的消息重试", async () => {
    const host = createMockHost({
      script: [
        new ProviderRequestError(413, "payload too large"),
        { message: assistant("recovered") },
      ],
    });
    await runAgentLoop(host);
    expect(host.trace.escalateCalls).toEqual([0]);
    expect(host.trace.streams).toHaveLength(2);
    expect(
      host.trace.streams[1].some((m) => m.role === "user" && m.content === "[compacted]"),
    ).toBe(true);
    expect(host.trace.completed).toEqual(["recovered"]);
  });

  it("溢出压缩后回合预算回血：已经花掉的账不再压着后续轮次", async () => {
    const host = createMockHost({
      turnBudget: () => ({ maxRounds: 20, maxTokens: 50_000 }),
      script: [
        // 首轮就攒掉大半预算
        { message: assistant("", [toolCall("c1", "read_file")]), usage: { inputTokens: 40_000 } },
        new ProviderRequestError(413, "payload too large"),
        // 压缩后的重试轮再记 4 万：不回血就是 8 万，下一轮轮首会被 token 预算硬停
        { message: assistant("", [toolCall("c2", "read_file")]), usage: { inputTokens: 40_000 } },
        { message: assistant("recovered"), usage: { inputTokens: 40_000 } },
      ],
    });
    await runAgentLoop(host);
    expect(host.trace.escalateCalls).toEqual([0]);
    expect(host.trace.completed).toEqual(["recovered"]);
    expect(host.trace.errors).toEqual([]);
  });

  it("截断的工具调用：不执行，补配对结果并报错结束", async () => {
    const host = createMockHost({
      script: [{ message: assistant("", [toolCall("c1", "edit_file")]), finishReason: "length" }],
    });
    await runAgentLoop(host);
    expect(host.trace.executedTools).toEqual([]);
    expect(host.trace.pushedToolMessages[0]?.content).toContain("truncated");
    expect(host.trace.errors[0]).toContain("truncated");
    expect(host.trace.metrics).toBe(1);
  });

  it("turn_stop 拦截：reason 作为 user 消息续跑，下一轮带该消息", async () => {
    let stopCalls = 0;
    const host = createMockHost({
      script: [{ message: assistant("done?") }, { message: assistant("really done") }],
      hooks: {
        beforeTurnEnd: async () => {
          stopCalls += 1;
          return stopCalls === 1 ? { block: true, reason: "run the tests first" } : undefined;
        },
      },
    });
    await runAgentLoop(host);
    expect(host.trace.streams).toHaveLength(2);
    expect(host.trace.pushedUserMessages).toEqual(["run the tests first"]);
    // 续跑那一轮的请求里能看到注入的 user 消息
    expect(
      host.trace.streams[1].some((m) => m.role === "user" && m.content === "run the tests first"),
    ).toBe(true);
    expect(host.trace.completed).toEqual(["really done"]);
    expect(host.trace.metrics).toBe(1);
  });

  it("turn_stop 连续拦截超过上限：强制收尾并告警", async () => {
    const host = createMockHost({
      script: [
        { message: assistant("a") },
        { message: assistant("b") },
        { message: assistant("c") },
        { message: assistant("d") },
        { message: assistant("e") },
      ],
      hooks: {
        beforeTurnEnd: async () => ({ block: true, reason: "keep going" }),
      },
    });
    await runAgentLoop(host);
    // 3 次拦截后第 4 次强制结束
    expect(host.trace.streams).toHaveLength(MAX_TURN_STOP_BLOCKS + 1);
    expect(host.trace.errors[0]).toContain("kept blocking");
    expect(host.trace.metrics).toBe(1);
  });

  it("turn_stop 放行：正常收尾（onMessageComplete + metrics）", async () => {
    let stopActiveSeen: boolean | null = null;
    const host = createMockHost({
      script: [{ message: assistant("fine") }],
      hooks: {
        beforeTurnEnd: async ({ stopHookActive }) => {
          stopActiveSeen = stopHookActive;
          return undefined;
        },
      },
    });
    await runAgentLoop(host);
    expect(stopActiveSeen).toBe(false);
    expect(host.trace.pushedUserMessages).toEqual([]);
    expect(host.trace.completed).toEqual(["fine"]);
    expect(host.trace.metrics).toBe(1);
  });
});

describe("供应商故障转移（fallback chain）", () => {
  const overflow = () =>
    new ProviderRequestError(
      400,
      "This model's maximum context length is 8192 tokens. Please reduce the length of the messages.",
    );

  /**
   * 带 fallback 的假宿主：providers 是 [主, 备1, 备2]，script 按轮回放；
   * host.fallbackProvider 复刻 runtime 的语义（可切则返回下一家，否则 null）。
   */
  function createFallbackHost(options: {
    script: ScriptItem[];
    chain?: ProviderConfig[];
  }): AgentLoopHost & {
    trace: { providers: string[]; escalateCalls: number[]; completed: string[] };
  } {
    const main = { id: "main", model: "m1", baseUrl: "http://127.0.0.1" } as ProviderConfig;
    const chain = (options.chain ?? [{ id: "backup", model: "m2", baseUrl: "http://127.0.0.1" } as ProviderConfig]);
    const script = [...options.script];
    let current = main;
    let hop = 0;
    const trace = {
      providers: [] as string[],
      escalateCalls: [] as number[],
      completed: [] as string[],
    };

    return {
      trace,
      initialMessages: () => [{ role: "user", content: "hi" }],
      provider: () => current,
      tools: () => [],
      usageAnchor: () => null,
      aborted: () => false,
      abortSignal: () => undefined,
      incremental: () => ({ enabled: false, signature: "" }),
      fallbackProvider: (error) => {
        // 只复刻判定顺序：abort / overflow 不切，其余交给 isFailoverEligible 的语义
        if (error instanceof ProviderRequestError && error.status === 503) {
          const next = chain[hop];
          hop += 1;
          if (!next) return null;
          current = next;
          return next;
        }
        return null;
      },
      resolveRequestProvider: ({ maxTokens }) => ({ ...current, maxTokens }),
      commitResponseChain: () => {},
      onRoundStart: () => {},
      onDelta: () => {},
      onThinking: () => {},
      onToolCallProgress: () => {},
      onToolCallComplete: () => {},
      stream: (streamOptions) => {
        trace.providers.push(streamOptions.provider.id);
        const next = script.shift();
        if (!next) throw new Error("mock script exhausted");
        if (next instanceof Error) return Promise.reject(next);
        return Promise.resolve({ message: next.message });
      },
      persistAssistantMessage: async () => {},
      recordUsage: async () => {},
      onMessageComplete: (result) => trace.completed.push(result.message.content ?? ""),
      onError: () => {},
      persistMetrics: async () => {},
      escalateOnOverflow: async (messages, stage) => {
        trace.escalateCalls.push(stage);
        return { messages: [...messages, { role: "user", content: "[compacted]" } as ChatMessage], stage: 3 };
      },
      executeToolCall: async (call) => ({
        role: "tool",
        content: "ok",
        tool_call_id: call.id,
        name: call.function.name,
      }),
      executeTaskToolCall: async (call) => ({
        role: "tool",
        content: "ok",
        tool_call_id: call.id,
        name: call.function.name,
      }),
      executeReadOnlyToolCall: async (call) => ({
        role: "tool",
        content: "ok",
        tool_call_id: call.id,
        name: call.function.name,
      }),
      pushToolMessage: async (messages, message) => {
        messages.push(message);
      },
      pushUserMessage: async (messages, content) => {
        messages.push({ role: "user", content });
      },
      earlyRun: () => undefined,
    };
  }

  it("503 切到下一跳并继续本回合", async () => {
    const host = createFallbackHost({
      script: [new ProviderRequestError(503, "service unavailable"), { message: assistant("recovered") }],
    });
    await runAgentLoop(host);
    expect(host.trace.providers).toEqual(["main", "backup"]);
    expect(host.trace.completed).toEqual(["recovered"]);
    expect(host.trace.escalateCalls).toEqual([]);
  });

  it("401 不切链，错误直接抛给用户", async () => {
    const host = createFallbackHost({
      script: [new ProviderRequestError(401, "invalid api key")],
    });
    await expect(runAgentLoop(host)).rejects.toThrow(/401/);
    expect(host.trace.providers).toEqual(["main"]);
  });

  it("溢出优先走压缩降级，而不是切服务商", async () => {
    const host = createFallbackHost({
      script: [overflow(), { message: assistant("recovered") }],
    });
    await runAgentLoop(host);
    expect(host.trace.escalateCalls).toEqual([0]);
    expect(host.trace.providers).toEqual(["main", "main"]);
  });

  it("切换后溢出档位归零：新 provider 上仍能走完整降级", async () => {
    const host = createFallbackHost({
      script: [
        new ProviderRequestError(503, "down"),
        overflow(),
        { message: assistant("recovered") },
      ],
    });
    await runAgentLoop(host);
    expect(host.trace.providers).toEqual(["main", "backup", "backup"]);
    expect(host.trace.escalateCalls).toEqual([0]);
    expect(host.trace.completed).toEqual(["recovered"]);
  });

  it("链走完（2 跳上限）仍然失败时抛出最后一个错误", async () => {
    const host = createFallbackHost({
      script: [
        new ProviderRequestError(503, "first"),
        new ProviderRequestError(503, "second"),
        new ProviderRequestError(503, "third"),
      ],
      chain: [
        { id: "backup1", model: "m2", baseUrl: "http://127.0.0.1" } as ProviderConfig,
        { id: "backup2", model: "m3", baseUrl: "http://127.0.0.1" } as ProviderConfig,
      ],
    });
    await expect(runAgentLoop(host)).rejects.toThrow(/third/);
    expect(host.trace.providers).toEqual(["main", "backup1", "backup2"]);
  });
});
