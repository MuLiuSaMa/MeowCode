import { describe, expect, it } from "vitest";
import { PINNED_GROUP_ID, groupSessionsByProject, reorderConversationPaths } from "./conversation-groups";
import type { SessionSummary } from "./api";

function session(overrides: Partial<SessionSummary> & { filePath: string; cwd: string }): SessionSummary {
  return {
    title: overrides.filePath,
    createdAt: "2026-10-01T00:00:00.000Z",
    messageCount: 2,
    ...overrides,
  } as SessionSummary;
}

function order(groups: Array<{ cwd: string }>): string[] {
  return groups.map((group) => group.cwd);
}

const base = { archivedSessions: [] as string[], removedProjects: [] as string[], pinnedProjects: [] as string[] };

describe("groupSessionsByProject", () => {
  it("does not hoist the active workspace to the top", () => {
    const groups = groupSessionsByProject({
      ...base,
      workspace: "D:/old-project",
      sessions: [
        session({ filePath: "a.jsonl", cwd: "D:/new-project", createdAt: "2026-10-30T00:00:00.000Z" }),
        session({ filePath: "b.jsonl", cwd: "D:/old-project", createdAt: "2026-10-01T00:00:00.000Z" }),
      ],
    });
    // 关键回归：点开旧项目的会话，新项目仍然排在前面
    expect(order(groups)).toEqual(["D:/new-project", "D:/old-project"]);
  });

  it("hoists the project and the card after continuing an old chat", () => {
    const groups = groupSessionsByProject({
      ...base,
      workspace: null,
      sessions: [
        // 新项目：会话本身较新，但最近没有活动
        session({ filePath: "new.jsonl", cwd: "D:/new-project", createdAt: "2026-11-01T00:00:00.000Z" }),
        // 旧项目：今天继续了其中的旧对话
        session({
          filePath: "continued.jsonl",
          cwd: "D:/old-project",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-11-28T00:00:00.000Z",
        }),
        session({
          filePath: "older.jsonl",
          cwd: "D:/old-project",
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
        }),
      ],
    });
    expect(order(groups)).toEqual(["D:/old-project", "D:/new-project"]);
    expect(groups[0].items.map((item) => item.filePath)).toEqual([
      "continued.jsonl",
      "older.jsonl",
    ]);
  });

  it("uses manual card order without changing project order", () => {
    const groups = groupSessionsByProject({
      ...base,
      workspace: null,
      conversationOrder: {
        "D:/a": ["old.jsonl", "fresh.jsonl"],
      },
      sessions: [
        session({ filePath: "fresh.jsonl", cwd: "D:/a", updatedAt: "2026-11-28T00:00:00.000Z" }),
        session({ filePath: "old.jsonl", cwd: "D:/a", updatedAt: "2026-01-01T00:00:00.000Z" }),
        session({ filePath: "other.jsonl", cwd: "D:/b", updatedAt: "2026-11-20T00:00:00.000Z" }),
      ],
    });
    expect(order(groups)).toEqual(["D:/a", "D:/b"]);
    expect(groups[0].items.map((item) => item.filePath)).toEqual(["old.jsonl", "fresh.jsonl"]);
  });

  it("appends new cards after manually ordered cards", () => {
    const groups = groupSessionsByProject({
      ...base,
      workspace: null,
      conversationOrder: {
        "D:/a": ["b.jsonl", "a.jsonl"],
      },
      sessions: [
        session({ filePath: "a.jsonl", cwd: "D:/a", updatedAt: "2026-11-01T00:00:00.000Z" }),
        session({ filePath: "b.jsonl", cwd: "D:/a", updatedAt: "2026-10-01T00:00:00.000Z" }),
        session({ filePath: "c.jsonl", cwd: "D:/a", updatedAt: "2026-11-28T00:00:00.000Z" }),
      ],
    });
    expect(groups[0].items.map((item) => item.filePath)).toEqual(["b.jsonl", "a.jsonl", "c.jsonl"]);
  });

  it("keeps pinned projects above recency", () => {
    const groups = groupSessionsByProject({
      ...base,
      workspace: null,
      pinnedProjects: ["D:/pinned-b", "D:/pinned-a"],
      sessions: [
        session({ filePath: "a.jsonl", cwd: "D:/fresh", createdAt: "2026-10-31T00:00:00.000Z" }),
        session({ filePath: "b.jsonl", cwd: "D:/pinned-a", createdAt: "2026-10-02T00:00:00.000Z" }),
        session({ filePath: "c.jsonl", cwd: "D:/pinned-b", createdAt: "2026-10-03T00:00:00.000Z" }),
      ],
    });
    expect(order(groups)).toEqual(["D:/pinned-b", "D:/pinned-a", "D:/fresh"]);
  });

  it("collects pinned conversations into a synthetic group above all projects", () => {
    const groups = groupSessionsByProject({
      ...base,
      workspace: null,
      pinnedProjects: ["D:/pinned-project"],
      pinnedConversations: ["b.jsonl", "a.jsonl", "b.jsonl"],
      sessions: [
        session({ filePath: "a.jsonl", cwd: "D:/pinned-project", createdAt: "2026-11-28T00:00:00.000Z" }),
        session({ filePath: "b.jsonl", cwd: "D:/other", createdAt: "2026-10-01T00:00:00.000Z" }),
        session({ filePath: "c.jsonl", cwd: "D:/other", createdAt: "2026-11-01T00:00:00.000Z" }),
      ],
    });
    expect(groups[0].cwd).toBe(PINNED_GROUP_ID);
    // 按置顶顺序排列，重复条目去重
    expect(groups[0].items.map((item) => item.filePath)).toEqual(["b.jsonl", "a.jsonl"]);
    // 置顶的会话从原项目分组里移出，不再重复显示；项目里只剩 c.jsonl
    expect(order(groups)).toEqual([PINNED_GROUP_ID, "D:/other"]);
    const other = groups.find((group) => group.cwd === "D:/other");
    expect(other?.items.map((item) => item.filePath)).toEqual(["c.jsonl"]);
  });

  it("keeps archived, empty and stale chats out of the pinned zone", () => {
    const groups = groupSessionsByProject({
      ...base,
      workspace: null,
      archivedSessions: ["archived.jsonl"],
      pinnedConversations: ["stale.jsonl", "archived.jsonl", "empty.jsonl", "kept.jsonl"],
      sessions: [
        session({ filePath: "archived.jsonl", cwd: "D:/a" }),
        session({ filePath: "empty.jsonl", cwd: "D:/b", messageCount: 0 }),
        session({ filePath: "kept.jsonl", cwd: "D:/b" }),
        session({ filePath: "plain.jsonl", cwd: "D:/b", createdAt: "2026-11-20T00:00:00.000Z" }),
      ],
    });
    expect(groups[0].cwd).toBe(PINNED_GROUP_ID);
    // stale.jsonl 已不在会话列表里（置顶后文件被删），同样不进栏
    expect(groups[0].items.map((item) => item.filePath)).toEqual(["kept.jsonl"]);
    // 项目里剩未被置顶的 plain.jsonl
    expect(order(groups)).toEqual([PINNED_GROUP_ID, "D:/b"]);
    const project = groups.find((group) => group.cwd === "D:/b");
    expect(project?.items.map((item) => item.filePath)).toEqual(["plain.jsonl"]);
  });

  it("adds no synthetic group when nothing is pinned", () => {
    const groups = groupSessionsByProject({
      ...base,
      workspace: "D:/work",
      sessions: [session({ filePath: "a.jsonl", cwd: "D:/work" })],
    });
    expect(order(groups)).toEqual(["D:/work"]);
    expect(groups.some((group) => group.cwd === PINNED_GROUP_ID)).toBe(false);
  });

  it("always lists the active workspace even when it has no chats", () => {
    const groups = groupSessionsByProject({
      ...base,
      workspace: "D:/empty",
      sessions: [session({ filePath: "a.jsonl", cwd: "D:/other" })],
    });
    expect(order(groups)).toEqual(["D:/other", "D:/empty"]);
    expect(groups[1].items).toEqual([]);
  });

  it("hides archived chats, empty chats and removed projects", () => {
    const groups = groupSessionsByProject({
      ...base,
      workspace: null,
      archivedSessions: ["archived.jsonl"],
      removedProjects: ["D:/removed"],
      sessions: [
        session({ filePath: "archived.jsonl", cwd: "D:/a" }),
        session({ filePath: "empty.jsonl", cwd: "D:/b", messageCount: 0 }),
        session({ filePath: "gone.jsonl", cwd: "D:/removed" }),
        session({ filePath: "kept.jsonl", cwd: "D:/kept" }),
      ],
    });
    expect(order(groups)).toEqual(["D:/kept"]);
  });

  it("reorders a card before or after its drop target", () => {
    expect(reorderConversationPaths(["a", "b", "c"], "a", "c", "before")).toEqual(["b", "a", "c"]);
    expect(reorderConversationPaths(["a", "b", "c"], "c", "a", "after")).toEqual(["a", "c", "b"]);
    expect(reorderConversationPaths(["a", "b", "c"], "b", "b", "after")).toEqual(["a", "b", "c"]);
  });

  it("folds worktree sessions back into their source project", () => {
    const groups = groupSessionsByProject({
      ...base,
      workspace: null,
      sessions: [
        session({ filePath: "a.jsonl", cwd: "D:/repo" }),
        session({
          filePath: "b.jsonl",
          cwd: "D:/repo/.worktrees/feat",
          worktree: { sourceCwd: "D:/repo" },
        } as Partial<SessionSummary> & { filePath: string; cwd: string }),
      ],
    });
    expect(order(groups)).toEqual(["D:/repo"]);
    expect(groups[0].items).toHaveLength(2);
  });
});
