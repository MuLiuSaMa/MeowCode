/**
 * 系统通知的纯逻辑（不依赖 Electron，方便单测）。
 * main.cjs 只负责拿事件、判断窗口是否在前台、调 nativeNotification.show()，
 * 这里决定「弹不弹」「标题/正文写什么」「同一件事会不会重复弹」。
 */

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
};
