import { describe, expect, it } from "vitest";
import { timelineFromHistory } from "./timeline";
import type { ChatMessage } from "./api";

const key = (prefix: string) => `${prefix}-key`;

describe("timeline output-limit continuations", () => {
  it("merges adjacent assistant segments into one message", () => {
    const items = timelineFromHistory(
      [
        { role: "user", content: "写个大文件" },
        { role: "assistant", content: "part one", reasoning: "r1" },
        { role: "assistant", content: " part two", reasoning: "r2", thinkingMs: 1_200 },
      ] as ChatMessage[],
      key,
    );
    const assistants = items.filter(
      (item): item is Extract<(typeof items)[number], { kind: "message" }> =>
        item.kind === "message" && item.role === "assistant",
    );
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({
      content: "part one part two",
      thinking: "r1r2",
      thinkingMs: 1_200,
    });
  });

  it("does not merge across tool calls", () => {
    const items = timelineFromHistory(
      [
        { role: "user", content: "x" },
        { role: "assistant", content: "a" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: "ok", tool_call_id: "c1", name: "read_file" },
        { role: "assistant", content: "b" },
      ] as ChatMessage[],
      key,
    );
    const assistants = items.filter(
      (item): item is Extract<(typeof items)[number], { kind: "message" }> =>
        item.kind === "message" && item.role === "assistant",
    );
    expect(assistants.map((item) => item.content)).toEqual(["a", "b"]);
  });
});
