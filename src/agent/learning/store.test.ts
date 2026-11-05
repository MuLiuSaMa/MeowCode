import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendJournal,
  appendOutcome,
  applyLearningOps,
  consumeDailyBudget,
  learningRootFor,
  listLearnedSkills,
  listRetiredSkillNames,
  mergeGuidelines,
  mergeTraits,
  readGuidelines,
  readJournal,
  readLedger,
  readOutcomes,
  readProfile,
  recordEffect,
  rollbackSkill,
  setSkillStatus,
  writeLearnedSkill,
} from "./store";
import type { TurnOutcomeRecord } from "./types";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length) {
    await rm(tempRoots.pop()!, { recursive: true, force: true });
  }
});

async function makeWorkspace(): Promise<{ workspace: string; homeDir: string }> {
  const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-learning-"));
  const homeDir = await mkdtemp(path.join(tmpdir(), "meowcode-home-"));
  tempRoots.push(workspace, homeDir);
  return { workspace, homeDir };
}

function outcome(id: string): TurnOutcomeRecord {
  return {
    id,
    sessionId: "s1",
    turnIndex: 1,
    timestamp: new Date().toISOString(),
    scope: "project",
    status: "completed",
    toolCalls: 1,
    toolErrors: 0,
    commandFingerprints: [],
    recoveryPairs: [],
    errorSignatures: [],
    recalledIds: [],
    skillReads: [],
    userCorrected: false,
    implicitScore: 1,
    holdout: false,
  };
}

describe("learning roots", () => {
  it("separates user and project scopes", async () => {
    const { workspace, homeDir } = await makeWorkspace();
    expect(learningRootFor("project", workspace, homeDir)).toBe(
      path.join(workspace, ".meowcode", "learning"),
    );
    expect(learningRootFor("user", workspace, homeDir)).toBe(
      path.join(homeDir, ".meowcode", "learning"),
    );
  });
});

describe("profile traits", () => {
  it("merges by statement and never overwrites other dimensions", async () => {
    const { workspace, homeDir } = await makeWorkspace();
    const root = learningRootFor("user", workspace, homeDir);

    await mergeTraits(root, [
      { dimension: "communication", statement: "用户偏好中文回复", userStated: true },
      { dimension: "coding_style", statement: "用户偏好函数式写法" },
    ]);
    await mergeTraits(root, [{ dimension: "communication", statement: "用户偏好中文回复" }]);

    const profile = await readProfile(root);
    expect(profile.traits).toHaveLength(2);
    const communication = profile.traits.find((trait) => trait.dimension === "communication")!;
    // 用户明说过的：置信度钉在 0.95，不因重复观察继续抬高
    expect(communication.confidence).toBe(0.95);
    expect(communication.userStated).toBe(true);
    const coding = profile.traits.find((trait) => trait.dimension === "coding_style")!;
    expect(coding.confidence).toBe(0.4);
    expect(coding.status).toBe("tentative");
  });
});

describe("guidelines", () => {
  it("dedupes by normalized text and keeps the id stable", async () => {
    const { workspace, homeDir } = await makeWorkspace();
    const root = learningRootFor("project", workspace, homeDir);
    await mergeGuidelines(root, [
      { text: "提交前先跑 pnpm test", trigger: { command: "git commit" } },
    ]);
    await mergeGuidelines(root, [
      { text: "提交前先跑  pnpm test", trigger: { command: "git commit" } },
    ]);
    const file = await readGuidelines(root);
    expect(file.items).toHaveLength(1);
    expect(file.items[0].confidence).toBeCloseTo(0.5);
  });
});

