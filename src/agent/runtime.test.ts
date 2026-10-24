import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserHostClient, BrowserHostCommand } from "./browser-host";
import { ProviderRequestError } from "./provider-error";
import type { ChatMessage, MeowEvent } from "./types";
import { SessionStore } from "./session-store";

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

const { AgentRuntime, validatePlanInput } = await import("./runtime.js");
const { normalizeApprovalMode } = await import("./types.js");

function makeRuntime(sessionsDir: string): InstanceType<typeof AgentRuntime> {
  return new AgentRuntime({
    providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
    sessionsDir,
    // 隔离真实 ~/.meowcode：全局技能索引会让 system 消息内容随用户环境漂移
    homeDir: sessionsDir,
  });
}

async function collectEvents(runtime: InstanceType<typeof AgentRuntime>): Promise<MeowEvent[]> {
  const events: MeowEvent[] = [];
  runtime.onEvent((event) => events.push(event));
  return events;
}

beforeEach(() => {
  streamMock.mockReset();
});

describe("validatePlanInput", () => {
  it("accepts valid steps and trims titles", () => {
    const result = validatePlanInput({
      steps: [{ title: "  write tests  ", status: "in_progress" }],
      explanation: "why not",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.steps).toEqual([{ title: "write tests", status: "in_progress" }]);
      expect(result.explanation).toBe("why not");
    }
  });

  it("rejects empty or oversized step lists", () => {
    expect(validatePlanInput({ steps: [] }).ok).toBe(false);
    expect(validatePlanInput({}).ok).toBe(false);
    const thirteen = Array.from({ length: 13 }, (_, index) => ({
      title: `step ${index}`,
      status: "pending",
    }));
    expect(validatePlanInput({ steps: thirteen }).ok).toBe(false);
  });

  it("rejects invalid statuses and empty titles", () => {
    const badStatus = validatePlanInput({ steps: [{ title: "a", status: "doing" }] });
    expect(badStatus.ok).toBe(false);
    if (!badStatus.ok) expect(badStatus.error).toContain("Invalid plan step status");
    expect(validatePlanInput({ steps: [{ title: "   ", status: "pending" }] }).ok).toBe(false);
  });
});

describe("request prefix stability", () => {
  it("keeps one stable system message, persists tool results, and extends the previous prefix", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: "a.txt", content: "hello" }),
              },
            },
            {
              id: "call-2",
              type: "function",
              function: {
                name: "update_plan",
                arguments: JSON.stringify({
                  steps: [{ title: "Step A", status: "in_progress" }],
                }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "again" } });

    await runtime.prompt("do it");

    const firstRequest = streamMock.mock.calls[0][0].messages as ChatMessage[];
    const secondRequest = streamMock.mock.calls[1][0].messages as ChatMessage[];
    expect(firstRequest.filter((message) => message.role === "system")).toHaveLength(1);
    expect(secondRequest.filter((message) => message.role === "system")).toHaveLength(1);
    expect(secondRequest[0]).toEqual(firstRequest[0]);
    // 计划正文随工具结果进入请求，不再改写 system
    expect(
      secondRequest.some(
        (message) =>
          message.role === "tool" &&
          message.name === "update_plan" &&
          message.content.includes("1. [in_progress] Step A"),
      ),
    ).toBe(true);
    expect(
      secondRequest.some((message) => message.role === "tool" && message.name === "write_file"),
    ).toBe(true);

    // 工具结果落盘：重载会话后仍能完整重放
    const { SessionStore } = await import("./session-store.js");
    const reloaded = await SessionStore.load(runtime.current!.filePath);
    expect(reloaded.effectiveMessages.filter((message) => message.role === "tool")).toHaveLength(2);

    await runtime.prompt("next");
    const thirdRequest = streamMock.mock.calls[2][0].messages as ChatMessage[];
    // 上一轮最终请求是这一轮请求的严格前缀（append-only）
    expect(thirdRequest.slice(0, secondRequest.length)).toEqual(secondRequest);
    // 计划已在历史里时不再重复注入上下文 note
    expect(
      thirdRequest.filter(
        (message) =>
          message.role === "user" &&
          message.content.startsWith("Runtime context: current task plan"),
      ),
    ).toHaveLength(0);
  });
});

describe("AgentRuntime context compaction", () => {
  it("compacts once on overflow and retries the turn", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    const session = await runtime.newSession();
    const events = await collectEvents(runtime);
    const overflow = new ProviderRequestError(413, "prompt is too long");
    streamMock
      .mockRejectedValueOnce(overflow)
      .mockResolvedValueOnce({ message: { role: "assistant", content: "SUMMARY" } })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "FINAL" } });

    await runtime.prompt("do the thing");

    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.some((event) => event.type === "message_complete" && event.text === "FINAL")).toBe(true);
    expect(events.some((event) => event.type === "compaction_started")).toBe(true);
    expect(
      events.some((event) => event.type === "compaction_completed" && event.summary === "SUMMARY"),
    ).toBe(true);
    expect(streamMock).toHaveBeenCalledTimes(3); // 失败 + 摘要 + 重试
    expect(runtime.current?.currentCompactionSummary).toBe("SUMMARY");
    // 压缩后的有效历史 = 摘要（user 前缀）+ 压缩点之后的消息
    expect(runtime.current?.effectiveMessages.map((message) => message.content)).toEqual([
      "Earlier conversation summary:\nSUMMARY",
      "FINAL",
    ]);
  });

  it("does not loop compaction when the retry also overflows", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    const events = await collectEvents(runtime);
    const overflow = new ProviderRequestError(413, "prompt is too long");
    streamMock
      .mockRejectedValueOnce(overflow)
      .mockResolvedValueOnce({ message: { role: "assistant", content: "S" } })
      .mockRejectedValue(overflow);

    await runtime.prompt("try again");

    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(events.filter((event) => event.type === "compaction_started")).toHaveLength(1);
    expect(streamMock).toHaveBeenCalledTimes(3); // 失败 + 摘要 + 一次重试，没有第二次压缩
    expect(runtime.current?.entries.filter((entry) => entry.type === "compaction_summary")).toHaveLength(1);
  });

  it("escapes overflow with the lightweight tool-output shrink before any model call", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    // 未声明窗口：请求前不做任何裁剪，溢出后第一档「确定性收缩」必须兜住
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    const session = runtime.current!;
    const events = await collectEvents(runtime);
    await session.appendMessage({ role: "user", content: "do it" });
    for (let index = 0; index < 8; index += 1) {
      await session.appendMessage({
        role: "assistant",
        content: null,
        tool_calls: [{ id: `call-${index}`, type: "function", function: { name: "read_file", arguments: "{}" } }],
      });
      await session.appendMessage({
        role: "tool",
        content: "a".repeat(6_000),
        tool_call_id: `call-${index}`,
        name: "read_file",
      });
    }
    await session.flush();
    const overflow = new ProviderRequestError(413, "prompt is too long");
    streamMock
      .mockRejectedValueOnce(overflow)
      .mockResolvedValueOnce({ message: { role: "assistant", content: "FINAL" } });

    await runtime.prompt("continue");

    // 只有溢出 + 重试两次请求：收缩是本地操作，不产生摘要/纪要调用
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(events.some((event) => event.type === "compaction_started")).toBe(false);
    expect(runtime.current?.entries.filter((entry) => entry.type === "tool_digest")).toHaveLength(0);
    // 第二次请求里旧输出已换成头尾摘录，最近 2 轮原样保留
    const second = streamMock.mock.calls[1][0].messages as ChatMessage[];
    const tools = second.filter((message) => message.role === "tool");
    expect(tools).toHaveLength(8);
    expect(tools[0].content).toContain("chars trimmed");
    expect(tools[7].content.length).toBe(6_000);
  });

  it("summarizes only old tool outputs (stage 2) instead of full compaction", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = new AgentRuntime({
      providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m", contextWindow: 16_000 }],
      sessionsDir: dir,
    });
    await runtime.newSession();
    const session = runtime.current!;
    const events = await collectEvents(runtime);
    await session.appendMessage({ role: "user", content: "do it" });
    for (let index = 0; index < 4; index += 1) {
      await session.appendMessage({
        role: "assistant",
        content: null,
        tool_calls: [{ id: `call-${index}`, type: "function", function: { name: "read_file", arguments: "{}" } }],
      });
      await session.appendMessage({
        role: "tool",
        content: "a".repeat(40_000),
        tool_call_id: `call-${index}`,
        name: "read_file",
      });
    }
    await session.appendMessage({ role: "assistant", content: "done" });
    await session.flush();

    const overflow = new ProviderRequestError(413, "prompt is too long");
    streamMock
      .mockRejectedValueOnce(overflow) // 首次请求溢出
      .mockResolvedValueOnce({
        // 纪要请求：只返回 call-0 的纪要
        message: { role: "assistant", content: "call-0: a.txt dumped, 40k lines of noise" },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "FINAL" } });

    await runtime.prompt("continue");

    // 溢出 + 纪要 + 重试 = 3 次请求；没有全量压缩
    expect(streamMock).toHaveBeenCalledTimes(3);
    expect(events.some((event) => event.type === "compaction_started")).toBe(false);
    expect(events.some((event) => event.type === "compaction_completed")).toBe(false);
    // 纪要落盘，可跨回合重放
    expect(runtime.current?.entries.filter((entry) => entry.type === "tool_digest")).toHaveLength(1);
    const third = streamMock.mock.calls[2][0].messages as ChatMessage[];
    const digested = third.find(
      (message) => message.role === "tool" && message.tool_call_id === "call-0",
    );
    expect(digested && digested.role === "tool" ? digested.content : "").toBe(
      "[summarized] a.txt dumped, 40k lines of noise",
    );
    // 重载会话后纪要仍然生效（原文留在 JSONL，不改写）
    const reloaded = await SessionStore.load(runtime.current!.filePath);
    const replayed = reloaded.effectiveMessages.find(
      (message) => message.role === "tool" && message.tool_call_id === "call-0",
    );
    expect(replayed && replayed.role === "tool" ? replayed.content : "").toContain("[summarized]");
    const raw = reloaded.messages.find(
      (message) => message.role === "tool" && message.tool_call_id === "call-0",
    );
    expect(raw && raw.role === "tool" ? raw.content.length : 0).toBe(40_000);
  });

  it("propagates non-overflow errors without compacting", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    const events = await collectEvents(runtime);
    streamMock.mockRejectedValueOnce(new ProviderRequestError(401, "invalid api key"));

    await runtime.prompt("hello");

    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === "compaction_started")).toBe(false);
    expect(runtime.current?.entries.filter((entry) => entry.type === "compaction_summary")).toHaveLength(0);
  });

  // 后台预热压缩：真实用量过阈值就提前生成摘要，溢出时直接采用，不阻塞回合
  const seedHistory = async (session: SessionStore, rounds: number, chars = 2_400) => {
    for (let index = 0; index < rounds; index += 1) {
      await session.appendMessage({ role: "user", content: `q${index} ${"x".repeat(chars)}` });
      await session.appendMessage({ role: "assistant", content: `a${index} ${"y".repeat(chars)}` });
    }
  };
  const makeWindowedRuntime = (dir: string) =>
    new AgentRuntime({
      providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m", contextWindow: 16_000 }],
      sessionsDir: dir,
    });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("pre-warms the summary in the background and adopts it on overflow without a summary call", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeWindowedRuntime(dir);
    await runtime.newSession();
    await seedHistory(runtime.current!, 8);
    const events = await collectEvents(runtime);

    streamMock
      .mockResolvedValueOnce({
        message: { role: "assistant", content: "round one" },
        usage: { inputTokens: 13_600, outputTokens: 10 }, // 85% × 16k：过预热阈值
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "WARM-SUMMARY" } });
    await runtime.prompt("do it");
    await flush();

    // 预热在后台跑完，前台没有任何压缩发生
    expect(events.some((event) => event.type === "compaction_warmup" && event.phase === "started")).toBe(true);
    expect(events.some((event) => event.type === "compaction_warmup" && event.phase === "completed")).toBe(true);
    expect(events.some((event) => event.type === "compaction_started")).toBe(false);

    streamMock
      .mockRejectedValueOnce(new ProviderRequestError(413, "prompt is too long"))
      .mockResolvedValueOnce({ message: { role: "assistant", content: "FINAL" } });
    await runtime.prompt("next");

    // 溢出 → 直接采用预热摘要 → 重试：没有额外的摘要请求
    expect(streamMock).toHaveBeenCalledTimes(4);
    expect(runtime.current?.currentCompactionSummary).toBe("WARM-SUMMARY");
    expect(runtime.current?.effectiveMessages[0]?.content).toBe("Earlier conversation summary:\nWARM-SUMMARY");
    // 摘要只覆盖预热时的前缀：预热之后新增的对话逐字保留
    expect(runtime.current?.effectiveMessages.some((message) => message.content === "do it")).toBe(true);
    expect(runtime.current?.effectiveMessages.some((message) => message.content === "next")).toBe(true);
  });

  it("skips the warmup below the usage threshold", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeWindowedRuntime(dir);
    await runtime.newSession();
    await seedHistory(runtime.current!, 8);
    const events = await collectEvents(runtime);

    streamMock.mockResolvedValueOnce({
      message: { role: "assistant", content: "round one" },
      usage: { inputTokens: 6_000, outputTokens: 10 }, // 37%：不触发
    });
    await runtime.prompt("do it");
    await flush();

    expect(events.some((event) => event.type === "compaction_warmup")).toBe(false);
    expect(streamMock).toHaveBeenCalledTimes(1);
  });

  it("proactively adopts a ready warmup when usage stays above 85%", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeWindowedRuntime(dir);
    await runtime.newSession();
    await seedHistory(runtime.current!, 8);
    const events = await collectEvents(runtime);

    // 第一轮：85% 用量 → 预热启动并在后台完成
    streamMock
      .mockResolvedValueOnce({
        message: { role: "assistant", content: "round one" },
        usage: { inputTokens: 13_600, outputTokens: 10 },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "WARM-SUMMARY" } });
    await runtime.prompt("do it");
    await flush();
    expect(events.some((event) => event.type === "compaction_warmup" && event.phase === "completed")).toBe(true);
    expect(events.some((event) => event.type === "compaction_started")).toBe(false);

    // 第二轮：没有溢出，但占用仍在 85% → 回合间隙主动采纳预热摘要（零摘要请求）
    streamMock.mockResolvedValueOnce({
      message: { role: "assistant", content: "round two" },
      usage: { inputTokens: 13_800, outputTokens: 10 },
    });
    await runtime.prompt("again");
    await flush();

    expect(events.some((event) => event.type === "compaction_started")).toBe(true);
    expect(events.some((event) => event.type === "compaction_completed")).toBe(true);
    expect(runtime.current?.currentCompactionSummary).toBe("WARM-SUMMARY");
    // 总调用 = 两轮对话 + 一次预热摘要；主动采纳不产生新的模型请求
    expect(streamMock).toHaveBeenCalledTimes(3);
    // 采纳后该轮新增的对话逐字保留在摘要之后
    expect(runtime.current?.effectiveMessages.some((message) => message.content === "again")).toBe(true);
  });

  it("does not block the turn while the warmup is still in flight", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeWindowedRuntime(dir);
    await runtime.newSession();
    await seedHistory(runtime.current!, 8);
    const events = await collectEvents(runtime);

    let releaseWarmup: (value: unknown) => void = () => undefined;
    streamMock
      .mockResolvedValueOnce({
        message: { role: "assistant", content: "round one" },
        usage: { inputTokens: 13_600, outputTokens: 10 },
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseWarmup = resolve;
          }),
      );
    await runtime.prompt("do it");
    await flush();

    // 回合已结束、预热仍挂起：主动档不等待、不阻塞，本轮没有任何压缩
    expect(events.some((event) => event.type === "compaction_started")).toBe(false);
    expect(events.some((event) => event.type === "error")).toBe(false);

    releaseWarmup({ message: { role: "assistant", content: "LATE-SUMMARY" } });
    await flush();
    // 预热照常完成，留待下一轮主动采纳或溢出兜底
    expect(events.some((event) => event.type === "compaction_warmup" && event.phase === "completed")).toBe(true);
    expect(events.some((event) => event.type === "compaction_started")).toBe(false);
  });

  it("awaits an in-flight warmup on overflow instead of starting a new summary", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeWindowedRuntime(dir);
    await runtime.newSession();
    await seedHistory(runtime.current!, 8);
    const events = await collectEvents(runtime);

    let releaseWarmup: (value: unknown) => void = () => undefined;
    streamMock
      .mockResolvedValueOnce({
        message: { role: "assistant", content: "round one" },
        usage: { inputTokens: 13_600, outputTokens: 10 },
      })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          releaseWarmup = resolve;
        }),
      );
    await runtime.prompt("do it");

    streamMock
      .mockRejectedValueOnce(new ProviderRequestError(413, "prompt is too long"))
      .mockResolvedValueOnce({ message: { role: "assistant", content: "FINAL" } });
    const second = runtime.prompt("next");
    // 等溢出已经发生、升级流程开始等预热结果
    for (let i = 0; i < 200 && streamMock.mock.calls.length < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    releaseWarmup({ message: { role: "assistant", content: "WARM-SUMMARY" } });
    await second;

    // 溢出 + 预热 + 重试：等待中的预热被直接采用，没有新的摘要调用
    expect(streamMock).toHaveBeenCalledTimes(4);
    expect(runtime.current?.currentCompactionSummary).toBe("WARM-SUMMARY");
    expect(events.some((event) => event.type === "compaction_failed")).toBe(false);
  });

  it("falls back to the synchronous compaction when the warmup failed", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeWindowedRuntime(dir);
    await runtime.newSession();
    await seedHistory(runtime.current!, 8);
    const events = await collectEvents(runtime);

    streamMock
      .mockResolvedValueOnce({
        message: { role: "assistant", content: "round one" },
        usage: { inputTokens: 13_600, outputTokens: 10 },
      })
      .mockRejectedValueOnce(new Error("warmup backend down"));
    await runtime.prompt("do it");
    await flush();
    expect(events.some((event) => event.type === "compaction_warmup" && event.phase === "failed")).toBe(true);

    streamMock
      .mockRejectedValueOnce(new ProviderRequestError(413, "prompt is too long"))
      .mockResolvedValueOnce({ message: { role: "assistant", content: "SYNC-SUMMARY" } })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "FINAL" } });
    await runtime.prompt("next");

    // 预热失败不挡路：照常前台压缩
    expect(streamMock).toHaveBeenCalledTimes(5);
    expect(runtime.current?.currentCompactionSummary).toBe("SYNC-SUMMARY");
    expect(events.some((event) => event.type === "compaction_started")).toBe(true);
  });
});

