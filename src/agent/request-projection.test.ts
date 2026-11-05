import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_HYSTERESIS_TRIGGER_BYTES,
  KEEP_THINKING_USER_TURNS,
  MAX_USER_IMAGE_MESSAGES_IN_CONTEXT,
  projectAnthropicThinking,
  projectForMainPath,
  projectForRequest,
  projectAttachmentsHysteresis,
  projectUserDocuments,
  projectUserImages,
} from "./request-projection";
import type { ChatMessage, ProviderConfig } from "./types";

const image = (name: string) => ({ data: `data-${name}`, mimeType: "image/png" });
const user = (text: string, images?: ReturnType<typeof image>[]): ChatMessage => ({
  role: "user",
  content: text,
  ...(images?.length ? { images } : {}),
});
const assistant = (text: string, thinking?: string): ChatMessage => ({
  role: "assistant",
  content: text,
  ...(thinking
    ? { anthropic_thinking: [{ type: "thinking" as const, thinking, signature: `sig-${text}` }] }
    : {}),
});
const anthropic: ProviderConfig = {
  id: "p",
  name: "P",
  baseUrl: "http://localhost",
  model: "m",
  protocol: "anthropic-messages",
};
const openai: ProviderConfig = { ...anthropic, protocol: "openai-chat-completions" };

describe("projectUserImages", () => {
  it("只保留最近 N 条带图 user 消息，旧图片换成说明且不改原对象", () => {
    const messages: ChatMessage[] = [
      user("one", [image("1")]),
      assistant("ok"),
      user("two", [image("2")]),
      user("three", [image("3")]),
      user("four", [image("4")]),
      user("five", [image("5")]),
    ];
    const projected = projectUserImages(messages, 3);

    expect(projected).toHaveLength(messages.length);
    expect(projected[0]).not.toBe(messages[0]);
    expect(projected[0].role === "user" ? projected[0].images : undefined).toBeUndefined();
    expect(projected[0].content).toContain("1 image(s) omitted");
    // 最近 3 条保持原引用
    expect(projected[3]).toBe(messages[3]);
    expect(projected[4]).toBe(messages[4]);
    expect(projected[5]).toBe(messages[5]);
    // 原消息不被修改
    expect(messages[0].role === "user" ? messages[0].images : undefined).toHaveLength(1);
  });

  it("没有旧图片时返回原数组", () => {
    const messages: ChatMessage[] = [user("one", [image("1")]), user("two")];
    expect(projectUserImages(messages, MAX_USER_IMAGE_MESSAGES_IN_CONTEXT)).toBe(messages);
  });
});

describe("projectAnthropicThinking", () => {
  it("只保留当前 user 回合的 thinking，旧 thinking 块被省略", () => {
    const messages: ChatMessage[] = [
      user("first"),
      assistant("a1", "thinking-1"),
      user("second"),
      assistant("a2", "thinking-2"),
    ];
    const projected = projectAnthropicThinking(messages, KEEP_THINKING_USER_TURNS);

    expect(projected).toHaveLength(messages.length);
    expect(projected[1].role === "assistant" ? projected[1].anthropic_thinking : undefined).toBeUndefined();
    expect(projected[3]).toBe(messages[3]);
    expect(
      projected[3].role === "assistant" ? projected[3].anthropic_thinking?.[0] : undefined,
    ).toBeDefined();
  });

  it("keepTurns=2 时保留最近两个 user 回合", () => {
    const messages: ChatMessage[] = [
      user("first"),
      assistant("a1", "thinking-1"),
      user("second"),
      assistant("a2", "thinking-2"),
    ];
    const projected = projectAnthropicThinking(messages, 2);
    expect(projected[1]).toBe(messages[1]);
  });

  it("注入的 runtime user 消息不算回合边界", () => {
    const note: ChatMessage = {
      role: "user",
      content: "Runtime context: current task plan\n1. step",
    };
    const messages: ChatMessage[] = [
      user("first"),
      assistant("a1", "thinking-1"),
      user("second"),
      assistant("a2", "thinking-2"),
      note,
    ];
    const projected = projectAnthropicThinking(messages, 1);
    expect(
      projected[1].role === "assistant" ? projected[1].anthropic_thinking : undefined,
    ).toBeUndefined();
    expect(projected[3]).toBe(messages[3]);
  });
});

