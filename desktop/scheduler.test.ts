import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  createScheduler,
  computeNextRun,
  normalizeAutomation,
  validateCron,
} = require("./scheduler.cjs") as {
  createScheduler: (options?: Record<string, unknown>) => {
    start: () => void;
    stop: () => void;
    list: () => Array<Record<string, any>>;
    save: (input: Record<string, unknown>) => Record<string, any>;
    remove: (id: string) => boolean;
    setEnabled: (id: string, enabled: boolean) => Record<string, any>;
    runNow: (id: string) => Promise<boolean>;
    handleTurnComplete: (sessionId: string, status: string) => void;
    _replaceAll: (list: Array<Record<string, unknown>>) => void;
    _tick: () => void;
  };
  computeNextRun: (automation: Record<string, any>, fromMs: number) => number | null;
  normalizeAutomation: (raw: unknown) =>
    | { ok: true; value: Record<string, any> }
    | { ok: false; error: string };
  validateCron: (expression: string) => string | null;
};

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "mc-scheduler-"));
  const filePath = join(dir, "automations.json");
  cleanupDirs.push(dir);
  return filePath;
}
const cleanupDirs: string[] = [];
afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 固定一个「今天中午 12 点」的起点，日期断言不受测试运行时刻影响 */
function noonToday(): number {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime();
}

function writeRaw(filePath: string, list: Array<Record<string, unknown>>): void {
  writeFileSync(filePath, JSON.stringify(list), "utf8");
}

type TransportCall = { cwd: string; message: string };
function stubTransport(
  impl?: (call: TransportCall) => { sessionId: string } | Promise<never>,
) {
  const calls: TransportCall[] = [];
  const transport = async (call: TransportCall) => {
    calls.push(call);
    if (impl) return (await impl(call)) as never;
    return { sessionId: `s-${calls.length}` };
  };
  return { calls, transport };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  await vi.waitFor(() => {
    expect(predicate()).toBe(true);
  });
}

describe("computeNextRun", () => {
  it("interval：无锚点从 from 起算，有未来锚点沿用节奏", () => {
    const from = noonToday();
    expect(computeNextRun({ kind: "interval", intervalMinutes: 10 }, from)).toBe(from + 10 * 60_000);
    const anchor = from + 5 * 60_000;
    expect(
      computeNextRun({ kind: "interval", intervalMinutes: 10, nextRunAt: new Date(anchor).toISOString() }, from),
    ).toBe(anchor + 10 * 60_000);
  });

  it("daily：今天的时刻还没到就用今天，过了就排明天", () => {
    const from = noonToday();
    expect(computeNextRun({ kind: "daily", time: "15:00" }, from)).toBe(from + 3 * 3_600_000);
    const tomorrow = new Date(from);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    expect(computeNextRun({ kind: "daily", time: "9:00" }, from)).toBe(tomorrow.getTime());
  });

  it("weekly：目标是本周的星期几", () => {
    const from = noonToday();
    const weekday = new Date(from).getDay();
    const next = computeNextRun({ kind: "weekly", weekday, time: "15:00" }, from);
    expect(next).toBe(from + 3 * 3_600_000);
    const later = computeNextRun({ kind: "weekly", weekday, time: "09:00" }, from);
    expect(later).toBeGreaterThan(from);
    expect(new Date(later).getDay()).toBe(weekday);
    expect(later - from).toBeLessThanOrEqual(8 * 24 * 3_600_000);
  });

  it("monthly：目标日缺月收敛到月末（1月31日 → 2月28日）", () => {
    const from = new Date(2026, 0, 15, 12, 0, 0, 0).getTime();
    const jan31 = new Date(2026, 0, 31, 9, 0, 0, 0).getTime();
    expect(computeNextRun({ kind: "monthly", dayOfMonth: 31, time: "09:00" }, from)).toBe(jan31);
    const after = new Date(2026, 0, 31, 10, 0, 0, 0).getTime();
    expect(computeNextRun({ kind: "monthly", dayOfMonth: 31, time: "09:00" }, after)).toBe(
      new Date(2026, 1, 28, 9, 0, 0, 0).getTime(),
    );
  });

  it("once：未来返回该时刻，过去返回 null", () => {
    const from = noonToday();
    const future = from + 60_000;
    expect(computeNextRun({ kind: "once", onceAt: new Date(future).toISOString() }, from)).toBe(future);
    expect(computeNextRun({ kind: "once", onceAt: new Date(from - 1).toISOString() }, from)).toBeNull();
  });

  it("cron：解析出下一个分钟级时刻；非法表达式返回 null", () => {
    const from = new Date(2026, 0, 15, 12, 0, 0, 0).getTime();
    const next = computeNextRun({ kind: "cron", cron: "30 9 * * *" }, from);
    expect(next).toBeGreaterThan(from);
    const d = new Date(next);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(30);
    expect(computeNextRun({ kind: "cron", cron: "not a cron" }, from)).toBeNull();
  });

  it("validateCron：合法返回 null，非法返回错误", () => {
    expect(validateCron("*/5 * * * *")).toBeNull();
    expect(validateCron("garbage")).toBeTruthy();
  });
});

