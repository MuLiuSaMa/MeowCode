import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkLearningContent,
  clipText,
  extractCommandFlags,
  isPathInside,
  isValidLearningName,
  isValidTriggerRegex,
  looksLikeLossyUpdate,
  redactSecrets,
} from "./guard";

describe("control-plane guard", () => {
  it("rejects content that mentions governance tooling", () => {
    expect(checkLearningContent("先调用 update_plan 把步骤写下来", "skill")).toContain(
      "control plane",
    );
    expect(checkLearningContent("改 .meowcode/harness.json 的节点", "guideline")).toContain(
      "control plane",
    );
    expect(checkLearningContent("把 approvalMode 设成 full", "skill")).toContain("control plane");
  });

  it("allows ordinary mentions of planning and tasks", () => {
    // 裸 "task"/"plan" 是极常见的英文词，不能误杀
    expect(checkLearningContent("This task needs a plan before editing.", "skill")).toBeNull();
    expect(checkLearningContent("先跑 pnpm test 再提交", "skill")).toBeNull();
  });
});

describe("bypass guard", () => {
  it("rejects instructions to skip verification", () => {
    expect(checkLearningContent("改完直接跳过验证提交", "skill")).toContain("bypass");
    expect(checkLearningContent("run git commit --no-verify", "skill")).toContain("bypass");
    expect(checkLearningContent("bypass the approval step", "skill")).toContain("bypass");
    expect(checkLearningContent("pnpm deploy --dangerously-skip-checks", "skill")).toContain(
      "bypass",
    );
  });

  it("allows positive instructions about testing", () => {
    expect(checkLearningContent("每次改完都要跑 pnpm test 确认通过", "skill")).toBeNull();
  });
});

describe("config guard", () => {
  it("rejects writes to configuration surfaces", () => {
    expect(checkLearningContent("编辑 settings.json 打开这个开关", "skill")).toContain(
      "configuration",
    );
    expect(checkLearningContent("设置 MEOWCODE_SELF_LEARNING=1", "skill")).toContain(
      "configuration",
    );
    expect(checkLearningContent("在 mcp.json 里加一个 server", "guideline")).toContain(
      "configuration",
    );
  });
});

describe("secret redaction", () => {
  it("replaces credential values but keeps the key name", () => {
    const { text, hits } = redactSecrets(
      "export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx && password=hunter2hunter2",
    );
    expect(hits).toBeGreaterThanOrEqual(2);
    expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(text).not.toContain("hunter2hunter2");
    expect(text).toContain("[redacted]");
  });

  it("leaves ordinary text alone", () => {
    const input = "pnpm build --mode production";
    expect(redactSecrets(input)).toEqual({ text: input, hits: 0 });
  });
});

describe("size limits", () => {
  it("rejects oversized content per kind", () => {
    expect(checkLearningContent("x".repeat(6_001), "skill")).toContain("too long");
    expect(checkLearningContent("x".repeat(301), "guideline")).toContain("too long");
    expect(checkLearningContent("x".repeat(201), "profile")).toContain("too long");
    expect(checkLearningContent("", "skill")).toBe("empty content");
  });

  it("clips with an ellipsis marker", () => {
    expect(clipText("abcdef", 3)).toBe("abc…");
    expect(clipText("abc", 10)).toBe("abc");
  });
});

describe("names and paths", () => {
  it("accepts kebab-case and rejects traversal", () => {
    expect(isValidLearningName("pnpm-publish")).toBe(true);
    expect(isValidLearningName("../escape")).toBe(false);
    expect(isValidLearningName("Publish")).toBe(false);
    expect(isValidLearningName("a/b")).toBe(false);
  });

  it("detects paths outside the root", () => {
    const root = path.join(path.sep, "tmp", "learning");
    expect(isPathInside(root, path.join(root, "skills", "a", "SKILL.md"))).toBe(true);
    expect(isPathInside(root, path.join(path.sep, "tmp", "other", "x.md"))).toBe(false);
  });
});

describe("lossy update detection", () => {
  it("flags shorter content that dropped flags", () => {
    const before = "pnpm publish --tag latest --access public --no-git-checks";
    expect(looksLikeLossyUpdate(before, "pnpm publish")).toBe(true);
  });

  it("does not flag rewrites that keep the flags", () => {
    const before = "pnpm publish --tag latest --access public";
    expect(looksLikeLossyUpdate(before, "pnpm publish --tag latest --access public")).toBe(false);
  });

  it("does not flag content without flags", () => {
    expect(looksLikeLossyUpdate("先读文件再改", "先读文件")).toBe(false);
  });
});

describe("trigger regex", () => {
  it("requires a compilable, bounded pattern", () => {
    expect(isValidTriggerRegex("^pnpm\\s+test")).toBe(true);
    expect(isValidTriggerRegex("[unclosed")).toBe(false);
    expect(isValidTriggerRegex("")).toBe(false);
    expect(isValidTriggerRegex(`x${"y".repeat(120)}`)).toBe(false);
  });

  it("extracts command flags for comparison", () => {
    expect(extractCommandFlags("pnpm build --Mode prod --minify")).toEqual(["--minify", "--mode"]);
  });
});
