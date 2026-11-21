/**
 * 赞助者名单（主进程专用，纯 CJS，便于 main.cjs 直接 require 和单测覆盖）。
 *
 * 数据源：NexBox 数据仓的 sponsors.json（Gitee 直连，国内可访问），
 * 约定与 NexBox 一致：{ update_time, list: [{ name, amount }] }。
 * 只取昵称，不展示金额（与关于页现有口径一致）。
 *
 * 刷新节奏：启动先读磁盘缓存立即展示，再后台拉取；之后每 3 小时刷新一次。
 * 关于页打开时会主动请求一次，保证不重装应用也能看到最新名单；
 * 拉取失败保留当前/缓存名单，绝不把已有列表清空。
 */
const fs = require("node:fs");
const path = require("node:path");

const SPONSORS_URL = "https://gitee.com/muliuawa/nexbox/raw/master/sponsors.json";
const REFRESH_MS = 3 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_NAME_CHARS = 80;
const MAX_NAMES = 1_000;

function normalizeSponsors(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.list)) return null;
  const names = [];
  for (const item of data.list) {
    const name =
      item && typeof item.name === "string" ? item.name.trim().slice(0, MAX_NAME_CHARS) : "";
    if (name) names.push(name);
    if (names.length >= MAX_NAMES) break;
  }
  if (!names.length) return null;
  return {
    updateTime: typeof data.update_time === "string" ? data.update_time.trim().slice(0, 40) : "",
    names,
  };
}

/** 缓存读回的是规范化后的形状（updateTime + names），与源文件的 list 形状不同。 */
function normalizeCachedSponsors(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.names)) return null;
  const names = [];
  for (const value of data.names) {
    const name = typeof value === "string" ? value.trim().slice(0, MAX_NAME_CHARS) : "";
    if (name) names.push(name);
    if (names.length >= MAX_NAMES) break;
  }
  if (!names.length) return null;
  return {
    updateTime:
      typeof data.updateTime === "string" ? data.updateTime.trim().slice(0, 40) : "",
    names,
  };
}

/** 解析赞助名单文件；只保留昵称，忽略金额。 */
function parseSponsors(rawText) {
  let data;
  try {
    data = JSON.parse(String(rawText ?? ""));
  } catch {
    return null;
  }
  return normalizeSponsors(data);
}

/**
 * @param {{
 *   cachePath?: string,
 *   fetchImpl?: typeof fetch,
 *   onUpdate?: (sponsors: ReturnType<typeof parseSponsors>) => void,
 * }} options
 */
function createSponsorsController(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const onUpdate = typeof options.onUpdate === "function" ? options.onUpdate : () => {};
  const cachePath = options.cachePath ?? "";
  let current = null;
  let lastPublished = "";
  let timer = null;
  let started = false;

  function readCache() {
    if (!cachePath) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      return normalizeCachedSponsors(parsed && typeof parsed === "object" ? parsed.sponsors : null);
    } catch {
      return null;
    }
  }

  function writeCache() {
    if (!cachePath) return;
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(
        cachePath,
        JSON.stringify({ sponsors: current, savedAt: Date.now() }),
        "utf8",
      );
    } catch {
      // 落盘失败不影响本次展示
    }
  }

  function publish() {
    const next = JSON.stringify(current);
    if (next === lastPublished) return;
    lastPublished = next;
    try {
      onUpdate(current);
    } catch {
      // 展示回调异常不阻断后续刷新
    }
  }

  function apply(next, persist) {
    current = next;
    if (persist) writeCache();
    publish();
  }

  async function fetchSponsors() {
    const response = await fetchImpl(SPONSORS_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_PAYLOAD_BYTES) throw new Error("sponsors payload too large");
    return parseSponsors(text);
  }

  async function refresh() {
    try {
      const next = await fetchSponsors();
      if (next) apply(next, true);
    } catch {
      // 网络/服务端异常：保留当前（或缓存）名单，等下一轮刷新
    } finally {
      schedule();
    }
    return current;
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void refresh();
    }, REFRESH_MS);
    if (typeof timer.unref === "function") timer.unref();
  }

  function start() {
    if (started) return;
    started = true;
    const cached = readCache();
    if (cached) apply(cached, false);
    void refresh();
  }

  function stop() {
    started = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    start,
    stop,
    refresh,
    get: () => current,
  };
}

module.exports = { SPONSORS_URL, parseSponsors, createSponsorsController };