describe("learned skills", () => {
  it("writes frontmatter, bumps revision and keeps created date", async () => {
    const { workspace, homeDir } = await makeWorkspace();
    const root = learningRootFor("project", workspace, homeDir);

    const first = await writeLearnedSkill(root, {
      name: "pnpm-publish",
      description: "用户说发布文章时走这套",
      content: "## Commands\n\npnpm build --tag latest",
      scope: "project",
      actor: "learner",
    });
    expect(first.written).toBe(true);

    const second = await writeLearnedSkill(root, {
      name: "pnpm-publish",
      description: "用户说发布文章时走这套",
      content: "## Commands\n\npnpm build --tag latest && pnpm publish --tag latest",
      scope: "project",
      actor: "learner",
    });
    expect(second.written).toBe(true);

    const [skill] = await listLearnedSkills(root);
    expect(skill.name).toBe("pnpm-publish");
    expect(skill.revision).toBe(2);
    expect(skill.evidence).toBe(2);
    expect(skill.status).toBe("tentative");
    expect(skill.body).toContain("pnpm publish");
  });

  it("rejects a lossy update that drops command flags", async () => {
    const { workspace, homeDir } = await makeWorkspace();
    const root = learningRootFor("project", workspace, homeDir);
    const body =
      "## Commands\n\npnpm build --target es2022 --minify --sourcemap --outdir dist\n" +
      "pnpm publish --tag latest --access public --no-git-checks";
    await writeLearnedSkill(root, {
      name: "publish",
      description: "发布流程",
      content: body,
      scope: "project",
      actor: "learner",
    });

    const result = await writeLearnedSkill(root, {
      name: "publish",
      description: "发布流程",
      content: "pnpm publish",
      scope: "project",
      actor: "learner",
    });
    expect(result.written).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining("lossy") });
    const [skill] = await listLearnedSkills(root);
    expect(skill.revision).toBe(1);
  });

  it("refuses to write over a retired skill", async () => {
    const { workspace, homeDir } = await makeWorkspace();
    const root = learningRootFor("project", workspace, homeDir);
    await writeLearnedSkill(root, {
      name: "flaky",
      description: "不靠谱的流程",
      content: "do the thing",
      scope: "project",
      actor: "learner",
    });
    await setSkillStatus(root, "flaky", "retired");
    const result = await writeLearnedSkill(root, {
      name: "flaky",
      description: "不靠谱的流程",
      content: "do the thing better",
      scope: "project",
      actor: "learner",
    });
    expect(result.written).toBe(false);
    expect(await listRetiredSkillNames(workspace, homeDir)).toContain("flaky");
  });

  it("rolls back to the previous revision", async () => {
    const { workspace, homeDir } = await makeWorkspace();
    const root = learningRootFor("project", workspace, homeDir);
    await writeLearnedSkill(root, {
      name: "build",
      description: "构建流程",
      content: "pnpm build --mode production",
      scope: "project",
      actor: "learner",
    });
    await writeLearnedSkill(root, {
      name: "build",
      description: "构建流程",
      content: "pnpm build --mode production --minify",
      scope: "project",
      actor: "learner",
    });
    expect(await rollbackSkill(root, "build")).toBe(true);
    const [skill] = await listLearnedSkills(root);
    expect(skill.body).toContain("--mode production");
    expect(skill.body).not.toContain("--minify");
  });

  it("rejects names that would escape the learning root", async () => {
    const { workspace, homeDir } = await makeWorkspace();
    const root = learningRootFor("project", workspace, homeDir);
    const result = await writeLearnedSkill(root, {
      name: "../escape",
      description: "逃逸",
      content: "x",
      scope: "project",
      actor: "learner",
    });
    expect(result.written).toBe(false);
  });
});

describe("scope isolation", () => {
  it("never leaks entries across scopes through a shared empty default", async () => {
    const { workspace, homeDir } = await makeWorkspace();
    const projectRoot = learningRootFor("project", workspace, homeDir);
    const userRoot = learningRootFor("user", workspace, homeDir);

    // 回归：空默认值曾是模块级常量，`{...EMPTY}` 浅拷贝让 items 数组共享，
    // 一次 push 就把「空默认值」改掉，用户层于是读到项目层的经验。
    await mergeGuidelines(projectRoot, [{ text: "项目级经验", trigger: { keyword: "改" } }]);
    expect((await readGuidelines(userRoot)).items).toEqual([]);
    expect((await readGuidelines(projectRoot)).items).toHaveLength(1);

    await mergeTraits(projectRoot, [{ dimension: "rigor", statement: "项目级偏好" }]);
    expect((await readProfile(userRoot)).traits).toEqual([]);
    expect((await readProfile(projectRoot)).traits).toHaveLength(1);
  });
});

describe("ledger", () => {
  it("promotes after 3 helped and retires after 2 hurt", async () => {
    const { workspace, homeDir } = await makeWorkspace();
    const root = learningRootFor("project", workspace, homeDir);
    const id = "project:skill:publish";

    let outcome = await recordEffect(root, [id], "helped");
    expect(outcome.promoted).toEqual([]);
    await recordEffect(root, [id], "helped");
    outcome = await recordEffect(root, [id], "helped");
    expect(outcome.promoted).toEqual([id]);

    const other = "project:guideline:abc";
    await recordEffect(root, [other], "hurt");
    const second = await recordEffect(root, [other], "hurt");
    expect(second.retired).toEqual([other]);

    const ledger = await readLedger(root);
    expect(ledger.perAdaptation[id].status).toBe("active");
    expect(ledger.perAdaptation[other].status).toBe("retired");
  });

  it("enforces the daily call budget across reads", async () => {
    const { workspace, homeDir } = await makeWorkspace();
    const root = learningRootFor("project", workspace, homeDir);
    expect(await consumeDailyBudget(root, 2)).toBe(true);
    expect(await consumeDailyBudget(root, 2)).toBe(true);
    expect(await consumeDailyBudget(root, 2)).toBe(false);
    const ledger = await readLedger(root);
    expect(ledger.dailyCalls.count).toBe(2);
  });
});

