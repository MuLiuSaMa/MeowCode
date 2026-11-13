import { describe, expect, it } from "vitest";
import {
  ALTERNATING_WINDOW,
  MAX_TURN_ROUNDS,
  TURN_WRAPUP_NOTE,
  TurnBudget,
  callSignature,
} from "./turn-budget.js";

describe("callSignature", () => {
  it("键序不影响签名（模型换 key 顺序不算新调用）", () => {
    const a = callSignature("read_file", '{"path":"a.ts","offset":2}');
    const b = callSignature("read_file", '{"offset":2,"path":"a.ts"}');
    expect(a).toBe(b);
  });

  it("参数不同即不同签名；非法 JSON 退化为原文比较", () => {
    expect(callSignature("read_file", '{"path":"a.ts"}')).not.toBe(
      callSignature("read_file", '{"path":"b.ts"}'),
    );
    expect(callSignature("read_file", "{broken")).toBe(callSignature("read_file", "{broken"));
  });
});

describe("TurnBudget rounds", () => {
  it("轮次到上限即硬停，错误文案带数字", () => {
    const budget = new TurnBudget({ maxRounds: 3 });
    expect(budget.beginRound().stop).toBeUndefined();
    expect(budget.beginRound().stop).toBeUndefined();
    expect(budget.beginRound().stop).toBeUndefined();
    const stop = budget.beginRound();
    expect(stop.stop).toContain("3-round budget");
  });

  it("软阈值只提醒一次", () => {
    const budget = new TurnBudget({ maxRounds: 3 });
    const notes = [1, 2, 3].map(() => budget.beginRound().note);
    expect(notes.filter(Boolean)).toHaveLength(1);
    expect(notes.find(Boolean)).toBe(TURN_WRAPUP_NOTE);
  });

  it("默认上限远高于真实任务所需", () => {
    expect(MAX_TURN_ROUNDS).toBeGreaterThanOrEqual(40);
    const budget = new TurnBudget();
    for (let index = 0; index < MAX_TURN_ROUNDS; index += 1) {
      expect(budget.beginRound().stop, `round ${index + 1}`).toBeUndefined();
    }
    expect(budget.beginRound().stop).toBeDefined();
  });
});

describe("TurnBudget token cap", () => {
  it("累计输入+输出超过上限后下一轮硬停", () => {
    const budget = new TurnBudget({ maxRounds: 100, maxTokens: 1_000 });
    expect(budget.beginRound().stop).toBeUndefined();
    budget.recordUsage({ inputTokens: 800, outputTokens: 300 });
    expect(budget.usedTokens).toBe(1_100);
    expect(budget.beginRound().stop).toContain("token budget");
  });

  it("没有上限时永不因 token 停", () => {
    const budget = new TurnBudget({ maxRounds: 100 });
    budget.recordUsage({ inputTokens: 50_000_000, outputTokens: 1 });
    expect(budget.beginRound().stop).toBeUndefined();
  });

  it("缓存命中的输入按计费当量折算，不按全量烧预算", () => {
    const budget = new TurnBudget({ maxRounds: 100, maxTokens: 20_000 });
    // 10 万输入里 9.5 万是缓存命中：计费当量约 1.45 万，不该当场判死
    budget.recordUsage({ inputTokens: 100_000, cacheReadTokens: 95_000 });
    expect(budget.usedTokens).toBeCloseTo(14_500, 3);
    expect(budget.beginRound().stop).toBeUndefined();
  });

  it("命中数异常大于总量时按全命中处理，不倒扣", () => {
    const budget = new TurnBudget({ maxRounds: 100 });
    budget.recordUsage({ inputTokens: 1_000, cacheReadTokens: 5_000 });
    expect(budget.usedTokens).toBeCloseTo(100, 3);
  });

  it("压缩回血：账降到当前上下文，且只降不升", () => {
    const budget = new TurnBudget({ maxRounds: 100, maxTokens: 10_000 });
    budget.recordUsage({ inputTokens: 9_500 });
    budget.rebase(2_000);
    budget.recordUsage({ inputTokens: 6_000 });
    // 不回血的话这里是 15_500，下一轮就会被砍
    expect(budget.usedTokens).toBe(8_000);
    expect(budget.beginRound().stop).toBeUndefined();
    budget.rebase(99_999);
    expect(budget.usedTokens).toBe(8_000);
  });
});

describe("TurnBudget alternating loop detection", () => {
  it("A/B 交替 3 次给提醒，第 4 次拒绝执行", () => {
    const budget = new TurnBudget();
    const a = callSignature("grep", '{"pattern":"foo"}');
    const b = callSignature("read_file", '{"path":"bar.ts"}');
    const reminders: string[] = [];
    let blocked = "";
    for (let round = 0; round < 4; round += 1) {
      for (const signature of [a, b]) {
        const verdict = budget.observeCall(signature, false);
        if (verdict.reminder) reminders.push(verdict.reminder);
        if (verdict.blocked) blocked = verdict.blocked;
      }
    }
    expect(reminders.length).toBeGreaterThan(0);
    expect(reminders[0]).toContain("identical arguments 3 times");
    expect(blocked).toContain("Blocked:");
    expect(blocked).toContain("4 times");
  });

  it("写类调用清空窗口：改动后重读同一文件不算循环", () => {
    const budget = new TurnBudget();
    const read = callSignature("read_file", '{"path":"a.ts"}');
    for (let index = 0; index < 3; index += 1) budget.observeCall(read, false);
    // 一次写类调用之后，之前攒的计数作废
    budget.observeCall(callSignature("edit_file", '{"path":"a.ts"}'), true);
    const verdict = budget.observeCall(read, false);
    expect(verdict.blocked).toBeUndefined();
    expect(verdict.reminder).toBeUndefined();
  });

  it("窗口有界：老调用滚出窗口后不再计数", () => {
    const budget = new TurnBudget();
    const once = callSignature("glob", '{"pattern":"*.ts"}');
    budget.observeCall(once, false);
    for (let index = 0; index < ALTERNATING_WINDOW + 2; index += 1) {
      budget.observeCall(callSignature("grep", `{"pattern":"p${index}"}`), false);
    }
    const verdict = budget.observeCall(once, false);
    expect(verdict.blocked).toBeUndefined();
    expect(verdict.reminder).toBeUndefined();
  });
});
