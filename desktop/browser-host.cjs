/**
 * 内嵌浏览器控制桥（主进程）：agent 的 browser_* 工具通过本地 HTTP 调这里，
 * 由主进程直接驱动渲染器里那个「agent 专属浏览器页签」的 guest webContents。
 *
 * 链路：agent server(子进程) --HTTP(token)--> 本桥 --IPC--> 渲染器(建页签/激活)
 *                                      └--直接操作 guest: loadURL/executeJavaScript/sendInputEvent/capturePage
 *
 * 借鉴 metis-main/desktop/browser-host.cjs，简化为单页签、8 个操作：
 * navigate / snapshot / click / type / screenshot / back / reload / shrink_image
 * （shrink_image 不碰页签：超限图片在主进程里用 nativeImage 缩图）。
 * 只监听 127.0.0.1 随机端口 + token 头校验。
 */
const http = require("node:http");
const { randomBytes } = require("node:crypto");
const { webContents, nativeImage } = require("electron");

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
const BIND_TIMEOUT_MS = 15_000;
const SCREENSHOT_MAX_WIDTH = 1280;
/** base64 上限 ~2.5MB，防止超大截图打爆 HTTP/IPC */
const SCREENSHOT_MAX_BASE64 = 2_500_000;

const ALLOWED_REMOTE = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isAllowedTarget(url) {
  return /^https?:\/\//i.test(url) || url === "about:blank";
}

function createBrowserHostController(options = {}) {
  const getMainWindow = options.getMainWindow;
  const token = options.token || randomBytes(24).toString("hex");
  let server = null;
  let baseUrl = "";
  /** agent 专属浏览器页签（单例）：{ tabId, webContentsId } */
  let agentTab = null;
  /** 等渲染器建页签并回报绑定：{ resolve, timer } */
  let pendingBind = null;

  function sendToRenderer(channel, payload) {
    const win = getMainWindow();
    if (!win || (typeof win.isDestroyed === "function" && win.isDestroyed())) {
      throw new Error("Desktop window is not available");
    }
    win.webContents.send(channel, payload);
  }

  /** 渲染器可能关掉页签或重载窗口，fromId 拿不到活 guest 就返回 null */
  function guestOf() {
    if (!agentTab) return null;
    const guest = webContents.fromId(agentTab.webContentsId);
    return guest && !guest.isDestroyed() ? guest : null;
  }

  function requireGuest() {
    const guest = guestOf();
    if (!guest) {
      throw new Error("浏览器页签未打开，请先用 browser_navigate 打开页面");
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

  /** 渲染器回报 tabId ↔ webContentsId 绑定（浏览器页签 dom-ready 时触发） */
  function bindTab(payload) {
    const tabId = typeof payload?.tabId === "string" ? payload.tabId : "";
    const webContentsId = Number(payload?.webContentsId);
    if (!tabId || !Number.isFinite(webContentsId)) {
      return { ok: false };
    }
    agentTab = { tabId, webContentsId };
    if (pendingBind) {
      clearTimeout(pendingBind.timer);
      pendingBind.resolve(agentTab);
      pendingBind = null;
    }
    return { ok: true, tabId };
  }

  function waitForBind() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingBind = null;
        reject(new Error("等待浏览器页签创建超时"));
      }, BIND_TIMEOUT_MS);
      pendingBind = { resolve, timer };
    });
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

  /** 建页签（或复用已验证存在的）并导航；返回页面元信息 */
  async function ensureAgentTab(url) {
    const alive = guestOf();
    if (alive) {
      try {
        sendToRenderer("meow:browser-select-tab", { tabId: agentTab.tabId });
      } catch {
        // 窗口不在（理论上不可能，guest 还活着）；导航继续，激活失败无所谓
      }
      await navigateGuest(alive, url);
      return { ok: true, tabId: agentTab.tabId, ...pageMeta(alive) };
    }
    sendToRenderer("meow:browser-ensure-tab", { requestId: `br-${Date.now()}`, url });
    const bound = await waitForBind();
    agentTab = bound;
    const guest = guestOf();
    if (!guest) throw new Error("浏览器页签创建后未能取得 webview");
    await navigateGuest(guest, url);
    return { ok: true, tabId: bound.tabId, ...pageMeta(guest) };
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
    const image = await guest.capturePage();
    const size = image.getSize();
    const final = size.width > SCREENSHOT_MAX_WIDTH ? image.resize({ width: SCREENSHOT_MAX_WIDTH }) : image;
    const base64 = final.toPNG().toString("base64");
    if (base64.length > SCREENSHOT_MAX_BASE64) {
      return { ok: false, error: "截图过大，请缩小页面内容或窗口后重试" };
    }
    return {
      ok: true,
      screenshotBase64: base64,
      mimeType: "image/png",
      ...pageMeta(guest),
      viewportWidth: size.width,
      viewportHeight: size.height,
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

  function start() {
    if (server) return Promise.resolve({ baseUrl, token });
    return new Promise((resolve, reject) => {
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
    if (pendingBind) {
      clearTimeout(pendingBind.timer);
      pendingBind = null;
    }
    agentTab = null;
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
    bindTab,
    handleCommand,
    get baseUrl() {
      return baseUrl;
    },
    get token() {
      return token;
    },
  };
}

module.exports = { createBrowserHostController, SNAPSHOT_SCRIPT };
