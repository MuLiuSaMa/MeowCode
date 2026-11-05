import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "./session-store.js";
import { buildExportDoc, renderJson } from "./session-export.js";
import { renderMarkdown } from "./session-export-markdown.js";
import { renderHtml } from "./session-export-html.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function makeSession() {
  const dir = await mkdtemp(path.join(tmpdir(), "meowcode-export-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "session.jsonl");
  const session = await SessionStore.create(filePath, "D:/repo");
  return { session, filePath };
}

/** 一轮完整对话：用户提问 → assistant 带思考与工具调用 → 工具结果 → 最终答复 */
async function seedTurn(session: SessionStore, turnId = "t1") {
  await session.appendTitle("修复登录超时");
  await session.appendTurnStart({ turnId, model: "m1", providerId: "p1" });
  await session.appendMessage({ role: "user", content: "登录为什么超时？" });
  await session.appendMessage({
    role: "assistant",
    content: "我先看下配置。",
    reasoning: "先读 auth.ts",
    tool_calls: [
      {
        id: "call-1",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"src/auth.ts"}' },
      },
    ],
  });
  await session.appendToolCallStarted({
    turnId,
    callId: "call-1",
    tool: "read_file",
    input: { path: "src/auth.ts" },
  });
  await session.appendMessage({
    role: "tool",
    content: "export const timeout = 30000;",
    tool_call_id: "call-1",
    name: "read_file",
  });
  await session.appendApproval({
    callId: "call-1",
    tool: "read_file",
    input: { path: "src/auth.ts" },
    approved: true,
  });
  await session.appendMessage({ role: "assistant", content: "超时是 30s 太短，调到 60s 就行。" });
  await session.appendUsage({ inputTokens: 100, outputTokens: 20, source: "chat" });
  await session.appendTurnEnd({ turnId, status: "completed" });
  await session.flush();
}

describe("buildExportDoc", () => {
  it("按 turn 分组，工具结果回填到对应调用上", async () => {
    const { session } = await makeSession();
    await seedTurn(session);

    const doc = buildExportDoc(session.entries);

    expect(doc.session.title).toBe("修复登录超时");
    expect(doc.session.cwd).toBe(path.resolve("D:/repo"));
    expect(doc.turns).toHaveLength(1);
    const turn = doc.turns[0]!;
    expect(turn.status).toBe("completed");
    expect(turn.items.map((item) => item.kind)).toEqual([
      "user",
      "assistant",
      "tool",
      "approval",
      "assistant",
    ]);
    const tool = turn.items.find((item) => item.kind === "tool");
    expect(tool && tool.kind === "tool" ? tool.call.output : "").toBe(
      "export const timeout = 30000;",
    );
    expect(doc.usage.inputTokens).toBe(100);
  });

  it("没有 turn_start 的历史条目收进 loose，不丢内容", async () => {
    const { session } = await makeSession();
    await session.appendMessage({ role: "user", content: "早期会话没有 turn 标记" });
    await session.flush();

    const doc = buildExportDoc(session.entries);

    expect(doc.turns).toHaveLength(0);
    expect(doc.loose?.items).toHaveLength(1);
  });

  it("includeTools=false 时不产生工具条目", async () => {
    const { session } = await makeSession();
    await seedTurn(session);

    const doc = buildExportDoc(session.entries, { includeTools: false });

    expect(doc.turns[0]!.items.some((item) => item.kind === "tool")).toBe(false);
  });
});

describe("renderMarkdown", () => {
  it("用户消息用引用块，工具调用折叠，思考折叠", async () => {
    const { session } = await makeSession();
    await seedTurn(session);
    const doc = buildExportDoc(session.entries);

    const markdown = renderMarkdown(doc, { exportedAt: "2026-11-01T00:00:00.000Z" });

    expect(markdown.startsWith("# 修复登录超时")).toBe(true);
    expect(markdown).toContain("> 登录为什么超时？");
    expect(markdown).toContain("<summary>Thinking</summary>");
    expect(markdown).toContain("<summary>Tool calls ×1 · read_file</summary>");
    expect(markdown).toContain("**Input**");
    expect(markdown).toContain("export const timeout = 30000;");
    expect(markdown).toContain("超时是 30s 太短");
    // 元信息
    expect(markdown).toContain("Session ID");
    expect(markdown).toContain(path.resolve("D:/repo"));
  });

  it("正文里的未闭合围栏被补齐，不会吞掉后面的折叠块", async () => {
    const { session } = await makeSession();
    await session.appendTurnStart({ turnId: "t1", model: "m", providerId: "p" });
    await session.appendMessage({ role: "user", content: "看这段代码\n```ts\nconst a = 1;" });
    await session.appendMessage({ role: "assistant", content: "这是结果" });
    await session.appendTurnEnd({ turnId: "t1", status: "completed" });
    await session.flush();

    const markdown = renderMarkdown(buildExportDoc(session.entries));

    // 补齐后总围栏数为偶数
    const fences = markdown.match(/^ {0,3}`{3,}/gm) ?? [];
    expect(fences.length % 2).toBe(0);
    expect(markdown).toContain("这是结果");
  });

  it("正文里的 details 被转义，代码块内的保持原样", async () => {
    const { session } = await makeSession();
    await session.appendTurnStart({ turnId: "t1", model: "m", providerId: "p" });
    await session.appendMessage({
      role: "user",
      content: "<details>注入</details>\n\n```html\n<details>keep</details>\n```",
    });
    await session.appendTurnEnd({ turnId: "t1", status: "completed" });
    await session.flush();

    const markdown = renderMarkdown(buildExportDoc(session.entries));

    expect(markdown).toContain("&lt;details>注入");
    expect(markdown).toContain("<details>keep</details>");
  });

  it("图片默认内联 data URI，关闭后写 assets 相对路径", async () => {
    const { session } = await makeSession();
    const png = Buffer.from("fake-png").toString("base64");
    await session.appendTurnStart({ turnId: "t1", model: "m", providerId: "p" });
    await session.appendMessage({
      role: "user",
      content: "看这张图",
      images: [{ data: png, mimeType: "image/png" }],
    });
    await session.appendTurnEnd({ turnId: "t1", status: "completed" });
    await session.flush();

    const doc = buildExportDoc(session.entries);
    expect(renderMarkdown(doc)).toContain(`data:image/png;base64,${png}`);
    expect(renderMarkdown(doc, { inlineImages: false })).toContain("assets/");
  });
});

describe("renderJson / renderHtml", () => {
  it("json 带 format/version 与结构化轮次", async () => {
    const { session } = await makeSession();
    await seedTurn(session);

    const payload = JSON.parse(renderJson(buildExportDoc(session.entries))) as {
      format: string;
      version: number;
      turns: Array<{ items: unknown[] }>;
    };

    expect(payload.format).toBe("meowcode.session.export");
    expect(payload.version).toBe(1);
    expect(payload.turns[0]!.items.length).toBeGreaterThan(0);
  });

  it("html 是单文件自包含（无外链脚本/字体）", async () => {
    const { session } = await makeSession();
    await seedTurn(session);

    const html = renderHtml(buildExportDoc(session.entries));

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('Content-Security-Policy');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("fonts.googleapis");
    expect(html).toContain("Tool calls ×1");
  });
});
