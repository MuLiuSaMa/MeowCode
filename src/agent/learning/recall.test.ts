import { describe, expect, it } from "vitest";
import {
  MAX_RECALL_CHARS,
  MAX_RECALL_ITEMS,
  buildLearnedPreferencesSection,
  buildRecallNote,
  globToRegExp,
  matchGuidelines,
  recallKey,
  summarizeTraits,
} from "./recall";
import type { Guideline, ProfileFile, UserTrait } from "./types";

function guideline(overrides: Partial<Guideline> = {}): Guideline {
  return {
    id: overrides.id ?? "g1",
    text: overrides.text ?? "提交前先跑 pnpm test",
    trigger: overrides.trigger ?? { command: "git commit" },
    status: overrides.status ?? "active",
    confidence: overrides.confidence ?? 0.8,
    created: "2026-10-01",
  };
}

const emptyContext = { text: "", commands: [], errors: [] };

describe("learned preferences section", () => {
  it("is absent when there is nothing to say", () => {
    expect(buildLearnedPreferencesSection({ version: 1, traits: [], updatedAt: "" })).toBeUndefined();
  });

  it("states that project rules win on conflict", () => {
    const profile: ProfileFile = {
      version: 1,
      updatedAt: "",
      traits: [
        {
          dimension: "communication",
          statement: "用户偏好中文回复",
          confidence: 0.9,
          evidence: [],
          lastConfirmed: "2026-10-31",
          status: "active",
        },
      ],
    };
    const section = buildLearnedPreferencesSection(profile)!;
    expect(section).toContain("## Learned preferences");
    expect(section).toContain("- 用户偏好中文回复");
    expect(section).toContain("AGENTS.md and project rules win on conflict");
  });

  it("drops retired traits and caps the section", () => {
    const traits: UserTrait[] = Array.from({ length: 40 }, (_, index) => ({
      dimension: "rigor" as const,
      statement: `偏好 ${index} ${"x".repeat(90)}`,
      confidence: 0.5,
      evidence: [],
      lastConfirmed: "2026-10-31",
      status: index === 0 ? "retired" : "active",
    }));
    const section = buildLearnedPreferencesSection({ version: 1, traits, updatedAt: "" })!;
    expect(section).not.toContain("偏好 0 ");
    expect(section.length).toBeLessThan(1_400);
    expect(section).toContain("omitted");
  });

  it("groups traits for the settings page", () => {
    const groups = summarizeTraits([
      {
        dimension: "communication",
        statement: "a",
        confidence: 0.5,
        evidence: [],
        lastConfirmed: "",
        status: "active",
      },
      {
        dimension: "rigor",
        statement: "b",
        confidence: 0.5,
        evidence: [],
        lastConfirmed: "",
        status: "active",
      },
      {
        dimension: "rigor",
        statement: "c",
        confidence: 0.5,
        evidence: [],
        lastConfirmed: "",
        status: "retired",
      },
    ]);
    expect(groups.map((group) => group.dimension).sort()).toEqual(["communication", "rigor"]);
    expect(groups.find((group) => group.dimension === "rigor")!.items).toHaveLength(1);
  });
});

describe("glob matching", () => {
  it("converts simple patterns", () => {
    expect(globToRegExp("**/*.test.ts")!.test("src/a.test.ts")).toBe(true);
    expect(globToRegExp("**/*.test.ts")!.test("src/a.ts")).toBe(false);
    expect(globToRegExp("*.md")!.test("README.md")).toBe(true);
    expect(globToRegExp("")).toBeNull();
  });
});

describe("guideline recall", () => {
  it("matches on command fingerprints", () => {
    const matched = matchGuidelines([guideline()], {
      text: "提交一下",
      commands: ["git commit -m 'x'"],
      errors: [],
    });
    expect(matched).toHaveLength(1);
  });

  it("matches on keyword, error, regex and file pattern", () => {
    const items = [
      guideline({ id: "kw", text: "先看类型", trigger: { keyword: "重构" } }),
      guideline({ id: "err", text: "锁文件冲突先删 node_modules", trigger: { error: "ETIMEDOUT" } }),
      guideline({ id: "re", text: "别动生成目录", trigger: { regex: "^generated/" } }),
      guideline({ id: "fp", text: "测试文件要加用例", trigger: { filePattern: "**/*.test.ts" } }),
    ];
    expect(matchGuidelines(items, { text: "帮我重构这段", commands: [], errors: [] }).map((i) => i.id)).toEqual(["kw"]);
    expect(matchGuidelines(items, { text: "报错了", commands: [], errors: ["ETIMEDOUT: timeout"], }).map((i) => i.id)).toEqual(["err"]);
    expect(matchGuidelines(items, { text: "generated/x.ts 有问题", commands: [], errors: [] }).map((i) => i.id)).toEqual(["re"]);
    expect(matchGuidelines(items, { text: "改一下 src/a.test.ts", commands: [], errors: [] }).map((i) => i.id)).toEqual(["fp"]);
  });

  it("skips retired items and non-matching items", () => {
    expect(matchGuidelines([guideline({ status: "retired" })], {
      text: "git commit",
      commands: ["git commit"],
      errors: [],
    })).toEqual([]);
    expect(matchGuidelines([guideline()], emptyContext)).toEqual([]);
  });

  it("orders by confidence and respects the budget", () => {
    const items = Array.from({ length: 6 }, (_, index) =>
      guideline({
        id: `g${index}`,
        text: `${"长".repeat(180)}-${index}`,
        trigger: { keyword: "改" },
        confidence: index / 10,
      }),
    );
    const matched = matchGuidelines(items, { text: "改一下", commands: [], errors: [] });
    expect(matched.length).toBeLessThanOrEqual(MAX_RECALL_ITEMS);
    const total = matched.reduce((sum, item) => sum + item.text.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_RECALL_CHARS);
    // 高置信度优先
    expect(matched[0].id).toBe("g5");
  });
});

describe("recall note", () => {
  it("renders a note that tells the model not to narrate it", () => {
    const note = buildRecallNote([guideline()])!;
    expect(note).toContain("[learning]");
    expect(note).toContain("提交前先跑 pnpm test");
    expect(note).toContain("Do not narrate");
  });

  it("is absent when nothing matched", () => {
    expect(buildRecallNote([])).toBeUndefined();
  });

  it("keys the same set stably so it is not re-injected", () => {
    const a = [guideline({ id: "b" }), guideline({ id: "a" })];
    const b = [guideline({ id: "a" }), guideline({ id: "b" })];
    expect(recallKey(a)).toBe(recallKey(b));
  });
});