describe("outcomes log", () => {
  it("keeps only the most recent 500 records", async () => {
    const { workspace, homeDir } = await makeWorkspace();
    const root = learningRootFor("project", workspace, homeDir);
    await mkdir(root, { recursive: true });
    const seed = Array.from({ length: 600 }, (_, index) => JSON.stringify(outcome(`o${index}`)));
    await writeFile(path.join(root, "outcomes.jsonl"), `${seed.join("\n")}\n`, "utf8");

    await appendOutcome(root, outcome("latest"));
    const records = await readOutcomes(root, 10_000);
    expect(records).toHaveLength(500);
    expect(records.at(-1)?.id).toBe("latest");
  });
});

describe("journal", () => {
  it("appends and reads newest first", async () => {
    const { workspace, homeDir } = await makeWorkspace();
    const root = learningRootFor("project", workspace, homeDir);
    await appendJournal(root, { action: "apply", scope: "project", kind: "skill", name: "a", revision: 1, actor: "learner" });
    await appendJournal(root, { action: "retire", scope: "project", kind: "skill", name: "b", revision: 2, actor: "evaluator" });
    const entries = await readJournal(root);
    expect(entries).toHaveLength(2);
    expect(entries[0].action).toBe("retire");
    expect(entries[1].action).toBe("apply");
  });
});

describe("applyLearningOps", () => {
  it("applies mixed ops and reports per-item rejections", async () => {
    const { workspace, homeDir } = await makeWorkspace();
    const result = await applyLearningOps(
      [
        { op: "profile", scope: "user", dimension: "communication", statement: "用户偏好简短回答" },
        { op: "guideline", scope: "project", text: "改完先跑测试", trigger: { command: "git commit" } },
        { op: "skill", scope: "project", name: "release", description: "发版流程", content: "pnpm release --tag latest" },
        { op: "proposal", scope: "project", name: "split-ci", content: "把 CI 拆成两个 job" },
        { op: "skill", scope: "project", name: "handwritten", description: "撞名", content: "x" },
      ],
      { workspace, homeDir, maxSkills: 20, actor: "learner", handwrittenSkills: new Set(["handwritten"]) },
    );
    expect(result.applied).toHaveLength(4);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toContain("handwritten");

    const skills = await listLearnedSkills(learningRootFor("project", workspace, homeDir));
    expect(skills.map((skill) => skill.name)).toEqual(["release"]);
    const proposal = await readFile(
      path.join(learningRootFor("project", workspace, homeDir), "proposals", "split-ci.md"),
      "utf8",
    );
    expect(proposal).toContain("两个 job");
  });

  it("requires replaces at capacity and refuses to retire proven skills", async () => {
    const { workspace, homeDir } = await makeWorkspace();
    const root = learningRootFor("project", workspace, homeDir);
    await writeLearnedSkill(root, {
      name: "old",
      description: "旧流程",
      content: "pnpm old --flag",
      scope: "project",
      actor: "learner",
    });
    await recordEffect(root, ["project:skill:old"], "helped");
    await recordEffect(root, ["project:skill:old"], "helped");
    await recordEffect(root, ["project:skill:old"], "helped");

    const atCapacity = await applyLearningOps(
      [{ op: "skill", scope: "project", name: "new", description: "新流程", content: "pnpm new --flag" }],
      { workspace, homeDir, maxSkills: 1, actor: "learner" },
    );
    expect(atCapacity.rejected[0].reason).toContain("capacity");

    const proven = await applyLearningOps(
      [
        {
          op: "skill",
          scope: "project",
          name: "new",
          description: "新流程",
          content: "pnpm new --flag",
          replaces: "old",
        },
      ],
      { workspace, homeDir, maxSkills: 1, actor: "learner" },
    );
    expect(proven.rejected[0].reason).toContain("proven value");
    expect((await listLearnedSkills(root)).map((skill) => skill.name)).toEqual(["old"]);
  });
});
