/**
 * 自动化（定时任务）调度器：主进程侧的时间驱动引擎。
 *
 * 放主进程而不是 agent server：server 在每次保存设置时都会整进程重启，定时器放那边
 * 会被频繁重置；主进程持有 serverUrl/serverToken，触发走 loopback HTTP（/session/new
 * → /session/prompt），执行与流式回传完全复用现有链路，agent server 零改动。
 *
 * 错过策略（用户确认）：应用没运行/休眠时错过的任务只记「已错过」，永不补跑。
 * 判定阈值 MISSED_TOLERANCE_MS：正常 30s tick 内的到期算「到点触发」，
 * 超过阈值才视为错过（重启/休眠恢复后的第一个 tick 会走这个分支）。
 */

const crypto = require("node:crypto");
const { parseExpression } = require("cron-parser");
const { readJsonWithBackup, writeJsonAtomic } = require("./persist.cjs");

const TICK_MS = 30_000;
/** 超过这个间隔的到期视为「错过」而不是「到点」：覆盖重启/休眠，容忍慢 tick */
const MISSED_TOLERANCE_MS = 10 * 60_000;
/** 触发失败重试：共尝试 3 次，间隔 10s（server 正在重启时给它恢复时间） */
const FIRE_ATTEMPTS = 3;
const FIRE_RETRY_DELAY_MS = 10_000;
const HISTORY_LIMIT = 20;
const INTERVAL_MINUTES_MAX = 525_600; // 一年

const AUTOMATION_KINDS = ["interval", "daily", "weekly", "monthly", "cron", "once"];
const HISTORY_STATUSES = ["started", "ok", "error", "missed"];

