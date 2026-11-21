import { describe, expect, it } from "vitest";
import {
  MAX_SEGMENT_CHARS,
  MAX_TRAJECTORY_ENTRIES,
  PromptTrajectoryRecorder,
  type PromptTrajectoryInput,
} from "./prompt-trajectory.js";

const VERSION = { baseline: "aaaaaaaa", instructions: "bbbbbbbb", segments: ["cccccccc"] };

function input(overrides: Partial<PromptTrajectoryInput> = {}): PromptTrajectoryInput {
  return {
    sessionId: "s1",
    turnId: "t1",
    roundId: "r1",
    providerId: "p",
    model: "m",
    protocol: "openai-chat-completions",
    promptVersion: VERSION,
    messages: [
      { role: "system", content: "base prompt" },
      { role: "system", content: "project rules" },
      { role: "system", content: "segment body" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ],
    tools: [
      {
        function: {
          name: "read_file",
          description: "read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
      { function: { name: "grep", description: "search", parameters: { type: "object" } } },
    ],
    ...overrides,
  };
}

describe("PromptTrajectoryRecorder", () => {
  it("按装配顺序标注 baseline / instructions / segment[i]", () => {
    const recorder = new PromptTrajectoryRecorder();
    const entry = recorder.record(input());

    expect(entry.segments.map((segment) => segment.label)).toEqual([
      "baseline",
      "instructions",
      "segment[0]",
    ]);
    // 只采 system 消息：user/assistant 不进分段
    expect(entry.segments).toHaveLength(3);
    expect(entry.segments[0].text).toBe("base prompt");
  });

  it("没有 instructions 时段下标从 segment[0] 开始", () => {
    const recorder = new PromptTrajectoryRecorder();
    const entry = recorder.record(
      input({
        promptVersion: { baseline: "aaaaaaaa", instructions: null, segments: [] },
        messages: [
          { role: "system", content: "base prompt" },
          { role: "system", content: "only segment" },
        ],
      }),
    );
    expect(entry.segments.map((segment) => segment.label)).toEqual(["baseline", "segment[0]"]);
  });

  it("接受文本块数组形式的 system 内容", () => {
    const recorder = new PromptTrajectoryRecorder();
    const entry = recorder.record(
      input({
        messages: [
          {
            role: "system",
            content: [{ type: "text", text: "block one" }, { type: "text", text: " + two" }],
          },
        ],
      }),
    );
    expect(entry.segments[0].text).toBe("block one + two");
  });

  it("超长分段截断并打标记，长度仍记录原始值", () => {
    const recorder = new PromptTrajectoryRecorder();
    const huge = "x".repeat(MAX_SEGMENT_CHARS + 500);
    const entry = recorder.record(input({ messages: [{ role: "system", content: huge }] }));

    expect(entry.segments[0].text).toHaveLength(MAX_SEGMENT_CHARS);
    expect(entry.segments[0].truncated).toBe(true);
    expect(entry.segments[0].length).toBe(huge.length);
  });

  it("第一条没有 diff，第二条给出段与工具的变化", () => {
    const recorder = new PromptTrajectoryRecorder();
    const first = recorder.record(input());
    expect(first.diff).toBeNull();

    const second = recorder.record(
      input({
        roundId: "r2",
        messages: [
          { role: "system", content: "base prompt" },
          { role: "system", content: "project rules CHANGED" },
          { role: "system", content: "segment body" },
        ],
        tools: [
          {
            function: {
              name: "read_file",
              description: "read a file",
              parameters: { type: "object", properties: { path: { type: "string" } } },
            },
          },
          // grep 被移除，新增 glob
          { function: { name: "glob", description: "match", parameters: { type: "object" } } },
        ],
      }),
    );

    expect(second.diff).not.toBeNull();
    expect(second.diff?.system).toEqual([1]);
    expect(second.diff?.addedTools).toEqual(["glob"]);
    expect(second.diff?.removedTools).toEqual(["grep"]);
  });

  it("工具描述变了但名字没变：记在 toolChanges 而不是增删", () => {
    const recorder = new PromptTrajectoryRecorder();
    recorder.record(input());
    const second = recorder.record(
      input({
        roundId: "r2",
        tools: [
          {
            function: {
              name: "read_file",
              description: "read a file (now with offsets)",
              parameters: { type: "object", properties: { path: { type: "string" } } },
            },
          },
          { function: { name: "grep", description: "search", parameters: { type: "object" } } },
        ],
      }),
    );

    expect(second.diff?.toolChanges?.map((item) => item.name)).toEqual(["read_file"]);
    expect(second.diff?.addedTools).toEqual([]);
    expect(second.diff?.removedTools).toEqual([]);
    expect(second.diff?.tools).toBe(true);
  });

  it("按会话隔离，并只保留最近 N 条", () => {
    const recorder = new PromptTrajectoryRecorder();
    for (let index = 0; index < MAX_TRAJECTORY_ENTRIES + 3; index += 1) {
      recorder.record(input({ roundId: `r${index}` }));
    }
    recorder.record(input({ sessionId: "s2", roundId: "other" }));

    const list = recorder.list("s1", 100);
    expect(list).toHaveLength(MAX_TRAJECTORY_ENTRIES);
    // 环形缓冲丢的是最旧的
    expect(list[list.length - 1].roundId).toBe(`r${MAX_TRAJECTORY_ENTRIES + 2}`);
    expect(recorder.list("s2")).toHaveLength(1);
  });

  it("list 的 limit 取尾部，顺序为旧 → 新", () => {
    const recorder = new PromptTrajectoryRecorder();
    for (let index = 0; index < 5; index += 1) {
      recorder.record(input({ roundId: `r${index}` }));
    }
    const tail = recorder.list("s1", 2);
    expect(tail.map((entry) => entry.roundId)).toEqual(["r3", "r4"]);
  });
});
