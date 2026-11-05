import { describe, expect, it } from "vitest";
import { timelineFromHistory } from "./timeline";
import type { ChatMessage, TurnFileChangeGroup } from "./api";

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

const firstTurn: TurnFileChangeGroup = {
  turnId: "t1",
  messageIndex: 2,
  checkpointId: "auto-1",
  canRewind: true,
  files: [
    { path: "src/a.ts", added: 3, removed: 1 },
    { path: "src/b.ts", added: 1, removed: 0 },
  ],
};

describe("timeline turn changes", () => {
  it("插入到该回合最后一条消息之后，而不是整个对话末尾", () => {
    const items = timelineFromHistory(messages(), nextKey, null, null, [firstTurn]);
    const index = items.findIndex((item) => item.kind === "turn-changes");
    expect(index).toBeGreaterThan(0);
    // 前面正好是第一轮的两条消息（user + assistant）
    expect(items.slice(0, index).map((item) => item.kind)).toEqual(["message", "message"]);
    expect(items[index]).toMatchObject({
      kind: "turn-changes",
      turnId: "t1",
      checkpointId: "auto-1",
      canRewind: true,
      files: firstTurn.files,
    });
  });

  it("回放末尾的回合补在时间线最后", () => {
    const items = timelineFromHistory(messages(), nextKey, null, null, [
      { ...firstTurn, turnId: "t2", messageIndex: 4 },
    ]);
    expect(items.at(-1)?.kind).toBe("turn-changes");
  });

  it("没有文件改动的组不产生卡片，同一回合只插一次", () => {
    const empty = timelineFromHistory(messages(), nextKey, null, null, [
      { ...firstTurn, files: [] },
    ]);
    expect(empty.some((item) => item.kind === "turn-changes")).toBe(false);

    const duplicated = timelineFromHistory(messages(), nextKey, null, null, [firstTurn, firstTurn]);
    expect(duplicated.filter((item) => item.kind === "turn-changes")).toHaveLength(1);
  });

  it("不带检查点时不渲染撤销目标（按钮由组件置灰）", () => {
    const items = timelineFromHistory(messages(), nextKey, null, null, [
      { ...firstTurn, checkpointId: undefined, canRewind: false },
    ]);
    const card = items.find((item) => item.kind === "turn-changes") as {
      checkpointId?: string;
      canRewind?: boolean;
    };
    expect(card.checkpointId).toBeUndefined();
    expect(card.canRewind).toBeUndefined();
  });
});
