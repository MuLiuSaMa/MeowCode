import { describe, expect, it } from "vitest";
import { groupSessionsByProject } from "./conversation-groups";
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