describe("AgentRuntime update_plan", () => {
  it("persists the plan, emits plan_updated, and keeps it in the tool result", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    const session = await runtime.newSession();
    const events = await collectEvents(runtime);
    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "update_plan",
                arguments: JSON.stringify({
                  steps: [{ title: "Explore", status: "completed" }, { title: "Fix", status: "in_progress" }],
                  explanation: "halfway there",
                }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "Plan noted." } });

    await runtime.prompt("make a plan");

    expect(runtime.current?.currentPlan?.steps.map((step) => step.title)).toEqual(["Explore", "Fix"]);
    expect(events.some((event) => event.type === "plan_updated" && event.steps.length === 2)).toBe(true);
    expect(events.some((event) => event.type === "message_complete" && event.text === "Plan noted.")).toBe(true);
    // 会话回放：从磁盘重新加载后计划仍在
    const reloaded = await (await import("./session-store.js")).SessionStore.load(session.filePath);
    expect(reloaded.currentPlan?.explanation).toBe("halfway there");
  });

  it("rejects an invalid plan without emitting plan_updated", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    const events = await collectEvents(runtime);
    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-2",
              type: "function",
              function: {
                name: "update_plan",
                arguments: JSON.stringify({ steps: [{ title: "Bad", status: "doing" }] }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "ok" } });

    await runtime.prompt("bad plan");

    expect(events.some((event) => event.type === "plan_updated")).toBe(false);
    expect(runtime.current?.currentPlan).toBeNull();
  });
});

describe("AgentRuntime manual compaction", () => {
  it("compacts on demand and persists the summary", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    const session = await runtime.newSession();
    await runtime.current?.appendMessage({ role: "user", content: "hello" });
    const events = await collectEvents(runtime);
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "MANUAL-SUMMARY" } });

    await runtime.compactSession();

    expect(events.some((event) => event.type === "compaction_started")).toBe(true);
    expect(
      events.some((event) => event.type === "compaction_completed" && event.summary === "MANUAL-SUMMARY"),
    ).toBe(true);
    expect(runtime.current?.currentCompactionSummary).toBe("MANUAL-SUMMARY");
    expect(runtime.current?.lastCompaction).toEqual({
      messageIndex: 1,
      summary: "MANUAL-SUMMARY",
    });
    // 压缩点之后只剩摘要本身，没有可继续压缩的新消息
    expect(runtime.current?.effectiveMessages).toEqual([
      { role: "user", content: "Earlier conversation summary:\nMANUAL-SUMMARY" },
    ]);
    expect(runtime.current?.hasUncompactedMessages).toBe(false);
    const reloaded = await (await import("./session-store.js")).SessionStore.load(session.filePath);
    expect(reloaded.currentCompactionSummary).toBe("MANUAL-SUMMARY");
  });

  it("adds a paths-only note for files touched before compaction", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.current?.appendMessage({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "read-1",
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) },
        },
      ],
    });
    await runtime.current?.appendMessage({
      role: "tool",
      content: "1: hello",
      tool_call_id: "read-1",
      name: "read_file",
    });
    await runtime.current?.appendMessage({ role: "user", content: "continue" });
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "S" } });

    await runtime.compactSession();

    const note = runtime.current?.effectiveMessages.find(
      (message) =>
        message.role === "user" &&
        message.content.includes("files already read or changed before compaction"),
    );
    expect(note?.role === "user" ? note.content : "").toContain("a.txt");
    expect(note?.role === "user" ? note.content : "").not.toContain("1: hello");
  });

  it("rejects compaction without a session", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    await expect(runtime.compactSession()).rejects.toThrow(/No active session/);
  });

  it("rejects compaction when there is nothing to compact", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    await expect(runtime.compactSession()).rejects.toThrow(/Nothing to compact/);
  });

  it("blocks prompts while compacting and clears the state when compaction fails", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    await runtime.current?.appendMessage({ role: "user", content: "hello" });
    const events = await collectEvents(runtime);
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    streamMock.mockImplementationOnce(() => pending);

    const compaction = runtime.compactSession();
    for (let i = 0; i < 100 && !runtime.isCompacting; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(runtime.isCompacting).toBe(true);
    expect(runtime.canAcceptPrompt).toBe(false);
    await expect(runtime.prompt("too early")).rejects.toThrow(/compaction is running/i);

    // 空摘要会让压缩失败：状态要清掉，不能一直卡在“正在压缩”
    release({ message: { role: "assistant", content: "" } });
    await expect(compaction).rejects.toThrow(/empty summary/);
    expect(runtime.isCompacting).toBe(false);
    expect(runtime.canAcceptPrompt).toBe(true);
    expect(events.some((event) => event.type === "compaction_failed")).toBe(true);
  });

  it("rejects compaction while a turn is running", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    // 挂起的请求模拟长回合；abort 信号触发时才退出
    streamMock.mockImplementation((options: { signal?: AbortSignal }) => {
      const signal = options?.signal;
      return new Promise<never>((_resolve, reject) => {
        // abort 可能发生在进入 provider 之前：先查一次已触发状态
        if (signal?.aborted) {
          reject(new Error("Aborted"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new Error("Aborted")));
      });
    });

    const running = runtime.prompt("hello");
    // prompt() 在 appendMessage 之后才置位 turnAbort，轮询等它真正启动
    let rejected = false;
    for (let i = 0; i < 100 && !rejected; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        await runtime.compactSession();
      } catch (error) {
        rejected = true;
        expect((error as Error).message).toMatch(/already running/);
      }
    }
    expect(rejected).toBe(true);

    runtime.abort();
    await running;
  });
});

