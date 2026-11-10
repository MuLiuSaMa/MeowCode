/**
 * 公告（主进程专用，纯 CJS，便于 main.cjs 直接 require 和单测覆盖）。
 *
 * 数据源：NexBox 数据仓的 notice_meowcode.json（Gitee 直连，国内可访问），
 * 约定与 NexBox 一致：{ version, announce_list: [...] }。
 * 取 announce_list 里第一条 enabled 的公告推给渲染层，显示在标题栏里；
 * 拉取失败 / 文件为空时视为「没有公告」，保留磁盘缓存兜底，绝不打扰启动。
 *
 * 刷新节奏：启动时先读磁盘缓存立即展示，再后台拉取；之后每 3 小时刷新一次。
 * 关闭状态按公告 id 持久化在缓存文件里（主进程落盘，dev/打包版共享），换新 id 才再出现。
 */
const fs = require("node:fs");
const path = require("node:path");

const NOTICE_URL = "https://gitee.com/muliuawa/nexbox/raw/master/notice_meowcode.json";
const REFRESH_MS = 3 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_CONTENT_CHARS = 20_000;

function clip(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** 规范化一条公告（缓存读回与网络解析共用） */
function normalizeNotice(notice) {
  if (!notice || typeof notice !== "object") return null;
  const content = clip(notice.content, MAX_CONTENT_CHARS);
  if (!content) return null;
  const rawUrl = clip(notice.url, 2_000);
  return {
    id: clip(notice.id, 120) || "cached",
    title: clip(notice.title, 200),
    content,
    date: clip(notice.date, 40),
    url: /^https?:\/\//i.test(rawUrl) ? rawUrl : "",
    version: typeof notice.version === "number" ? notice.version : 0,
  };
}

/**
 * 解析公告文件。返回第一条启用公告的展示字段，没有则 null。
 * 字段：id / title / content / date / url（url 只接受 http(s)）。
 */
function parseAnnouncement(rawText) {
  let data;
  try {
    data = JSON.parse(String(rawText ?? ""));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.announce_list)) return null;
  for (const item of data.announce_list) {
    if (!item || typeof item !== "object") continue;
    if (item.enabled === false) continue;
    const content = clip(item.content, MAX_CONTENT_CHARS);
    if (!content) continue;
    const title = clip(item.title, 200);
    const date = clip(item.date, 40);
    const rawUrl = clip(item.url, 2_000);
    const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : "";
    const rawId = clip(item.id, 120);
    const id = rawId || `announcement-${(title || content).slice(0, 32)}`;
    return {
      id,
      title,
      content,
      date,
      url,
      version: typeof data.version === "number" ? data.version : 0,
    };
  }
  return null;
}

/**
 * @param {{
 *   cachePath?: string,
 *   fetchImpl?: typeof fetch,
 *   onUpdate?: (notice: ReturnType<typeof parseAnnouncement>) => void,
 * }} options
 */
function createNoticeController(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const onUpdate = typeof options.onUpdate === "function" ? options.onUpdate : () => {};
  const cachePath = options.cachePath ?? "";
  /** 最新拉到的公告（未过滤关闭状态） */
  let current = null;
  /** 用户点过 × 的公告 id */
  let dismissedId = "";
  /** 上一次推给渲染层的可见公告（null = 没有 / 已关闭） */
  let lastVisible = null;
  let timer = null;
  let started = false;

  function readState() {
    if (!cachePath) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  /** 整体写盘（notice + dismissedId 一起写）：避免两次读改写交错时丢掉关闭状态 */
  function writeState() {
    if (!cachePath) return;
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(
        cachePath,
        JSON.stringify({ notice: current, dismissedId, savedAt: Date.now() }),
        "utf8",
      );
    } catch {
      // 落盘失败不影响公告本身
    }
  }

  function visible() {
    return current && current.id !== dismissedId ? current : null;
  }

  function publish() {
    const next = visible();
    if (JSON.stringify(next) === JSON.stringify(lastVisible)) return;
    lastVisible = next;
    try {
      onUpdate(next);
    } catch {
      // 展示回调异常不阻断后续刷新
    }
  }

  function apply(next, persist) {
    current = next;
    if (persist) writeState();
    publish();
  }

  /** 关闭某条公告：记住 id 落盘并推空；换成新 id 的公告会重新出现 */
  function dismiss(id) {
    const target = clip(id, 120);
    if (!target) return;
    dismissedId = target;
    writeState();
    publish();
  }

  async function fetchNotice() {
    const response = await fetchImpl(NOTICE_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_PAYLOAD_BYTES) throw new Error("announcement payload too large");
    return parseAnnouncement(text);
  }

  async function refresh() {
    try {
      const next = await fetchNotice();
      apply(next, true);
    } catch {
      // 网络/服务端异常：保留当前（或缓存）公告，等下一轮刷新
    } finally {
      schedule();
    }
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
    const state = readState();
    dismissedId = clip(state.dismissedId, 120);
    const cached = normalizeNotice(state.notice);
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
    dismiss,
    get: () => visible(),
  };
}

module.exports = { NOTICE_URL, parseAnnouncement, createNoticeController };
