import { describe, expect, it } from "vitest";
import {
  breakdownMessages,
  compactionTriggerTokens,
  estimateContextTokens,
  estimateDocumentTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTokens,
  estimateToolDefinitionsTokens,
  repairToolPairs,
  shouldRecommendCompaction,
  shrinkToolOutputs,
  trimMessages,
} from "./context";
import type { ChatMessage } from "./types";

const system: ChatMessage = { role: "system", content: "You are MeowCode." };
const user = (text: string): ChatMessage => ({ role: "user", content: text });
const assistant = (text: string): ChatMessage => ({ role: "assistant", content: text });
const toolResult = (id: string, text: string): ChatMessage => ({
  role: "tool",
  content: text,
  tool_call_id: id,
});

describe("estimateTokens", () => {
  it("按 4 字符约 1 token 估算", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens(undefined as unknown as string)).toBe(0);
  });

  it("CJK 字符按 1 字约 1 token 估算", () => {
    expect(estimateTokens("你好")).toBe(2);
    expect(estimateTokens("你好ab")).toBe(3); // 2 CJK + ceil(2/4)
    expect(estimateTokens("中文内容 abc")).toBe(5); // 4 CJK + ceil(4/4)
    expect(estimateTokens("，。")).toBe(2); // CJK 标点同按 1 字计
    expect(estimateTokens("안녕")).toBe(2); // Hangul 也按 CJK 口径
    expect(estimateTokens("한국어")).toBe(3);
  });

  it("统计消息时把 tool_calls 的参数也算进去", () => {
    const message: ChatMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
      ],
    };
    // content 为 null 时只算工具名 + 参数
    expect(estimateMessageTokens(message)).toBe(estimateTokens("read_file") + estimateTokens('{"path":"a.ts"}'));
  });
});

describe("estimateDocumentTokens", () => {
  it("有页数时按 3k/页上限估算，且至少 4k", () => {
    expect(estimateDocumentTokens({ data: "", pages: 1 })).toBe(4_000);
    expect(estimateDocumentTokens({ data: "", pages: 10 })).toBe(30_000);
  });

  it("没有页数时按体积保守回退，不再固定 4k", () => {
    expect(estimateDocumentTokens({ data: "x".repeat(100_000) })).toBe(10_000);
    expect(estimateDocumentTokens({ data: "x".repeat(1_000_000) })).toBe(100_000);
    expect(estimateDocumentTokens({ data: "x".repeat(2_000_000) })).toBe(200_000);
  });
});

