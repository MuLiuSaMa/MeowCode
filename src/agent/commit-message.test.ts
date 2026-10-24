import { describe, expect, it, vi } from "vitest";
import {
  buildUserPrompt,
  cleanCommitMessage,
  summarizePatch,
} from "./commit-message";

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));
vi.mock("./provider.js", () => ({
  completionUrl: vi.fn(),
  streamChatCompletion: streamMock,
  utilityProvider: (provider: Record<string, unknown>, maxTokens: number) => ({
    ...provider,
    maxTokens,
    reasoningEffort: undefined,
    thinkingBudget: undefined,
  }),
}));

const { generateCommitMessage } = await import("./commit-message.js");

describe("summarizePatch", () => {
  const patch = [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1 +1 @@",
    "-const a = 1;",
    "+const a = 2;",
    "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
    "--- a/pnpm-lock.yaml",
    "+++ b/pnpm-lock.yaml",
    "+huge lock diff",
    "diff --git a/dist/bundle.js b/dist/bundle.js",
    "+++ b/dist/bundle.js",
    "+built output",
  ].join("\n");

  it("drops lockfiles and build output", () => {
    const summary = summarizePatch(patch);
    expect(summary).toContain("src/app.ts");
    expect(summary).not.toContain("pnpm-lock.yaml");
    expect(summary).not.toContain("dist/bundle.js");
  });

  it("returns an empty string when there is nothing to summarize", () => {
    expect(summarizePatch(undefined)).toBe("");
    expect(summarizePatch("")).toBe("");
    expect(summarizePatch("diff --git a/package-lock.json b/package-lock.json\n+x")).toBe("");
  });

  it("truncates very large single-file patches", () => {
    const big = ["diff --git a/big.ts b/big.ts", ...Array.from({ length: 200 }, () => "+x".repeat(200))].join("\n");
    const summary = summarizePatch(big);
    expect(summary).toContain("[truncated]");
    expect(summary.length).toBeLessThan(4_000);
  });
});

describe("buildUserPrompt", () => {
  it("includes recent subjects, stat and patch", () => {
    const prompt = buildUserPrompt({
      recentSubjects: ["feat: 新增模型表单", "fix: 修复缓存"],
      statText: " src/app.ts | 2 +-",
      patchText: "diff --git a/src/app.ts b/src/app.ts\n+const a = 2;",
    });
    expect(prompt).toContain("Recent commit subjects");
    expect(prompt).toContain("- feat: 新增模型表单");
    expect(prompt).toContain("Staged files");
    expect(prompt).toContain("diff --git a/src/app.ts");
  });

  it("falls back to a note when nothing is staged", () => {
    const prompt = buildUserPrompt({ recentSubjects: [] });
    expect(prompt).toContain("No staged diff");
  });
});

describe("cleanCommitMessage", () => {
  it("keeps a plain message", () => {
    expect(cleanCommitMessage("feat: add pdf support")).toBe("feat: add pdf support");
  });

  it("keeps a subject plus body", () => {
    const message = cleanCommitMessage("feat: add pdf\n\n- extract text layer\n- cache pages");
    expect(message).toBe("feat: add pdf\n\n- extract text layer\n- cache pages");
  });

  it("strips think blocks", () => {
    expect(cleanCommitMessage("<think>hmm</think>\nfix: bug")).toBe("fix: bug");
  });

  it("unwraps fenced output", () => {
    expect(cleanCommitMessage("```text\nchore: bump deps\n```")).toBe("chore: bump deps");
    expect(cleanCommitMessage("```\nfix: crash\n```")).toBe("fix: crash");
  });

  it("accepts JSON output", () => {
    expect(cleanCommitMessage('{"message":"refactor: split git service"}')).toBe(
      "refactor: split git service",
    );
    expect(cleanCommitMessage('{"commit":"docs: update readme"}')).toBe("docs: update readme");
  });

  it("drops a leading label", () => {
    expect(cleanCommitMessage("Commit message: fix: typo")).toBe("fix: typo");
    expect(cleanCommitMessage("提交信息：修复构建")).toBe("修复构建");
  });

  it("truncates a long subject to 72 chars", () => {
    const message = cleanCommitMessage("x".repeat(120));
    expect(message).toHaveLength(72);
  });

  it("rejects empty output", () => {
    expect(cleanCommitMessage("")).toBeNull();
    expect(cleanCommitMessage("<think>only thinking</think>")).toBeNull();
  });
});

describe("generateCommitMessage", () => {
  const provider = {
    id: "p",
    name: "P",
    baseUrl: "http://localhost",
    model: "m",
  };

  it("calls the model once with no tools and returns the cleaned message", async () => {
    streamMock.mockReset();
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "feat: x" } });
    const message = await generateCommitMessage({
      provider,
      context: { recentSubjects: ["chore: seed"], statText: " a.txt | 1 +" },
    });
    expect(message).toBe("feat: x");
    const call = streamMock.mock.calls[0][0] as {
      tools: unknown[];
      provider: { maxTokens?: number; reasoningEffort?: unknown };
      messages: Array<{ role: string; content: string }>;
    };
    expect(call.tools).toEqual([]);
    expect(call.provider.maxTokens).toBe(400);
    expect(call.provider.reasoningEffort).toBeUndefined();
    expect(call.messages[0].role).toBe("system");
    expect(call.messages[1].content).toContain("chore: seed");
  });

  it("throws when the model returns nothing usable", async () => {
    streamMock.mockReset();
    streamMock.mockResolvedValueOnce({ message: { role: "assistant", content: "```\n```" } });
    await expect(
      generateCommitMessage({ provider, context: { recentSubjects: [] } }),
    ).rejects.toThrow();
  });
});
