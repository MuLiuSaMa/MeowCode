const fs = require("node:fs");
const path = require("node:path");

/**
 * 最小性能观测：把「哪个进程吃了多少 CPU / 内存」变成可查的数据。
 *
 * 设计取舍：
 * - 采样 10s 一次。`getAppMetrics()` 的 `percentCPUUsage` 语义是「距上次调用的均值」，
 *   所以采样间隔本身就是统计窗口；1s 反而会让读数抖动、且采样器自己变成噪音。
 * - 落盘 60s 一次，内存里留 360 点（≈1 小时）环形缓冲。落盘只用异步 append，
 *   刻意不用 persist.cjs 的 writeJsonAtomic —— 它带 fsync，采样器自己会制造 IO 毛刺。
 * - 崩溃/无响应单独写 crashes.jsonl，和采样流分开，方便直接 grep。
 * - 采样全程 try/catch：观测代码不允许影响主流程。
 */

/** 采样周期（同时是 percentCPUUsage 的统计窗口）。 */
const SAMPLE_INTERVAL_MS = 10_000;
/** 落盘周期。 */
const FLUSH_INTERVAL_MS = 60_000;
/** 环形缓冲点数：360 × 10s ≈ 1 小时。 */
const RING_LIMIT = 360;
/** 日志保留天数。 */
const RETAIN_DAYS = 7;
/** CPU 告警阈值（全进程 percentCPUUsage 之和，单核口径）。 */
const CPU_ALERT_PERCENT = 30;
/** 连续多少个采样点超过阈值才算告警（3 × 10s = 30s）。 */
const CPU_ALERT_SAMPLES = 3;
/** 渲染进程崩溃后自动 reload 的最小间隔，避免崩溃循环。 */
const CRASH_RELOAD_WINDOW_MS = 5 * 60 * 1000;

function dayStamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 主进程自己的堆数据用 Node 口径，和 webContents 的 workingSetSize 互补。 */
function mainMemory() {
  try {
    const usage = process.memoryUsage();
    return {
      rssMB: Math.round(usage.rss / 1048576),
      heapUsedMB: Math.round(usage.heapUsed / 1048576),
      heapTotalMB: Math.round(usage.heapTotal / 1048576),
      externalMB: Math.round(usage.external / 1048576),
    };
  } catch {
    return null;
  }
}