describe("estimateToolDefinitionsTokens", () => {
  it("把工具 schema 的 JSON 体积折算成 token", () => {
    expect(estimateToolDefinitionsTokens([])).toBe(0);
    const tools = [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file.",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ];
    expect(estimateToolDefinitionsTokens(tools)).toBeGreaterThan(10);
  });
});

describe("shouldRecommendCompaction", () => {
  it("窗口的 85% 起提示，未设置窗口不提示", () => {
    expect(shouldRecommendCompaction(849, 1000)).toBe(false);
    expect(shouldRecommendCompaction(850, 1000)).toBe(true);
    expect(shouldRecommendCompaction(950, 1000)).toBe(true);
    expect(shouldRecommendCompaction(950, null)).toBe(false);
    expect(shouldRecommendCompaction(950, 0)).toBe(false);
  });
});

describe("trimMessages", () => {
  it("总长度在预算内时保持内容不变", () => {
    const messages = [system, user("hi"), assistant("hello")];
    expect(trimMessages(messages, 100_000)).toEqual(messages);
  });

  it("contextWindow 为 0 时不裁剪", () => {
    const messages = [system, user("x".repeat(1000))];
    expect(trimMessages(messages, 0)).toBe(messages);
  });

  it("永远保留 system 消息", () => {
    const messages = [system, user("a".repeat(4000)), user("b".repeat(4000))];
    const trimmed = trimMessages(messages, 2000);
    expect(trimmed[0]).toBe(system);
    expect(trimmed.length).toBeGreaterThan(1);
  });

  it("保留开头全部 system 消息（稳定前缀 + 易变计划）", () => {
    const volatile: ChatMessage = { role: "system", content: "Current task plan:\n1. [pending] A" };
    const messages = [system, volatile, user("a".repeat(4000)), user("b".repeat(4000))];
    const trimmed = trimMessages(messages, 2000);
    expect(trimmed.slice(0, 2)).toEqual([system, volatile]);
  });

  it("预算不足时至少保留最后一条 user 消息", () => {
    const messages = [system, user("旧问题"), user("x".repeat(100_000))];
    const trimmed = trimMessages(messages, 500);
    expect(trimmed[0]).toBe(system);
    expect(trimmed.at(-1)?.role).toBe("user");
    expect(trimmed.at(-1)?.content).toBe("x".repeat(100_000));
  });

  it("带 tool_calls 的 assistant 与它的 tool 结果成组丢弃，不留孤儿", () => {
    const callMessage: ChatMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } },
      ],
    };
    const messages = [
      system,
      user("读一下"),
      callMessage,
      toolResult("c1", "x".repeat(3000)),
      assistant("读完了"),
      user("y".repeat(3000)),
    ];
    const trimmed = trimMessages(messages, 1500);

    const toolIds = new Set(
      trimmed.filter((m) => m.role === "assistant" && m.tool_calls?.length).flatMap((m) =>
        (m.tool_calls ?? []).map((c) => c.id),
      ),
    );
    for (const message of trimmed) {
      if (message.role === "tool") {
        expect(toolIds.has(message.tool_call_id ?? "")).toBe(true);
      }
    }
    expect(trimmed[0]).toBe(system);
  });

  it("裁剪后按时间正序，且 system 在最前", () => {
    const messages = [system, user("一"), assistant("二"), user("三".repeat(3000)), user("四")];
    const trimmed = trimMessages(messages, 900);
    expect(trimmed[0]).toBe(system);
    expect(trimmed.at(-1)).toEqual(user("四"));
  });

  it("工具调用组放不下时整组丢弃，不留孤儿 tool 消息", () => {
    const hugeCall: ChatMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "write_file", arguments: "x".repeat(20_000) },
        },
      ],
    };
    const messages = [
      system,
      user("做点事"),
      hugeCall,
      toolResult("c1", "ok"),
      assistant("完成"),
      user("下一步"),
    ];
    const trimmed = trimMessages(messages, 1500);
    expect(trimmed.some((message) => message.role === "tool")).toBe(false);
    expect(
      trimmed.some(
        (message) =>
          message.role === "assistant" &&
          message.tool_calls?.some((call) => call.id === "c1"),
      ),
    ).toBe(false);
    expect(trimmed.at(-1)).toEqual(user("下一步"));
  });

  it("重复的 tool 结果只保留一条", () => {
    const call: ChatMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } },
      ],
    };
    const messages = [
      system,
      user("读"),
      call,
      toolResult("c1", "first"),
      toolResult("c1", "second"),
      user("继续"),
    ];
    const trimmed = trimMessages(messages, 500);
    expect(trimmed.filter((message) => message.role === "tool")).toHaveLength(1);
    expect(trimmed.find((message) => message.role === "tool")?.content).toBe("first");
  });

  it("最后一条真实 user 与其后的注入上下文一起保留", () => {
    const note: ChatMessage = {
      role: "user",
      content: "The user referenced these workspace files with @mentions.\n\n<file path=\"a.txt\">x</file>",
    };
    const messages = [system, user("旧消息"), user("新请求"), note, assistant("回答")];
    const trimmed = trimMessages(messages, 200);
    expect(trimmed).toContainEqual(user("新请求"));
    expect(trimmed).toContainEqual(note);
  });

  it("reservedTokens 会从裁剪预算里扣掉工具 schema 等固定开销", () => {
    const messages = [
      system,
      user("a".repeat(4_000)),
      user("b".repeat(4_000)),
      user("c".repeat(4_000)),
    ];
    const withoutReserved = trimMessages(messages, 5_000, 0, 0);
    const withReserved = trimMessages(messages, 5_000, 0, 3_000);
    expect(withReserved.length).toBeLessThan(withoutReserved.length);
    expect(withReserved.at(-1)).toEqual(user("c".repeat(4_000)));
  });

  it("压缩摘要不会被裁掉", () => {
    const summary = user("Earlier conversation summary:\n很久以前的事情");
    const messages = [system, summary, user("x".repeat(20_000)), assistant("y")];
    const trimmed = trimMessages(messages, 500);
    expect(trimmed).toContainEqual(summary);
    expect(trimmed.some((message) => message.content === "x".repeat(20_000))).toBe(true);
    expect(trimmed.at(-1)).toEqual(assistant("y"));
  });
});