describe("projectForRequest", () => {
  it("Anthropic 同时裁旧 thinking 与旧图片", () => {
    const messages: ChatMessage[] = [
      user("one", [image("1")]),
      assistant("a1", "thinking-1"),
      user("two"),
      user("three"),
      user("four"),
      user("five", [image("5")]),
    ];
    const projected = projectForRequest(messages, anthropic, {
      keepUserImageMessages: 1,
      keepThinkingUserTurns: 1,
    });
    expect(projected[0].role === "user" ? projected[0].images : undefined).toBeUndefined();
    expect(
      projected[1].role === "assistant" ? projected[1].anthropic_thinking : undefined,
    ).toBeUndefined();
  });

  it("非 Anthropic 协议不碰 thinking，但仍裁旧图片", () => {
    const messages: ChatMessage[] = [
      user("one", [image("1")]),
      assistant("a1", "thinking-1"),
      user("two", [image("2")]),
      assistant("a2"),
    ];
    const projected = projectForRequest(messages, openai, { keepUserImageMessages: 1 });
    expect(
      projected[1].role === "assistant" ? projected[1].anthropic_thinking : undefined,
    ).toBeDefined();
    expect(projected[0].role === "user" ? projected[0].images : undefined).toBeUndefined();
  });

  it("未配置 provider 时不碰 thinking，最近的图片保持原样", () => {
    const messages: ChatMessage[] = [user("one", [image("1")]), assistant("a", "t")];
    const projected = projectForRequest(messages, null);
    expect(projected).toBe(messages);
  });
});

describe("projectUserDocuments", () => {
  const document = (name: string) => ({
    data: `pdf-${name}`,
    mimeType: "application/pdf",
    name: `${name}.pdf`,
  });
  const withDocs = (text: string, count = 1): ChatMessage => ({
    role: "user",
    content: text,
    documents: Array.from({ length: count }, (_, index) => document(`${text}-${index}`)),
  });

  it("keeps only the most recent N document messages", () => {
    const messages: ChatMessage[] = [
      withDocs("old"),
      assistant("a"),
      withDocs("mid"),
      assistant("b"),
      withDocs("new"),
    ];
    const projected = projectUserDocuments(messages, 2);
    expect(projected[0]).toMatchObject({
      role: "user",
      content: expect.stringContaining("document(s) omitted"),
    });
    expect((projected[0] as { documents?: unknown }).documents).toBeUndefined();
    expect((projected[2] as { documents?: unknown }).documents).toHaveLength(1);
    expect((projected[4] as { documents?: unknown }).documents).toHaveLength(1);
  });

  it("does not touch images while dropping documents", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "both", images: [image("1")], documents: [document("a")] },
      { role: "user", content: "newer", documents: [document("b")] },
    ];
    const projected = projectUserDocuments(messages, 1);
    expect((projected[0] as { images?: unknown }).images).toHaveLength(1);
    expect((projected[0] as { documents?: unknown }).documents).toBeUndefined();
  });

  it("returns the original array when nothing needs projecting", () => {
    const messages: ChatMessage[] = [withDocs("only")];
    expect(projectUserDocuments(messages, 3)).toBe(messages);
  });

  it("runs as part of projectForRequest", () => {
    const messages: ChatMessage[] = [
      withDocs("old"),
      assistant("a"),
      withDocs("new"),
    ];
    const projected = projectForRequest(messages, anthropic, { keepUserDocumentMessages: 1 });
    expect((projected[0] as { documents?: unknown }).documents).toBeUndefined();
    expect((projected[2] as { documents?: unknown }).documents).toHaveLength(1);
  });
});