describe("AgentRuntime context usage", () => {  it("falls back to estimates, then prefers real input tokens", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();

    // 未设窗口、未发过请求 → 估算路径
    const before = runtime.getContextUsage();
    expect(before.contextWindow).toBeNull();
    expect(before.source).toBe("estimate");
    expect(before.usedTokens).toBeGreaterThan(0);
    expect(before.recommendedCompaction).toBe(false);
    // 估算路径下三项明细就是各分项估算值，加总与总量一致
    const beforeParts = before.breakdown.system + before.breakdown.tools + before.breakdown.messages;
    expect(beforeParts).toBe(before.usedTokens);

    streamMock.mockResolvedValueOnce({
      message: { role: "assistant", content: "ok" },
      usage: { inputTokens: 4321, outputTokens: 10 },
    });
    await runtime.prompt("hi");

    const after = runtime.getContextUsage();
    expect(after.source).toBe("usage");
    expect(after.usedTokens).toBe(4321);
    // 真实用量路径下按估算比例摊分，三项之和仍等于真实总量
    const afterParts = after.breakdown.system + after.breakdown.tools + after.breakdown.messages;
    expect(afterParts).toBe(4321);
    expect(after.breakdown.system).toBeGreaterThan(0);
    expect(after.breakdown.tools).toBeGreaterThan(0);
    expect(after.breakdown.messages).toBeGreaterThan(0);
  });

  it("recommends manual compaction at 85% without auto-compacting", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = new AgentRuntime({
      providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m", contextWindow: 4_000 }],
      sessionsDir: dir,
    });
    await runtime.newSession();
    await runtime.current?.appendMessage({ role: "user", content: "长内容" + "x".repeat(14_000) });

    const usage = runtime.getContextUsage();
    expect(usage.recommendedCompaction).toBe(true);
    expect(usage.usedTokens / (usage.contextWindow ?? 1)).toBeGreaterThanOrEqual(0.85);

    // 85% 只提示，不在下一次请求前自动整理；只有 provider 报溢出才压缩。
    const events = await collectEvents(runtime);
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "ok" } });
    await runtime.prompt("继续");
    expect(events.some((event) => event.type === "compaction_started")).toBe(false);
  });
  it("emits raw cache buckets in usage events", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    const events = await collectEvents(runtime);
    streamMock.mockResolvedValueOnce({
      message: { role: "assistant", content: "ok" },
      usage: {
        inputTokens: 1_000,
        outputTokens: 5,
        cacheReadTokens: 600,
        cacheWriteTokens: 200,
      },
    });

    await runtime.prompt("hi");

    const usage = events.find((event) => event.type === "usage");
    expect(usage).toMatchObject({
      inputTokens: 1_000,
      outputTokens: 5,
      cacheReadTokens: 600,
      cacheWriteTokens: 200,
    });
  });
});

describe("AgentRuntime spurious overflow guard", () => {
  it("refuses to compact when the input is far below the declared window", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = new AgentRuntime({
      providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m", contextWindow: 1_000_000 }],
      sessionsDir: dir,
    });
    await runtime.newSession();
    const events = await collectEvents(runtime);
    streamMock.mockRejectedValueOnce(new ProviderRequestError(400, "prompt is too long"));

    await runtime.prompt("你好");

    // 两条消息远小于 1M 窗口：溢出必然是误判，报错而不是吞历史
    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(events.some((event) => event.type === "compaction_started")).toBe(false);
    expect(runtime.current?.entries.filter((entry) => entry.type === "compaction_summary")).toHaveLength(0);
    expect(streamMock).toHaveBeenCalledTimes(1); // 连摘要请求都没有
  });

  it("still compacts genuine overflow when the input approaches the window", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = new AgentRuntime({
      providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m", contextWindow: 8_000 }],
      sessionsDir: dir,
    });
    await runtime.newSession();
    await runtime.current?.appendMessage({
      role: "user",
      content: "x".repeat(20_000),
    });
    const events = await collectEvents(runtime);
    streamMock
      .mockRejectedValueOnce(new ProviderRequestError(400, "prompt is too long"))
      .mockResolvedValueOnce({ message: { role: "assistant", content: "S" } })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "FINAL" } });

    await runtime.prompt("继续");

    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.some((event) => event.type === "compaction_started")).toBe(true);
    expect(runtime.current?.currentCompactionSummary).toBe("S");
  });
});

describe("AgentRuntime provider switching", () => {
  it("resets the real-usage source when the active provider changes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = new AgentRuntime({
      providers: [
        { id: "a", name: "A", baseUrl: "http://localhost", model: "m" },
        { id: "b", name: "B", baseUrl: "http://localhost", model: "m2", contextWindow: 8_000 },
      ],
      sessionsDir: dir,
    });
    await runtime.newSession();
    streamMock.mockResolvedValueOnce({
      message: { role: "assistant", content: "ok" },
      usage: { inputTokens: 500 },
    });
    await runtime.prompt("hi");
    expect(runtime.getContextUsage()).toMatchObject({ source: "usage", usedTokens: 500 });

    runtime.setActiveProvider("b");
    const usage = runtime.getContextUsage();
    expect(usage.source).toBe("estimate"); // 旧模型的真实用量不再代表当前上下文
    expect(usage.contextWindow).toBe(8_000);
    expect(usage.usedTokens).toBeGreaterThan(0);
  });
});

describe("AgentRuntime tool rounds", () => {
  it("does not stop after 20 tool rounds", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    const events = await collectEvents(runtime);

    const ROUNDS = 25;
    let calls = 0;
    streamMock.mockImplementation(async () => {
      calls += 1;
      if (calls <= ROUNDS) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `call-${calls}`,
                type: "function",
                function: {
                  name: "update_plan",
                  arguments: JSON.stringify({
                    steps: [{ title: `Round ${calls}`, status: "in_progress" }],
                  }),
                },
              },
            ],
          },
        };
      }
      return { message: { role: "assistant", content: "finally done" } };
    });

    await runtime.prompt("many rounds");

    expect(streamMock).toHaveBeenCalledTimes(ROUNDS + 1);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(
      events.some((event) => event.type === "message_complete" && event.text === "finally done"),
    ).toBe(true);
  });
});

describe("AgentRuntime journal failures", () => {
  it("keeps an executed tool result in context when journaling it fails", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    const session = runtime.current;
    if (!session) throw new Error("session was not created");
    const events = await collectEvents(runtime);

    // 模拟磁盘写失败：工具结果落盘抛错，其余消息正常
    const original = session.appendMessage.bind(session);
    session.appendMessage = async (message: ChatMessage) => {
      if (message.role === "tool") throw new Error("disk is full");
      return original(message);
    };

    let calls = 0;
    streamMock.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "update_plan", arguments: JSON.stringify({ steps: [{ title: "A", status: "in_progress" }] }) },
              },
            ],
          },
        };
      }
      return { message: { role: "assistant", content: "done" } };
    });

    await runtime.prompt("plan something");

    const secondCallMessages = streamMock.mock.calls[1]?.[0]?.messages as ChatMessage[] | undefined;
    expect(secondCallMessages?.some((message) => message.role === "tool" && message.tool_call_id === "call-1")).toBe(
      true,
    );
    expect(events.some((event) => event.type === "error" && String(event.message).includes("会话记录写入失败"))).toBe(
      true,
    );
    expect(events.some((event) => event.type === "message_complete" && event.text === "done")).toBe(true);
  });
});

describe("AgentRuntime orphan tool calls", () => {
  it("drops a tool_call without a result even when no context window is configured", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    const session = runtime.current;
    if (!session) throw new Error("session was not created");

    // 模拟历史里残留一条中断的 tool_use：没有任何 tool 结果
    await session.appendMessage({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "orphan", type: "function", function: { name: "read_file", arguments: "{}" } },
      ],
    });
    streamMock.mockImplementation(async () => ({
      message: { role: "assistant", content: "ok" },
    }));

    await runtime.prompt("continue");

    const sent = streamMock.mock.calls[0]?.[0]?.messages as ChatMessage[] | undefined;
    expect(
      sent?.some(
        (message) =>
          message.role === "assistant" &&
          (message.tool_calls ?? []).some((call) => call.id === "orphan"),
      ),
    ).toBe(false);
  });
});

describe("AgentRuntime full access mode", () => {
  it("writes outside the workspace without approval and records the review diff", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "meowcode-outside-"));
    const outsideFile = path.join(outsideRoot, "outside.txt");
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    const events = await collectEvents(runtime);
    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "outside-1",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: outsideFile, content: "outside" }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    await runtime.prompt("write outside the workspace");

    expect(await readFile(outsideFile, "utf8")).toBe("outside");
    expect(events.some((event) => event.type === "approval_required")).toBe(false);
    const approvals = runtime.current!.entries.filter((entry) => entry.type === "approval");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ tool: "write_file", approved: true });
    const target = path.resolve(outsideFile);
    expect(runtime.current!.fileChanges[0].path).toBe(target);
    expect(events.some((event) => event.type === "file_changed" && event.path === target)).toBe(true);
  });

  it("reads outside the workspace in full mode but rejects it in default mode", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "meowcode-outside-"));
    const outsideFile = path.join(outsideRoot, "outside.txt");
    await writeFile(outsideFile, "secret", "utf8");

    const runRead = async (mode: "full" | "default") => {
      const runtime = makeRuntime(dir);
      await runtime.newSession(workspace);
      runtime.setApprovalMode(mode);
      streamMock
        .mockResolvedValueOnce({
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "read-1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: outsideFile }),
                },
              },
            ],
          },
        })
        .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });
      await runtime.prompt("read outside");
      return runtime.current!.effectiveMessages.find(
        (message) => message.role === "tool" && message.name === "read_file",
      );
    };

    const full = await runRead("full");
    expect(full?.content).toContain("1: secret");
    const restricted = await runRead("default");
    expect(restricted?.content).toContain("Path is outside the workspace");
  });
});

describe("AgentRuntime file change review records", () => {
  it("records write_file and edit_file diffs into the session and reloads from disk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-review-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full"); // 免审批直接执行，聚焦记录逻辑
    const events = await collectEvents(runtime);

    streamMock.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: "hello.txt", content: "line1\n" }),
            },
          },
        ],
      },
    });
    streamMock.mockResolvedValueOnce({
      message: { role: "assistant", content: "done" },
      usage: { inputTokens: 10, outputTokens: 1 },
    });
    await runtime.prompt("create hello.txt");

    const first = runtime.current!.fileChanges;
    expect(first).toHaveLength(1);
    expect(first[0].path).toBe("hello.txt");
    expect(first[0].operation).toBe("write_file");
    expect(first[0].diff).toContain("+ line1");
    expect(events.some((event) => event.type === "file_changed" && event.path === "hello.txt")).toBe(true);

    streamMock.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-2",
            type: "function",
            function: {
              name: "edit_file",
              arguments: JSON.stringify({ path: "hello.txt", oldString: "line1", newString: "line2" }),
            },
          },
        ],
      },
    });
    streamMock.mockResolvedValueOnce({
      message: { role: "assistant", content: "done" },
      usage: { inputTokens: 12, outputTokens: 1 },
    });
    await runtime.prompt("edit it");

    const after = runtime.current!.fileChanges;
    expect(after).toHaveLength(2);
    expect(after[1].operation).toBe("edit_file");
    expect(after[1].diff).toContain("+ line2");
    expect(after[1].diff).toContain("- line1");

    // 持久化：从磁盘重新加载后记录仍在
    const { SessionStore } = await import("./session-store.js");
    const reloaded = await SessionStore.load(runtime.current!.filePath);
    expect(reloaded.fileChanges).toHaveLength(2);
    expect(reloaded.fileChanges[0].path).toBe("hello.txt");
  });
});