describe("repairToolPairs", () => {
  it("丢弃没有工具结果的调用和对应的孤儿 tool 消息", () => {
    const messages: ChatMessage[] = [
      system,
      user("do it"),
      {
        role: "assistant",
        content: "working",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "grep", arguments: "{}" } },
        ],
      },
      toolResult("c1", "file content"),
      toolResult("orphan", "stray"),
      assistant("done"),
    ];

    const repaired = repairToolPairs(messages);
    const call = repaired.find((message) => message.role === "assistant" && message.tool_calls?.length);
    expect(call && call.role === "assistant" ? call.tool_calls?.map((item) => item.id) : null).toEqual(["c1"]);
    const tools = repaired.filter((message) => message.role === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ tool_call_id: "c1", content: "file content" });
  });

  it("去重同一个 callId 的多条 tool 结果", () => {
    const messages: ChatMessage[] = [
      user("do it"),
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      },
      toolResult("c1", "first"),
      toolResult("c1", "second"),
    ];
    const repaired = repairToolPairs(messages);
    expect(repaired.filter((message) => message.role === "tool")).toEqual([
      toolResult("c1", "first"),
    ]);
  });

  it("保留有正文的 assistant，丢弃纯空壳", () => {
    const messages: ChatMessage[] = [
      user("hi"),
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "grep", arguments: "{}" } },
        ],
      },
      {
        role: "assistant",
        content: "partial answer",
        tool_calls: [
          { id: "c2", type: "function", function: { name: "grep", arguments: "{}" } },
        ],
      },
    ];

    const repaired = repairToolPairs(messages);
    expect(repaired).toEqual([user("hi"), assistant("partial answer")]);
  });

  /**
   * 增量传输（Responses 的 previous_response_id）靠「消息对象引用未变 ⇒ 内容未变」
   * 判定前缀可复用。这里一旦改成重建对象，链会每轮都断、静默退化成全量重发，
   * 而且不报错——所以必须用 toBe 锁住引用，而不是只断言内容相等。
   */
  it("配对完整时保持对象引用不变（增量链的前缀复用前提）", () => {
    const call: ChatMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } },
        { id: "c2", type: "function", function: { name: "grep", arguments: "{}" } },
      ],
    };
    const resultA = toolResult("c1", "a");
    const resultB = toolResult("c2", "b");
    const tail = assistant("done");
    const messages: ChatMessage[] = [user("go"), call, resultA, resultB, tail];

    const repaired = repairToolPairs(messages);
    expect(repaired).toHaveLength(5);
    expect(repaired[0]).toBe(messages[0]);
    expect(repaired[1]).toBe(call);
    expect(repaired[2]).toBe(resultA);
    expect(repaired[3]).toBe(resultB);
    expect(repaired[4]).toBe(tail);
  });

  it("剔除无效调用时才重建该条 assistant，其余消息引用不动", () => {
    const call: ChatMessage = {
      role: "assistant",
      content: "working",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } },
        { id: "missing", type: "function", function: { name: "grep", arguments: "{}" } },
      ],
    };
    const first = user("go");
    const result = toolResult("c1", "ok");
    const repaired = repairToolPairs([first, call, result]);

    expect(repaired[0]).toBe(first);
    expect(repaired[2]).toBe(result);
    expect(repaired[1]).not.toBe(call); // 这一条确实被改写，允许换新对象
  });
});

describe("estimateMessageTokens with Anthropic thinking blocks", () => {
  it("counts replayed thinking blocks but not local-only reasoning", () => {
    const plain = estimateMessageTokens({ role: "assistant", content: "answer" });
    const withReasoning = estimateMessageTokens({
      role: "assistant",
      content: "answer",
      reasoning: "x".repeat(4000),
    });
    const withThinking = estimateMessageTokens({
      role: "assistant",
      content: "answer",
      anthropic_thinking: [
        { type: "thinking", thinking: "x".repeat(4000), signature: "s".repeat(80) },
      ],
    });

    expect(withReasoning).toBe(plain);
    expect(withThinking).toBeGreaterThan(plain + 900);
  });
});

