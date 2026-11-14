import { describe, expect, it } from "vitest";
import { dropSupersededNotes, supersededNoteFamily } from "./context-notes.js";
import type { ChatMessage } from "./types.js";

/**
 * #5 上下文注记的「只留最新」：mode / speech / plan / 命令账本四族，
 * 每族只保留最后一条。journal 与 UI 历史不动，只影响发出去的请求。
 */

function user(content: string): ChatMessage {
  return { role: "user", content };
}

describe("supersededNoteFamily", () => {
  it("按前缀识别四个家族，其余内容不算", () => {
    expect(supersededNoteFamily(user("Runtime context: [mode] plan\n..."))).toBe(
      "Runtime context: [mode]",
    );
    expect(supersedNoteFamilyHelper()).toBe("Runtime context: [speech style]");
    expect(
      supersededNoteFamily(user("Runtime context: current task plan (latest snapshot)\n...")),
    ).toBe("Runtime context: current task plan");
    expect(
      supersededNoteFamily(user("Runtime context: commands already run before compaction\n...")),
    ).toBe("Runtime context: commands already run before compaction");
    expect(supersededNoteFamily(user("普通用户消息"))).toBeNull();
    expect(supersededNoteFamily(user("Runtime context: [fork] You are a fork."))).toBeNull();
    // 非字符串内容 / 非 user 消息都不算
    expect(
      supersededNoteFamily({ role: "user", content: [{ type: "text", text: "Runtime context: [mode]" }] }),
    ).toBeNull();
    expect(supersededNoteFamily({ role: "assistant", content: "Runtime context: [mode]" })).toBeNull();
  });

  function supersedNoteFamilyHelper(): string | null {
    return supersededNoteFamily(user("Runtime context: [speech style] tafei\n..."));
  }
});

describe("dropSupersededNotes", () => {
  it("同一家族只留最后一条，顺序与引用保持不变", () => {
    const first = user("Runtime context: [mode] plan\nbe plan-like");
    const middle = user("实话说说进度");
    const second = user("Runtime context: [mode] goal\nbe goal-like");
    const third = user("Runtime context: [mode] plan\nback to plan");
    const out = dropSupersededNotes([first, middle, second, third]);

    // mode 家族只留最后一条：first/second 都被 third 覆盖
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(middle);
    expect(out[1]).toBe(third);
    expect(out.some((message) => message === first)).toBe(false);
  });

  it("不同家族互不影响，fork 契约永不丢弃", () => {
    const fork = user("Runtime context: [fork] You are a fork of the main conversation.");
    const mode = user("Runtime context: [mode] plan\nbe plan-like");
    const plan = user("Runtime context: current task plan (latest snapshot; supersedes earlier plans):\n- step");
    const speech = user("Runtime context: [speech style] tafei\nUse a playful tone.");
    const out = dropSupersededNotes([fork, mode, plan, speech]);

    expect(out).toHaveLength(4);
    expect(out[0]).toBe(fork);
  });

  it("没有注记时原样返回（内容等价）", () => {
    const messages = [user("hello"), user("world")];
    const out = dropSupersededNotes(messages);
    expect(out).toHaveLength(2);
    expect(out[0].content).toBe("hello");
    expect(out[1].content).toBe("world");
  });
});