describe("AgentRuntime browser tools", () => {
  it("advertises browser tools only when the desktop browser host is connected", async () => {
    const withHostDir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const plainDir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));

    const withHost = new AgentRuntime({
      providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
      sessionsDir: withHostDir,
      browserHost: { execute: async () => ({ ok: false, error: "not used" }) },
    });
    await withHost.newSession();
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "ok" } });
    await withHost.prompt("hello");
    const withHostTools = (
      streamMock.mock.calls[0][0] as { tools: Array<{ function: { name: string } }> }
    ).tools;
    expect(withHostTools.map((tool) => tool.function.name)).toContain("browser_navigate");

    const plain = makeRuntime(plainDir);
    await plain.newSession();
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "ok" } });
    await plain.prompt("hello");
    const plainTools = (
      streamMock.mock.calls[1][0] as { tools: Array<{ function: { name: string } }> }
    ).tools;
    expect(plainTools.map((tool) => tool.function.name)).not.toContain("browser_navigate");
    expect(plainTools.map((tool) => tool.function.name)).toContain("task");
    // 治理默认 goal：根 runtime 多挂 admit 控制面工具
    expect(plainTools.map((tool) => tool.function.name)).toContain("admit");
    // 14 个内置工具 + admit + read_video
    expect(plainTools).toHaveLength(16);
  });

  it("dispatches browser tool calls to the host without approval and emits tool events", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const commands: BrowserHostCommand[] = [];
    const browserHost: BrowserHostClient = {
      async execute(command) {
        commands.push(command);
        return { ok: true, url: "http://localhost:4173/", title: "Demo", tabId: "browser-1" };
      },
    };
    const runtime = new AgentRuntime({
      providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
      sessionsDir: dir,
      browserHost,
    });
    await runtime.newSession();
    const events = await collectEvents(runtime);
    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "b1",
              type: "function",
              function: {
                name: "browser_navigate",
                arguments: JSON.stringify({ url: "http://localhost:4173/" }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    await runtime.prompt("open the page");

    expect(commands).toEqual([{ op: "navigate", url: "http://localhost:4173/" }]);
    expect(events.some((event) => event.type === "approval_required")).toBe(false);
    expect(events.some((event) => event.type === "tool_started" && event.tool === "browser_navigate")).toBe(true);
    expect(events.some((event) => event.type === "tool_finished" && event.ok)).toBe(true);
    const secondMessages = streamMock.mock.calls[1][0].messages as ChatMessage[];
    const toolMessage = secondMessages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("http://localhost:4173/");
  });

  it("blocks browser write actions in read-only mode", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const commands: BrowserHostCommand[] = [];
    const runtime = new AgentRuntime({
      providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
      sessionsDir: dir,
      browserHost: {
        async execute(command) {
          commands.push(command);
          return { ok: true };
        },
      },
    });
    await runtime.newSession();
    runtime.setApprovalMode("read-only");
    const events = await collectEvents(runtime);
    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "type",
              type: "function",
              function: { name: "browser_type", arguments: JSON.stringify({ text: "secret" }) },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    await runtime.prompt("type it");

    expect(commands).toEqual([]);
    expect(events.some((event) => event.type === "approval_required")).toBe(false);
    const output = events.find(
      (event): event is Extract<MeowEvent, { type: "tool_output" }> => event.type === "tool_output",
    )?.output;
    expect(output).toContain("read-only");
  });

  it("asks for approval before external navigation", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const commands: BrowserHostCommand[] = [];
    const runtime = new AgentRuntime({
      providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
      sessionsDir: dir,
      browserHost: {
        async execute(command) {
          commands.push(command);
          return { ok: true };
        },
      },
    });
    await runtime.newSession();
    const events = await collectEvents(runtime);
    const approvalEvent = new Promise<Extract<MeowEvent, { type: "approval_required" }>>(
      (resolve) => {
        runtime.onEvent((event) => {
          if (event.type === "approval_required") resolve(event);
        });
      },
    );
    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "nav",
              type: "function",
              function: {
                name: "browser_navigate",
                arguments: JSON.stringify({ url: "https://example.com/" }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    const prompt = runtime.prompt("open example");
    const approval = await approvalEvent;
    expect(approval.tool).toBe("browser_navigate");
    expect(commands).toEqual([]);
    runtime.respondToApproval(approval.callId, false);
    await prompt;

    expect(commands).toEqual([]);
    expect(
      events.some(
        (event) => event.type === "tool_output" && event.output.includes("User denied"),
      ),
    ).toBe(true);
  });

  it("attaches or drops screenshot images based on the provider image modality", async () => {
    const makeRunner = async (inputModalities: Array<"text" | "image">) => {
      const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
      return new AgentRuntime({
        providers: [
          {
            id: "p",
            name: "P",
            baseUrl: "http://localhost",
            model: "m",
            protocol: "openai-chat-completions",
            inputModalities,
          },
        ],
        sessionsDir: dir,
        browserHost: {
          execute: async () => ({
            ok: true,
            screenshotBase64: "AAA",
            mimeType: "image/png",
            url: "http://localhost:4173/",
            title: "Demo",
          }),
        },
      });
    };
    const screenshotCall = {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "s1",
            type: "function",
            function: { name: "browser_screenshot", arguments: "{}" },
          },
        ],
      },
    };
    const finalMessage = { message: { role: "assistant", content: "seen" } };

    const withImage = await makeRunner(["text", "image"]);
    await withImage.newSession();
    streamMock.mockResolvedValueOnce(screenshotCall).mockResolvedValueOnce(finalMessage);
    await withImage.prompt("take a screenshot");
    const attached = (streamMock.mock.calls[1][0].messages as ChatMessage[]).find(
      (message) => message.role === "tool",
    );
    expect(attached?.images).toHaveLength(1);
    expect(attached?.images?.[0].mimeType).toBe("image/png");

    streamMock.mockReset();
    const textOnly = await makeRunner(["text"]);
    await textOnly.newSession();
    streamMock.mockResolvedValueOnce(screenshotCall).mockResolvedValueOnce(finalMessage);
    await textOnly.prompt("take a screenshot");
    const fallback = (streamMock.mock.calls[1][0].messages as ChatMessage[]).find(
      (message) => message.role === "tool",
    );
    expect(fallback?.images).toBeUndefined();
    expect(fallback?.content).toContain("meowcode-screenshots");
  });

  it("passes user-attached images to the provider but keeps them out of the session file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = new AgentRuntime({
      providers: [
        {
          id: "p",
          name: "P",
          baseUrl: "http://localhost",
          model: "m",
          protocol: "openai-chat-completions",
          inputModalities: ["text", "image"],
        },
      ],
      sessionsDir: dir,
    });
    await runtime.newSession();
    expect(runtime.acceptsImages).toBe(true);
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "看到了" } });

    await runtime.prompt("这是什么", undefined, [{ data: "AAA", mimeType: "image/png" }]);

    const sent = (streamMock.mock.calls[0][0].messages as ChatMessage[]).find(
      (message) => message.role === "user",
    );
    expect(sent?.images).toEqual([{ data: "AAA", mimeType: "image/png" }]);
    // base64 不落盘：重载会话时只保留文字
    const raw = await readFile(runtime.current!.filePath, "utf8");
    expect(raw).not.toContain("AAA");
  });
});

describe("approval modes", () => {
  it("blocks mutating tools in read-only mode", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    await writeFile(path.join(workspace, "a.txt"), "hello");
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    runtime.setApprovalMode("read-only");
    const events = await collectEvents(runtime);
    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "write",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: "a.txt", content: "changed" }),
              },
            },
            {
              id: "edit",
              type: "function",
              function: {
                name: "edit_file",
                arguments: JSON.stringify({ path: "a.txt", oldString: "hello", newString: "bye" }),
              },
            },
            {
              id: "command",
              type: "function",
              function: { name: "run_command", arguments: JSON.stringify({ command: "echo hi" }) },
            },
            {
              id: "read",
              type: "function",
              function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    await runtime.prompt("go");

    expect(events.some((event) => event.type === "approval_required")).toBe(false);
    const outputs = events
      .filter(
        (event): event is Extract<MeowEvent, { type: "tool_output" }> => event.type === "tool_output",
      )
      .map((event) => event.output);
    expect(outputs.filter((output) => output.includes("read-only mode"))).toHaveLength(3);
    expect(outputs.some((output) => output.includes("1: hello"))).toBe(true);
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("hello");
  });

  it("skill 引用的回合不受权限模式约束", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("ask");
    const events = await collectEvents(runtime);
    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "write",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: "skill.txt", content: "ok" }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    await runtime.prompt("【插件引用】demo-plugin · demo-plugin\n【技能引用】demo · demo\n\n执行技能");

    expect(events.some((event) => event.type === "approval_required")).toBe(false);
    expect(await readFile(path.join(workspace, "skill.txt"), "utf8")).toBe("ok");
  });

  it("applies multi_edit in full-access mode and records one file change", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    await writeFile(path.join(workspace, "a.txt"), "one\ntwo\nthree\n");
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    const events = await collectEvents(runtime);
    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "multi",
              type: "function",
              function: {
                name: "multi_edit",
                arguments: JSON.stringify({
                  path: "a.txt",
                  edits: [
                    { oldString: "one", newString: "1" },
                    { oldString: "three", newString: "3" },
                  ],
                }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    await runtime.prompt("go");

    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("1\ntwo\n3\n");
    const changed = events.filter((event) => event.type === "file_changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ path: "a.txt", operation: "edit_file" });
  });

  it("settles a pending approval when steering a queued prompt", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    // 该用例验证"待审批被插话结算"，需要每次询问模式（默认 auto 会在工作区内自动批准）
    await runtime.setApprovalMode("ask");
    streamMock.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "write",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: "a.txt", content: "x" }),
            },
          },
        ],
      },
    });
    streamMock.mockImplementation((options: { signal?: AbortSignal }) => {
      if (options?.signal?.aborted) return Promise.reject(new Error("Aborted"));
      return Promise.resolve({ message: { role: "assistant", content: "queued done" } });
    });
    const approvalEvent = new Promise<Extract<MeowEvent, { type: "approval_required" }>>(
      (resolve) => {
        runtime.onEvent((event) => {
          if (event.type === "approval_required") resolve(event);
        });
      },
    );
    const first = runtime.prompt("first");
    await approvalEvent;
    await runtime.prompt("second", "q1"); // 运行中 → 入队
    runtime.steerQueuedPrompt("q1");
    expect(runtime.pendingApproval).toBeNull();
    await first;
    expect(runtime.isRunning).toBe(false);
    expect(
      runtime.current?.messages.some(
        (message) => message.role === "user" && message.content === "second",
      ),
    ).toBe(true);
  });

  it("attaches risk details to a dangerous command approval", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "danger",
              type: "function",
              function: { name: "run_command", arguments: JSON.stringify({ command: "diskpart" }) },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    const approvalEvent = new Promise<Extract<MeowEvent, { type: "approval_required" }>>(
      (resolve) => {
        runtime.onEvent((event) => {
          if (event.type === "approval_required") resolve(event);
        });
      },
    );
    const prompt = runtime.prompt("go");
    const approval = await approvalEvent;
    expect(approval.risk?.level).toBe("high");
    expect(approval.risk?.reasons.length).toBeGreaterThan(0);
    runtime.respondToApproval(approval.callId, false);
    await prompt;
  });

  it("keeps the approval mode captured at turn start when switching sessions", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    const events = await collectEvents(runtime);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    streamMock
      .mockImplementationOnce(async () => {
        await gate;
        return {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "write",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "a.txt", content: "hello" }),
                },
              },
            ],
          },
        };
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });
    // 如果模式被会话切换重置，会卡在审批：自动拒绝以便测试失败而不是超时
    runtime.onEvent((event) => {
      if (event.type === "approval_required") runtime.respondToApproval(event.callId, false);
    });

    const running = runtime.prompt("go");
    const original = runtime.current!;
    await runtime.newSession();
    expect(runtime.current!.id).not.toBe(original.id);
    release();
    await running;

    expect(events.some((event) => event.type === "approval_required")).toBe(false);
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("hello");
  });
});

