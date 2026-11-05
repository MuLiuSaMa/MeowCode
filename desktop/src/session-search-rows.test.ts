import { describe, expect, it } from "vitest";
import type { SessionSearchHit } from "./api";
import { flattenHitRows } from "./session-search-rows";

function makeHit(sessionId: string, messageIndexes: number[]): SessionSearchHit {
  return {
    sessionId,
    filePath: `D:/sessions/${sessionId}.jsonl`,
    title: sessionId === "a" ? null : `标题 ${sessionId}`,
    cwd: "D:/work",
    createdAt: "2026-11-01T00:00:00.000Z",
    titleMatch: false,
    totalMatches: messageIndexes.length,
    snippets: messageIndexes.map((messageIndex) => ({
      text: "片段",
      ranges: [{ start: 0, end: 2 }],
      prefix: false,
      suffix: false,
      messageIndex,
      role: "user" as const,
    })),
  };
}

describe("flattenHitRows", () => {
  it("emits a header row then snippet rows per session", () => {
    const rows = flattenHitRows([makeHit("a", [2, 0, 1])]);
    expect(rows.map((row) => row.key)).toEqual([
      "a:header",
      "a:s1",
      "a:s2",
      "a:s0",
    ]);
    expect(rows[0].snippet).toBeNull();
    // 片段按 messageIndex 升序：2,0,1 → 0,1,2
    expect(rows.slice(1).map((row) => row.snippet?.messageIndex)).toEqual([0, 1, 2]);
  });

  it("keeps server order across sessions", () => {
    const rows = flattenHitRows([makeHit("b", [0]), makeHit("a", [3, 1])]);
    expect(rows.map((row) => row.key)).toEqual(["b:header", "b:s0", "a:header", "a:s1", "a:s0"]);
  });

  it("emits a placeholder row for title-only hits without snippets", () => {
    const rows = flattenHitRows([makeHit("a", [])]);
    expect(rows).toHaveLength(1);
    expect(rows[0].snippet).toBeNull();
  });
});