describe("estimateContextTokens", () => {
  const toolCall = (id: string): ChatMessage => ({
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: "{}" } }],
  });
  const toolResult = (id: string, text: string): ChatMessage => ({
    role: "tool",
    content: text,
    tool_call_id: id,
  });

  it("无锚点时整段估算", () => {
    const messages = [system, user("你好"), assistant("done")];
    const usage = estimateContextTokens(messages, null);
    expect(usage.source).toBe("estimate");
    expect(usage.tokens).toBe(estimateMessagesTokens(messages));
    expect(usage.usageTokens).toBe(0);
  });

  it("有锚点时 = 真实用量 + 之后新增消息的估算", () => {
    const messages = [system, user("hi"), assistant("ok"), toolCall("c1"), toolResult("c1", "x".repeat(4000))];
    // 锚点覆盖前 2 条（system+user+assistant 中的 2 条有效消息）……这里按消息条数切
    const anchor = { inputTokens: 5_000, messageCount: 2 };
    const usage = estimateContextTokens(messages, anchor);
    expect(usage.source).toBe("usage");
    expect(usage.usageTokens).toBe(5_000);
    expect(usage.trailingTokens).toBe(estimateMessagesTokens(messages.slice(2)));
    expect(usage.tokens).toBe(5_000 + usage.trailingTokens);
  });

  it("锚点越界（消息数对不上）时退回估算", () => {
    const messages = [user("hi")];
    const usage = estimateContextTokens(messages, { inputTokens: 5_000, messageCount: 9 });
    expect(usage.source).toBe("estimate");
    expect(usage.tokens).toBe(estimateMessagesTokens(messages));
  });

  it("inputTokens 非正的锚点无效", () => {
    const messages = [user("hi")];
    expect(estimateContextTokens(messages, { inputTokens: 0, messageCount: 1 }).source).toBe("estimate");
  });
});

describe("shrinkToolOutputs", () => {
  const toolCall = (id: string): ChatMessage => ({
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: "{}" } }],
  });

  it("保留最近 2 个单元，旧工具输出抽头尾", () => {
    const messages: ChatMessage[] = [user("do it")];
    for (let index = 0; index < 5; index += 1) {
      messages.push(toolCall(`call-${index}`));
      messages.push({
        role: "tool",
        content: `line-0 ${"x".repeat(3000)} line-end-${index}`,
        tool_call_id: `call-${index}`,
        name: "read_file",
      });
    }
    const { messages: shrunk, changed } = shrinkToolOutputs(messages);
    expect(changed).toBe(true);
    const tools = shrunk.filter((message) => message.role === "tool");
    expect(tools).toHaveLength(5); // 结构完整，只换内容
    const contents = tools.map((message) => message.content);
    // 最后 2 个单元逐字保留
    expect(contents[4]).toBe(`line-0 ${"x".repeat(3000)} line-end-4`);
    expect(contents[3]).toBe(`line-0 ${"x".repeat(3000)} line-end-3`);
    // 更早的抽头尾：头尾都在，中间被剪掉，且标注了裁剪量
    expect(contents[0]).toContain("line-0 ");
    expect(contents[0]).toContain("line-end-0");
    expect(contents[0]).toContain("chars trimmed");
    expect(contents[0].length).toBeLessThan(2_000);
  });

  it("改文件的记录不收缩，图片随收缩一并卸下", () => {
    const messages: ChatMessage[] = [
      user("do it"),
      toolCall("edit-1"),
      { role: "tool", content: "z".repeat(5000), tool_call_id: "edit-1", name: "edit_file" },
      toolCall("shot-1"),
      {
        role: "tool",
        content: "screenshot",
        tool_call_id: "shot-1",
        name: "browser_screenshot",
        images: [{ data: "AAAA", mimeType: "image/png" }],
      },
      user("继续"),
    ];
    const { messages: shrunk, changed } = shrinkToolOutputs(messages, { keepRecentUnits: 1 });
    expect(changed).toBe(true);
    const edit = shrunk.find((message) => message.role === "tool" && message.tool_call_id === "edit-1");
    expect(edit && edit.content).toBe("z".repeat(5000));
    const shot = shrunk.find((message) => message.role === "tool" && message.tool_call_id === "shot-1");
    expect(shot && shot.role === "tool" ? shot.images : undefined).toBeUndefined();
    expect(shot && shot.content).toContain("image(s) dropped");
  });

  it("没有可收缩的输出时返回原数组", () => {
    const messages = [user("hi"), assistant("hello")];
    expect(shrinkToolOutputs(messages)).toEqual({ messages, changed: false });
  });

  it("spilled 命中的收缩摘录带 locator，全文标注算进预算", () => {
    const messages: ChatMessage[] = [user("do it")];
    for (let index = 0; index < 4; index += 1) {
      messages.push(toolCall(`call-${index}`));
      messages.push({
        role: "tool",
        content: `out-${index} ${"y".repeat(3000)}`,
        tool_call_id: `call-${index}`,
        name: "run_command",
      });
    }
    const spilled = new Map([
      ["call-0", ".meowcode/tool-output/run_command-x.log"],
      ["call-1", ".meowcode/tool-output/run_command-y.log"],
    ]);
    const { messages: shrunk, changed } = shrinkToolOutputs(messages, { spilled });
    expect(changed).toBe(true);
    const tools = shrunk.filter((message) => message.role === "tool");
    // 默认 keepRecentUnits=2：只有最旧两个工具单元被收缩，locator 只出现在它们身上
    expect(tools[0] && tools[0].role === "tool" ? tools[0].content : "").toContain(
      "full text saved to .meowcode/tool-output/run_command-x.log; read it with read_file",
    );
    expect(tools[1] && tools[1].role === "tool" ? tools[1].content : "").toContain(
      "full text saved to .meowcode/tool-output/run_command-y.log",
    );
    expect(tools[2] && tools[2].role === "tool" ? tools[2].content : "").not.toContain("full text saved");
    expect(
      tools[3] && tools[3].role === "tool" ? tools[3].content : "",
    ).toBe(`out-3 ${"y".repeat(3000)}`);
    // 收敛口径不变：带 locator 的摘录总长仍 ≤ maxChars（逐字保留的后两条不在此列）
    expect(tools[0] && tools[0].role === "tool" ? tools[0].content.length : 0).toBeLessThanOrEqual(1_200);
    expect(tools[1] && tools[1].role === "tool" ? tools[1].content.length : 0).toBeLessThanOrEqual(1_200);
  });
});