describe("turn ownership", () => {
  it("settles a pending approval when the turn is aborted", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    const events = await collectEvents(runtime);
    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "danger",
              type: "function",
              function: { name: "run_command", arguments: JSON.stringify({ command: "echo hi" }) },
            },
          ],
        },
      })
      .mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));

    const approvalEvent = new Promise<Extract<MeowEvent, { type: "approval_required" }>>(
      (resolve) => {
        runtime.onEvent((event) => {
          if (event.type === "approval_required") resolve(event);
        });
      },
    );
    const prompt = runtime.prompt("go");
    const approval = await approvalEvent;
    expect(runtime.pendingApproval).toMatchObject({
      callId: approval.callId,
      sessionId: runtime.current!.id,
      tool: "run_command",
      input: { command: "echo hi" },
    });

    runtime.abort();
    await Promise.race([
      prompt,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("turn did not settle after abort")), 1000),
      ),
    ]);

    expect(runtime.pendingApproval).toBeNull();
    expect(runtime.isRunning).toBe(false);
    expect(events.some((event) => event.type === "turn_complete")).toBe(true);
  });

  it("clears pending approval details after a response", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call",
              type: "function",
              function: { name: "run_command", arguments: JSON.stringify({ command: "echo hi" }) },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });
    const approvalEvent = new Promise<Extract<MeowEvent, { type: "approval_required" }>>(
      (resolve) => {
        runtime.onEvent((event) => {
          if (event.type === "approval_required") resolve(event);
        });
      },
    );
    const prompt = runtime.prompt("go");
    const approval = await approvalEvent;
    expect(runtime.pendingApproval?.sessionId).toBe(runtime.current!.id);
    runtime.respondToApproval(approval.callId, false);
    expect(runtime.pendingApproval).toBeNull();
    await prompt;
  });

  it("rejects prompts for another conversation while a turn is running", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    streamMock.mockImplementation((options: { signal?: AbortSignal }) => {
      return new Promise<never>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    });

    const original = runtime.current!;
    const running = runtime.prompt("first");
    expect(runtime.isRunning).toBe(true);
    expect(runtime.canAcceptPrompt).toBe(true); // 同会话可以排队

    await runtime.newSession();
    expect(runtime.canAcceptPrompt).toBe(false);
    await expect(runtime.prompt("second")).rejects.toThrow(/Another conversation/);

    await runtime.switchSession(original.filePath);
    expect(runtime.canAcceptPrompt).toBe(true);
    runtime.abort();
    await running;
    expect(runtime.isRunning).toBe(false);
  });
});

describe("response truncation", () => {
  it("surfaces a length finish reason as an error", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    const events = await collectEvents(runtime);
    streamMock.mockResolvedValueOnce({
      message: { role: "assistant", content: "partial" },
      finishReason: "length",
    });

    await runtime.prompt("go");

    expect(
      events.some((event) => event.type === "message_complete" && event.text === "partial"),
    ).toBe(true);
    const error = events.find(
      (event): event is Extract<MeowEvent, { type: "error" }> => event.type === "error",
    );
    expect(error?.message).toContain("truncated");
  });

  it("does not execute tool calls from a truncated response", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    const events = await collectEvents(runtime);
    streamMock.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "write",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: "a.txt", content: "should not exist" }),
            },
          },
        ],
      },
      finishReason: "length",
    });

    await runtime.prompt("go");

    await expect(readFile(path.join(workspace, "a.txt"), "utf8")).rejects.toThrow();
    const error = events.find(
      (event): event is Extract<MeowEvent, { type: "error" }> => event.type === "error",
    );
    expect(error?.message).toContain("truncated during a tool call");

    // 截断的 tool_call 也要有配对的 tool 结果，历史才能继续使用
    const { SessionStore } = await import("./session-store.js");
    const reloaded = await SessionStore.load(runtime.current!.filePath);
    expect(reloaded.effectiveMessages.filter((message) => message.role === "tool")).toHaveLength(1);
  });
});

describe("usage persistence", () => {
  it("persists provider usage to the session", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    streamMock.mockResolvedValueOnce({
      message: { role: "assistant", content: "ok" },
      usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 80 },
    });

    await runtime.prompt("hi");

    const { SessionStore } = await import("./session-store.js");
    const reloaded = await SessionStore.load(runtime.current!.filePath);
    expect(reloaded.usageTotals).toMatchObject({
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 80,
      cacheInputTokens: 120,
      cacheReported: true,
      hasUsage: true,
    });
  });

  it("persists turn timing metrics", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    streamMock.mockImplementationOnce(
      async (options: { onDelta?: (delta: string) => void }) => {
        options.onDelta?.("hello");
        return {
          message: { role: "assistant", content: "hello" },
          usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5 },
        };
      },
    );

    await runtime.prompt("hi");

    const { SessionStore } = await import("./session-store.js");
    const reloaded = await SessionStore.load(runtime.current!.filePath);
    const metrics = reloaded.lastTurnMetrics;
    expect(typeof metrics?.responseMs).toBe("number");
    expect(typeof metrics?.firstTokenMs).toBe("number");
  });
});

describe("workspace instructions", () => {  it("injects AGENTS.md and refreshes it between turns", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    await writeFile(path.join(workspace, "AGENTS.md"), "RULE ONE");
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);

    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "ok" } });
    await runtime.prompt("hi");
    const first = streamMock.mock.calls[0][0].messages as ChatMessage[];
    const firstSystems = first.filter(
      (message): message is Extract<ChatMessage, { role: "system" }> => message.role === "system",
    );
    expect(firstSystems).toHaveLength(2);
    expect(firstSystems[0].content).toContain("You are MeowCode");
    expect(firstSystems[1].content).toContain("RULE ONE");

    await writeFile(path.join(workspace, "AGENTS.md"), "RULE TWO");
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "again" } });
    await runtime.prompt("again");
    const second = streamMock.mock.calls[1][0].messages as ChatMessage[];
    const secondSystems = second.filter(
      (message): message is Extract<ChatMessage, { role: "system" }> => message.role === "system",
    );
    expect(secondSystems[0]).toEqual(firstSystems[0]);
    expect(secondSystems[1].content).toContain("RULE TWO");
  });

  it("keeps the base prompt first and mode instructions last across modes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    await writeFile(path.join(workspace, "AGENTS.md"), "RULE ONE");
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setSessionMode("plan");

    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "ok" } });
    await runtime.prompt("plan something");
    const sent = streamMock.mock.calls[0][0].messages as ChatMessage[];
    const systems = sent.filter(
      (message): message is Extract<ChatMessage, { role: "system" }> => message.role === "system",
    );
    // 顺序锁死：稳定基础提示 → 工作区规则（可变）→ 模式指令（尾随）。
    // Anthropic 双断点依赖这个顺序：前缀缓存不被可变段冲掉。
    expect(systems[0].content).toContain("You are MeowCode");
    expect(systems[1].content).toContain("RULE ONE");
    expect(systems.at(-1)?.content).toContain("plan");
    expect(systems[0].content).not.toContain("RULE ONE");
  });
});

describe("parallel read-only tools", () => {
  it("executes a batch of reads and keeps result order", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    await writeFile(path.join(workspace, "a.txt"), "AAA");
    await writeFile(path.join(workspace, "b.txt"), "BBB");
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    const events = await collectEvents(runtime);
    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "a",
              type: "function",
              function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) },
            },
            {
              id: "b",
              type: "function",
              function: { name: "read_file", arguments: JSON.stringify({ path: "b.txt" }) },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    await runtime.prompt("read both");

    const toolMessages = (streamMock.mock.calls[1][0].messages as ChatMessage[]).filter(
      (message): message is Extract<ChatMessage, { role: "tool" }> => message.role === "tool",
    );
    expect(toolMessages.map((message) => message.tool_call_id)).toEqual(["a", "b"]);
    expect(toolMessages[0].content).toContain("1: AAA");
    expect(toolMessages[1].content).toContain("1: BBB");

    const started = events
      .filter(
        (event): event is Extract<MeowEvent, { type: "tool_started" }> =>
          event.type === "tool_started",
      )
      .map((event) => event.callId);
    expect(started).toEqual(["a", "b"]);
  });
});

describe("midstream early tool execution (experimental)", () => {
  const makeEarlyRuntime = (dir: string) =>
    new AgentRuntime({
      providers: [{ id: "p", name: "P", baseUrl: "http://localhost", model: "m" }],
      sessionsDir: dir,
      experimental: { midstreamToolExec: true },
    });

  it("starts a read-only tool midstream and lands the result exactly once", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    await writeFile(path.join(workspace, "a.txt"), "AAA");
    const runtime = makeEarlyRuntime(dir);
    await runtime.newSession(workspace);
    const events = await collectEvents(runtime);

    let startedBeforeStreamEnd = false;
    streamMock.mockImplementationOnce(
      async (options: {
        onToolCallComplete?: (call: unknown) => void;
        onDelta?: (delta: string) => void;
      }) => {
        // 流中途：参数闭合 → runtime 立即启动只读工具执行
        options.onToolCallComplete?.({
          id: "call-1",
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        // 流还没结束，tool_started 已发出（提前执行已启动）
        startedBeforeStreamEnd = events.some((event) => event.type === "tool_started");
        options.onDelta?.("ok");
        return {
          message: {
            role: "assistant",
            content: "ok",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) },
              },
            ],
          },
          usage: { inputTokens: 10, outputTokens: 1 },
        };
      },
    );

    await runtime.prompt("read a.txt");

    expect(startedBeforeStreamEnd).toBe(true);
    // 只执行了一次：分派阶段复用提前执行的结果，tool_started 不重复
    expect(events.filter((event) => event.type === "tool_started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool_finished")).toHaveLength(1);
    // 结果按 callId 落盘，模型下一轮能读到内容
    const toolMessages = (streamMock.mock.calls[1][0].messages as ChatMessage[]).filter(
      (message): message is Extract<ChatMessage, { role: "tool" }> => message.role === "tool",
    );
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].tool_call_id).toBe("call-1");
    expect(toolMessages[0].content).toContain("AAA");
  });

  it("does not register the callback when the switch is off", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    streamMock.mockImplementationOnce(async (options: {
      onToolCallComplete?: unknown;
    }) => {
      // 默认关闭：runtime 根本不传回调，行为与改动前完全一致
      expect(options.onToolCallComplete).toBeUndefined();
      return { message: { role: "assistant", content: "ok" } };
    });
    await runtime.prompt("hi");
    expect(streamMock).toHaveBeenCalledTimes(1);
  });
});

