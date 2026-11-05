import { describe, expect, it } from "vitest";
import { timelineFromHistory, type HistoryCheckpoint } from "./timeline";
import type { ChatMessage } from "./api";

function keyFactory(prefix: string): string {
  return `${prefix}-key`;
}

function messages(): ChatMessage[] {
  return [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
    { role: "user", content: "第二问" },
    { role: "assistant", content: "第二答" },
  ];
}

const autoWithSnapshot: HistoryCheckpoint = {
  id: "auto-1",
  timestamp: "2026-11-01T08:00:00.000Z",
  auto: true,
  fileChanges: [],
  messageIndex: 0,
  hasSnapshot: true,
  fileCount: 2,
};

describe("timeline checkpoints", () => {
  it("anchors automatic checkpoints onto their user message instead of a divider", () => {
    const items = timelineFromHistory(messages(), keyFactory, null, [autoWithSnapshot]);
    const dividers = items.filter((item) => item.kind === "checkpoint");
    expect(dividers).toHaveLength(0);
    const firstUser = items.find(
      (item) => item.kind === "message" && item.role === "user",
    ) as { checkpointId?: string; checkpointHasSnapshot?: boolean };
    expect(firstUser.checkpointId).toBe("auto-1");
    expect(firstUser.checkpointHasSnapshot).toBe(true);
    // 第二条 user 消息没有检查点，不挂入口
    const userItems = items.filter((item) => item.kind === "message" && item.role === "user");
    expect((userItems[1] as { checkpointId?: string }).checkpointId).toBeUndefined();
  });

  it("does not attach a rewind entry when the auto checkpoint has no snapshot (legacy sessions)", () => {
    const legacy: HistoryCheckpoint = { ...autoWithSnapshot, hasSnapshot: false, fileCount: 0 };
    const items = timelineFromHistory(messages(), keyFactory, null, [legacy]);
    const firstUser = items.find(
      (item) => item.kind === "message" && item.role === "user",
    ) as { checkpointId?: string; checkpointHasSnapshot?: boolean };
    // 旧条目仍挂载 id（仅对话回滚可用），但标记无快照
    expect(firstUser.checkpointId).toBe("auto-1");
    expect(firstUser.checkpointHasSnapshot).toBe(false);
  });

  it("keeps rendering manual checkpoints as dividers with snapshot info", () => {
    const manual: HistoryCheckpoint = {
      id: "manual-1",
      timestamp: "2026-11-01T08:01:00.000Z",
      label: "阶段完成",
      auto: false,
      fileChanges: ["a.ts"],
      messageIndex: 2,
      hasSnapshot: true,
      fileCount: 1,
    };
    const items = timelineFromHistory(messages(), keyFactory, null, [manual]);
    const dividers = items.filter((item) => item.kind === "checkpoint");
    expect(dividers).toHaveLength(1);
    expect(dividers[0]).toMatchObject({
      kind: "checkpoint",
      id: "manual-1",
      label: "阶段完成",
      hasSnapshot: true,
      fileCount: 1,
    });
  });

  it("auto checkpoints without any checkpoint list leave user messages untouched", () => {
    const items = timelineFromHistory(messages(), keyFactory, null, null);
    const userItems = items.filter((item) => item.kind === "message" && item.role === "user");
    for (const item of userItems) {
      expect((item as { checkpointId?: string }).checkpointId).toBeUndefined();
    }
  });
});
