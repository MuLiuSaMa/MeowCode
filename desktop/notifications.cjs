/**
 * 系统通知的纯逻辑（不依赖 Electron，方便单测）。
 * main.cjs 只负责拿事件、判断窗口是否在前台、调 nativeNotification.show()，
 * 这里决定「弹不弹」「标题/正文写什么」「同一件事会不会重复弹」。
 */

const crypto = require("node:crypto");

/** 通知正文的长度上限：Windows toast 卡片约两行，再长就被截断了。 */
const PREVIEW_MAX = 120;
/** 同一会话的回合结束通知在这个窗口内只弹一次（SSE 重连可能重放）。 */
const TURN_DEDUPE_MS = 3000;

/** 压平空白并截断：AI 回复里的换行、缩进、连续空格在 toast 里都会变成异常留白。 */
function summarize(text, max = PREVIEW_MAX) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return "";
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max).trimEnd()}…`;
}

/**
 * 回合结束的正文：有本轮回复摘要就用摘要，没有（比如纯工具调用的回合）退回状态文案。
 * status 来自 turn_complete 事件的 status 字段。
 */
function describeTurn({ status, preview, labels }) {
  const summary = summarize(preview);
  if (summary) return summary;
  if (status === "aborted") return labels?.turnAborted ?? "";
  if (status === "error") return labels?.turnError ?? "";
  return labels?.turnDone ?? "";
}

/**
 * 审批请求的正文：工具名 + 最能说明问题的一行细节。
 * 命令 > 文件路径 > input 里第一个字符串值 > 只有工具名。
 */
function describeApproval({ tool, command, input, labels }) {
  const name = String(tool ?? "").trim();
  const detail = firstMeaningfulDetail(command, input);
  const head = labels?.approval ?? "";
  const parts = [head, name ? `${name}${detail ? ` · ${detail}` : ""}` : detail]
    .filter((part) => String(part ?? "").trim().length > 0)
    .join("：");
  return summarize(parts);
}

function firstMeaningfulDetail(command, input) {
  const direct = typeof command === "string" ? command.trim() : "";
  if (direct) return clip(direct);
  if (!input || typeof input !== "object") return "";
  for (const key of ["command", "cmd", "path", "file_path", "pattern", "url", "query"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return clip(value.trim());
  }
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.trim()) return clip(value.trim());
  }
  return "";
}

function clip(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
}

/**
 * ask_user 通知的正文：第一道题（多题时用 +N 提示还有几道）。
 * 模型挂起等用户点选的场景，和审批一样属于「等你响应」。
 */
function describeAsk({ questions, labels }) {
  const list = Array.isArray(questions) ? questions : [];
  const first = list.find((item) => typeof item?.question === "string" && item.question.trim());
  const head = labels?.ask ?? "";
  const question = summarize(first?.question);
  if (!question) return summarize(head);
  const suffix = list.length > 1 ? ` +${list.length - 1}` : "";
  return summarize(`${head}：${question}${suffix}`);
}

/** 总开关关掉、系统不支持（Linux 无通知守护、Windows 通知被策略禁用）时都不弹。 */
function shouldNotify({ enabled, supported }) {
  return enabled !== false && supported !== false;
}

/** 通知标题：会话标题 → 「未命名会话」兜底。 */
function notificationTitle(title, untitled) {
  const raw = summarize(title, 60);
  return raw || untitled || "MeowCode";
}

/**
 * 去重表。
 * windowMs <= 0：标记常驻，直到显式 release（审批请求：同一个 callId 只提示一次）。
 * windowMs > 0：时间窗内重复的同 key 被拒（回合结束：SSE 重连可能重放）。
 */
function createDedupe({ windowMs = 0, now = Date.now, limit = 200 } = {}) {
  const seen = new Map();
  return {
    /** 返回 true = 第一次见，应当提示 */
    accept(key) {
      if (!key) return true;
      const at = now();
      const previous = seen.get(key);
      if (previous !== undefined) {
        if (windowMs <= 0) return false;
        if (at - previous < windowMs) return false;
        seen.delete(key);
      }
      seen.set(key, at);
      if (seen.size > limit) {
        for (const oldest of [...seen.keys()].slice(0, seen.size - limit)) seen.delete(oldest);
      }
      return true;
    },
    release(key) {
      if (key) seen.delete(key);
    },
    size() {
      return seen.size;
    },
  };
}

/** XML 文本 / 属性转义：标题正文来自会话，必须当作纯文本塞进 toast。 */
function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * 通知 tag：Windows 对 toast tag 长度有限制，会话 id（UUID 36 位）不直接当 tag。
 * 取 sha1 前 16 位做稳定短 tag；真实 sessionId 另放在 arguments 的 sid 里，
 * 这样冷启动（进程里没有路由表）也能还原会话。
 */
function notificationTag(sessionId) {
  const text = String(sessionId ?? "");
  if (!text) return "";
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/**
 * 自定义 Windows toast XML：标题 + 正文 + 图标 + 输入框 + 发送按钮。
 * Electron 的 handleActivation 会解析 arguments 里的 type/tag，
 * 并把输入框内容按 id（reply）放进 details.reply，所以格式必须对齐。
 */
function buildReplyToastXml({
  title,
  body,
  iconUrl,
  tag,
  sessionId,
  placeholder,
  sendLabel,
}) {
  const clickArgs = escapeXml(`type=click&tag=${tag}&sid=${sessionId}`);
  const replyArgs = escapeXml(`type=reply&tag=${tag}&sid=${sessionId}`);
  const image = iconUrl
    ? `<image placement="appLogoOverride" hint-crop="none" src="${escapeXml(iconUrl)}"/>`
    : "";
  // 不用 scenario="reminder"：那样每条通知都会常驻屏幕直到手动关掉。
  // 普通 toast 在用户点进输入框时不会自动收起，错过后也能从通知中心回复。
  return [
    // duration="long"：默认 5 秒对"打开通知再打字"太短，长版约 25 秒
    `<toast launch="${clickArgs}" duration="long">`,
    "<visual>",
    '<binding template="ToastGeneric">',
    `<text>${escapeXml(title)}</text>`,
    `<text>${escapeXml(body)}</text>`,
    image,
    "</binding>",
    "</visual>",
    "<actions>",
    `<input id="reply" type="text" placeHolderContent="${escapeXml(placeholder)}"/>`,
    `<action content="${escapeXml(sendLabel)}" activationType="foreground" arguments="${replyArgs}" hintInputId="reply"/>`,
    "</actions>",
    "</toast>",
  ].join("");
}

/** 解析 Electron 回传的激活参数（key=value&key=value）。 */
function parseActivationArgs(raw) {
  const parsed = {};
  for (const token of String(raw ?? "").split("&")) {
    const index = token.indexOf("=");
    if (index <= 0) continue;
    parsed[token.slice(0, index)] = token.slice(index + 1);
  }
  return parsed;
}

/**
 * 从激活事件里取回复文本：自定义 XML 的输入框内容在 userInputs.reply，
 * 预设模板 / macOS 走 details.reply；两处都没有就是普通点击。
 */
function pickReplyText(details) {
  const direct = typeof details?.reply === "string" ? details.reply : "";
  if (direct) return direct;
  const fromInputs = details?.userInputs?.reply;
  return typeof fromInputs === "string" ? fromInputs : "";
}

/** tag → sessionId 路由：通知被点/回复时据此找回会话，过期自动清掉。 */
function createReplyRoutes({ ttlMs = 6 * 60 * 60 * 1000, limit = 200, now = Date.now } = {}) {
  const routes = new Map();
  return {
    remember(tag, sessionId) {
      if (!tag || !sessionId) return;
      routes.delete(tag);
      routes.set(tag, { sessionId, at: now() });
      if (routes.size > limit) {
        for (const key of [...routes.keys()].slice(0, routes.size - limit)) routes.delete(key);
      }
    },
    resolve(tag) {
      if (!tag) return null;
      const hit = routes.get(tag);
      if (!hit) return null;
      if (now() - hit.at > ttlMs) {
        routes.delete(tag);
        return null;
      }
      return hit.sessionId;
    },
    size() {
      return routes.size;
    },
  };
}

module.exports = {
  PREVIEW_MAX,
  TURN_DEDUPE_MS,
  summarize,
  describeTurn,
  describeApproval,
  describeAsk,
  shouldNotify,
  notificationTitle,
  createDedupe,
  escapeXml,
  notificationTag,
  buildReplyToastXml,
  parseActivationArgs,
  pickReplyText,
  createReplyRoutes,
};
