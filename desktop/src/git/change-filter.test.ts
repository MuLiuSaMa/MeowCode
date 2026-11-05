import { describe, expect, it } from "vitest";
import type { GitStatus, SessionChangeSummary } from "../api";
import { filterUncommittedSessionChanges } from "./change-filter";

function change(path: string): SessionChangeSummary {
  return {
    path,
    operation: "edit_file",
    changeCount: 1,
    added: 1,
    removed: 0,
    timestamp: "2026-11-01T00:00:00.000Z",
  };
}

function status(overrides: Partial<GitStatus>): GitStatus {
  return {
    isRepo: true,
    root: "C:/repo",
    staged: [],
    unstaged: [],
    conflicted: [],
    ...overrides,
  };
}

describe("filterUncommittedSessionChanges", () => {
  it("keeps only files that still appear in git status", () => {
    const result = filterUncommittedSessionChanges(
      [change("a.ts"), change("src/b.ts"), change("src/committed.ts")],
      status({
        staged: [{ path: "a.ts", index: "modified", worktree: null }],
        unstaged: [{ path: "src/b.ts", index: null, worktree: "modified" }],
      }),
      "C:/repo",
    );
    expect(result.map((item) => item.path)).toEqual(["a.ts", "src/b.ts"]);
  });

  it("maps a workspace subdirectory to repo-root relative paths", () => {
    const result = filterUncommittedSessionChanges(
      [change("src/a.ts"), change("src/old.ts")],
      status({
        unstaged: [{ path: "packages/app/src/a.ts", index: null, worktree: "modified" }],
      }),
      "C:/repo/packages/app",
    );
    expect(result.map((item) => item.path)).toEqual(["src/a.ts"]);
  });

  it("treats staged files as uncommitted", () => {
    const result = filterUncommittedSessionChanges(
      [change("a.ts")],
      status({ staged: [{ path: "a.ts", index: "added", worktree: null }] }),
      "C:/repo",
    );
    expect(result).toHaveLength(1);
  });

  it("shows all changes when the workspace is not a git repo", () => {
    const changes = [change("a.ts")];
    expect(
      filterUncommittedSessionChanges(changes, { ...status({}), isRepo: false }, "C:/repo"),
    ).toBe(changes);
  });

  it("shows all changes when the git status list is truncated", () => {
    const changes = [change("a.ts")];
    const truncated = status({
      staged: [{ path: "other.ts", index: "modified", worktree: null }],
      stagedCount: 1200,
    });
    expect(filterUncommittedSessionChanges(changes, truncated, "C:/repo")).toBe(changes);
  });

  it("shows all changes without a workspace", () => {
    const changes = [change("a.ts")];
    expect(filterUncommittedSessionChanges(changes, status({}), null)).toBe(changes);
  });

  it("normalizes Windows separators and case", () => {
    const result = filterUncommittedSessionChanges(
      [change("src\\A.ts")],
      status({ unstaged: [{ path: "SRC/a.ts", index: null, worktree: "modified" }] }),
      "C:/Repo",
    );
    expect(result).toHaveLength(1);
  });
});