describe("normalizeAutomation", () => {
  const valid = {
    title: "每天检查",
    prompt: "检查依赖更新",
    cwd: "C:\\repo",
    kind: "daily",
    time: "09:00",
  };

  it("缺字段/非法 kind 报错", () => {
    expect(normalizeAutomation({ ...valid, title: "  " }).ok).toBe(false);
    expect(normalizeAutomation({ ...valid, prompt: "" }).ok).toBe(false);
    expect(normalizeAutomation({ ...valid, cwd: "" }).ok).toBe(false);
    expect(normalizeAutomation({ ...valid, kind: "yearly" }).ok).toBe(false);
    expect(normalizeAutomation({ ...valid, time: "25:00" }).ok).toBe(false);
  });

  it("once 强制 recurring=false；已过期的一次性任务直接停用", () => {
    const future = normalizeAutomation({
      ...valid,
      kind: "once",
      onceAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(future.ok).toBe(true);
    if (!future.ok) return;
    expect(future.value.recurring).toBe(false);
    expect(future.value.enabled).toBe(true);
    const past = normalizeAutomation({
      ...valid,
      kind: "once",
      onceAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(past.ok).toBe(true);
    if (!past.ok) return;
    expect(past.value.enabled).toBe(false);
  });

  it("历史封顶 20 条，非法状态被丢弃", () => {
    const history = Array.from({ length: 25 }, (_, i) => ({
      at: new Date(i).toISOString(),
      status: i === 0 ? "bogus" : "ok",
    }));
    const result = normalizeAutomation({ ...valid, history });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.history).toHaveLength(20);
  });

  it("非法 cron 带回解析错误", () => {
    const result = normalizeAutomation({ ...valid, kind: "cron", cron: "oops" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.length).toBeGreaterThan(0);
  });
});

describe("createScheduler", () => {
  it("到点触发：transport 收到前缀+正文，历史记 started，推进下一次", async () => {
    const filePath = tempFile();
    const { calls, transport } = stubTransport();
    const fixedNow = noonToday();
    const daily = {
      id: "auto-daily",
      title: "日报",
      prompt: "总结提交",
      cwd: "C:\\repo",
      kind: "daily",
      time: "23:59",
      enabled: true,
      recurring: true,
      createdAt: new Date(fixedNow).toISOString(),
      fireCount: 0,
      history: [],
      nextRunAt: new Date(fixedNow - 5_000).toISOString(),
    };
    writeRaw(filePath, [daily]);
    const scheduler = createScheduler({
      filePath: () => filePath,
      transport,
      getPrefix: (a: { title: string }) => `【定时任务「${a.title}」】`,
      now: () => fixedNow,
      fireRetryDelayMs: 1,
    });
    scheduler.start();
    await waitFor(() => calls.length === 1);
    scheduler.stop();

    expect(calls[0].cwd).toBe("C:\\repo");
    expect(calls[0].message.startsWith("【定时任务「日报」】")).toBe(true);
    expect(calls[0].message.endsWith("总结提交")).toBe(true);
    const after = scheduler.list()[0];
    expect(after.history[0].status).toBe("started");
    expect(after.history[0].sessionId).toBe("s-1");
    expect(after.fireCount).toBe(1);
    expect(Date.parse(after.nextRunAt)).toBeGreaterThan(fixedNow);
    // 已落盘
    const onDisk = JSON.parse(readFileSync(filePath, "utf8"));
    expect(onDisk[0].history[0].status).toBe("started");
  });

  it("错过（超过容错）：只记 missed，不触发，推进到下一个未来槽位", () => {
    const filePath = tempFile();
    const { calls, transport } = stubTransport();
    const fixedNow = noonToday();
    writeRaw(filePath, [
      {
        id: "auto-late",
        title: "过期任务",
        prompt: "p",
        cwd: "C:\\repo",
        kind: "daily",
        time: "08:00",
        enabled: true,
        recurring: true,
        createdAt: new Date(fixedNow).toISOString(),
        fireCount: 0,
        history: [],
        nextRunAt: new Date(fixedNow - 20 * 60_000).toISOString(),
      },
    ]);
    const scheduler = createScheduler({
      filePath: () => filePath,
      transport,
      now: () => fixedNow,
      fireRetryDelayMs: 1,
    });
    scheduler.start();
    scheduler.stop();
    expect(calls).toHaveLength(0);
    const after = scheduler.list()[0];
    expect(after.history[0].status).toBe("missed");
    expect(after.enabled).toBe(true);
    expect(Date.parse(after.nextRunAt)).toBeGreaterThan(fixedNow);
  });

  it("一次性任务触发后停用；maxRuns 达到后停用", async () => {
    const filePath = tempFile();
    const { calls, transport } = stubTransport();
    const fixedNow = noonToday();
    writeRaw(filePath, [
      {
        id: "auto-once",
        title: "一次性",
        prompt: "p",
        cwd: "C:\\repo",
        kind: "once",
        onceAt: new Date(fixedNow + 60_000).toISOString(),
        enabled: true,
        recurring: false,
        createdAt: new Date(fixedNow).toISOString(),
        fireCount: 0,
        history: [],
        // 存储里的 nextRunAt 落后于 onceAt：模拟重启窗口内到点
        nextRunAt: new Date(fixedNow - 5_000).toISOString(),
      },
      {
        id: "auto-cap",
        title: "限次",
        prompt: "p",
        cwd: "C:\\repo",
        kind: "daily",
        time: "23:59",
        enabled: true,
        recurring: true,
        maxRuns: 1,
        createdAt: new Date(fixedNow).toISOString(),
        fireCount: 0,
        history: [],
        nextRunAt: new Date(fixedNow - 5_000).toISOString(),
      },
    ]);
    const scheduler = createScheduler({
      filePath: () => filePath,
      transport,
      now: () => fixedNow,
      fireRetryDelayMs: 1,
    });
    scheduler.start();
    await waitFor(() => calls.length === 2);
    scheduler.stop();
    const [once, cap] = scheduler.list();
    expect(once.enabled).toBe(false);
    expect(once.nextRunAt).toBeNull();
    expect(cap.enabled).toBe(false);
    expect(cap.fireCount).toBe(1);
  });

  it("触发失败重试 3 次后记 error、发 fire-failed 事件、照常推进", async () => {
    const filePath = tempFile();
    const attempts: TransportCall[] = [];
    const counting = async (call: TransportCall) => {
      attempts.push(call);
      throw new Error("server down");
    };
    const events: Array<Record<string, unknown>> = [];
    const fixedNow = noonToday();
    writeRaw(filePath, [
      {
        id: "auto-fail",
        title: "会失败",
        prompt: "p",
        cwd: "C:\\repo",
        kind: "daily",
        time: "23:59",
        enabled: true,
        recurring: true,
        createdAt: new Date(fixedNow).toISOString(),
        fireCount: 0,
        history: [],
        nextRunAt: new Date(fixedNow - 5_000).toISOString(),
      },
    ]);
    const scheduler = createScheduler({
      filePath: () => filePath,
      transport: counting,
      now: () => fixedNow,
      fireRetryDelayMs: 1,
      onEvent: (event: Record<string, unknown>) => events.push(event),
    });
    scheduler.start();
    await waitFor(() => attempts.length === 3);
    scheduler.stop();
    const after = scheduler.list()[0];
    expect(after.history[0].status).toBe("error");
    expect(after.history[0].error).toContain("server down");
    expect(after.fireCount).toBe(0);
    expect(Date.parse(after.nextRunAt)).toBeGreaterThan(fixedNow);
    expect(events.some((e) => e.type === "fire-failed")).toBe(true);
  });

  it("runNow：手动触发不推进 fireCount 与 nextRunAt", async () => {
    const filePath = tempFile();
    const { calls, transport } = stubTransport();
    const fixedNow = noonToday();
    writeRaw(filePath, [
      {
        id: "auto-manual",
        title: "手动",
        prompt: "p",
        cwd: "C:\\repo",
        kind: "daily",
        time: "23:59",
        enabled: true,
        recurring: true,
        createdAt: new Date(fixedNow).toISOString(),
        fireCount: 3,
        history: [],
        nextRunAt: new Date(fixedNow + 3_600_000).toISOString(),
      },
    ]);
    const scheduler = createScheduler({
      filePath: () => filePath,
      transport,
      now: () => fixedNow,
      fireRetryDelayMs: 1,
    });
    scheduler.start();
    await scheduler.runNow("auto-manual");
    scheduler.stop();
    const after = scheduler.list()[0];
    expect(calls).toHaveLength(1);
    expect(after.fireCount).toBe(3);
    expect(Date.parse(after.nextRunAt)).toBe(fixedNow + 3_600_000);
    expect(after.history[0].status).toBe("started");
  });

  it("save：新建自动生成 id 与 nextRunAt；更新保留 createdAt/fireCount/history", () => {
    const filePath = tempFile();
    const { transport } = stubTransport();
    const fixedNow = noonToday();
    const scheduler = createScheduler({
      filePath: () => filePath,
      transport,
      now: () => fixedNow,
      fireRetryDelayMs: 1,
    });
    scheduler.start();
    const created = scheduler.save({
      title: "新建",
      prompt: "p",
      cwd: "C:\\repo",
      kind: "daily",
      time: "09:00",
      enabled: true,
    });
    expect(created.id).toMatch(/^auto-/);
    expect(Date.parse(created.nextRunAt)).toBeGreaterThan(fixedNow);

    const updated = scheduler.save({
      id: created.id,
      title: "改名",
      prompt: "p2",
      cwd: "C:\\repo",
      kind: "daily",
      time: "10:00",
      enabled: true,
    });
    expect(updated.title).toBe("改名");
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.fireCount).toBe(0);
    expect(updated.nextRunAt).not.toBeNull();
    expect(() =>
      scheduler.save({ title: "坏", prompt: "p", cwd: "C:\\repo", kind: "daily", time: "99:00" }),
    ).toThrow();
    scheduler.stop();
  });

  it("setEnabled：停用清 nextRunAt，重新启用从现在重排", () => {
    const filePath = tempFile();
    const { transport } = stubTransport();
    const fixedNow = noonToday();
    writeRaw(filePath, [
      {
        id: "auto-toggle",
        title: "t",
        prompt: "p",
        cwd: "C:\\repo",
        kind: "daily",
        time: "09:00",
        enabled: true,
        recurring: true,
        createdAt: new Date(fixedNow).toISOString(),
        fireCount: 0,
        history: [],
        nextRunAt: new Date(fixedNow + 3_600_000).toISOString(),
      },
    ]);
    const scheduler = createScheduler({
      filePath: () => filePath,
      transport,
      now: () => fixedNow,
      fireRetryDelayMs: 1,
    });
    scheduler.start();
    const off = scheduler.setEnabled("auto-toggle", false);
    expect(off.enabled).toBe(false);
    expect(off.nextRunAt).toBeNull();
    const on = scheduler.setEnabled("auto-toggle", true);
    expect(on.enabled).toBe(true);
    expect(Date.parse(on.nextRunAt)).toBeGreaterThan(fixedNow);
    scheduler.stop();
  });

  it("remove：删除后列表与磁盘同步", () => {
    const filePath = tempFile();
    const { transport } = stubTransport();
    const fixedNow = noonToday();
    writeRaw(filePath, [
      {
        id: "auto-gone",
        title: "t",
        prompt: "p",
        cwd: "C:\\repo",
        kind: "daily",
        time: "09:00",
        enabled: true,
        recurring: true,
        createdAt: new Date(fixedNow).toISOString(),
        fireCount: 0,
        history: [],
        nextRunAt: new Date(fixedNow + 3_600_000).toISOString(),
      },
    ]);
    const scheduler = createScheduler({
      filePath: () => filePath,
      transport,
      now: () => fixedNow,
      fireRetryDelayMs: 1,
    });
    scheduler.start();
    expect(scheduler.remove("auto-gone")).toBe(true);
    expect(scheduler.list()).toHaveLength(0);
    const onDisk = JSON.parse(readFileSync(filePath, "utf8"));
    expect(onDisk).toHaveLength(0);
    scheduler.stop();
  });

  it("handleTurnComplete：started → ok/error 并落盘（runtime 原始值 completed 也算成功）", async () => {
    const filePath = tempFile();
    const { calls, transport } = stubTransport();
    const fixedNow = noonToday();
    writeRaw(filePath, [
      {
        id: "auto-turn",
        title: "t",
        prompt: "p",
        cwd: "C:\\repo",
        kind: "daily",
        time: "23:59",
        enabled: true,
        recurring: true,
        createdAt: new Date(fixedNow).toISOString(),
        fireCount: 0,
        history: [],
        nextRunAt: new Date(fixedNow - 5_000).toISOString(),
      },
    ]);
    const scheduler = createScheduler({
      filePath: () => filePath,
      transport,
      now: () => fixedNow,
      fireRetryDelayMs: 1,
    });
    scheduler.start();
    await waitFor(() => calls.length === 1);
    scheduler.handleTurnComplete("s-1", "completed");
    scheduler.stop();
    expect(scheduler.list()[0].history[0].status).toBe("ok");
    const onDisk = JSON.parse(readFileSync(filePath, "utf8"));
    expect(onDisk[0].history[0].status).toBe("ok");
  });

  it("handleTurnComplete：aborted/error 回合结算为失败", async () => {
    const filePath = tempFile();
    const { calls, transport } = stubTransport();
    const fixedNow = noonToday();
    writeRaw(filePath, [
      {
        id: "auto-abort",
        title: "t",
        prompt: "p",
        cwd: "C:\\repo",
        kind: "daily",
        time: "23:59",
        enabled: true,
        recurring: true,
        createdAt: new Date(fixedNow).toISOString(),
        fireCount: 0,
        history: [],
        nextRunAt: new Date(fixedNow - 5_000).toISOString(),
      },
    ]);
    const scheduler = createScheduler({
      filePath: () => filePath,
      transport,
      now: () => fixedNow,
      fireRetryDelayMs: 1,
    });
    scheduler.start();
    await waitFor(() => calls.length === 1);
    scheduler.handleTurnComplete("s-1", "aborted");
    scheduler.stop();
    expect(scheduler.list()[0].history[0].status).toBe("error");
  });
});
