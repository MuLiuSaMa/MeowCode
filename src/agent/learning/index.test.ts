import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LearningController } from "./index";
import { createTurnTrace, isControlGroupHoldout, recordToolCall } from "./signals";
import {
  learningRootFor,
  listLearnedSkills,
  mergeGuidelines,
  readGuidelines,
  readLedger,
  readOutcomes,
  writeLearnedSkill,
} from "./store";
import type { ProviderConfig } from "../types";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length) {
    await rm(tempRoots.pop()!, { recursive: true, force: true });
  }
});

async function makeWorkspace(): Promise<{ workspace: string; homeDir: string }> {
  const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-learn-ws-"));
  const homeDir = await mkdtemp(path.join(tmpdir(), "meowcode-learn-home-"));
  tempRoots.push(workspace, homeDir);
  return { workspace, homeDir };
}

const dummyProvider = {} as ProviderConfig;

function context(text: string) {
  return { text, commands: [] as string[], errors: [] as string[] };
}

/**
 * 挑一个「这些回合都不在对照组」的会话 id。
 * 15% 的回合会把 tentative 条目抽掉（这是设计），测试要避开它们才能看到召回。
 */
function pickSession(...turns: number[]): string {
  for (let index = 0; index < 2_000; index += 1) {
    const id = `session-${index}`;
    if (turns.every((turn) => !isControlGroupHoldout(id, turn))) return id;
  }
  throw new Error("no non-holdout session id found");
}

describe("learning controller", () => {
  it("is inert without a workspace", async () => {
    const controller = new LearningController({ workspace: "", config: { enabled: true } });
    expect(controller.enabled).toBe(false);
    const result = await controller.beginTurn("s1", "发布", context("发布"));
    expect(result.recalledIds).toEqual([]);
    expect(result.note).toBeUndefined();
  });

  it("returns no note when nothing has been learned yet", async () => {
    const { workspace, homeDir } = await makeWorkspace();
    const controller = new LearningController({ workspace, homeDir, config: { enabled: true } });
    const result = await controller.beginTurn("s1", "帮我发布", context("帮我发布"));
    expect(result.note).toBeUndefined();
    expect(result.recalledIds).toEqual([]);
  });

  it("recalls a guideline by trigger and renders a note", async () => {
    const { workspace, homeDir } = await makeWorkspace();
    const root = learningRootFor("project", workspace, homeDir);
    await mergeGuidelines(root, [
      { text: "发布前先跑 pnpm build", trigger: { keyword: "发布" } },
    ]);
    const controller = new LearningController({ workspace, homeDir, config: { enabled: true } });
    const session = pickSession(1);
    const result = await controller.beginTurn(session, "帮我发布一下", context("帮我发布一下"));
    expect(result.recalledIds).toHaveLength(1);
    expect(result.note).toContain("发布前先跑 pnpm build");
  });

  it("does not re-inject the same recall in consecutive turns", async () => {
    const { workspace, homeDir } = await makeWorkspace();
    const root = learningRootFor("project", workspace, homeDir);
    await mergeGuidelines(root, [{ text: "发布前先跑构建", trigger: { keyword: "发布" } }]);
    const controller = new LearningController({ workspace, homeDir, config: { enabled: true } });
    const session = pickSession(1, 2);
    const first = await controller.beginTurn(session, "发布", context("发布"));
    const second = await controller.beginTurn(session, "再发布一次", context("再发布一次"));
    expect(first.note).toBeDefined();
    expect(second.note).toBeUndefined();
    // 但应用次数照记
    expect(second.recalledIds).toEqual(first.recalledIds);
  });

  it("credits helped on a clean turn and hurt when the user corrects it", async () => {
    const { workspace, homeDir } = await makeWorkspace();
    const root = learningRootFor("project", workspace, homeDir);
    await mergeGuidelines(root, [{ text: "发布前先跑构建", trigger: { keyword: "发布" } }]);
    const controller = new LearningController({ workspace, homeDir, config: { enabled: true } });
    const session = pickSession(1);

    const turn = await controller.beginTurn(session, "发布", context("发布"));
    const trace = createTurnTrace();
    trace.userTexts.push("发布");
    recordToolCall(trace, { name: "run_command", args: { command: "pnpm build" }, ok: true });

    await controller.endTurn({
      sessionId: session,
      turnIndex: turn.turnIndex,
      status: "completed",
      trace,
      recalledIds: turn.recalledIds,
      holdout: false,
    });
    let ledger = await readLedger(root);
    const entry = ledger.perAdaptation[turn.recalledIds[0]];
    expect(entry.helped).toBe(1);
    expect(entry.hurt).toBe(0);

    // 下一轮用户说「不对」：上一轮的召回被判为帮倒忙
    await controller.beginTurn(session, "不对，我要的是另一个流程", context("不对"));
    ledger = await readLedger(root);
    expect(ledger.perAdaptation[turn.recalledIds[0]].hurt).toBe(1);
  });

  it("records an outcome row for the turn", async () => {
    const { workspace, homeDir } = await makeWorkspace();
    const root = learningRootFor("project", workspace, homeDir);
    const controller = new LearningController({ workspace, homeDir, config: { enabled: true } });
    const trace = createTurnTrace();
    trace.userTexts.push("改个 bug");
    recordToolCall(trace, { name: "run_command", args: { command: "pnpm test" }, ok: false });
    await controller.endTurn({
      sessionId: "s1",
      turnIndex: 1,
      status: "completed",
      trace,
      recalledIds: [],
      holdout: false,
    });
    const outcomes = await readOutcomes(root);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].toolErrors).toBe(1);
    expect(outcomes[0].implicitScore).toBe(0.5);
  });

  it("skips the model entirely when no zero-token signal fires", async () => {
    const { workspace, homeDir } = await makeWorkspace();
    const controller = new LearningController({ workspace, homeDir, config: { enabled: true } });
    const trace = createTurnTrace();
    trace.userTexts.push("给 parser 加个空行处理");
    recordToolCall(trace, { name: "read_file", args: { path: "src/parser.ts" }, ok: true });
    // dummyProvider 一旦被调用就会抛错；返回 null 说明门禁确实挡住了
    const result = await controller.learnFromTurn({
      sessionId: "s1",
      messages: [{ role: "user", content: "给 parser 加个空行处理" }],
      trace,
      provider: dummyProvider,
    });
    expect(result).toBeNull();
  });

  it("keeps the holdout decision deterministic per session and turn", async () => {
    const { workspace, homeDir } = await makeWorkspace();
    const root = learningRootFor("project", workspace, homeDir);
    await writeLearnedSkill(root, {
      name: "release",
      description: "发版流程",
      content: "pnpm release --tag latest",
      scope: "project",
      actor: "learner",
    });
    const a = new LearningController({ workspace, homeDir, config: { enabled: true } });
    const b = new LearningController({ workspace, homeDir, config: { enabled: true } });
    const first = await a.beginTurn("session-x", "hi", context("hi"));
    const second = await b.beginTurn("session-x", "hi", context("hi"));
    expect(second.holdout).toBe(first.holdout);
    expect(second.turnIndex).toBe(first.turnIndex);
  });

  it("forgets a session's in-memory state on demand", async () => {
    const { workspace, homeDir } = await makeWorkspace();
    const controller = new LearningController({ workspace, homeDir, config: { enabled: true } });
    const first = await controller.beginTurn("s1", "a", context("a"));
    controller.forgetSession("s1");
    const second = await controller.beginTurn("s1", "b", context("b"));
    expect(second.turnIndex).toBe(1);
    expect(first.turnIndex).toBe(1);
  });
});

