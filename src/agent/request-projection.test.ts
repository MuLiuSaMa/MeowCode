import { describe, expect, it } from "vitest";
import {
  KEEP_THINKING_USER_TURNS,
  MAX_USER_IMAGE_MESSAGES_IN_CONTEXT,
  projectAnthropicThinking,
  projectForRequest,
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
