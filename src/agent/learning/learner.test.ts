import { describe, expect, it } from "vitest";
import {
  buildLearningUserPrompt,
  cleanLearningOps,
  normalizeTrigger,
  systemPromptFor,
  type ExistingKnowledge,
} from "./learner";
import { MAX_OPS_PER_BATCH, type ProfileFile } from "./types";
import type { GuidelinesFile } from "./types";

function existing(overrides: Partial<ExistingKnowledge> = {}): ExistingKnowledge {
  const profile: ProfileFile = { version: 1, traits: [], updatedAt: "" };
  const guidelines: GuidelinesFile = { version: 1, items: [], updatedAt: "" };
  return { profile, guidelines, skills: [], maxSkills: 20, ...overrides };
}

describe("cleanLearningOps", () => {
  it("returns nothing for unusable output", () => {
    expect(cleanLearningOps("")).toEqual([]);
    expect(cleanLearningOps("not json at all")).toEqual([]);
    expect(cleanLearningOps('{"ops": "nope"}')).toEqual([]);
    expect(cleanLearningOps("[]")).toEqual([]);
  });

  it("strips thinking blocks and code fences", () => {
    const raw = [
      "```json",
      '[{"op":"profile","scope":"user","dimension":"communication","statement":"用户偏好中文"}]',
      "```",
    ].join("\n");
    const ops = cleanLearningOps(raw);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: "profile", dimension: "communication" });

    const withThinking = `<thinking>let me think</thinking>${raw}`;
    expect(cleanLearningOps(withThinking)).toHaveLength(1);
  });

  it("drops ops with an unknown kind, bad scope or invalid name", () => {
    const ops = cleanLearningOps(
      JSON.stringify([
        { op: "tool", scope: "user", name: "evil", content: "x" },
        { op: "profile", scope: "global", dimension: "rigor", statement: "x" },
        { op: "skill", scope: "project", name: "../escape", description: "d", content: "c" },
        { op: "skill", scope: "project", name: "ok", description: "d", content: "pnpm build --flag" },
      ]),
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: "skill", name: "ok" });
  });

  it("requires a usable trigger for guidelines", () => {
    const ops = cleanLearningOps(
      JSON.stringify([
        { op: "guideline", scope: "project", text: "没有触发的经验" },
        { op: "guideline", scope: "project", text: "空触发", trigger: {} },
        { op: "guideline", scope: "project", text: "坏正则", trigger: { regex: "[unclosed" } },
        { op: "guideline", scope: "project", text: "提交前跑测试", trigger: { command: "git commit" } },
      ]),
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ text: "提交前跑测试" });
  });

  it("redacts secrets before they reach storage", () => {
    const ops = cleanLearningOps(
      JSON.stringify([
        {
          op: "skill",
          scope: "project",
          name: "deploy",
          description: "部署流程",
          content: "export TOKEN=sk-abcdefghijklmnopqrstuvwx && pnpm deploy --prod",
        },
      ]),
    );
    expect(ops).toHaveLength(1);
    const content = (ops[0] as { content: string }).content;
    expect(content).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(content).toContain("[redacted]");
  });

  it("caps a single batch", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      op: "profile",
      scope: "user",
      dimension: "rigor",
      statement: `偏好 ${index}`,
    }));
    expect(cleanLearningOps(JSON.stringify(many))).toHaveLength(MAX_OPS_PER_BATCH);
  });

  it("keeps the replaces field only when it is a valid name", () => {
    const good = cleanLearningOps(
      JSON.stringify([
        {
          op: "skill",
          scope: "project",
          name: "new",
          description: "d",
          content: "c",
          replaces: "old",
        },
      ]),
    );
    expect(good[0]).toMatchObject({ replaces: "old" });

    const bad = cleanLearningOps(
      JSON.stringify([
        {
          op: "skill",
          scope: "project",
          name: "new",
          description: "d",
          content: "c",
          replaces: "../x",
        },
      ]),
    );
    expect(bad[0]).not.toHaveProperty("replaces");
  });
});

describe("normalizeTrigger", () => {
  it("keeps only non-empty, valid fields", () => {
    expect(normalizeTrigger({ command: "pnpm test", error: "", regex: "[bad" })).toEqual({
      command: "pnpm test",
    });
    expect(normalizeTrigger({})).toBeNull();
    expect(normalizeTrigger("nope")).toBeNull();
  });
});

describe("prompts", () => {
  it("states the control-plane and dedup rules in both modes", () => {
    for (const mode of ["turn", "idle"] as const) {
      const prompt = systemPromptFor(mode);
      expect(prompt).toContain("update_plan");
      expect(prompt).toContain("UPDATE IT IN PLACE");
      expect(prompt).toContain("Return [] when nothing generalizes");
    }
    expect(systemPromptFor("idle")).toContain("merge, prune, and promote");
    expect(systemPromptFor("turn")).toContain("turn learning pass");
  });

  it("includes the existing knowledge so the model can dedupe", () => {
    const prompt = buildLearningUserPrompt({
      transcript: "USER: 发布一下\nASSISTANT: 好",
      signals: [{ type: "explicit_save", detail: "记住发布流程" }],
      existing: existing({
        profile: {
          version: 1,
          updatedAt: "",
          traits: [
            {
              dimension: "communication",
              statement: "用户偏好中文回复",
              confidence: 0.95,
              evidence: [],
              lastConfirmed: "2026-10-31",
              status: "active",
              userStated: true,
            },
          ],
        },
        guidelines: {
          version: 1,
          updatedAt: "",
          items: [
            {
              id: "abc12345",
              text: "提交前跑测试",
              trigger: { command: "git commit" },
              status: "active",
              confidence: 0.8,
              created: "2026-10-01",
            },
          ],
        },
        skills: [{ name: "release", description: "发版流程", status: "tentative" }],
        maxSkills: 20,
      }),
      today: "2026-10-31",
    });
    expect(prompt).toContain("Today's date: 2026-10-31");
    expect(prompt).toContain("[communication] 用户偏好中文回复");
    expect(prompt).toContain("abc12345 — 提交前跑测试 [command=git commit]");
    expect(prompt).toContain("release (tentative) — 发版流程");
    expect(prompt).toContain("1/20");
    expect(prompt).toContain("explicit_save");
    expect(prompt).toContain("USER: 发布一下");
  });

  it("says so explicitly when there is nothing yet", () => {
    const prompt = buildLearningUserPrompt({
      transcript: "x",
      signals: [],
      existing: existing(),
      today: "2026-10-31",
    });
    expect(prompt).toContain("Existing profile traits: none yet.");
    expect(prompt).toContain("Existing guidelines: none yet.");
    expect(prompt).toContain("0/20");
    expect(prompt).not.toContain("Turn signals");
  });
});