describe("defaults", () => {
  it("ships disabled — an experimental feature must be opted into", () => {
    const controller = new LearningController({ workspace: "/tmp/whatever" });
    expect(controller.enabled).toBe(false);
  });
});

describe("clear all", () => {
  it("wipes skills, guidelines and outcomes in both scopes", async () => {
    const { workspace, homeDir } = await makeWorkspace();
    const projectRoot = learningRootFor("project", workspace, homeDir);
    const userRoot = learningRootFor("user", workspace, homeDir);
    await writeLearnedSkill(projectRoot, {
      name: "release",
      description: "发版流程",
      content: "pnpm release --tag latest",
      scope: "project",
      actor: "learner",
    });
    await mergeGuidelines(projectRoot, [{ text: "提交前跑测试", trigger: { command: "git commit" } }]);
    await mergeGuidelines(userRoot, [{ text: "用中文回复", trigger: { keyword: "回复" } }]);

    const controller = new LearningController({ workspace, homeDir, config: { enabled: true } });
    const result = await controller.clearAll();

    expect(result.cleared.sort()).toEqual(["project", "user"]);
    expect(await listLearnedSkills(projectRoot)).toEqual([]);
    expect((await readGuidelines(projectRoot)).items).toEqual([]);
    expect((await readGuidelines(userRoot)).items).toEqual([]);
    expect(await readOutcomes(projectRoot)).toEqual([]);
  });

  it("is safe to run on an empty workspace", async () => {
    const { workspace, homeDir } = await makeWorkspace();
    const controller = new LearningController({ workspace, homeDir, config: { enabled: true } });
    await expect(controller.clearAll()).resolves.toEqual({ cleared: ["project", "user"] });
  });
});
