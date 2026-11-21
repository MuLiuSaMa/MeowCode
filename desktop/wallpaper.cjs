/**
 * 自定义背景的主进程部分：取值归一化 + meow-media:// 协议的响应。
 *
 * 渲染层用 file:// 直链读应用数据目录会被 Chromium 的文件同源策略拦掉（字体那边同理，走的是 data URL），
 * 视频几十上百 MB 又不能 base64，所以这里按 Range 分段返回，媒体元素才能正常起播和拖动进度。
 */

const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");

const WALLPAPER_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};
const WALLPAPER_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "avif"];
const WALLPAPER_VIDEO_EXTENSIONS = ["mp4", "m4v", "webm", "mov"];
const WALLPAPER_KINDS = ["image", "video"];
/** 背景库上限：缩略图网格装得下，也不至于把目录塞爆 */
const WALLPAPER_MAX_ITEMS = 24;
/** 轮播间隔（秒）之间切换 */
const WALLPAPER_CAROUSEL_MIN_SEC = 5;
const WALLPAPER_CAROUSEL_MAX_SEC = 3600;
const WALLPAPER_DEFAULT_TUNING = {
  opacity: 1,
  brightness: 1,
  blur: 0,
  uiOpacity: 0.72,
  carouselEnabled: false,
  carouselIntervalSec: 60,
};

function clampWallpaperNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** 文件名清洗：只留单层 basename，避免路径穿越 */
function cleanFileName(value) {
  const name = typeof value === "string" ? path.basename(value.trim()) : "";
  return name === "." || name === ".." ? "" : name;
}

/**
 * 背景设置的唯一入口：渲染层传什么都要从这里过一遍。
 *
 * 结构是「背景库 + 当前选中 + 轮播」：
 *   { items: [{kind, fileName}], active, enabled, opacity, brightness, blur, uiOpacity, carousel: {enabled, intervalSec} }
 * 旧版本只有单个 {kind, fileName}，这里顺手迁移成一项的库。
 */
function normalizeWallpaper(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw;
  const items = [];
  const seen = new Set();
  const push = (kind, fileName) => {
    if (!WALLPAPER_KINDS.includes(kind)) return;
    const name = cleanFileName(fileName);
    if (!name || seen.has(name)) return;
    if (items.length >= WALLPAPER_MAX_ITEMS) return;
    seen.add(name);
    items.push({ kind, fileName: name });
  };
  if (Array.isArray(source.items)) {
    for (const item of source.items) {
      if (!item || typeof item !== "object") continue;
      push(item.kind, item.fileName);
    }
  } else {
    // 旧格式：单张背景
    push(source.kind, source.fileName);
  }
  if (!items.length) return null;
  const requested = typeof source.active === "string" ? cleanFileName(source.active) : "";
  const active = items.some((item) => item.fileName === requested)
    ? requested
    : items[0].fileName;
  const carousel = source.carousel && typeof source.carousel === "object" ? source.carousel : {};
  return {
    items,
    active,
    // 关掉 = 保留背景库但不显示（渲染层照样能选、能调）
    enabled: source.enabled !== false,
    opacity: clampWallpaperNumber(source.opacity, 0.05, 1, WALLPAPER_DEFAULT_TUNING.opacity),
    brightness: clampWallpaperNumber(
      source.brightness,
      0.2,
      2,
      WALLPAPER_DEFAULT_TUNING.brightness,
    ),
    blur: clampWallpaperNumber(source.blur, 0, 40, WALLPAPER_DEFAULT_TUNING.blur),
    uiOpacity: clampWallpaperNumber(source.uiOpacity, 0.2, 1, WALLPAPER_DEFAULT_TUNING.uiOpacity),
    // 视频背景默认静音：自动播放带声音会被拦，也让用户先看到画面再决定开不开
    videoSound: source.videoSound === true,
    carousel: {
      enabled: carousel.enabled === true,
      intervalSec: Math.round(
        clampWallpaperNumber(
          carousel.intervalSec,
          WALLPAPER_CAROUSEL_MIN_SEC,
          WALLPAPER_CAROUSEL_MAX_SEC,
          WALLPAPER_DEFAULT_TUNING.carouselIntervalSec,
        ),
      ),
    },
  };
}

/** 只认目录内的单层文件名：协议请求和 settings 里的 fileName 都从这里过一遍 */
function wallpaperFile(dir, name) {
  const base = cleanFileName(name);
  if (!base) return "";
  return path.join(dir, base);
}

/** 解析 Range 头：返回 null 表示整文件，返回 "invalid" 表示客户端要的范围不可满足 */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!match) return null;
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return "invalid";
  }
  return { start, end };
}

/** 协议请求来自 http（dev server）或 file（打包后）页面，一律放开 CORS */
const WALLPAPER_CORS = { "access-control-allow-origin": "*" };

function wallpaperResponse({ dir, request }) {
  try {
    return wallpaperResponseUnsafe({ dir, request });
  } catch {
    // 解码失败 / 权限不足：一律当成找不到，别把异常抛给协议层
    return new Response("Not found", { status: 404, headers: WALLPAPER_CORS });
  }
}

function wallpaperResponseUnsafe({ dir, request }) {
  const url = new URL(request.url);
  if (url.hostname !== "wallpaper") return new Response("Not found", { status: 404 });
  const file = wallpaperFile(dir, decodeURIComponent(url.pathname.replace(/^\/+/, "")));
  const stat = file ? fs.statSync(file, { throwIfNoEntry: false }) : null;
  if (!file || !stat || !stat.isFile()) {
    return new Response("Not found", { status: 404, headers: WALLPAPER_CORS });
  }
  const type = WALLPAPER_MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  // 首帧缩略图文件名固定、内容不可变：允许长期缓存，启动预热和背景切换才能命中
  const cacheControl = file.toLowerCase().endsWith(".thumb.jpg")
    ? "public, max-age=31536000, immutable"
    : "no-store";
  const range = parseRange(request.headers.get("range"), stat.size);
  if (range === "invalid") {
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${stat.size}`, "accept-ranges": "bytes", ...WALLPAPER_CORS },
    });
  }
  if (range) {
    return new Response(Readable.toWeb(fs.createReadStream(file, { start: range.start, end: range.end })), {
      status: 206,
      headers: {
        "content-type": type,
        "content-length": String(range.end - range.start + 1),
        "content-range": `bytes ${range.start}-${range.end}/${stat.size}`,
        "accept-ranges": "bytes",
        "cache-control": cacheControl,
        ...WALLPAPER_CORS,
      },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), {
    status: 200,
    headers: {
      "content-type": type,
      "content-length": String(stat.size),
      "accept-ranges": "bytes",
      "cache-control": cacheControl,
      ...WALLPAPER_CORS,
    },
  });
}

/** 在 Electron 主进程里挂上 meow-media 协议（scheme 必须在 app ready 之前登记为 privileged） */
function registerWallpaperProtocol({ protocol, dir }) {
  protocol.handle("meow-media", (request) => wallpaperResponse({ dir, request }));
}

module.exports = {
  WALLPAPER_MIME,
  WALLPAPER_IMAGE_EXTENSIONS,
  WALLPAPER_VIDEO_EXTENSIONS,
  WALLPAPER_DEFAULT_TUNING,
  WALLPAPER_MAX_ITEMS,
  WALLPAPER_CAROUSEL_MIN_SEC,
  WALLPAPER_CAROUSEL_MAX_SEC,
  normalizeWallpaper,
  wallpaperFile,
  wallpaperResponse,
  registerWallpaperProtocol,
};