describe("prompt queue", () => {
  it("runs a prompt queued during an active turn", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    const events = await collectEvents(runtime);
    let release!: (value: { message: { role: "assistant"; content: string } }) => void;
    streamMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce({ message: { role: "assistant", content: "second done" } });

    const first = runtime.prompt("first");
    await vi.waitFor(() => expect(streamMock).toHaveBeenCalledTimes(1));
    expect(runtime.activeTurnSessionId).toBe(runtime.current!.id);
    await runtime.prompt("second", "q-second");
    release({ message: { role: "assistant", content: "first done" } });
    await first;

    expect(runtime.activeTurnSessionId).toBeNull();
    expect(streamMock).toHaveBeenCalledTimes(2);
    const secondRequest = streamMock.mock.calls[1][0].messages as ChatMessage[];
    expect(
      secondRequest.some((message) => message.role === "user" && message.content === "second"),
    ).toBe(true);
    const starts = events.filter(
      (event): event is Extract<MeowEvent, { type: "message_start" }> =>
        event.type === "message_start",
    );
    expect(starts).toHaveLength(2);
    expect(starts[0].queuedId).toBeUndefined();
    expect(starts[1].queuedId).toBe("q-second");
    expect(events.filter((event) => event.type === "turn_complete")).toHaveLength(2);

    const { SessionStore } = await import("./session-store.js");
    const reloaded = await SessionStore.load(runtime.current!.filePath);
    expect(
      reloaded.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual(["first", "second"]);
  });

  it("removes a queued prompt by id", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    let release!: (value: { message: { role: "assistant"; content: string } }) => void;
    streamMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce({ message: { role: "assistant", content: "kept" } });

    const first = runtime.prompt("first");
    await vi.waitFor(() => expect(streamMock).toHaveBeenCalledTimes(1));
    await runtime.prompt("drop me", "q-drop");
    await runtime.prompt("keep me", "q-keep");
    expect(runtime.removeQueuedPrompt("q-drop")).toBe(true);
    expect(runtime.removeQueuedPrompt("q-drop")).toBe(false);
    release({ message: { role: "assistant", content: "first done" } });
    await first;

    expect(streamMock).toHaveBeenCalledTimes(2);
    const secondRequest = streamMock.mock.calls[1][0].messages as ChatMessage[];
    expect(secondRequest.some((message) => message.role === "user" && message.content === "keep me")).toBe(true);
    expect(secondRequest.some((message) => message.role === "user" && message.content === "drop me")).toBe(false);

    const { SessionStore } = await import("./session-store.js");
    const reloaded = await SessionStore.load(runtime.current!.filePath);
    expect(
      reloaded.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual(["first", "keep me"]);
  });

  it("steers a queued prompt by aborting the active turn", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    const events = await collectEvents(runtime);
    streamMock
      .mockImplementationOnce((options: { signal?: AbortSignal }) => {
        const signal = options?.signal;
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("Aborted")));
        });
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "two done" } })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "one done" } });

    const first = runtime.prompt("first");
    await vi.waitFor(() => expect(streamMock).toHaveBeenCalledTimes(1));
    await runtime.prompt("one", "q-one");
    await runtime.prompt("two", "q-two");
    runtime.steerQueuedPrompt("q-two");
    await first;

    expect(streamMock).toHaveBeenCalledTimes(3);
    const starts = events.filter(
      (event): event is Extract<MeowEvent, { type: "message_start" }> =>
        event.type === "message_start",
    );
    expect(starts.map((event) => event.queuedId)).toEqual([undefined, "q-two", "q-one"]);

    const { SessionStore } = await import("./session-store.js");
    const reloaded = await SessionStore.load(runtime.current!.filePath);
    expect(
      reloaded.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual(["first", "two", "one"]);
  });

  it("drops queued prompts when the turn is aborted", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    const events = await collectEvents(runtime);
    streamMock.mockImplementationOnce((options: { signal?: AbortSignal }) => {
      const signal = options?.signal;
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () =>
          reject(new DOMException("This operation was aborted", "AbortError")),
        );
      });
    });

    const first = runtime.prompt("first");
    await vi.waitFor(() => expect(streamMock).toHaveBeenCalledTimes(1));
    await runtime.prompt("queued");
    runtime.abort();
    await first;

    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.some((event) => event.type === "turn_complete")).toBe(true);
    const { SessionStore } = await import("./session-store.js");
    const reloaded = await SessionStore.load(runtime.current!.filePath);
    expect(reloaded.messages.filter((message) => message.role === "user")).toHaveLength(1);
  });

  it("still surfaces non-abort failures", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession();
    const events = await collectEvents(runtime);
    streamMock.mockRejectedValueOnce(new Error("provider exploded"));

    await runtime.prompt("hi");

    const error = events.find(
      (event): event is Extract<MeowEvent, { type: "error" }> => event.type === "error",
    );
    expect(error?.message).toContain("provider exploded");
  });
});

describe("abort safety", () => {
  it("does not execute later tool calls after abort", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    const events = await collectEvents(runtime);
    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "cmd",
              type: "function",
              function: {
                name: "run_command",
                arguments: JSON.stringify({ command: "Start-Sleep -Seconds 30" }),
              },
            },
            {
              id: "write",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: "a.txt", content: "should not exist" }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    const prompt = runtime.prompt("go");
    await vi.waitFor(() =>
      expect(
        events.some((event) => event.type === "tool_started" && event.tool === "run_command"),
      ).toBe(true),
    );
    runtime.abort();
    await prompt;

    await expect(readFile(path.join(workspace, "a.txt"), "utf8")).rejects.toThrow();
    const outputs = events.filter(
      (event): event is Extract<MeowEvent, { type: "tool_output" }> =>
        event.type === "tool_output",
    );
    expect(outputs.some((event) => event.output.includes("aborted"))).toBe(true);
  });
});


describe("AgentRuntime file mentions", () => {
  it("injects referenced workspace files and ignores paths outside", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    const outside = await mkdtemp(path.join(tmpdir(), "meowcode-outside-"));
    await writeFile(path.join(workspace, "note file.txt"), "hello from file");
    await writeFile(path.join(workspace, "code.ts"), "const x = 1;");
    await writeFile(path.join(outside, "secret.txt"), "top secret");
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    await runtime.prompt(
      `read @"note file.txt" and @code.ts, not @${path.join(outside, "secret.txt")}`,
    );

    const request = streamMock.mock.calls[0]?.[0] as { messages: ChatMessage[] };
    const joined = request.messages.map((message) => message.content ?? "").join("\n---\n");
    expect(joined).toContain("hello from file");
    expect(joined).toContain("const x = 1;");
    expect(joined).not.toContain("top secret");
    // 会话里只保存用户原文，文件内容作为不显示的上下文条目
    expect(
      runtime.current?.messages.some(
        (message) => message.role === "user" && message.content?.includes("@code.ts"),
      ),
    ).toBe(true);
    expect(runtime.current?.entries.some((entry) => entry.type === "context_note")).toBe(true);
  });

  it("re-injects a file that the agent edited after the earlier injection", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    await writeFile(path.join(workspace, "code.ts"), "const x = 1;");
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");

    // 第一轮：@ 注入旧内容
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "read" } });
    await runtime.prompt("@code.ts");

    // 第二轮：模型改这个文件
    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "edit-1",
              type: "function",
              function: {
                name: "edit_file",
                arguments: JSON.stringify({
                  path: "code.ts",
                  oldString: "const x = 1;",
                  newString: "const x = 2;",
                }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "edited" } });
    await runtime.prompt("change it");

    // 第三轮：再次 @ 同一文件 —— 历史里那份内容已过期，必须重新注入而不是给"已读"占位
    // messages 是运行时活引用，必须在调用瞬间快照，否则会被本轮后续消息污染
    let captured: ChatMessage[] = [];
    streamMock.mockImplementationOnce(async (request: { messages: ChatMessage[] }) => {
      captured = request.messages.map((message) => ({ ...message }));
      return { message: { role: "assistant", content: "ok" } };
    });
    await runtime.prompt("@code.ts again");

    const lastNote = [...captured]
      .reverse()
      .find(
        (message) =>
          message.role === "user" &&
          (message.content ?? "").includes("The user referenced these workspace files"),
      )?.content ?? "";
    expect(lastNote).toContain("Result of calling the read_file tool");
    expect(lastNote).toContain("const x = 2;");
    expect(lastNote).not.toContain("Already read earlier");
  });
});

describe("AgentRuntime tool argument validation", () => {
  it("rejects invalid JSON and missing required fields without executing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    await writeFile(path.join(workspace, "a.txt"), "original");
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    const events = await collectEvents(runtime);
    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "bad-json",
              type: "function",
              function: { name: "write_file", arguments: '{"path":' },
            },
            {
              id: "missing-content",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ path: "a.txt" }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    await runtime.prompt("go");

    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("original");
    await expect(readFile(path.join(workspace, "undefined"), "utf8")).rejects.toThrow();
    const outputs = events
      .filter(
        (event): event is Extract<MeowEvent, { type: "tool_output" }> =>
          event.type === "tool_output",
      )
      .map((event) => event.output);
    expect(outputs.filter((output) => output.includes("Tool call rejected"))).toHaveLength(2);
    expect(events.some((event) => event.type === "approval_required")).toBe(false);
  });
});

describe("AgentRuntime compaction request budget", () => {
  it("caps the summary request max tokens to the reserved output budget", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = new AgentRuntime({
      providers: [
        {
          id: "p",
          name: "P",
          baseUrl: "http://localhost",
          model: "m",
          contextWindow: 8_000,
          maxTokens: 4_096,
        },
      ],
      sessionsDir: dir,
    });
    await runtime.newSession();
    await runtime.current?.appendMessage({ role: "user", content: "hello" });
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "SUMMARY" } });

    await runtime.compactSession();

    const request = streamMock.mock.calls[0]?.[0] as { provider: { maxTokens?: number } };
    expect(request.provider.maxTokens).toBe(2_048);
  });
});

describe("AgentRuntime session restore", () => {
  it("restores the preferred session and falls back to the latest for the workspace", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    const first = makeRuntime(dir);
    const firstHeader = await first.newSession(workspace);
    await first.current?.appendMessage({ role: "user", content: "first" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const secondHeader = await first.newSession(workspace);

    const restored = makeRuntime(dir);
    await restored.restore(workspace, firstHeader.filePath);
    expect(restored.current?.filePath).toBe(firstHeader.filePath);

    const fallback = makeRuntime(dir);
    await fallback.restore(workspace, path.join(dir, "missing.jsonl"));
    expect(fallback.current?.filePath).toBe(secondHeader.filePath);
  });
});

describe("AgentRuntime turn durability", () => {
  it("persists turn_start/turn_end and restores approval mode", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("read-only");
    streamMock.mockResolvedValueOnce({
      message: { role: "assistant", content: "done" },
      finishReason: "stop",
    });

    await runtime.prompt("hello");

    const filePath = runtime.current!.filePath;
    const store = await SessionStore.load(filePath);
    expect(store.openTurns).toEqual([]);
    expect(store.lastTurnEnd?.status).toBe("completed");
    expect(store.sessionSettings?.approvalMode).toBe("read-only");
    await store.close();

    const restored = makeRuntime(dir);
    await restored.switchSession(filePath);
    expect(restored.currentApprovalMode).toBe("read-only");
    expect(restored.current?.messages.map((message) => message.content)).toEqual(["hello", "done"]);
  });

  it("writes queued prompts to disk while a turn is running", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    streamMock.mockImplementationOnce(
      (options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          if (options.signal?.aborted) {
            reject(new Error("Aborted"));
            return;
          }
          options.signal?.addEventListener("abort", () => reject(new Error("Aborted")));
        }),
    );

    const running = runtime.prompt("first");
    for (let attempt = 0; attempt < 100 && !runtime.isRunning; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await runtime.prompt("second", "queue-2");

    const store = await SessionStore.load(runtime.current!.filePath);
    expect(
      store.entries.some(
        (entry) => entry.type === "queued_prompt" && entry.queueId === "queue-2",
      ),
    ).toBe(true);
    await store.close();

    runtime.abort();
    await running;
  });

  it("persists a partial assistant message when the turn is aborted", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    streamMock.mockImplementationOnce(
      (options: { signal?: AbortSignal; onDelta?: (delta: string) => void }) =>
        new Promise((_resolve, reject) => {
          options.onDelta?.("half an answer");
          const abort = () => reject(new Error("Aborted"));
          if (options.signal?.aborted) abort();
          else options.signal?.addEventListener("abort", abort);
        }),
    );

    const running = runtime.prompt("hello");
    for (let attempt = 0; attempt < 100 && !runtime.isRunning; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    runtime.abort();
    await running;

    const store = await SessionStore.load(runtime.current!.filePath);
    expect(store.messages.some(
      (message) => message.role === "assistant" && message.content === "half an answer",
    )).toBe(true);
    expect(store.lastTurnEnd?.status).toBe("aborted");
    await store.close();
  });

  it("keeps queued prompts across a graceful shutdown", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    const runtime = makeRuntime(dir);
    const header = await runtime.newSession(workspace);
    streamMock.mockImplementationOnce(
      (options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const abort = () => reject(new Error("Aborted"));
          if (options.signal?.aborted) abort();
          else options.signal?.addEventListener("abort", abort);
        }),
    );

    const running = runtime.prompt("first");
    for (let attempt = 0; attempt < 100 && !runtime.isRunning; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await runtime.prompt("second", "q-shutdown");
    runtime.shutdown();
    await running;

    streamMock.mockClear();
    const restored = makeRuntime(dir);
    await restored.switchSession(header.filePath);
    expect(restored.recoveredPrompts).toEqual([{ id: "q-shutdown", text: "second" }]);
    expect(streamMock).not.toHaveBeenCalled();
  });

  it("restores unexecuted queue items without auto-running them", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    const runtime = makeRuntime(dir);
    const header = await runtime.newSession(workspace);
    const store = await SessionStore.load(header.filePath);
    await store.appendQueuedPrompt("q1", "send me later");
    await store.close();

    streamMock.mockClear();
    const restored = makeRuntime(dir);
    await restored.switchSession(header.filePath);
    expect(restored.recoveredPrompts).toEqual([{ id: "q1", text: "send me later" }]);
    expect(streamMock).not.toHaveBeenCalled();
  });
});

