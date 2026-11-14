import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  listCandidates,
  loadCandidate,
  markFrozen,
  saveCandidate,
  type PromptCandidate,
} from "./candidate.js";
import {
  evaluateCandidate,
  recommendFreeze,
  type CandidateReport,
  type RunOutcome,
} from "./evaluate.js";

function candidate(overrides: Partial<PromptCandidate> = {}): PromptCandidate {
  return {
    id: "cand-1",
    createdAt: "2026-11-14T00:00:00.000Z",
    baselineVersion: "a1b2c3d4",
    segment: "root-agent",
    text: "You are MeowCode (candidate).",
    notes: "tighten the goal section",
    frozen: false,
    ...overrides,
  };
}

describe("candidate store", () => {
  it("落盘、读取、列表按时间排序", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-opt-"));
    await saveCandidate(workspace, candidate({ id: "cand-2", createdAt: "2026-11-13T00:00:00.000Z" }));
    await saveCandidate(workspace, candidate({ id: "cand-1" }));
    const all = await listCandidates(workspace);
    expect(all.map((item) => item.id)).toEqual(["cand-2", "cand-1"]);
    expect((await loadCandidate(workspace, "cand-1"))?.segment).toBe("root-agent");
  });

  it("拒绝不安全的 id（路径穿越）", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-opt-"));
    await expect(saveCandidate(workspace, candidate({ id: "../evil" }))).rejects.toThrow();
  });

  it("markFrozen 只改标记，正文不变", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "meowcode-opt-"));
    await saveCandidate(workspace, candidate());
    const frozen = await markFrozen(workspace, "cand-1");
    expect(frozen?.frozen).toBe(true);
    expect(frozen?.text).toBe("You are MeowCode (candidate).");
  });
});

const ok = (toolErrors = 0): RunOutcome => ({ status: "completed", toolErrors, userCorrected: false });

describe("evaluateCandidate", () => {
  it("按任务对比两个版本，均值差取整到打平阈值", async () => {
    const report = await evaluateCandidate({
      candidate: candidate(),
      tasks: [
        { id: "t1", prompt: "fix the parser" },
        { id: "t2", prompt: "add a flag" },
      ],
      run: async ({ segment }) => (segment ? ok() : ok(1)),
      repeat: 2,
    });
    expect(report.perTask).toHaveLength(2);
    // 候选全对、基线各带 1 次工具错：0.5 分差，全部算赢
    expect(report.wins).toBe(2);
    expect(report.losses).toBe(0);
    expect(report.avgDelta).toBeCloseTo(0.5, 5);
    expect(report.enoughSamples).toBe(false);
  });

  it("微差（<0.05）记为打平，不给假信号", async () => {
    // 两个版本跑同一份交替序列：各得 0.75，均值差为 0 → 打平
    const counters = new Map<string, number>();
    const report = await evaluateCandidate({
      candidate: candidate(),
      tasks: [{ id: "t1", prompt: "x" }],
      run: async ({ segment }) => {
        const key = segment ?? "baseline";
        const nth = (counters.get(key) ?? 0) + 1;
        counters.set(key, nth);
        return nth % 2 === 1 ? ok() : ok(1);
      },
      repeat: 2,
    });
    expect(report.ties).toBe(1);
    expect(report.avgDelta).toBe(0);
  });

  it("aborted 一律 -1 分（与线上口径一致）", async () => {
    const report = await evaluateCandidate({
      candidate: candidate(),
      tasks: [{ id: "t1", prompt: "x" }],
      run: async ({ segment }) => (segment ? { status: "aborted", toolErrors: 0, userCorrected: false } : ok()),
      repeat: 1,
    });
    expect(report.avgDelta).toBeLessThan(0);
    expect(report.losses).toBe(1);
  });
});

function report(overrides: Partial<CandidateReport> = {}): CandidateReport {
  return {
    candidateId: "cand-1",
    segment: "root-agent",
    baselineVersion: "a1b2c3d4",
    avgDelta: 0.25,
    wins: 3,
    ties: 1,
    losses: 0,
    perTask: [],
    enoughSamples: true,
    ...overrides,
  };
}

describe("recommendFreeze", () => {
  it("样本不足时拒绝下结论", () => {
    const decision = recommendFreeze(report({ enoughSamples: false, wins: 9 }));
    expect(decision.freeze).toBe(false);
    expect(decision.reason).toContain("task");
  });

  it("单任务大幅回归直接否决，即使平均为正", () => {
    const decision = recommendFreeze(
      report({
        perTask: [
          { taskId: "t1", baselineScore: 1, candidateScore: 0.25, delta: -0.75 },
          { taskId: "t2", baselineScore: 0.5, candidateScore: 1, delta: 0.5 },
        ],
        avgDelta: -0.125,
      }),
    );
    expect(decision.freeze).toBe(false);
    expect(decision.reason).toContain("t1");
  });

  it("平均为正且无回归才建议冻结", () => {
    const good = recommendFreeze(report());
    expect(good.freeze).toBe(true);
    expect(good.reason).toContain("+0.25");
    const flat = recommendFreeze(report({ avgDelta: 0 }));
    expect(flat.freeze).toBe(false);
  });

  it("赢面没过半不冻结", () => {
    const decision = recommendFreeze(
      report({ wins: 1, losses: 2, ties: 1, avgDelta: 0.1 }),
    );
    expect(decision.freeze).toBe(false);
    expect(decision.reason).toContain("do not beat losses");
  });
});
