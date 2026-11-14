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
/** 投递失败重试的间隔：server 正在重启时给它恢复时间（次数见 DELIVER_ATTEMPTS） */
const FIRE_RETRY_DELAY_MS = 10_000;
const HISTORY_LIMIT = 20;
const INTERVAL_MINUTES_MAX = 525_600; // 一年

/**
 * 决策记录：每次触发都留一条「做了 / 没做 / 为什么」。
 * 放 automation.decisions 而不是 history —— history 只有 4 个状态且结算逻辑按
 * history[0].sessionId 精确匹配，混入 observed 会打乱它。
 */
const DECISION_LIMIT = 50;
const DECISION_MESSAGE_MAX = 2_000;
const DECISION_OUTCOMES = ["executed", "observed", "skipped", "failed", "uncertain"];
/** 三档自主：off 只记跳过，observe 只记「本该发什么」，auto 真执行 */
const AUTONOMY_MODES = ["off", "observe", "auto"];
const TRIGGER_PHASES = ["creating", "created", "delivered"];
/** 卡在 creating 超过这个时间就认为进程当时被杀了：转 uncertain，永不重建 */
const STALE_TRIGGER_MS = 2 * 60_000;
/** pendingTrigger 最长保留一天，超过就当垃圾清掉 */
const PENDING_TRIGGER_TTL_MS = 24 * 60 * 60_000;
/** 只对投递重试：建会话不重试，否则一次故障会留下多个孤儿会话 */
const DELIVER_ATTEMPTS = 2;

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

  const createdAt =
    typeof source.createdAt === "string" && source.createdAt ? source.createdAt : iso(Date.now());
  /** 缺省 auto：老任务保持原行为，不因为升级就突然不跑了 */
  const autonomy = AUTONOMY_MODES.includes(source.autonomy) ? source.autonomy : "auto";

  const value = {
    id: typeof source.id === "string" && source.id ? source.id : generateId(),
    title,
    prompt,
    cwd,
    kind,
    enabled: source.enabled !== false,
    recurring: kind === "once" ? false : source.recurring !== false,
    createdAt,
    updatedAt: iso(Date.now()),
    fireCount: Number.isFinite(Number(source.fireCount)) ? Math.max(0, Math.floor(Number(source.fireCount))) : 0,
    history: [],
    autonomy,
    mandate: normalizeMandate(source.mandate, autonomy, createdAt),
    decisions: normalizeDecisions(source.decisions),
    pendingTrigger: normalizePendingTrigger(source.pendingTrigger),
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

/** 授权是数据：谁在什么时候把这条任务设成了哪一档，事后改档不篡改历史 */
function normalizeMandate(raw, autonomy, createdAt) {
  const source = raw && typeof raw === "object" ? raw : null;
  const mode = source && AUTONOMY_MODES.includes(source.mode) ? source.mode : autonomy;
  const at = source && typeof source.at === "string" && source.at ? source.at : createdAt;
  // 两个字段都没有 = 升级前就存在的记录，标 legacy 便于审计区分
  const origin = source ? (source.source === "legacy" ? "legacy" : "user") : "legacy";
  return { mode, at, source: origin };
}

/** 决策记录：非法条目丢弃，最新在前，封顶 DECISION_LIMIT 条 */
function normalizeDecisions(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const decisions = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    if (!DECISION_OUTCOMES.includes(entry.outcome)) continue;
    if (!AUTONOMY_MODES.includes(entry.autonomy)) continue;
    const at = typeof entry.at === "string" && entry.at ? entry.at : "";
    if (!at) continue;
    decisions.push({
      // 老条目没有 triggerId：用决策时间回填，至少能唯一标识
      triggerId:
        typeof entry.triggerId === "string" && entry.triggerId ? entry.triggerId : `legacy:${at}`,
      scheduledAt:
        typeof entry.scheduledAt === "string" && entry.scheduledAt ? entry.scheduledAt : at,
      at,
      trigger: entry.trigger === "manual" ? "manual" : "schedule",
      autonomy: entry.autonomy,
      outcome: entry.outcome,
      ...(typeof entry.plannedMessage === "string"
        ? { plannedMessage: entry.plannedMessage.slice(0, DECISION_MESSAGE_MAX) }
        : {}),
      ...(typeof entry.messageHash === "string" ? { messageHash: entry.messageHash } : {}),
      ...(entry.sessionId ? { sessionId: String(entry.sessionId) } : {}),
      ...(TRIGGER_PHASES.includes(entry.phase) ? { phase: entry.phase } : {}),
      ...(entry.error ? { error: String(entry.error).slice(0, 500) } : {}),
      ...(entry.result === "ok" || entry.result === "error" ? { result: entry.result } : {}),
    });
    if (decisions.length >= DECISION_LIMIT) break;
  }
  return decisions;
}