function generateId() {
  return `auto-${crypto.randomBytes(5).toString("hex")}`;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function parseHHMM(value) {
  if (typeof value !== "string") return null;
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

/** 校验 cron 表达式，合法返回 null，非法返回错误消息（保存时给 UI 提示用）。 */
function validateCron(expression) {
  try {
    parseExpression(String(expression ?? ""), { currentDate: new Date() });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function nextDailyAt(fromMs, time) {
  const d = new Date(fromMs);
  d.setHours(time.hours, time.minutes, 0, 0);
  // 严格晚于 from：computeNextRun 总是在「处理完当前槽位」之后调用
  if (d.getTime() <= fromMs) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function nextWeeklyAt(fromMs, weekday, time) {
  const d = new Date(nextDailyAt(fromMs, time));
  const delta = (weekday - d.getDay() + 7) % 7;
  if (delta > 0) d.setDate(d.getDate() + delta);
  return d.getTime();
}

function nextMonthlyAt(fromMs, dayOfMonth, time) {
  const candidate = (year, month) => {
    // 目标日不在该月（2 月 30 日之类）时收敛到当月最后一天
    const lastDay = new Date(year, month + 1, 0).getDate();
    return new Date(year, month, Math.min(dayOfMonth, lastDay), time.hours, time.minutes, 0, 0);
  };
  const d = new Date(fromMs);
  let c = candidate(d.getFullYear(), d.getMonth());
  if (c.getTime() <= fromMs) {
    c =
      d.getMonth() === 11
        ? candidate(d.getFullYear() + 1, 0)
        : candidate(d.getFullYear(), d.getMonth() + 1);
  }
  return c.getTime();
}

/**
 * 下一次触发时间（毫秒），永远严格晚于 fromMs；算不出来（一次性已过期等）返回 null。
 * 纯函数：interval 的节奏锚定读 automation.nextRunAt，其余只看调度字段。
 */
function computeNextRun(automation, fromMs) {
  const kind = automation?.kind;
  if (kind === "once") {
    const at = Date.parse(automation.onceAt ?? "");
    return Number.isFinite(at) && at > fromMs ? at : null;
  }
  if (kind === "interval") {
    const minutes = Math.max(1, Math.floor(Number(automation.intervalMinutes) || 0));
    const step = minutes * 60_000;
    // 有既有节奏就沿用它（避免每次 tick 抖动累积漂移）；对不上就重新从现在起算
    const anchor = Date.parse(automation.nextRunAt ?? "");
    const base = Number.isFinite(anchor) && anchor > fromMs ? anchor : fromMs;
    let next = base + step;
    if (next <= fromMs) next = fromMs + step;
    return next;
  }
  if (kind === "daily") {
    const time = parseHHMM(automation.time);
    return time ? nextDailyAt(fromMs, time) : null;
  }
  if (kind === "weekly") {
    const time = parseHHMM(automation.time);
    const weekday = Math.floor(Number(automation.weekday));
    if (!time || !(weekday >= 0 && weekday <= 6)) return null;
    return nextWeeklyAt(fromMs, weekday, time);
  }
  if (kind === "monthly") {
    const time = parseHHMM(automation.time);
    const dayOfMonth = Math.floor(Number(automation.dayOfMonth));
    if (!time || !(dayOfMonth >= 1 && dayOfMonth <= 31)) return null;
    return nextMonthlyAt(fromMs, dayOfMonth, time);
  }
  if (kind === "cron") {
    try {
      return parseExpression(String(automation.cron ?? ""), {
        currentDate: new Date(fromMs),
      }).next().getTime();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 归一化一条自动化记录：合法返回 { ok: true, value }，非法返回 { ok: false, error }。
 * 加载时过滤脏数据、保存时校验 UI 草稿共用这一个入口。
 */
function normalizeAutomation(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const fail = (error) => ({ ok: false, error });

  const title = typeof source.title === "string" ? source.title.trim() : "";
  if (!title) return fail("title is required");
  if (title.length > 80) return fail("title is too long");
  const prompt = typeof source.prompt === "string" ? source.prompt.trim() : "";
  if (!prompt) return fail("prompt is required");
  if (prompt.length > 20_000) return fail("prompt is too long");
  const cwd = typeof source.cwd === "string" ? source.cwd.trim() : "";
  if (!cwd) return fail("cwd is required");

  const kind = source.kind;
  if (!AUTOMATION_KINDS.includes(kind)) return fail("unknown schedule kind");

  const value = {
    id: typeof source.id === "string" && source.id ? source.id : generateId(),
    title,
    prompt,
    cwd,
    kind,
    enabled: source.enabled !== false,
    recurring: kind === "once" ? false : source.recurring !== false,
    createdAt:
      typeof source.createdAt === "string" && source.createdAt
        ? source.createdAt
        : iso(Date.now()),
    updatedAt: iso(Date.now()),
    fireCount: Number.isFinite(Number(source.fireCount)) ? Math.max(0, Math.floor(Number(source.fireCount))) : 0,
    history: [],
  };

  if (kind === "interval") {
    const minutes = Math.floor(Number(source.intervalMinutes));
    if (!(minutes >= 1 && minutes <= INTERVAL_MINUTES_MAX)) {
      return fail("intervalMinutes must be 1-525600");
    }
    value.intervalMinutes = minutes;
  } else if (kind === "daily" || kind === "weekly" || kind === "monthly") {
    const time = parseHHMM(source.time);
    if (!time) return fail("time must be HH:MM");
    value.time = `${String(time.hours).padStart(2, "0")}:${String(time.minutes).padStart(2, "0")}`;
    if (kind === "weekly") {
      const weekday = Math.floor(Number(source.weekday));
      if (!(weekday >= 0 && weekday <= 6)) return fail("weekday must be 0-6");
      value.weekday = weekday;
    }
    if (kind === "monthly") {
      const dayOfMonth = Math.floor(Number(source.dayOfMonth));
      if (!(dayOfMonth >= 1 && dayOfMonth <= 31)) return fail("dayOfMonth must be 1-31");
      value.dayOfMonth = dayOfMonth;
    }
  } else if (kind === "cron") {
    const expression = typeof source.cron === "string" ? source.cron.trim() : "";
    if (!expression) return fail("cron is required");
    const cronError = validateCron(expression);
    if (cronError) return fail(cronError);
    value.cron = expression;
  } else if (kind === "once") {
    const at = Date.parse(source.onceAt ?? "");
    if (!Number.isFinite(at)) return fail("onceAt must be an ISO date");
    value.onceAt = new Date(at).toISOString();
  }

  if (source.maxRuns != null) {
    const maxRuns = Math.floor(Number(source.maxRuns));
    if (maxRuns >= 1 && maxRuns <= 100_000) value.maxRuns = maxRuns;
  }

  // 历史：只保留已知字段与合法状态，最新的在前，封顶 20 条
  const history = Array.isArray(source.history) ? source.history : [];
  for (const entry of history) {
    if (!entry || typeof entry !== "object") continue;
    if (!HISTORY_STATUSES.includes(entry.status)) continue;
    value.history.push({
      at: typeof entry.at === "string" && entry.at ? entry.at : value.updatedAt,
      status: entry.status,
      ...(entry.sessionId ? { sessionId: String(entry.sessionId) } : {}),
      ...(entry.error ? { error: String(entry.error).slice(0, 500) } : {}),
    });
    if (value.history.length >= HISTORY_LIMIT) break;
  }

  // nextRunAt：外部传入就保留（重启恢复用），否则由启用状态推算
  if (typeof source.nextRunAt === "string" && source.nextRunAt) {
    const at = Date.parse(source.nextRunAt);
    if (Number.isFinite(at)) value.nextRunAt = new Date(at).toISOString();
  }
  if (value.enabled && !value.nextRunAt) {
    const next = computeNextRun(value, Date.now());
    if (next) value.nextRunAt = iso(next);
  }
  if (!value.enabled) value.nextRunAt = null;
  if (value.kind === "once" && !value.nextRunAt) value.enabled = false;

  return { ok: true, value };
}

/**
 * 创建调度器。options：
 * - filePath(): automations.json 的绝对路径（data-location 迁移后随 settingsDir 变）
 * - transport({cwd, message}) → {sessionId}：实际触发，主进程注入（loopback HTTP）
 * - getPrefix(automation) → string：投递 prompt 的前缀行（跟界面语言）
 * - onEvent({type: "changed"} | {type: "fire-failed", automation, error})
 * - log：console 兼容对象
 */
function createScheduler(options) {
  const opts = options ?? {};
  const log = opts.log ?? console;
  const now = () => (typeof opts.now === "function" ? opts.now() : Date.now());
  /** 正在触发的任务 id：tick 与手动「立即运行」并发时防重复 */
  const firing = new Set();
  /** 已触发未收尾的 sessionId → automationId：turn_complete 关联用 */
  let automations = [];
  let timer = null;
  let ticking = false;

  const emit = (event) => {
    if (typeof opts.onEvent === "function") {
      try {
        opts.onEvent(event);
      } catch (error) {
        log.warn?.("[scheduler] onEvent failed:", error);
      }
    }
  };
  const changed = () => emit({ type: "changed" });

  function load() {
    const filePath = opts.filePath();
    const raw = readJsonWithBackup(filePath, []);
    const list = Array.isArray(raw) ? raw : [];
    automations = [];
    for (const item of list) {
      const normalized = normalizeAutomation(item);
      if (normalized.ok) automations.push(normalized.value);
      else log.warn?.("[scheduler] dropped invalid automation:", normalized.error);
    }
    // 排序稳定：创建时间早的在前（UI 渲染顺序跟存储顺序一致）
    automations.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  function persist() {
    try {
      writeJsonAtomic(opts.filePath(), automations);
    } catch (error) {
      log.error?.("[scheduler] persist failed:", error);
    }
  }

  function list() {
    return JSON.parse(JSON.stringify(automations));
  }

  function find(id) {
    return automations.find((item) => item.id === id) ?? null;
  }

  function recordHistory(automation, entry) {
    automation.history.unshift({ at: iso(now()), ...entry });
    if (automation.history.length > HISTORY_LIMIT) {
      automation.history.length = HISTORY_LIMIT;
    }
  }

  /** 触发后推进调度：一次性/算不出下次 → 停用；达到 maxRuns → 停用。 */
  function advanceSchedule(automation, fromMs) {
    const next = computeNextRun(automation, fromMs);
    if (!automation.recurring || next === null) {
      automation.enabled = false;
      automation.nextRunAt = null;
      return;
    }
    automation.nextRunAt = iso(next);
    if (automation.maxRuns && automation.fireCount >= automation.maxRuns) {
      automation.enabled = false;
      automation.nextRunAt = null;
    }
  }

  function buildMessage(automation) {
    const prefix =
      typeof opts.getPrefix === "function" ? String(opts.getPrefix(automation) ?? "") : "";
    return prefix ? `${prefix}\n\n${automation.prompt}` : automation.prompt;
  }

  async function delay(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  const retryDelayMs = () =>
    Number.isFinite(Number(opts.fireRetryDelayMs)) ? Number(opts.fireRetryDelayMs) : FIRE_RETRY_DELAY_MS;

  /** 触发一次：新建会话 + 投递 prompt，重试 FIRE_ATTEMPTS 次，结果记历史。 */
  async function fire(automation, { manual = false } = {}) {
    if (firing.has(automation.id)) return false;
    firing.add(automation.id);
    try {
      const message = buildMessage(automation);
      let lastError = null;
      for (let attempt = 0; attempt < FIRE_ATTEMPTS; attempt += 1) {
        if (attempt > 0) await delay(retryDelayMs());
        try {
          const result = await opts.transport({ cwd: automation.cwd, message });
          const sessionId = String(result?.sessionId ?? "");
          if (!sessionId) throw new Error("transport returned no sessionId");
          recordHistory(automation, { status: "started", sessionId });
          if (!manual) {
            automation.fireCount += 1;
            advanceSchedule(automation, now());
          }
          persist();
          changed();
          return true;
        } catch (error) {
          lastError = error;
        }
      }
      const errorText =
        lastError instanceof Error ? lastError.message : String(lastError ?? "fire failed");
      recordHistory(automation, { status: "error", error: errorText });
      if (!manual) advanceSchedule(automation, now());
      persist();
      emit({ type: "fire-failed", automation: JSON.parse(JSON.stringify(automation)), error: errorText });
      changed();
      return false;
    } finally {
      firing.delete(automation.id);
    }
  }

  function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const current = now();
      for (const automation of [...automations]) {
        if (!automation.enabled || !automation.nextRunAt) continue;
        const due = Date.parse(automation.nextRunAt);
        if (!(Number.isFinite(due) && due <= current)) continue;
        if (current - due > MISSED_TOLERANCE_MS) {
          // 错过（休眠/没开机）：只记历史，永不补跑
          recordHistory(automation, { status: "missed" });
          advanceSchedule(automation, current);
          persist();
          changed();
          continue;
        }
        void fire(automation);
      }
    } finally {
      ticking = false;
    }
  }

  return {
    start() {
      load();
      // 启动即 tick 一次：应用重启窗口内到期的任务尽快补上（超过容错的会被标 missed）
      tick();
      timer = setInterval(() => tick(), opts.tickMs ?? TICK_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    list,
    /** 新建或更新（按 id 判断），返回归一化后的记录；非法抛错给 IPC 层。 */
    save(input) {
      const existing = input?.id ? find(String(input.id)) : null;
      const draft = normalizeAutomation({
        ...(existing ?? {}),
        ...input,
        id: existing?.id ?? undefined,
        createdAt: existing?.createdAt,
        fireCount: existing?.fireCount,
        history: existing?.history ?? [],
      });
      if (!draft.ok) throw new Error(draft.error);
      const next = draft.value;
      // 保存即重排：启用状态下从现在起算下一次
      next.nextRunAt = null;
      if (next.enabled) {
        const at = computeNextRun(next, now());
        next.nextRunAt = at ? iso(at) : null;
        if (!next.nextRunAt && next.kind === "once") next.enabled = false;
      }
      const index = automations.findIndex((item) => item.id === next.id);
      if (index >= 0) automations[index] = next;
      else automations.push(next);
      persist();
      changed();
      return JSON.parse(JSON.stringify(next));
    },
    remove(id) {
      const index = automations.findIndex((item) => item.id === id);
      if (index < 0) return false;
      automations.splice(index, 1);
      persist();
      changed();
      return true;
    },
    setEnabled(id, enabled) {
      const automation = find(id);
      if (!automation) throw new Error(`automation not found: ${id}`);
      automation.enabled = Boolean(enabled);
      if (automation.enabled) {
        const at = computeNextRun(automation, now());
        automation.nextRunAt = at ? iso(at) : null;
        if (!automation.nextRunAt && automation.kind === "once") automation.enabled = false;
      } else {
        automation.nextRunAt = null;
      }
      persist();
      changed();
      return JSON.parse(JSON.stringify(automation));
    },
    /** 手动「立即运行」：不走调度、不推进 nextRunAt/fireCount，结果照记历史。 */
    runNow(id) {
      const automation = find(id);
      if (!automation) throw new Error(`automation not found: ${id}`);
      return fire(automation, { manual: true });
    },
    /** SSE turn_complete 关联：把同 sessionId 的 started 历史结算成 ok/error。 */
    handleTurnComplete(sessionId, status) {
      const id = String(sessionId ?? "");
      if (!id) return;
      let dirty = false;
      for (const automation of automations) {
        const entry = automation.history[0];
        if (!entry || entry.status !== "started" || entry.sessionId !== id) continue;
        // runtime 发的原始值是 "completed"/"aborted"/"error"（"ok" 只用于 trace 映射）
        entry.status = status === "ok" || status === "completed" ? "ok" : "error";
        dirty = true;
      }
      if (dirty) {
        persist();
        changed();
      }
    },
    /** 测试辅助：注入假的调度状态（直接替换内存列表并落盘）/ 手动驱动一轮 tick。 */
    _replaceAll(list) {
      automations = list;
      persist();
    },
    _tick: () => tick(),
  };
}

module.exports = {
  AUTOMATION_KINDS,
  createScheduler,
  computeNextRun,
  normalizeAutomation,
  validateCron,
  MISSED_TOLERANCE_MS,
  TICK_MS,
};