function createPerfMonitor({ app, dir, isEnabled, log = console }) {
  const ring = [];
  const pending = [];
  let sampleTimer = null;
  let flushTimer = null;
  let started = false;
  let cpuStreak = 0;
  let lastReloadAt = 0;
  let lastSampleAt = Date.now();

  const samplesDir = dir;
  const crashPath = path.join(samplesDir, "crashes.jsonl");

  function enabled() {
    try {
      return typeof isEnabled === "function" ? isEnabled() !== false : true;
    } catch {
      return true;
    }
  }

  /** 启动时清掉过期日志，避免观测数据自己把磁盘吃满。 */
  function pruneOldFiles() {
    try {
      const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
      for (const name of fs.readdirSync(samplesDir)) {
        if (!name.endsWith(".jsonl")) continue;
        const filePath = path.join(samplesDir, name);
        try {
          if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
        } catch {
          // 单个文件失败不影响其它
        }
      }
    } catch {
      // 目录还不存在：第一次 flush 会创建
    }
  }

  async function appendJsonLine(filePath, row) {
    try {
      await fs.promises.mkdir(samplesDir, { recursive: true });
      await fs.promises.appendFile(filePath, `${JSON.stringify(row)}\n`, "utf8");
    } catch (error) {
      log.warn?.("[MeowCode] perf log append failed:", error?.message ?? error);
    }
  }

  function sample() {
    if (!enabled()) return;
    const now = Date.now();
    let procs = [];
    let totalCpu = 0;
    let totalRssMB = 0;
    try {
      const metrics = app.getAppMetrics();
      for (const metric of metrics) {
        const cpu = Number(metric.cpu?.percentCPUUsage ?? 0);
        // workingSetSize 单位是 KB
        const rssMB = Math.round(Number(metric.memory?.workingSetSize ?? 0) / 1024);
        totalCpu += cpu;
        totalRssMB += rssMB;
        procs.push({
          pid: metric.pid,
          type: metric.type ?? "unknown",
          cpu: Math.round(cpu * 10) / 10,
          rssMB,
          ...(metric.name ? { name: metric.name } : {}),
        });
      }
    } catch {
      procs = [];
    }

    if (totalCpu >= CPU_ALERT_PERCENT) {
      cpuStreak += 1;
    } else {
      cpuStreak = 0;
    }

    const row = {
      t: new Date(now).toISOString(),
      // 距上次采样的实际间隔：用它才能把 percentCPUUsage 换算成 CPU 时间
      dt: Math.round((now - lastSampleAt) / 1000),
      cpu: Math.round(totalCpu * 10) / 10,
      rssMB: totalRssMB,
      procs,
      main: mainMemory(),
      ...(cpuStreak >= CPU_ALERT_SAMPLES ? { note: "cpu-high" } : {}),
    };
    lastSampleAt = now;

    ring.push(row);
    if (ring.length > RING_LIMIT) ring.shift();
    pending.push(row);
  }

  async function flush() {
    if (!pending.length) return;
    const rows = pending.splice(0, pending.length);
    const filePath = path.join(samplesDir, `${dayStamp()}.jsonl`);
    try {
      await fs.promises.mkdir(samplesDir, { recursive: true });
      await fs.promises.appendFile(
        filePath,
        rows.map((row) => `${JSON.stringify(row)}\n`).join(""),
        "utf8",
      );
    } catch (error) {
      log.warn?.("[MeowCode] perf log flush failed:", error?.message ?? error);
    }
  }

  function recordCrash(kind, details) {
    const row = {
      t: new Date().toISOString(),
      kind,
      ...details,
    };
    try {
      // 崩溃是低频事件，这里同步写可以接受：保证进程退出前能落盘
      fs.mkdirSync(samplesDir, { recursive: true });
      fs.appendFileSync(crashPath, `${JSON.stringify(row)}\n`, "utf8");
    } catch {
      // 观测失败不影响主流程
    }
    log.warn?.(`[MeowCode] ${kind}:`, row);
  }

  function maybeReload(contents, reason) {
    const now = Date.now();
    if (now - lastReloadAt < CRASH_RELOAD_WINDOW_MS) return;
    lastReloadAt = now;
    recordCrash("renderer-reload", { reason: reason ?? "gone" });
    try {
      contents.reload();
    } catch {
      // 已销毁
    }
  }

  function installHandlers() {
    app.on("render-process-gone", (_event, contents, details) => {
      recordCrash("render-process-gone", {
        reason: details?.reason,
        exitCode: details?.exitCode,
        pid: contents?.getOSProcessId?.(),
      });
      // 只有异常退出才尝试恢复；正常退出（窗口关闭）不能 reload
      if (details?.reason && details.reason !== "clean-exit") {
        maybeReload(contents, details.reason);
      }
    });

    app.on("child-process-gone", (_event, details) => {
      recordCrash("child-process-gone", {
        type: details?.type,
        reason: details?.reason,
        exitCode: details?.exitCode,
        serviceName: details?.serviceName,
        name: details?.name,
      });
    });

    app.on("web-contents-created", (_event, contents) => {
      contents.on("unresponsive", () => {
        recordCrash("unresponsive", { pid: contents.getOSProcessId?.() });
      });
    });
  }

  function start() {
    if (started) return;
    started = true;
    lastSampleAt = Date.now();
    pruneOldFiles();
    installHandlers();
    sampleTimer = setInterval(sample, SAMPLE_INTERVAL_MS);
    sampleTimer.unref?.();
    flushTimer = setInterval(() => {
      void flush();
    }, FLUSH_INTERVAL_MS);
    flushTimer.unref?.();
  }

  async function stop() {
    if (sampleTimer) {
      clearInterval(sampleTimer);
      sampleTimer = null;
    }
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    started = false;
    await flush();
  }

  return {
    start,
    stop,
    sample,
    flush,
    /** 供未来的「进程资源管理器」面板读取；返回副本，调用方改不到内部状态。 */
    snapshot: () => ring.slice(),
    logPath: samplesDir,
  };
}

module.exports = { createPerfMonitor };