describe("trimMessages keeps history append-only under budget", () => {
  const toolCall = (id: string): ChatMessage => ({
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: "{}" } }],
  });

  it("does not rewrite any message when everything fits the budget", () => {
    // 缓存优先：预算内任何中段改写都会让上一次请求已缓存的前缀整段失效。
    const messages: ChatMessage[] = [system, user("do it")];
    for (let index = 0; index < 8; index += 1) {
      messages.push(toolCall(`call-${index}`));
      messages.push({ role: "tool", content: "x".repeat(6000), tool_call_id: `call-${index}`, name: "read_file" });
    }
    messages.push(assistant("done"));

    const trimmed = trimMessages(messages, 200_000, 4_096);

    expect(trimmed).toHaveLength(messages.length);
    trimmed.forEach((message, index) => expect(message).toBe(messages[index]));
    expect(JSON.stringify(trimmed)).toBe(JSON.stringify(messages));
  });

  it("never shrinks edit results, because they record what was changed", () => {
    const messages: ChatMessage[] = [system, user("do it")];
    for (let index = 0; index < 8; index += 1) {
      messages.push(toolCall(`call-${index}`));
      messages.push({ role: "tool", content: "x".repeat(6000), tool_call_id: `call-${index}`, name: "edit_file" });
    }
    messages.push(assistant("done"));

    const trimmed = trimMessages(messages, 12_000, 1_000);
    const tools = trimmed.filter((message) => message.role === "tool");

    expect(tools.some((message) => message.content.includes("chars trimmed"))).toBe(false);
  });

  it("超出预算时先抽旧工具输出（保住全部轮次），而不是原样发送", () => {
    const messages: ChatMessage[] = [system, user("do it")];
    for (let index = 0; index < 4; index += 1) {
      messages.push(toolCall(`call-${index}`));
      messages.push({ role: "tool", content: "a".repeat(40_000), tool_call_id: `call-${index}`, name: "read_file" });
    }
    messages.push(assistant("done"));

    const trimmed = trimMessages(messages, 16_000, 1_024);
    const tools = trimmed.filter((message) => message.role === "tool");

    // 轮次结构完整，旧输出换成头尾摘录，最近 1 轮逐字保留
    expect(tools).toHaveLength(4);
    expect(tools[0].content).toContain("chars trimmed");
    expect(tools[0].content.length).toBeLessThan(2_000);
    expect(tools[2].content).toContain("chars trimmed");
    expect(tools[3].content.length).toBe(40_000);
  });
});

