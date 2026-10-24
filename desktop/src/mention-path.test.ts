import { describe, expect, it } from "vitest";
import {
  buildMentionItems,
  detectMention,
  mentionDirToken,
  mentionScopeOf,
  mentionToken,
  parentDir,
  type MentionEntry,
} from "./mention-path";

describe("detectMention", () => {
  it("captures the token at the caret and reports its span", () => {
    const value = "看看 @src/ap";
    expect(detectMention(value, value.length)).toEqual({
      query: "src/ap",
      start: 3,
      end: 10,
    });
  });

  it("only triggers at word start", () => {
    // 邮箱不该被当成文件引用
    expect(detectMention("foo@bar.com", 11)).toBeNull();
    // 行首也合法
    expect(detectMention("@a.ts", 5)).toMatchObject({ query: "a.ts", start: 0 });
    // 括号后也合法
    expect(detectMention("(@a", 3)).toMatchObject({ query: "a" });
  });

  it("gives up inside a quoted path", () => {
    expect(detectMention('@"a b', 5)).toBeNull();
  });
});

describe("mentionScopeOf", () => {
  it("splits the query into directory scope and filter", () => {
    expect(mentionScopeOf("")).toEqual({ dir: "", filter: "" });
    expect(mentionScopeOf("ap")).toEqual({ dir: "", filter: "ap" });
    expect(mentionScopeOf("src/")).toEqual({ dir: "src", filter: "" });
    expect(mentionScopeOf("src/ap")).toEqual({ dir: "src", filter: "ap" });
    expect(mentionScopeOf("a/b/c")).toEqual({ dir: "a/b", filter: "c" });
  });
});

describe("parentDir", () => {
  it("walks up one level and stops at the root", () => {
    expect(parentDir("a/b/c")).toBe("a/b");
    expect(parentDir("a/b")).toBe("a");
    expect(parentDir("a")).toBe("");
    expect(parentDir("")).toBe("");
  });
});

describe("mention tokens", () => {
  it("keeps directory navigation unquoted so the panel stays open", () => {
    expect(mentionDirToken("src")).toBe("@src/");
    expect(mentionDirToken("")).toBe("@");
  });

  it("quotes paths with spaces for the server parser", () => {
    expect(mentionToken("src/a.ts")).toBe("@src/a.ts");
    expect(mentionToken("docs/a b.md")).toBe('@"docs/a b.md"');
  });
});

describe("buildMentionItems", () => {
  const entries: MentionEntry[] = [
    { name: "components", path: "src/components", dir: true },
    { name: "app.ts", path: "src/app.ts", dir: false },
    { name: "utils.ts", path: "src/utils.ts", dir: false },
  ];

  it("has no parent entry at the workspace root", () => {
    const items = buildMentionItems(entries, "", "");
    expect(items.map((item) => item.kind)).toEqual(["dir", "file", "file"]);
  });

  it("puts the parent entry first inside a directory", () => {
    const items = buildMentionItems(entries, "src", "");
    expect(items[0]).toEqual({ kind: "up", name: "..", path: "" });
    expect(items).toHaveLength(4);
  });

  it("filters by name without dropping the parent entry", () => {
    const items = buildMentionItems(entries, "src", "APP");
    expect(items.map((item) => item.name)).toEqual(["..", "app.ts"]);
  });

  it("keeps the parent entry when the directory read failed", () => {
    // entries 为空 = 读取失败或空目录；没有 `..` 的话用户退不回去
    expect(buildMentionItems([], "src/deep", "")).toEqual([
      { kind: "up", name: "..", path: "src" },
    ]);
  });
});