/** 未完成触发：阶段不认识或超过一天就当不存在（残留的会话由人自己处理） */
function normalizePendingTrigger(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!TRIGGER_PHASES.includes(raw.phase)) return null;
  if (typeof raw.triggerId !== "string" || !raw.triggerId) return null;
  const at = typeof raw.at === "string" && raw.at ? raw.at : "";
  if (!at) return null;
  const atMs = Date.parse(at);
  if (Number.isFinite(atMs) && Date.now() - atMs > PENDING_TRIGGER_TTL_MS) return null;
  return {
    triggerId: raw.triggerId,
    scheduledAt:
      typeof raw.scheduledAt === "string" && raw.scheduledAt ? raw.scheduledAt : at,
    at,
    trigger: raw.trigger === "manual" ? "manual" : "schedule",
    phase: raw.phase,
    ...(raw.sessionId ? { sessionId: String(raw.sessionId) } : {}),
  };
}

/** 正文指纹：连续槽位内容没变时，UI 可以把多条 observed 折起来看 */
function hashText(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
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

  /** 槽位标识：定时按 nextRunAt 定格，手动按调用时刻。同一槽位只决策一次。 */
  function resolveTrigger(automation, manual) {
    const scheduledAt = manual ? iso(now()) : automation.nextRunAt ?? iso(now());
    return {
      triggerId: manual
        ? `${automation.id}:manual:${crypto.randomUUID()}`
        : `${automation.id}:${scheduledAt}`,
      scheduledAt,
      trigger: manual ? "manual" : "schedule",
    };
  }

  function recordDecision(automation, entry) {
    automation.decisions.unshift(entry);
    if (automation.decisions.length > DECISION_LIMIT) {
      automation.decisions.length = DECISION_LIMIT;
    }
  }

  /**
   * 触发一次。五段：定槽位 → 档位闸 → 先落盘 → 建会话 → 投递。
   *
   * 两个不变量：
   * 1. 一次触发最多建一个会话 —— 旧实现把建会话放在重试循环里，一次故障会留下
   *    2~3 个孤儿会话；现在只有投递会重试，且复用同一个 sessionId。
   * 2. off / observe 档不发任何请求，只留决策记录。
   */
  async function fire(automation, { manual = false } = {}) {
    if (firing.has(automation.id)) return false;
    firing.add(automation.id);
    try {
      const message = buildMessage(automation);
      const trigger = resolveTrigger(automation, manual);
      // 同一槽位已经决策过（重复 tick / 崩溃恢复后补跑）：不再执行
      if (automation.decisions.some((item) => item.triggerId === trigger.triggerId)) {
        return false;
      }
      const base = { ...trigger, at: iso(now()), autonomy: automation.autonomy };

      if (!manual && automation.autonomy !== "auto") {
        recordDecision(automation, {
          ...base,
          outcome: automation.autonomy === "observe" ? "observed" : "skipped",
          plannedMessage: message.slice(0, DECISION_MESSAGE_MAX),
          messageHash: hashText(message),
        });
        advanceSchedule(automation, now());
        persist();
        changed();
        return false;
      }

      // 先落盘再发请求：保证「客户端已发出」必先于「服务端已创建」被记录
      automation.pendingTrigger = { ...trigger, phase: "creating" };
      persist();

      let sessionId = "";
      try {
        const opened = await opts.openSession({ cwd: automation.cwd });
        sessionId = String(opened?.sessionId ?? "");
        if (!sessionId) throw new Error("openSession returned no sessionId");
      } catch (error) {
        const errorText =
          error instanceof Error ? error.message : String(error ?? "openSession failed");
        recordDecision(automation, { ...base, outcome: "failed", error: errorText });
        recordHistory(automation, { status: "error", error: errorText });
        automation.pendingTrigger = null;
        if (!manual) advanceSchedule(automation, now());
        persist();
        emit({ type: "fire-failed", automation: JSON.parse(JSON.stringify(automation)), error: errorText });
        changed();
        return false;
      }

      automation.pendingTrigger = { ...trigger, phase: "created", sessionId };
      persist();

      let delivered = false;
      let lastError = null;
      for (let attempt = 0; attempt < DELIVER_ATTEMPTS; attempt += 1) {
        if (attempt > 0) await delay(retryDelayMs());
        try {
          await opts.deliver({ sessionId, cwd: automation.cwd, message });
          delivered = true;
          break;
        } catch (error) {
          lastError = error;
        }
      }

      if (!delivered) {
        const errorText =
          lastError instanceof Error ? lastError.message : String(lastError ?? "deliver failed");
        recordDecision(automation, { ...base, outcome: "failed", sessionId, error: errorText });
        recordHistory(automation, { status: "error", error: errorText });
        automation.pendingTrigger = null;
        if (!manual) advanceSchedule(automation, now());
        persist();
        emit({ type: "fire-failed", automation: JSON.parse(JSON.stringify(automation)), error: errorText });
        changed();
        return false;
      }

      automation.pendingTrigger = null;
      recordHistory(automation, { status: "started", sessionId });
      recordDecision(automation, { ...base, outcome: "executed", sessionId, phase: "delivered" });
      if (!manual) {
        automation.fireCount += 1;
        advanceSchedule(automation, now());
      }
      persist();
      changed();
      return true;
    } finally {
      firing.delete(automation.id);
    }
  }

  /**
   * 崩溃恢复：卡在 creating 的转 uncertain（会话可能已建好但响应没回来，
   * 重建会多出孤儿会话），卡在 created 的用同一个 sessionId 补投一次。
   */
  async function reapStaleTriggers() {
    let dirty = false;
    for (const automation of automations) {
      const pending = automation.pendingTrigger;
      if (!pending) continue;
      const at = Date.parse(pending.at);
      const fresh = Number.isFinite(at) && now() - at < STALE_TRIGGER_MS;
      if (pending.phase === "creating") {
        if (!fresh) {
          recordDecision(automation, {
            triggerId: pending.triggerId,
            scheduledAt: pending.scheduledAt,
            at: iso(now()),
            trigger: pending.trigger,
            autonomy: automation.autonomy,
            outcome: "uncertain",
            error: "trigger interrupted while creating the session",
          });
          automation.pendingTrigger = null;
          dirty = true;
        }
        continue;
      }
      if (pending.phase === "created" && pending.sessionId) {
        const sessionId = pending.sessionId;
        const decision = {
          triggerId: pending.triggerId,
          scheduledAt: pending.scheduledAt,
          at: iso(now()),
          trigger: pending.trigger,
          autonomy: automation.autonomy,
        };
        try {
          await opts.deliver({ sessionId, cwd: automation.cwd, message: buildMessage(automation) });
          recordHistory(automation, { status: "started", sessionId });
          recordDecision(automation, { ...decision, outcome: "executed", sessionId, phase: "delivered" });
        } catch (error) {
          recordDecision(automation, {
            ...decision,
            outcome: "failed",
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        automation.pendingTrigger = null;
        dirty = true;
      }
    }
    if (dirty) {
      persist();
      changed();
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
      // 上次进程被杀时留下的半截触发：先收尾（转 uncertain 或补投），再跑调度
      void reapStaleTriggers();
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
      // 档位变更 = 一次显式授权：mandate 记下来；没改就沿用原记录
      const autonomy = AUTONOMY_MODES.includes(input?.autonomy)
        ? input.autonomy
        : existing?.autonomy;
      const mandate =
        autonomy && autonomy !== existing?.autonomy
          ? { mode: autonomy, at: iso(now()), source: "user" }
          : existing?.mandate;
      const draft = normalizeAutomation({
        ...(existing ?? {}),
        ...input,
        id: existing?.id ?? undefined,
        createdAt: existing?.createdAt,
        fireCount: existing?.fireCount,
        history: existing?.history ?? [],
        // 决策记录与半截触发只能由调度器自己写，UI 传来的值一律忽略
        autonomy,
        mandate,
        decisions: existing?.decisions ?? [],
        pendingTrigger: existing?.pendingTrigger ?? null,
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
        // 先结算决策记录：手动触发没有 history 条目，只有 decisions 能对上
        const decision = automation.decisions.find(
          (item) => item.sessionId === id && item.outcome === "executed" && item.result === undefined,
        );
        if (decision) {
          decision.result = status === "ok" || status === "completed" ? "ok" : "error";
          dirty = true;
        }
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
  AUTONOMY_MODES,
  DECISION_LIMIT,
  DECISION_OUTCOMES,
  createScheduler,
  computeNextRun,
  normalizeAutomation,
  validateCron,
  MISSED_TOLERANCE_MS,
  TICK_MS,
};
