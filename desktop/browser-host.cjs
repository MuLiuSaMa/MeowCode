/**
 * 浏览器控制桥（主进程）：agent 的 browser_* 工具通过本地 HTTP 调这里。
 *
 * agent 用一个「静默浏览器」：懒建的隐藏 BrowserWindow + 固定视口（AGENT_VIEWPORT），
 * 不挂在右侧面板里 —— 面板大小、面板开不开都不影响 agent 的页面布局和截图尺寸。
 * 链路：agent server(子进程) --HTTP(token)--> 本桥 --> 隐藏窗口的 webContents
 *                                             (loadURL / executeJavaScript / sendInputEvent / capturePage)
 *
 * 9 个操作：navigate / preview / snapshot / click / type / screenshot / back / reload / shrink_image
 * （shrink_image 不碰窗口：超限图片在主进程里用 nativeImage 缩图）。
 * 只监听 127.0.0.1 随机端口 + token 头校验。
 *
 * preview 服务「页面样式」：模型直接把 HTML 源码交给这个桥，它落在系统临时目录
 * （SCRATCH_ROOT，启动与退出各清空一次，不碰用户仓库），页面只活在隐藏窗口里，界面上不弹浏览器。
 * 传工作区里的 HTML 路径也行，这时同一路径段下的相对资源（css / js / 图片）一并加载。
 */
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { BrowserWindow, nativeImage } = require("electron");

const fsp = fs.promises;

/** agent 专属浏览器的固定视口：不跟右侧面板走，截图尺寸稳定 */
const AGENT_VIEWPORT = { width: 1280, height: 900 };

/** 快照脚本：只收可见的可交互元素（最多 200 个，文本截 120 字），ref 存 DOM 属性上（导航自动失效） */
const SNAPSHOT_SCRIPT = String.raw`(() => {
  const selector = 'a[href], button, input, textarea, select, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="textbox"], [role="combobox"], [role="menuitem"], [onclick], [tabindex]:not([tabindex="-1"]), canvas, video';
  const elements = Array.from(document.querySelectorAll(selector)).filter((el) => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }).slice(0, 200);
  document.querySelectorAll('[data-meow-ref]').forEach((el) => el.removeAttribute('data-meow-ref'));
  const nodes = elements.map((el, index) => {
    const ref = 'e' + index;
    el.setAttribute('data-meow-ref', ref);
    const rect = el.getBoundingClientRect();
    const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    return {
      ref,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || undefined,
      type: el.getAttribute('type') || undefined,
      name: text || undefined,
      value: typeof el.value === 'string' ? el.value.slice(0, 80) : undefined,
      href: el.tagName === 'A' ? el.href : undefined,
      box: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  });
  return {
    url: location.href,
    title: document.title,
    nodes,
    viewportWidth: Math.round(window.innerWidth || 0),
    viewportHeight: Math.round(window.innerHeight || 0),
  };
})()`;

const NAV_TIMEOUT_MS = 20_000;
const OP_TIMEOUT_MS = 30_000;
const SCREENSHOT_MAX_WIDTH = 1280;
/** base64 上限 ~2.5MB，防止超大截图打爆 HTTP/IPC */
const SCREENSHOT_MAX_BASE64 = 2_500_000;

const ALLOWED_REMOTE = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** 预览页面的 MIME：只按扩展名给，认不出的按二进制流 */
const PREVIEW_MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
};

function isAllowedTarget(url) {
  return /^https?:\/\//i.test(url) || url === "about:blank";
}

/** 临时预览目录：页面样式的 HTML 写这里，用完（启动 / 退出）自动清空，不写进用户仓库 */
const SCRATCH_ROOT = path.join(os.tmpdir(), "meowcode-previews");
let scratchSeq = 0;

/** 清空临时预览目录；目录不存在时什么都不做 */
function cleanScratch() {
  try {
    for (const name of fs.readdirSync(SCRATCH_ROOT)) {
      fs.rmSync(path.join(SCRATCH_ROOT, name), { recursive: true, force: true });
    }
  } catch {
    // 目录还不存在
  }
}