describe("approval mode: writable roots", () => {
  const setup = async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    const events = await collectEvents(runtime);
    return { runtime, workspace, events };
  };

  const toolCall = (id: string, name: string, args: unknown) => ({
    message: {
      role: "assistant" as const,
      content: null,
      tool_calls: [
        { id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } },
      ],
    },
  });

  it("new sessions start in auto mode", async () => {
    const { runtime } = await setup();
    expect(runtime.currentApprovalMode).toBe("auto");
  });

  it("auto-approves a write inside the workspace without prompting", async () => {
    const { runtime, workspace, events } = await setup();
    await writeFile(path.join(workspace, "a.txt"), "hello");
    streamMock
      .mockResolvedValueOnce(toolCall("w1", "write_file", { path: "a.txt", content: "bye" }))
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    await runtime.prompt("go");

    expect(events.some((event) => event.type === "approval_required")).toBe(false);
    expect(runtime.pendingApprovalList).toHaveLength(0);
    expect(await readFile(path.join(workspace, "a.txt"), "utf8")).toBe("bye");
  });

  it("still asks before running a command", async () => {
    const { runtime, events } = await setup();
    streamMock
      .mockResolvedValueOnce(toolCall("c1", "run_command", { command: "echo hi" }))
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    const promptPromise = runtime.prompt("go");
    await vi.waitFor(() => {
      expect(runtime.pendingApprovalList).toHaveLength(1);
    });
    expect(runtime.pendingApprovalList[0]).toMatchObject({ tool: "run_command" });
    runtime.respondToApproval("c1", false);
    await promptPromise;

    expect(events.some((event) => event.type === "approval_required")).toBe(true);
  });

  it("rejects a path outside the workspace without asking", async () => {
    const { runtime, events } = await setup();
    const outside = path.join(tmpdir(), `meowcode-outside-${Date.now()}.txt`);
    streamMock
      .mockResolvedValueOnce(toolCall("w2", "write_file", { path: outside, content: "x" }))
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    await runtime.prompt("go");

    expect(events.some((event) => event.type === "approval_required")).toBe(false);
    const outputs = events
      .filter(
        (event): event is Extract<MeowEvent, { type: "tool_output" }> => event.type === "tool_output",
      )
      .map((event) => event.output);
    expect(outputs.some((output) => output.includes("outside the workspace"))).toBe(true);
    await expect(readFile(outside, "utf8")).rejects.toThrow();
  });

  it("maps the legacy default mode to ask", () => {
    expect(normalizeApprovalMode("default")).toBe("ask");
    expect(normalizeApprovalMode("auto")).toBe("auto");
    expect(normalizeApprovalMode(undefined)).toBe("auto");
  });
});

describe("AgentRuntime approval staleness", () => {
  const editCall = (id: string, path: string, oldString: string, newString: string) => ({
    id,
    type: "function" as const,
    function: { name: "edit_file", arguments: JSON.stringify({ path, oldString, newString }) },
  });

  const approvalsOf = (events: MeowEvent[]) =>
    events.filter(
      (event): event is Extract<MeowEvent, { type: "approval_required" }> =>
        event.type === "approval_required",
    );

  it("re-asks once when the file changes while the approval is open", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    const file = path.join(workspace, "code.ts");
    await writeFile(file, "const x = 1;\nconst y = 1;\n");
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    runtime.setApprovalMode("ask");
    const events = await collectEvents(runtime);

    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [editCall("edit-1", "code.ts", "const x = 1;", "const x = 10;")],
        },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    const prompt = runtime.prompt("edit it");
    await vi.waitFor(() => expect(approvalsOf(events)).toHaveLength(1));
    const first = approvalsOf(events)[0];

    // 用户思考期间手动改了同一文件的另一行
    await writeFile(file, "const x = 1;\nconst y = 2;\n");
    runtime.respondToApproval(first.callId, true);

    await vi.waitFor(() => expect(approvalsOf(events)).toHaveLength(2));
    const second = approvalsOf(events)[1];
    expect(second.stale).toBe(true);
    // 新预览基于改动后的内容
    expect(second.diff).toContain("const y = 2;");

    runtime.respondToApproval(second.callId, true);
    await prompt;

    expect(await readFile(file, "utf8")).toBe("const x = 10;\nconst y = 2;\n");
    expect(
      runtime.current?.entries.some(
        (entry) => entry.type === "approval" && entry.reason === "stale_rechecked",
      ),
    ).toBe(true);
  });

  it("writes nothing when the file keeps changing during the second approval", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    const file = path.join(workspace, "code.ts");
    await writeFile(file, "const x = 1;\nconst y = 1;\n");
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    runtime.setApprovalMode("ask");
    const events = await collectEvents(runtime);

    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [editCall("edit-2", "code.ts", "const x = 1;", "const x = 10;")],
        },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    const prompt = runtime.prompt("edit it");
    await vi.waitFor(() => expect(approvalsOf(events)).toHaveLength(1));
    const first = approvalsOf(events)[0];
    await writeFile(file, "const x = 1;\nconst y = 2;\n");
    runtime.respondToApproval(first.callId, true);

    await vi.waitFor(() => expect(approvalsOf(events)).toHaveLength(2));
    const second = approvalsOf(events)[1];
    // 第二次弹窗还开着时又改了一次
    await writeFile(file, "const x = 1;\nconst y = 3;\n");
    runtime.respondToApproval(second.callId, true);
    await prompt;

    // 放弃执行，避免"批的是 A、写的是 B"
    expect(await readFile(file, "utf8")).toBe("const x = 1;\nconst y = 3;\n");
    const outputs = events
      .filter(
        (event): event is Extract<MeowEvent, { type: "tool_output" }> =>
          event.type === "tool_output",
      )
      .map((event) => event.output);
    expect(outputs.some((output) => output.includes("kept changing"))).toBe(true);
  });

  it("previews and records every file touched by a cross-file multi_edit", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    const a = path.join(workspace, "a.ts");
    const b = path.join(workspace, "b.ts");
    await writeFile(a, "const a = 1;\n");
    await writeFile(b, "const b = 2;\n");
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    runtime.setApprovalMode("ask");
    const events = await collectEvents(runtime);

    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "multi-1",
              type: "function",
              function: {
                name: "multi_edit",
                arguments: JSON.stringify({
                  edits: [
                    { path: "a.ts", oldString: "const a = 1;", newString: "const a = 10;" },
                    { path: "b.ts", oldString: "const b = 2;", newString: "const b = 20;" },
                  ],
                }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    const prompt = runtime.prompt("batch edit");
    await vi.waitFor(() => expect(approvalsOf(events)).toHaveLength(1));
    const approval = approvalsOf(events)[0];
    // 审批预览必须同时展示两个文件，否则就是"看不见的批准"
    expect(approval.diff).toContain("a.ts");
    expect(approval.diff).toContain("b.ts");
    expect(approval.diff).toContain("2 files");

    runtime.respondToApproval(approval.callId, true);
    await prompt;

    expect(await readFile(a, "utf8")).toBe("const a = 10;\n");
    expect(await readFile(b, "utf8")).toBe("const b = 20;\n");
    const changed = events
      .filter((event): event is Extract<MeowEvent, { type: "file_changed" }> =>
        event.type === "file_changed",
      )
      .map((event) => event.path)
      .sort();
    expect(changed).toEqual(["a.ts", "b.ts"]);
  });
});

describe("session modes", () => {
  /** 一次 prompt 里发多个工具调用，随后收尾 */
  function toolTurn(calls: Array<{ id: string; name: string; args: unknown }>) {
    return {
      message: {
        role: "assistant",
        content: null,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      },
    };
  }

  it("auto-approves plan documents under plans/ and emits plan_documented", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    // 默认 auto：即使不是 plan 模式也会自动批准，这里验证 reason 必须是 plan_mode
    await runtime.setSessionMode("plan");
    const events = await collectEvents(runtime);
    streamMock
      .mockResolvedValueOnce(
        toolTurn([
          {
            id: "plan-doc",
            name: "write_file",
            args: { path: "plans/2026-10-17-refactor.md", content: "# Plan\n" },
          },
        ]),
      )
      .mockResolvedValueOnce({ message: { role: "assistant", content: "plan written" } });

    await runtime.prompt("plan it");

    const session = runtime.current!;
    expect(await readFile(path.join(workspace, "plans", "2026-10-17-refactor.md"), "utf8")).toBe(
      "# Plan\n",
    );
    expect(events.some((event) => event.type === "approval_required")).toBe(false);
    const approvals = session.entries.filter(
      (entry): entry is Extract<typeof entry, { type: "approval" }> => entry.type === "approval",
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ approved: true, reason: "plan_mode", tool: "write_file" });
    const documented = events.filter(
      (event): event is Extract<MeowEvent, { type: "plan_documented" }> =>
        event.type === "plan_documented",
    );
    expect(documented).toHaveLength(1);
    expect(documented[0].path).toBe(path.join("plans", "2026-10-17-refactor.md"));
  });

  it("rejects writes outside plans/, commands and subagents in plan mode", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setSessionMode("plan");
    const events = await collectEvents(runtime);
    streamMock
      .mockResolvedValueOnce(
        toolTurn([
          { id: "src-write", name: "write_file", args: { path: "src/x.ts", content: "x" } },
          { id: "cmd", name: "run_command", args: { command: "echo hi" } },
          { id: "sub", name: "task", args: { description: "look around" } },
        ]),
      )
      .mockResolvedValueOnce({ message: { role: "assistant", content: "blocked" } });

    await runtime.prompt("go");

    expect(events.some((event) => event.type === "approval_required")).toBe(false);
    const outputs = events
      .filter(
        (event): event is Extract<MeowEvent, { type: "tool_output" }> => event.type === "tool_output",
      )
      .map((event) => event.output);
    expect(outputs.filter((output) => output.includes("plan mode"))).toHaveLength(3);
    const finished = events.filter(
      (event): event is Extract<MeowEvent, { type: "tool_finished" }> =>
        event.type === "tool_finished",
    );
    expect(finished.every((event) => event.ok === false)).toBe(true);
    expect(await readFile(path.join(workspace, "src", "x.ts"), "utf8").catch(() => null)).toBeNull();
    expect(events.some((event) => event.type === "subagent_started")).toBe(false);
  });

  it("still allows plan documents when the approval mode is read-only", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("read-only");
    await runtime.setSessionMode("plan");
    const events = await collectEvents(runtime);
    streamMock
      .mockResolvedValueOnce(
        toolTurn([
          {
            id: "plan-doc",
            name: "write_file",
            args: { path: "plans/2026-10-17-demo.md", content: "# Demo\n" },
          },
        ]),
      )
      .mockResolvedValueOnce({ message: { role: "assistant", content: "ok" } });

    await runtime.prompt("plan it");

    expect(await readFile(path.join(workspace, "plans", "2026-10-17-demo.md"), "utf8")).toBe(
      "# Demo\n",
    );
    expect(
      events.some(
        (event) => event.type === "tool_output" && event.output.includes("read-only mode"),
      ),
    ).toBe(false);
    expect(events.some((event) => event.type === "plan_documented")).toBe(true);
  });

  it("injects the mode prompt last and gates goal-mode mutations behind admit", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setApprovalMode("ask");
    streamMock.mockResolvedValue({ message: { role: "assistant", content: "done" } });

    await runtime.prompt("plain");
    const plainSystems = (streamMock.mock.calls[0][0].messages as ChatMessage[]).filter(
      (message) => message.role === "system",
    );

    await runtime.setSessionMode("goal");
    await runtime.prompt("goal turn");
    const goalMessages = streamMock.mock.calls[1][0].messages as ChatMessage[];
    const goalSystems = goalMessages.filter((message) => message.role === "system");
    expect(goalSystems).toHaveLength(plainSystems.length + 1);
    expect(goalSystems.at(-1)?.content).toContain("Goal mode is active");
    // 模式指令插在 system 段末尾，用户消息在它之后
    const goalUserIndex = goalMessages.findIndex(
      (message) => message.role === "user" && message.content === "goal turn",
    );
    expect(goalUserIndex).toBeGreaterThan(goalMessages.indexOf(goalSystems.at(-1)!));

    await runtime.setSessionMode("plan");
    await runtime.prompt("plan turn");
    const planMessages = streamMock.mock.calls[2][0].messages as ChatMessage[];
    const planSystems = planMessages.filter((message) => message.role === "system");
    expect(planSystems.at(-1)?.content).toContain("Plan mode is active");

    // goal 模式的治理门禁：未 admit 时 run_command 被拦（不再直接走审批）
    await runtime.setSessionMode("goal");
    const events = await collectEvents(runtime);
    streamMock.mockResolvedValueOnce(
      toolTurn([{ id: "cmd", name: "run_command", args: { command: "echo hi" } }]),
    );
    streamMock.mockResolvedValueOnce(
      toolTurn([{ id: "adm", name: "admit", args: { tier: "T0", task_shape: "echo hi" } }]),
    );
    streamMock.mockResolvedValueOnce(
      toolTurn([{ id: "cmd2", name: "run_command", args: { command: "echo hi" } }]),
    );
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });
    const prompt = runtime.prompt("run it");
    await vi.waitFor(() =>
      expect(
        events.some(
          (event) =>
            event.type === "tool_output" && event.callId === "cmd" &&
            event.output.includes("admit first"),
        ),
      ).toBe(true),
    );
    expect(
      events.some((event) => event.type === "approval_required" && event.callId === "cmd"),
    ).toBe(false);
    // admit 之后审批流照旧：run_command 弹审批，拒绝即结束
    await vi.waitFor(() =>
      expect(
        events.some((event) => event.type === "approval_required" && event.callId === "cmd2"),
      ).toBe(true),
    );
    const approval = events.find(
      (event): event is Extract<MeowEvent, { type: "approval_required" }> =>
        event.type === "approval_required" && event.callId === "cmd2",
    )!;
    runtime.respondToApproval(approval.callId, false);
    await prompt;
  });

  it("emits session_mode and persists the mode on the session", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(await mkdtemp(path.join(tmpdir(), "meowcode-ws-")));
    const events = await collectEvents(runtime);

    await runtime.setSessionMode("plan");

    expect(runtime.currentSessionMode).toBe("plan");
    expect(events.some((event) => event.type === "session_mode" && event.mode === "plan")).toBe(true);
    expect(runtime.current!.sessionSettings?.mode).toBe("plan");

    // 恢复路径也读得到（旧会话无字段 → default）
    const { recoverSession } = await import("./session-recovery.js");
    const recovered = await recoverSession(runtime.current!);
    expect(recovered.mode).toBe("plan");
  });

  it("resets the mode when a new session is created", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    await runtime.setSessionMode("goal");

    await runtime.newSession(workspace);

    expect(runtime.currentSessionMode).toBe("default");
    expect(runtime.current!.sessionSettings?.mode).toBeUndefined();
  });
});

