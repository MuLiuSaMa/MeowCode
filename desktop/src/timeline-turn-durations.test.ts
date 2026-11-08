import { describe, expect, it } from "vitest";
import { timelineFromHistory } from "./timeline";
import type { ChatMessage, TurnDurationGroup, TurnFileChangeGroup } from "./api";

let seq = 0;
function nextKey(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

function messages(): ChatMessage[] {
  return [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
    { role: "user", content: "第二问" },
    { role: "assistant", content: "第二答" },
  ];
}

const firstDuration: TurnDurationGroup = {
  turnId: "t1",
  messageIndex: 2,
  durationMs: 3500,
  status: "completed",
};

describe("timeline turn durations", () => {
  it("插入到该回合最后一条消息之后，而不是整个对话末尾", () => {
    const items = timelineFromHistory(messages(), nextKey, null, null, null, [firstDuration]);
    const index = items.findIndex((item) => item.kind === "turn-info");
    expect(index).toBeGreaterThan(0);
    expect(items.slice(0, index).map((item) => item.kind)).toEqual(["message", "message"]);
    expect(items[index]).toMatchObject({
      kind: "turn-info",
      turnId: "t1",
      durationMs: 3500,
      status: "completed",
    });
  });

  it("紧跟在同回合的改动汇总卡片之后", () => {
    const change: TurnFileChangeGroup = {
      turnId: "t1",
      messageIndex: 2,
      canRewind: false,
      files: [{ path: "a.ts", added: 1, removed: 0 }],
    };
    const items = timelineFromHistory(messages(), nextKey, null, null, [change], [firstDuration]);
    const kinds = items.map((item) => item.kind);
    expect(kinds.indexOf("turn-info")).toBe(kinds.indexOf("turn-changes") + 1);
  });

  it("回放末尾的回合补在时间线最后", () => {
    const items = timelineFromHistory(messages(), nextKey, null, null, null, [
      { ...firstDuration, turnId: "t2", messageIndex: 4 },
    ]);
    expect(items.at(-1)).toMatchObject({ kind: "turn-info", turnId: "t2" });
  });

  it("每一轮各一条，同一回合只插一次", () => {
    const items = timelineFromHistory(messages(), nextKey, null, null, null, [
      firstDuration,
      { ...firstDuration, turnId: "t2", messageIndex: 4, durationMs: 1200 },
      firstDuration,
    ]);
    const infos = items.filter((item) => item.kind === "turn-info");
    expect(infos).toHaveLength(2);
    expect(infos.map((item) => (item as { turnId?: string }).turnId)).toEqual(["t1", "t2"]);
  });
});