/** 把 HTML 写进临时预览目录并返回文件名（name 只用来给文件起个好认的名字） */
function writeScratchHtml(html, name) {
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  const slug =
    String(name || "page")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "page";
  scratchSeq += 1;
  const file = `${slug}-${scratchSeq}.html`;
  fs.writeFileSync(path.join(SCRATCH_ROOT, file), html, "utf8");
  return file;
}

function createBrowserHostController(options = {}) {
  /** 预览根目录（桌面端传当前工作区）：relative 路径都从这里解析 */
  const getWorkspaceRoot = options.getWorkspaceRoot;
  /** 预览路径里的随机段：不知道它就取不到工作区文件 */
  const previewToken = randomBytes(16).toString("hex");
  const token = options.token || randomBytes(24).toString("hex");
  let server = null;
  let baseUrl = "";
  /** agent 的静默浏览器：隐藏窗口 + 固定视口（AGENT_VIEWPORT），界面上看不到也碰不到 */
  let agentWindow = null;

  /** 隐藏窗口没建 / 被关掉时返回 null */
  function guestOf() {
    if (!agentWindow || agentWindow.isDestroyed()) return null;
    const guest = agentWindow.webContents;
    return guest && !guest.isDestroyed() ? guest : null;
  }

  /** 懒建隐藏窗口：第一次用到浏览器工具时才起，避免应用启动就多一个 Chromium 窗口 */
  function ensureAgentWindow() {
    const alive = guestOf();
    if (alive) return alive;
    agentWindow = new BrowserWindow({
      show: false,
      useContentSize: true,
      width: AGENT_VIEWPORT.width,
      height: AGENT_VIEWPORT.height,
      skipTaskbar: true,
      webPreferences: {
        // 隐藏窗口默认会被降频：定时器/动画停住，截图就是过期的画面
        backgroundThrottling: false,
        partition: "persist:meow-browser-agent",
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // 窗口边框会让 width/height 略偏：按内容区再钉一次，视口才是稳定的 1280x900
    agentWindow.setContentSize(AGENT_VIEWPORT.width, AGENT_VIEWPORT.height);
    agentWindow.on("closed", () => {
      agentWindow = null;
    });
    return agentWindow.webContents;
  }

  function requireGuest() {
    const guest = guestOf();
    if (!guest) {
      throw new Error("浏览器尚未打开，请先用 browser_navigate 打开页面");
    }
    return guest;
  }

  function pageMeta(guest) {
    let url = "";
    let title = "";
    try {
      url = guest.getURL();
    } catch {
      // guest 已销毁
    }
    try {
      title = guest.getTitle();
    } catch {
      // guest 已销毁
    }
    return { url, title };
  }

  /** 工作区根目录：每次现取，桌面端切换工作区后预览也跟着走 */
  function workspaceRoot() {
    const root = typeof getWorkspaceRoot === "function" ? getWorkspaceRoot() : "";
    return typeof root === "string" ? root.trim() : "";
  }

  /** 相对路径 → root 内的绝对路径；越界返回 null */
  function resolveUnder(root, relative) {
    if (!root || !relative) return null;
    const base = path.resolve(root);
    const target = path.resolve(base, relative);
    if (target !== base && !target.startsWith(`${base}${path.sep}`)) return null;
    return target;
  }

  /** 工作区里的绝对路径 */
  function resolveInWorkspace(relative) {
    return resolveUnder(workspaceRoot(), relative);
  }

  /** 临时预览目录里的绝对路径 */
  function resolveScratch(relative) {
    return resolveUnder(SCRATCH_ROOT, relative);
  }

  /** 相对路径 → 静态预览地址（越界或根缺失时返回 null） */
  function staticUrl(prefix, relative, resolve) {
    if (!baseUrl || !resolve(relative)) return null;
    const encoded = relative
      .split(/[\\/]+/)
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `${baseUrl}${prefix}/${previewToken}/${encoded}`;
  }

  /** 工作区文件的预览地址：同前缀下的相对资源（css/js/图片）也能加载 */
  function previewUrl(relative) {
    return staticUrl("/preview", relative, resolveInWorkspace);
  }

  /** 临时预览文件的地址 */
  function scratchUrl(file) {
    return staticUrl("/scratch", file, resolveScratch);
  }

  /** 静态预览：只读指定根内的文件，路径穿越与目录一律拒绝 */
  async function serveStatic(root, req, res, prefix) {
    const rawPath = String(req.url || "").split("?")[0];
    const sendText = (status, text) => {
      res.writeHead(status, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(text);
    };
    if (!rawPath.startsWith(prefix)) {
      sendText(404, "not found");
      return;
    }
    let relative;
    try {
      relative = decodeURIComponent(rawPath.slice(prefix.length));
    } catch {
      sendText(400, "bad path");
      return;
    }
    const target = resolveUnder(root, relative);
    if (!target) {
      sendText(403, "forbidden");
      return;
    }
    try {
      const info = await fsp.stat(target);
      if (!info.isFile()) {
        sendText(404, "not a file");
        return;
      }
      const body = await fsp.readFile(target);
      res.writeHead(200, {
        "content-type": PREVIEW_MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
        "content-length": body.byteLength,
        "cache-control": "no-store",
      });
      res.end(body);
    } catch {
      sendText(404, "not found");
    }
  }

  function loadAndWait(guest, url) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        guest.removeListener("did-finish-load", finish);
        guest.removeListener("did-fail-load", fail);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("页面加载超时"));
      }, NAV_TIMEOUT_MS);
      const finish = () => {
        cleanup();
        resolve();
      };
      const fail = (_event, code, desc, _validated, isMainFrame) => {
        if (isMainFrame === false) return; // 子框架失败不算
        cleanup();
        if (code === -3) {
          // ERR_ABORTED：被后续导航/重定向取代，按成功处理
          resolve();
          return;
        }
        reject(new Error(`${desc || "页面加载失败"} (${code})`));
      };
      guest.once("did-finish-load", finish);
      guest.on("did-fail-load", fail);
      guest.loadURL(url).catch((error) => {
        cleanup();
        reject(error);
      });
    });
  }

  async function navigateGuest(guest, url) {
    let current = "";
    try {
      current = guest.getURL();
    } catch {
      // guest 已销毁
    }
    const loading = typeof guest.isLoading === "function" && guest.isLoading();
    if (current === url) {
      // 新建页签的初始 src 已经在加载同地址：等它完成即可，避免二次加载
      if (loading) await waitForLoadBare(guest, NAV_TIMEOUT_MS);
      return;
    }
    await loadAndWait(guest, url);
  }

  /** 等当前加载完成（不再触发 loadURL），超时容忍 */
  function waitForLoadBare(guest, timeoutMs) {
    return new Promise((resolve) => {
      if (typeof guest.isLoading === "function" && !guest.isLoading()) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        guest.removeListener("did-finish-load", finish);
        guest.removeListener("did-fail-load", finish);
      };
      const finish = () => {
        cleanup();
        resolve();
      };
      guest.once("did-finish-load", finish);
      guest.once("did-fail-load", finish);
    });
  }

  /** 在隐藏窗口里打开页面并等加载完；返回页面元信息 */
  async function ensureAgentTab(url) {
    const guest = ensureAgentWindow();
    await navigateGuest(guest, url);
    return { ok: true, ...pageMeta(guest) };
  }

  function sendInputEventSafely(guest, events) {
    try {
      if (typeof guest.sendInputEvent !== "function") return false;
      for (const event of events) guest.sendInputEvent(event);
      return true;
    } catch {
      return false;
    }
  }

  function buildSnapshotText(data) {
    const lines = [];
    lines.push(`url: ${data.url}`);
    lines.push(`title: ${data.title}`);
    lines.push(`viewport: ${data.viewportWidth}x${data.viewportHeight}`);
    if (!data.nodes?.length) {
      lines.push("(no visible interactive elements found)");
      return lines.join("\n");
    }
    for (const node of data.nodes) {
      const parts = [`[${node.ref}]`, `<${node.tag}${node.type ? ` type=${node.type}` : ""}>`];
      if (node.role) parts.push(`role=${node.role}`);
      if (node.name) parts.push(JSON.stringify(node.name));
      if (node.href) parts.push(`href=${node.href}`);
      if (typeof node.value === "string" && node.value) parts.push(`value=${JSON.stringify(node.value)}`);
      parts.push(`@${node.box.x},${node.box.y} ${node.box.width}x${node.box.height}`);
      lines.push(parts.join(" "));
    }
    return lines.join("\n");
  }

  async function snapshot() {
    const guest = requireGuest();
    const data = await guest.executeJavaScript(SNAPSHOT_SCRIPT, true);
    return {
      ok: true,
      url: data.url,
      title: data.title,
      snapshot: buildSnapshotText(data),
      viewportWidth: data.viewportWidth,
      viewportHeight: data.viewportHeight,
    };
  }

  async function click(ref) {
    const name = String(ref || "");
    if (!/^e\d+$/.test(name)) {
      return { ok: false, error: "ref 无效：应传快照返回的 eN 形式的编号" };
    }
    const guest = requireGuest();
    const selector = `[data-meow-ref="${name}"]`;
    const box = await guest.executeJavaScript(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: "center", inline: "center" });
        const rect = el.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      })()`,
      true,
    );
    if (!box) {
      return { ok: false, error: `找不到元素 ${name}（页面可能已变化），请重新 browser_snapshot` };
    }
    const sent = sendInputEventSafely(guest, [
      { type: "mouseMove", x: box.x, y: box.y },
      { type: "mouseDown", x: box.x, y: box.y, button: "left", clickCount: 1 },
      { type: "mouseUp", x: box.x, y: box.y, button: "left", clickCount: 1 },
    ]);
    if (!sent) {
      // 回退：非可信点击（普通 DOM 有效；canvas/pointer-lock 类页面需要可信输入）
      await guest.executeJavaScript(
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (el) el.click();
          return true;
        })()`,
        true,
      );
    }
    // 点击可能触发导航，给页面一点时间（不阻塞过久）
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { ok: true, ...pageMeta(guest), clicked: name, trusted: sent };
  }

  async function typeText(command) {
    const guest = requireGuest();
    const ref = typeof command.ref === "string" && command.ref ? command.ref : "";
    if (ref && !/^e\d+$/.test(ref)) {
      return { ok: false, error: "ref 无效：应传快照返回的 eN 形式的编号" };
    }
    const text = String(command.text ?? "");
    const selector = ref ? `[data-meow-ref="${ref}"]` : null;
    const result = await guest.executeJavaScript(
      `(() => {
        const el = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : "document.activeElement"};
        if (!el) {
          return { ok: false, error: ${selector ? "'找不到 ref 对应的元素，请重新 browser_snapshot'" : "'页面上没有聚焦的元素，请提供 ref'"} };
        }
        el.focus();
        if ("value" in el) {
          el.value = (el.value || "") + ${JSON.stringify(text)};
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (el.isContentEditable) {
          el.textContent = (el.textContent || "") + ${JSON.stringify(text)};
          el.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          return { ok: false, error: "目标元素不可输入" };
        }
        return { ok: true };
      })()`,
      true,
    );
    if (!result?.ok) {
      return { ok: false, error: result?.error || "输入失败" };
    }
    if (command.submit) {
      sendInputEventSafely(guest, [
        { type: "keyDown", keyCode: "Enter" },
        { type: "char", keyCode: "Enter" },
        { type: "keyUp", keyCode: "Enter" },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return { ok: true, ...pageMeta(guest), typed: text, ...(command.submit ? { submitted: true } : {}) };
  }

  async function screenshot() {
    const guest = requireGuest();
    let image = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        image = await guest.capturePage();
        break;
      } catch (error) {
        // 隐藏窗口第一次合成常常还没出帧（UnknownVizError）：等一帧再重试
        if (attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
    }
    const size = image.getSize();
    const final = size.width > SCREENSHOT_MAX_WIDTH ? image.resize({ width: SCREENSHOT_MAX_WIDTH }) : image;
    const base64 = final.toPNG().toString("base64");
    if (base64.length > SCREENSHOT_MAX_BASE64) {
      return { ok: false, error: "截图过大，请缩小页面内容或窗口后重试" };
    }
    // 报缩放后的尺寸：模型拿到的是这张图，不是原始 device-pixel 大小
    const finalSize = final.getSize();
    return {
      ok: true,
      screenshotBase64: base64,
      mimeType: "image/png",
      ...pageMeta(guest),
      viewportWidth: finalSize.width,
      viewportHeight: finalSize.height,
    };
  }

  /** 图片缩放默认目标：边长 1568（视觉 token 计费在 ~1.5K 边长后收益骤减） */
  const IMAGE_SHRINK_MAX_EDGE = 1568;
  const IMAGE_SHRINK_MAX_BYTES = 4 * 1024 * 1024;

  /**
   * 超限图片自动缩图：桌面主进程用 nativeImage 解码（支持 PNG/JPEG/WebP 等），
   * 按 maxEdge 缩边长，体积仍超限就继续降边长/降质量，最多 4 轮。
   * PNG（截图类）保持 PNG 保文字锐度，缩不动（照片类）才转 JPEG。
   */
  async function shrinkImage(command) {
    const filePath = String(command.path || "").trim();
    if (!filePath) return { ok: false, error: "shrink_image requires a path" };
    const maxBytes = Number(command.maxBytes) > 0 ? Number(command.maxBytes) : IMAGE_SHRINK_MAX_BYTES;
    const maxEdge = Number(command.maxEdge) > 0 ? Number(command.maxEdge) : IMAGE_SHRINK_MAX_EDGE;
    let image;
    try {
      image = nativeImage.createFromPath(filePath);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!image || image.isEmpty()) {
      return { ok: false, error: "unsupported or unreadable image" };
    }
    const original = image.getSize();
    const preferPng = /\.png$/i.test(filePath);
    let scale = Math.min(1, maxEdge / Math.max(original.width, original.height));
    const resized = (ratio) =>
      ratio < 1
        ? image.resize({
            width: Math.max(1, Math.round(original.width * ratio)),
            height: Math.max(1, Math.round(original.height * ratio)),
            quality: "good",
          })
        : image;

    let current = resized(scale);
    let asPng = preferPng;
    let quality = 88;
    let encoded = asPng ? current.toPNG() : current.toJPEG(quality);
    let attempts = 0;
    while (encoded.length > maxBytes && attempts < 4) {
      attempts += 1;
      scale *= 0.7;
      current = resized(scale);
      if (!asPng) quality = Math.max(50, quality - 12);
      encoded = asPng ? current.toPNG() : current.toJPEG(quality);
      // PNG 连缩两轮仍超限：多半是照片类内容，转 JPEG 更省
      if (asPng && attempts >= 2 && encoded.length > maxBytes) {
        asPng = false;
        encoded = current.toJPEG(quality);
      }
    }
    if (encoded.length > maxBytes) {
      return { ok: false, error: `still too large after downscale (${encoded.length} bytes)` };
    }
    const final = current.getSize();
    return {
      ok: true,
      data: encoded.toString("base64"),
      mimeType: asPng ? "image/png" : "image/jpeg",
      width: final.width,
      height: final.height,
      bytes: encoded.length,
      originalWidth: original.width,
      originalHeight: original.height,
    };
  }

  async function simpleNav(op) {
    const guest = requireGuest();
    if (op === "back") {
      let canGoBack = true;
      try {
        canGoBack =
          typeof guest.navigationHistory?.canGoBack === "function"
            ? guest.navigationHistory.canGoBack()
            : typeof guest.canGoBack === "function"
              ? guest.canGoBack()
              : true;
      } catch {
        // 保守放行
      }
      if (!canGoBack) {
        return { ok: false, error: "浏览器没有可回退的历史" };
      }
      guest.goBack();
    } else {
      guest.reload();
    }
    // 导航异步，给一点时间并容忍无 did-finish-load 的情况
    await waitForLoadBare(guest, op === "back" ? 8000 : 8000);
    return { ok: true, ...pageMeta(guest) };
  }

  async function handleCommand(command) {
    if (!command || typeof command !== "object" || typeof command.op !== "string") {
      return { ok: false, error: "Invalid browser command" };
    }
    switch (command.op) {
      case "navigate": {
        const url = String(command.url || "").trim();
        if (!isAllowedTarget(url)) {
          return { ok: false, error: "只支持 http(s) 地址或 about:blank" };
        }
        return await ensureAgentTab(url);
      }
      case "preview": {
        const html = typeof command.html === "string" ? command.html : "";
        if (html.trim()) {
          try {
            const file = writeScratchHtml(html, command.name);
            const url = scratchUrl(file);
            if (!url) return { ok: false, error: "预览地址生成失败" };
            return { ...(await ensureAgentTab(url)), preview: file };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, error: `写入临时预览文件失败：${message}` };
          }
        }
        const relative = String(command.path || "").trim();
        if (!relative) return { ok: false, error: "缺少预览文件路径" };
        const target = resolveInWorkspace(relative);
        if (!target) return { ok: false, error: "路径不在工作区内" };
        try {
          const info = await fsp.stat(target);
          if (!info.isFile()) return { ok: false, error: "预览目标是目录，不是文件" };
        } catch {
          return { ok: false, error: `预览文件不存在：${relative}` };
        }
        const url = previewUrl(relative);
        if (!url) return { ok: false, error: "预览地址生成失败" };
        return { ...(await ensureAgentTab(url)), preview: relative };
      }
      case "snapshot":
        return await snapshot();
      case "click":
        return await click(command.ref);
      case "type":
        return await typeText(command);
      case "screenshot":
        return await screenshot();
      case "back":
      case "reload":
        return await simpleNav(command.op);
      case "shrink_image":
        return await shrinkImage(command);
      default:
        return { ok: false, error: `Unsupported browser op: ${command.op}` };
    }
  }

  async function start() {
    if (server) return { baseUrl, token };
    cleanScratch();
    return await new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        const respond = (status, body) => {
          const text = JSON.stringify(body);
          res.writeHead(status, {
            "content-type": "application/json; charset=utf-8",
            "content-length": Buffer.byteLength(text),
          });
          res.end(text);
        };
        const remote = req.socket.remoteAddress || "";
        if (!ALLOWED_REMOTE.has(remote)) {
          respond(403, { ok: false, error: "forbidden" });
          return;
        }
        // 页面预览：只有带随机段前缀的 GET 才走静态文件，其他请求照旧走 JSON 控制面
        const rawUrl = String(req.url || "");
        if (req.method === "GET" && rawUrl.startsWith(`/preview/${previewToken}/`)) {
          void serveStatic(workspaceRoot(), req, res, `/preview/${previewToken}/`);
          return;
        }
        if (req.method === "GET" && rawUrl.startsWith(`/scratch/${previewToken}/`)) {
          void serveStatic(SCRATCH_ROOT, req, res, `/scratch/${previewToken}/`);
          return;
        }
        if (req.method === "GET" && req.url === "/health") {
          respond(200, { ok: true });
          return;
        }
        if (req.method === "POST" && req.url === "/browser/command") {
          if (req.headers["x-meow-browser-token"] !== token) {
            respond(401, { ok: false, error: "invalid token" });
            return;
          }
          let raw = "";
          req.on("data", (chunk) => {
            raw += chunk;
            if (raw.length > 1_000_000) req.destroy();
          });
          req.on("end", async () => {
            let command;
            try {
              command = JSON.parse(raw || "{}");
            } catch {
              respond(400, { ok: false, error: "invalid JSON body" });
              return;
            }
            const run = handleCommand(command).catch((error) => ({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }));
            const guard = new Promise((resolveGuard) => {
              setTimeout(() => resolveGuard({ ok: false, error: "操作超时" }), OP_TIMEOUT_MS);
            });
            respond(200, await Promise.race([run, guard]));
          });
          return;
        }
        respond(404, { ok: false, error: "not found" });
      });
      server.on("error", (error) => {
        server = null;
        reject(error);
      });
      server.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve({ baseUrl, token });
      });
    });
  }

  function stop() {
    cleanScratch();
    if (agentWindow && !agentWindow.isDestroyed()) {
      try {
        agentWindow.destroy();
      } catch {
        // 已销毁
      }
    }
    agentWindow = null;
    if (server) {
      try {
        server.close();
      } catch {
        // 已关闭
      }
      server = null;
      baseUrl = "";
    }
  }

  return {
    start,
    stop,
    handleCommand,
    /** 相对路径 → 预览地址（路径越界或工作区缺失时返回 null） */
    previewUrl,
    get baseUrl() {
      return baseUrl;
    },
    get token() {
      return token;
    },
  };
}

module.exports = { createBrowserHostController, SNAPSHOT_SCRIPT };