describe("tool loop detection", () => {
  const readCall = (id: string, target: string) => ({
    id,
    type: "function",
    function: { name: "read_file", arguments: JSON.stringify({ path: target }) },
  });

  it("appends a loop reminder on the 3rd identical call with identical output", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    await writeFile(path.join(workspace, "a.txt"), "same content");
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [readCall("c1", "a.txt"), readCall("c2", "a.txt"), readCall("c3", "a.txt")],
        },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    await runtime.prompt("go");

    const second = streamMock.mock.calls[1][0].messages as ChatMessage[];
    const notes = second.filter(
      (message) => message.role === "tool" && message.content.includes("3 times in a row"),
    );
    expect(notes).toHaveLength(1);
  });

  it("does not count calls with different arguments or changing outputs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    await writeFile(path.join(workspace, "a.txt"), "alpha");
    await writeFile(path.join(workspace, "b.txt"), "beta");
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    const editCall = (id: string, from: string, to: string) => ({
      id,
      type: "function",
      function: {
        name: "edit_file",
        arguments: JSON.stringify({ path: "a.txt", oldString: from, newString: to }),
      },
    });
    streamMock
      // read a → edit → read（输出已变）→ edit → read：交替变化，永不累计
      .mockResolvedValueOnce({
        message: { role: "assistant", content: null, tool_calls: [readCall("c1", "a.txt")] },
      })
      .mockResolvedValueOnce({
        message: { role: "assistant", content: null, tool_calls: [editCall("c2", "alpha", "beta")] },
      })
      .mockResolvedValueOnce({
        message: { role: "assistant", content: null, tool_calls: [readCall("c3", "a.txt")] },
      })
      .mockResolvedValueOnce({
        message: { role: "assistant", content: null, tool_calls: [editCall("c4", "beta", "gamma")] },
      })
      .mockResolvedValueOnce({
        message: { role: "assistant", content: null, tool_calls: [readCall("c5", "a.txt")] },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    await runtime.prompt("go");

    const request = streamMock.mock.calls[5][0].messages as ChatMessage[];
    expect(request.some((m) => m.role === "tool" && m.content.includes("times in a row"))).toBe(false);
  });

  it("blocks the identical call after 8 zero-information repeats", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    await writeFile(path.join(workspace, "a.txt"), "same content");
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: Array.from({ length: 8 }, (_, index) => readCall(`c${index}`, "a.txt")),
        },
      })
      // 同一回合的第二轮流：状态已累计到 8，相同调用在执行前被拦截
      .mockResolvedValueOnce({
        message: { role: "assistant", content: null, tool_calls: [readCall("c9", "a.txt")] },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "turn done" } });

    await runtime.prompt("go");

    // 第 9 次相同调用被拒绝执行：回执以 Blocked: 开头
    const third = streamMock.mock.calls[2][0].messages as ChatMessage[];
    const blocked = third.filter(
      (message) => message.role === "tool" && message.content.startsWith("Blocked:"),
    );
    expect(blocked).toHaveLength(1);
  });
});

describe("context_status virtual tool", () => {
  it("reports usage, window and remaining headroom", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    const runtime = new (await import("./runtime.js")).AgentRuntime({
      providers: [
        { id: "p", name: "P", baseUrl: "http://localhost", model: "m", contextWindow: 100_000 },
      ],
      sessionsDir: dir,
    });
    await runtime.newSession(workspace);
    streamMock
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "c1", type: "function", function: { name: "context_status", arguments: "{}" } },
          ],
        },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    await runtime.prompt("check");

    const second = streamMock.mock.calls[1][0].messages as ChatMessage[];
    const status = second.find((m) => m.role === "tool" && m.name === "context_status");
    expect(status).toBeTruthy();
    expect(status!.content).toContain("Context usage:");
    expect(status!.content).toContain("100000");
    expect(status!.content).toContain("Breakdown:");
  });

  it("clamps the main request output budget to the remaining window", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const runtime = new (await import("./runtime.js")).AgentRuntime({
      providers: [
        {
          id: "p",
          name: "P",
          baseUrl: "http://localhost",
          model: "m",
          contextWindow: 8_000,
          maxTokens: 4_096,
        },
      ],
      sessionsDir: dir,
    });
    await runtime.newSession();
    await runtime.current?.appendMessage({ role: "user", content: "x".repeat(6_000) });
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "ok" } });

    await runtime.prompt("go");

    const request = streamMock.mock.calls[0][0] as { provider: { maxTokens?: number } };
    expect(request.provider.maxTokens).toBeGreaterThanOrEqual(256);
    expect(request.provider.maxTokens).toBeLessThan(4_096);
  });

  it("derives a session-stable prompt_cache_key for responses providers only", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    const runtime = new (await import("./runtime.js")).AgentRuntime({
      providers: [
        {
          id: "resp",
          name: "R",
          baseUrl: "http://localhost",
          model: "m",
          protocol: "openai-responses",
        },
      ],
      sessionsDir: dir,
    });
    await runtime.newSession(workspace);
    streamMock.mockResolvedValue({ message: { role: "assistant", content: "hi" } });
    await runtime.prompt("hello");

    const provider = streamMock.mock.calls[0][0].provider as { promptCacheKey?: string };
    expect(provider.promptCacheKey).toBe(`${runtime.current!.id}:main`);
  });
});

describe("free tool-result pruning (proactive shrink)", () => {
  it("shrinks old oversized tool outputs before the window fills", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    const big = Array.from(
      { length: 1_200 },
      (_, index) => `line ${index} of the big file with some padding text`,
    ).join("\n");
    await writeFile(path.join(workspace, "big.txt"), big);
    await writeFile(path.join(workspace, "mid.txt"), "medium file\n".repeat(40));
    const runtime = new (await import("./runtime.js")).AgentRuntime({
      providers: [
        { id: "p", name: "P", baseUrl: "http://localhost", model: "m", contextWindow: 5_500 },
      ],
      sessionsDir: dir,
    });
    await runtime.newSession(workspace);
    streamMock
      .mockResolvedValueOnce({
        message: { role: "assistant", content: null, tool_calls: [readCall0("c1", "big.txt")] },
      })
      .mockResolvedValueOnce({
        message: { role: "assistant", content: null, tool_calls: [readCall0("c2", "mid.txt")] },
      })
      .mockResolvedValueOnce({
        message: { role: "assistant", content: null, tool_calls: [readCall0("c3", "mid.txt")] },
      })
      .mockResolvedValueOnce({
        message: { role: "assistant", content: null, tool_calls: [readCall0("c4", "mid.txt")] },
      })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    await runtime.prompt("read stuff");

    // 第 4 次请求组装时：big 的结果已在 keepRecentUnits=2 之外，应被收缩成头尾摘录
    const fourth = streamMock.mock.calls[3][0].messages as ChatMessage[];
    const bigResult = fourth.find(
      (m) => m.role === "tool" && m.content.includes("chars trimmed"),
    );
    expect(bigResult).toBeTruthy();
  });
});

describe("AgentRuntime repeated read short-circuit", () => {
  const readToolCall = (id: string, target: string) => ({
    role: "assistant" as const,
    content: null,
    tool_calls: [readCall0(id, target)],
  });

  it("returns a stub for the same unchanged file range", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    await writeFile(path.join(workspace, "a.txt"), "hello\nworld\n");
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    await collectEvents(runtime);
    streamMock
      .mockResolvedValueOnce({ message: readToolCall("r1", "a.txt") })
      .mockResolvedValueOnce({ message: readToolCall("r2", "a.txt") })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    await runtime.prompt("read twice");

    const toolMessages =
      runtime.current?.effectiveMessages.filter((message) => message.role === "tool") ?? [];
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0].role === "tool" ? toolMessages[0].content : "").toContain("1: hello");
    expect(toolMessages[1].role === "tool" ? toolMessages[1].content : "").toContain(
      "Unchanged since your last read",
    );
    expect(toolMessages[1].role === "tool" ? toolMessages[1].content : "").not.toContain("1: hello");

    // 第三次请求里模型看到的是 stub，而不是第二次全文
    const thirdRequest = streamMock.mock.calls[2][0].messages as ChatMessage[];
    const lastTool = [...thirdRequest].reverse().find((message) => message.role === "tool");
    expect(lastTool?.role === "tool" ? lastTool.content : "").toContain(
      "Unchanged since your last read",
    );
  });

  it("falls back to full content after the file is edited", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "meowcode-runtime-"));
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-ws-"));
    await writeFile(path.join(workspace, "a.txt"), "hello\n");
    const runtime = makeRuntime(dir);
    await runtime.newSession(workspace);
    runtime.setApprovalMode("full");
    await collectEvents(runtime);
    streamMock
      .mockResolvedValueOnce({ message: readToolCall("r1", "a.txt") })
      .mockResolvedValueOnce({
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "e1",
              type: "function",
              function: {
                name: "edit_file",
                arguments: JSON.stringify({ path: "a.txt", oldString: "hello", newString: "bye" }),
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({ message: readToolCall("r2", "a.txt") })
      .mockResolvedValueOnce({ message: { role: "assistant", content: "done" } });

    await runtime.prompt("read, edit, read");

    const toolMessages =
      runtime.current?.effectiveMessages.filter((message) => message.role === "tool") ?? [];
    const lastRead = [...toolMessages].reverse().find((message) => message.name === "read_file");
    expect(lastRead?.role === "tool" ? lastRead.content : "").toContain("1: bye");
    expect(lastRead?.role === "tool" ? lastRead.content : "").not.toContain(
      "Unchanged since your last read",
    );
  });
});

function readCall0(id: string, target: string) {
  return {
    id,
    type: "function",
    function: { name: "read_file", arguments: JSON.stringify({ path: target }) },
  };
}
