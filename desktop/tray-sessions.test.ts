import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

type TraySession = { filePath: string; title: string | null; createdAt: string };

type TraySessionsModule = {
  TRAY_RECENT_COUNT: number;
  TRAY_MORE_LIMIT: number;
  TRAY_LABEL_MAX: number;
  normalizeTraySessions: (list: unknown) => TraySession[];
  traySessionLabel: (session: { title?: string | null } | null, untitled: string) => string;
  splitTraySessions: (list: TraySession[]) => { recent: TraySession[]; more: TraySession[] };
};

const requireCjs = createRequire(import.meta.url);
const {
  TRAY_RECENT_COUNT,
  TRAY_MORE_LIMIT,
  TRAY_LABEL_MAX,
  normalizeTraySessions,
  traySessionLabel,
  splitTraySessions,
} = requireCjs("./tray-sessions.cjs") as TraySessionsModule;

/** 造一条会话摘要：默认每个都发过消息。 */
function session(overrides: Record<string, unknown> = {}) {
  return {
    filePath: "C:/sessions/a.jsonl",
    title: "标题",
    createdAt: "2026-11-01T00:00:00.000Z",
    messageCount: 3,
    ...overrides,
  };
}

describe("tray session list", () => {
  it("drops entries that cannot be opened or never got a message", () => {
    const list = normalizeTraySessions([
      session({ filePath: "b.jsonl", messageCount: 2, createdAt: "2026-11-01T02:00:00.000Z" }),
      session({ filePath: "empty.jsonl", messageCount: 0 }),
      session({ filePath: "legacy.jsonl", messageCount: undefined }),
      session({ filePath: "", messageCount: 1 }),
      session({ filePath: null, messageCount: 1 }),
      null,
      "junk",
    ]);
    expect(list.map((item) => item.filePath)).toEqual(["b.jsonl"]);
  });

  it("sorts newest first like the sidebar", () => {
    const list = normalizeTraySessions([
      session({ filePath: "old.jsonl", createdAt: "2026-10-01T00:00:00.000Z" }),
      session({ filePath: "new.jsonl", createdAt: "2026-11-01T00:00:00.000Z" }),
      session({ filePath: "mid.jsonl", createdAt: "2026-10-20T00:00:00.000Z" }),
    ]);
    expect(list.map((item) => item.filePath)).toEqual(["new.jsonl", "mid.jsonl", "old.jsonl"]);
  });

  it("keeps only what the menu can show (3 recent + more)", () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      session({
        filePath: `s${index}.jsonl`,
        createdAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
      }),
    );
    const list = normalizeTraySessions(many);
    expect(list).toHaveLength(TRAY_RECENT_COUNT + TRAY_MORE_LIMIT);
    expect(list[0].filePath).toBe("s39.jsonl");
  });

  it("splits into the 3 recent items and a 更多 submenu", () => {
    const many = Array.from({ length: 6 }, (_, index) => session({ filePath: `s${index}.jsonl` }));
    const { recent, more } = splitTraySessions(many);
    expect(recent.map((item) => item.filePath)).toEqual(["s0.jsonl", "s1.jsonl", "s2.jsonl"]);
    expect(more.map((item) => item.filePath)).toEqual(["s3.jsonl", "s4.jsonl", "s5.jsonl"]);
    expect(splitTraySessions([])).toEqual({ recent: [], more: [] });
  });
});

describe("tray session label", () => {
  it("falls back to the untitled string when the session has no title yet", () => {
    expect(traySessionLabel({ title: null }, "未命名会话")).toBe("未命名会话");
    expect(traySessionLabel({ title: "   " }, "未命名会话")).toBe("未命名会话");
    expect(traySessionLabel(null, "未命名会话")).toBe("未命名会话");
  });

  it("escapes & so Windows does not read it as a mnemonic", () => {
    expect(traySessionLabel({ title: "A & B" }, "未命名会话")).toBe("A && B");
  });

  it("clips long titles instead of letting the menu run off screen", () => {
    const label = traySessionLabel({ title: "字".repeat(TRAY_LABEL_MAX + 20) }, "未命名会话");
    expect(label).toBe(`${"字".repeat(TRAY_LABEL_MAX)}…`);
    expect(traySessionLabel({ title: "短标题" }, "未命名会话")).toBe("短标题");
  });
});
