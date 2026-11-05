import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MEMORY_INDEX_NAME, listMemories, memoryDirFor } from "./memory";
import {
  applyMemoryOps,
  buildExtractionUserPrompt,
  cleanExtractionOps,
  formatMemoryNotice,
  hasNewUserMessage,
  lastRealUserMessageIndex,
  serializeMessages,
  wroteMemoryDirectly,
  type MemoryOp,
} from "./memory-extraction";
import type { ChatMessage } from "./types";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length) {
    await rm(tempRoots.pop()!, { recursive: true, force: true });
  }
});

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function user(text: string): ChatMessage {
  return { role: "user", content: text };
}

describe("serializeMessages", () => {
  it("renders user, assistant, tool calls and results with role labels", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "you are a coding agent" },
      user("以后提交信息都用中文"),
      {
        role: "assistant",
        content: "好的，我记下了",
        tool_calls: [
          { id: "1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } },
        ],
      },
      { role: "tool", content: "file body", tool_call_id: "1", name: "read_file" },
    ];
    const text = serializeMessages(messages);
    expect(text).toContain("USER: 以后提交信息都用中文");
    expect(text).toContain("ASSISTANT: 好的，我记下了");
    expect(text).toContain("- called read_file(");
    expect(text).toContain("- result(read_file): file body");
    // system 不进蒸馏素材
    expect(text).not.toContain("you are a coding agent");
  });

  it("skips synthetic user messages and clips long content", () => {
    const messages: ChatMessage[] = [
      user("[memory] Background memory extraction updated your memory directory."),
      user("x".repeat(6000)),
    ];
    const text = serializeMessages(messages);
    expect(text).not.toContain("[memory]");
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(4200);
  });

  it("keeps the newest messages when over the total budget", () => {
    const messages: ChatMessage[] = [];
    for (let index = 0; index < 40; index += 1) {
      messages.push(user(`message-${index}-${"y".repeat(2000)}`));
    }
    const text = serializeMessages(messages);
    expect(text).toContain("message-39");
    expect(text).not.toContain("message-0-");
    expect(text.length).toBeLessThan(50_000);
  });
});

describe("cleanExtractionOps", () => {
  it("parses the JSON object form and validates entries", () => {
    const raw = JSON.stringify({
      ops: [
        {
          op: "write",
          scope: "user",
          name: "commit-language",
          type: "feedback",
          description: "提交信息用中文",
          content: "用户要求 commit message 一律中文并带 scope。",
        },
        { op: "delete", scope: "project", name: "outdated-fact" },
      ],
    });
    expect(cleanExtractionOps(raw)).toEqual([
      {
        op: "write",
        scope: "user",
        name: "commit-language",
        description: "提交信息用中文",
        content: "用户要求 commit message 一律中文并带 scope。",
        type: "feedback",
      },
      { op: "delete", scope: "project", name: "outdated-fact" },
    ] satisfies MemoryOp[]);
  });

  it("strips think blocks and fences", () => {
    const raw = `<think>let me reason about this</think>\`\`\`json\n{"ops":[{"op":"write","scope":"user","name":"a","description":"d","content":"c"}]}\n\`\`\``;
    expect(cleanExtractionOps(raw)).toEqual([
      { op: "write", scope: "user", name: "a", description: "d", content: "c" },
    ]);
  });

  it("drops invalid entries and caps the op count", () => {
    const ops = Array.from({ length: 12 }, (_, index) => ({
      op: "write",
      scope: "user",
      name: `entry-${index}`,
      description: "d",
      content: "c",
    }));
    const raw = JSON.stringify({
      ops: [
        { op: "write", scope: "workspace", name: "bad-scope", content: "c" }, // 非法 scope
        { op: "write", scope: "user", name: "../evil", content: "c" }, // 非法名字
        { op: "write", scope: "user", name: "no-content", description: "d" }, // 缺 content
        { op: "nonsense", scope: "user", name: "x" }, // 未知 op
        ...ops,
      ],
    });
    const cleaned = cleanExtractionOps(raw);
    expect(cleaned).toHaveLength(8);
    expect(cleaned.every((op) => op.name !== "../evil" && op.name !== "bad-scope" && op.name !== "no-content")).toBe(true);
  });

  it("returns empty for prose output or missing ops", () => {
    expect(cleanExtractionOps("I think nothing is worth saving.")).toEqual([]);
    expect(cleanExtractionOps('{"message":"hi"}')).toEqual([]);
    expect(cleanExtractionOps("")).toEqual([]);
  });

  it("accepts a bare array form", () => {
    const raw = JSON.stringify([{ op: "delete", scope: "user", name: "a" }]);
    expect(cleanExtractionOps(raw)).toEqual([{ op: "delete", scope: "user", name: "a" }]);
  });
});