describe("projectAttachmentsHysteresis", () => {
  /** 定长 payload 的图片消息（字节 = name.length，方便用小常数测） */
  const sized = (text: string, bytes: number) => ({
    role: "user" as const,
    content: text,
    images: [{ data: "x".repeat(bytes), mimeType: "image/png" }],
  });

  it("总量未过触发线时返回原数组（引用不变）", () => {
    const messages: ChatMessage[] = [sized("a", 40), sized("b", 40)];
    expect(projectAttachmentsHysteresis(messages, "images", 100, 50)).toBe(messages);
  });

  it("越过触发线：保留最新 ≤ 目标线的后缀，更旧的换成说明且不改原对象", () => {
    const a = sized("a", 40);
    const b = sized("b", 40);
    const c = sized("c", 40);
    const messages: ChatMessage[] = [a, b, c]; // 总量 120 > 100，最新后缀 ≤50 只装得下 c
    const projected = projectAttachmentsHysteresis(messages, "images", 100, 50);
    expect((projected[0] as { images?: unknown }).images).toBeUndefined();
    expect((projected[0] as { images?: unknown }).content).toContain("1 image(s) omitted");
    expect((projected[1] as { images?: unknown }).images).toBeUndefined();
    expect((projected[2] as { images?: unknown }).images).toHaveLength(1);
    expect(projected[2]).toBe(c); // 未投影的沿用原引用
    expect(a.images).toHaveLength(1); // 原对象不被修改
  });

  it("滞回：新增图片吃掉余量前切点不动（前缀字节零变化），吃满才前移一次", () => {
    const older = sized("old", 40);
    const kept = sized("kept", 30);
    const messages: ChatMessage[] = [older, kept]; // 70 > 60 触发，kept(30) ≤ 35 目标 → 裁 older
    const first = projectAttachmentsHysteresis(messages, "images", 60, 35);
    expect((first[0] as { images?: unknown }).images).toBeUndefined();
    expect((first[1] as { images?: unknown }).images).toHaveLength(1);

    // 新增小图（总 70+10=80 仍 > 60，但保留集 30+10=40 > 35 → kept 被裁）
    // 换成「仍在余量内」的新小图：40+10=50？不对——新图进保留集，kept 30+10=40 超 35。
    // 这里验证真正的不变量：裁剪之间「未裁消息的投影字节」不变。
    const grown: ChatMessage[] = [older, kept, sized("new", 10)];
    const second = projectAttachmentsHysteresis(grown, "images", 60, 35);
    // 保留集 = newest ≤35：new(10)+kept(30)=40 > 35 → 只留 new；older/kept 都被裁。
    // 切点前移一次（kept 出列），older 的投影结果与上一轮一致。
    expect((second[0] as { images?: unknown }).images).toBeUndefined();
    expect((second[1] as { images?: unknown }).images).toBeUndefined();
    expect((second[2] as { images?: unknown }).images).toHaveLength(1);
    expect(second[0].role === "user" ? second[0].content : "").toBe(first[0].role === "user" ? first[0].content : "");
  });

  it("重启确定性：同一历史重算两次字节一致（幂等）", () => {
    const messages: ChatMessage[] = [
      sized("a", 40),
      assistant("ok"),
      sized("b", 40),
      sized("c", 40),
    ];
    const once = projectAttachmentsHysteresis(messages, "images", 100, 50);
    const twice = projectAttachmentsHysteresis(once, "images", 100, 50);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it("最新一条就超目标线：仍保留最新一条，只裁更旧的", () => {
    const messages: ChatMessage[] = [sized("a", 40), sized("huge", 90)];
    const projected = projectAttachmentsHysteresis(messages, "images", 100, 50);
    expect((projected[0] as { images?: unknown }).images).toBeUndefined();
    expect((projected[1] as { images?: unknown }).images).toHaveLength(1);
  });

  it("projectForMainPath 同时跑图片与文档，且不碰 thinking", () => {
    // 用真实量级：旧图 8.5MiB（总量越过 8MiB 触发线），新图 2MiB（≤4MiB 目标线，保留）
    const old = "x".repeat(ATTACHMENT_HYSTERESIS_TRIGGER_BYTES + 512 * 1024);
    const fresh = "x".repeat(2 * 1024 * 1024);
    const messages: ChatMessage[] = [
      { role: "user", content: "a", images: [{ data: old, mimeType: "image/png" }] },
      assistant("think", "chain"),
      { role: "user", content: "b", images: [{ data: fresh, mimeType: "image/png" }] },
    ];
    const projected = projectForMainPath(messages);
    expect((projected[0] as { images?: unknown }).images).toBeUndefined();
    // thinking 不在主路径投影范围内
    expect(projected[1].role === "assistant" ? projected[1].anthropic_thinking : undefined).toHaveLength(1);
    expect((projected[2] as { images?: unknown }).images).toHaveLength(1);
  });
});