describe("breakdownMessages", () => {
  const call = (id: string): ChatMessage => ({
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: "{}" } }],
  });

  it("按角色与工具名拆分，各桶加总恒等于消息总量", () => {
    const messages: ChatMessage[] = [
      system,
      user("hello"),
      call("c1"),
      { role: "tool", content: "x".repeat(4_000), tool_call_id: "c1", name: "read_file" },
      call("c2"),
      { role: "tool", content: "y".repeat(800), tool_call_id: "c2", name: "grep" },
      assistant("done"),
      { role: "user", content: "Runtime context: [mode] plan mode is active" },
    ];
    const detail = breakdownMessages(messages);
    expect(detail.total).toBe(estimateMessagesTokens(messages));
    // read_file 输出远大于 grep，排第一
    expect(detail.toolResults[0]).toMatchObject({ name: "read_file" });
    expect(detail.toolResults.find((item) => item.name === "grep")?.tokens).toBeGreaterThan(0);
    // 模式提示属于注入通道，不能算进用户正文
    expect(detail.injected).toBeGreaterThan(0);
    expect(detail.userText).toBeGreaterThan(0);
    expect(detail.assistantText).toBeGreaterThan(0);
  });

  it("图片按张计价并单列，不重复计入正文", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: "see screenshot",
        images: [{ data: "AAAA", mimeType: "image/png" }],
      },
    ];
    const detail = breakdownMessages(messages);
    expect(detail.media).toBe(1_500);
    expect(detail.total).toBe(estimateMessagesTokens(messages));
    expect(detail.userText).toBeLessThan(detail.total);
  });

  it("工具超过 topN 时合并成 other tools，总量不变", () => {
    const messages: ChatMessage[] = [];
    for (let index = 0; index < 12; index += 1) {
      messages.push(call(`t${index}`));
      messages.push({
        role: "tool",
        content: "z".repeat(400),
        tool_call_id: `t${index}`,
        name: `tool_${index}`,
      });
    }
    const detail = breakdownMessages(messages, 3);
    expect(detail.toolResults).toHaveLength(4);
    expect(detail.toolResults.at(-1)?.name).toBe("other tools");
    expect(detail.total).toBe(estimateMessagesTokens(messages));
  });
});

describe("compactionTriggerTokens", () => {
  it("大窗口由 15% 余量决定，与 OpenCode 的 ceiling 对齐", () => {
    // 200k：余量 max(30000, 16000)=30000 → room 170000；0.85 比值 170000 → 取 170000
    expect(compactionTriggerTokens(200_000, 8_192, 0.85)).toBe(170_000);
    // 预热档 0.8 更严：min(160000, 170000)
    expect(compactionTriggerTokens(200_000, 8_192, 0.8)).toBe(160_000);
  });

  it("窗口不足以让出 16k 时退回 15% 份额，不会把阈值压没", () => {
    // 16k：15%=2400 且不足 2×16000 的固定档 → 输出预留 8192 取大者 → room 7808
    expect(compactionTriggerTokens(16_384, 8_192, 0.85)).toBe(8_192);
  });

  it("输出预留吃满窗口时退回纯比值", () => {
    // 8k：max(min(8192,21000), 1228)=8192 → room 0 → 退回 floor(8192×0.85)
    expect(compactionTriggerTokens(8_192, 8_192, 0.85)).toBe(6_963);
  });

  it("窗口未知返回 0，调用方按不触发处理", () => {
    expect(compactionTriggerTokens(null)).toBe(0);
    expect(compactionTriggerTokens(0)).toBe(0);
  });

  it("建议压缩与软阈值同源，小窗口不再晚触发", () => {
    // 32k 窗口用了 20k：旧口径 62% 不报警，新口径已过 min(27852, 16768)
    expect(shouldRecommendCompaction(20_000, 32_768, 8_192)).toBe(true);
    expect(shouldRecommendCompaction(12_000, 32_768, 8_192)).toBe(false);
  });
});