describe("applyMemoryOps", () => {
  it("writes to both scopes, syncs indexes and reports created vs updated", async () => {
    const workspace = await makeDir("meowcode-extract-ws-");
    const home = await makeDir("meowcode-extract-home-");
    const first = await applyMemoryOps(
      [
        {
          op: "write",
          scope: "user",
          name: "commit-language",
          description: "提交信息用中文",
          content: "commit message 一律中文。",
          type: "feedback",
        },
        { op: "write", scope: "project", name: "build-tool", description: "构建用 pnpm", content: "用 pnpm。" },
      ],
      workspace,
      home,
    );
    expect(first.written).toEqual(["commit-language (user)", "build-tool (project)"]);
    expect(first.updated).toEqual([]);

    const userIndex = await readFile(path.join(memoryDirFor("user", workspace, home), MEMORY_INDEX_NAME), "utf8");
    expect(userIndex).toContain("- [commit-language](commit-language.md) — 提交信息用中文");
    const projectDir = memoryDirFor("project", workspace);
    expect(await listMemories(projectDir)).toEqual([{ name: "build-tool", description: "构建用 pnpm" }]);

    const second = await applyMemoryOps(
      [{ op: "write", scope: "user", name: "commit-language", description: "提交信息用中文", content: "v2" }],
      workspace,
      home,
    );
    expect(second.updated).toEqual(["commit-language (user)"]);
    expect(second.written).toEqual([]);
  });

  it("deletes existing entries and skips missing ones", async () => {
    const workspace = await makeDir("meowcode-extract-ws-");
    const home = await makeDir("meowcode-extract-home-");
    await applyMemoryOps(
      [{ op: "write", scope: "user", name: "gone-soon", description: "d", content: "c" }],
      workspace,
      home,
    );
    const result = await applyMemoryOps(
      [
        { op: "delete", scope: "user", name: "gone-soon" },
        { op: "delete", scope: "user", name: "never-existed" },
      ],
      workspace,
      home,
    );
    expect(result.deleted).toEqual(["gone-soon (user)"]);
    expect(await listMemories(memoryDirFor("user", workspace, home))).toEqual([]);
  });
});

describe("gates", () => {
  it("detects direct memory writes after the cursor", () => {
    const messages: ChatMessage[] = [
      user("记住我喜欢 pnpm"),
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "1", type: "function", function: { name: "memory_write", arguments: "{}" } },
        ],
      },
    ];
    expect(wroteMemoryDirectly(messages, 0)).toBe(true);
    expect(wroteMemoryDirectly(messages, 1)).toBe(true);
    expect(wroteMemoryDirectly([user("hi")], 0)).toBe(false);
  });

  it("requires a real user message after the cursor", () => {
    const messages: ChatMessage[] = [
      user("first"),
      { role: "assistant", content: "done" },
      user("[memory] synthetic notice"),
    ];
    expect(hasNewUserMessage(messages, 1)).toBe(false);
    expect(hasNewUserMessage(messages, 0)).toBe(true);
    expect(lastRealUserMessageIndex(messages)).toBe(0);
    expect(lastRealUserMessageIndex([{ role: "assistant", content: "hi" }])).toBe(-1);
  });
});

describe("notice", () => {
  it("formats changes and returns null when nothing changed", () => {
    expect(
      formatMemoryNotice({
        written: ["commit-language (user)"],
        updated: ["build-tool (project)"],
        deleted: [],
      }),
    ).toContain('wrote commit-language (user); updated build-tool (project)');
    expect(formatMemoryNotice({ written: [], updated: [], deleted: [] })).toBeNull();
  });
});

describe("buildExtractionUserPrompt", () => {
  it("includes the manifest, date and transcript", () => {
    const prompt = buildExtractionUserPrompt({
      transcript: "USER: hello",
      manifest: [{ scope: "user", name: "a", description: "d" }],
      today: "2026-10-31",
    });
    expect(prompt).toContain("2026-10-31");
    expect(prompt).toContain("- [user] a — d");
    expect(prompt).toContain("USER: hello");
  });

  it("says none yet when the manifest is empty", () => {
    const prompt = buildExtractionUserPrompt({ transcript: "x", manifest: [], today: "2026-10-31" });
    expect(prompt).toContain("none yet");
  });
});

describe("writeMemoryFile via applyMemoryOps is name-safe", () => {
  it("never escapes the memory directory", async () => {
    const workspace = await makeDir("meowcode-extract-ws-");
    await mkdir(workspace, { recursive: true });
    const result = await applyMemoryOps(
      [
        {
          op: "write",
          scope: "project",
          name: "../../evil",
          description: "d",
          content: "c",
        },
      ],
      workspace,
    );
    // cleanExtractionOps 已过滤，但 applyMemoryOps 自身也要兜底（名字非法 → saveMemory 抛错被吞）
    expect(result.written).toEqual([]);
  });
});
