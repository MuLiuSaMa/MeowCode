/**
 * SMTP 发送：先构建 raw MIME（用于发送与 APPEND 已发送），再走 SMTP 投递。
 * Bcc 只进入 SMTP envelope，不写进 raw 头，避免抄送地址泄露给收件人。
 */
const fs = require("node:fs");
const nodemailer = require("nodemailer");

const CONNECT_TIMEOUT_MS = 15_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 60_000;
// 附件总大小上限（Gmail/多数服务商的常见上限）：raw MIME 全量缓冲，超限会 OOM 主进程
const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

function classifySmtpError(error) {
  const detail = String(error?.message ?? error ?? "");
  const code = String(error?.code ?? "").toUpperCase();
  if (code === "ATTACHMENT_TOO_LARGE") return { code: "attachment_too_large", detail };
  if (/attachment|ENOENT|no such file/i.test(detail) || code === "ENOENT") {
    return { code: "attachment_missing", detail };
  }
  if (/invalid login|authentication|auth[\s_-]*failed|username and password/i.test(detail) || code.includes("AUTH")) {
    // 主进程只给通用错误码，具体是 IMAP 还是 SMTP 由调用方带上
    return { code: "auth_failed", detail };
  }
  if (/certificate|self-signed|self signed|altname|CERT_/i.test(detail) || code.includes("CERT")) {
    return { code: "tls_error", detail };
  }
  if (code === "ETIMEDOUT" || /timed? ?out/i.test(detail)) return { code: "timeout", detail };
  if (
    ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH"].includes(code) ||
    /getaddrinfo|econnrefused|econnreset|network/i.test(detail)
  ) {
    return { code: "network_error", detail };
  }
  return { code: "smtp_error", detail };
}

function createTransport(account, auth) {
  return nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure !== false,
    requireTLS: Boolean(account.smtp.requireTLS),
    auth: { user: account.email, pass: auth?.password ?? "" },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    tls: { rejectUnauthorized: true, servername: account.smtp.host },
  });
}

function normalizeRecipients(value) {
  const parts = Array.isArray(value) ? value : [value];
  return parts
    .flatMap((item) => String(item ?? "").split(/[,;]/))
    .map((item) => item.trim())
    .filter((item) => item.includes("@"));
}

async function buildRawMessage(account, payload) {
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  let totalBytes = 0;
  for (const item of attachments) {
    try {
      totalBytes += (await fs.promises.stat(item.path)).size;
    } catch {
      // 缺失文件交给 nodemailer 报 attachment_missing
    }
    if (totalBytes > ATTACHMENT_MAX_BYTES) {
      throw Object.assign(new Error("attachments exceed 25MB"), { code: "ATTACHMENT_TOO_LARGE" });
    }
  }
  const composer = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: "unix",
  });
  const info = await composer.sendMail({
    from: { name: account.displayName || account.email, address: account.email },
    to: normalizeRecipients(payload.to),
    cc: normalizeRecipients(payload.cc).length ? normalizeRecipients(payload.cc) : undefined,
    subject: payload.subject || "",
    text: typeof payload.text === "string" ? payload.text : "",
    attachments: attachments.map((item) => ({
      filename: item.name || undefined,
      path: item.path,
    })),
    inReplyTo: payload.inReplyTo || undefined,
    references: payload.references || undefined,
    headers: { "X-Mailer": "MeowCode" },
  });
  if (!Buffer.isBuffer(info.message)) throw new Error("raw message build failed");
  return { raw: info.message, messageId: info.messageId || "" };
}

async function testSmtp(account, auth) {
  const transport = createTransport(account, auth);
  try {
    await transport.verify();
    return { ok: true };
  } catch (error) {
    return { ok: false, ...classifySmtpError(error) };
  } finally {
    try {
      transport.close();
    } catch {
      // 已关闭
    }
  }
}

async function sendMail(account, auth, payload) {
  const to = normalizeRecipients(payload.to);
  const cc = normalizeRecipients(payload.cc);
  const bcc = normalizeRecipients(payload.bcc);
  const recipients = [...to, ...cc, ...bcc];
  if (!recipients.length) return { ok: false, code: "no_recipient", detail: "" };
  let built;
  try {
    built = await buildRawMessage(account, payload);
  } catch (error) {
    return { ok: false, ...classifySmtpError(error) };
  }
  const transport = createTransport(account, auth);
  try {
    await transport.sendMail({
      envelope: { from: account.email, to: recipients },
      raw: built.raw,
    });
    return { ok: true, raw: built.raw, messageId: built.messageId };
  } catch (error) {
    return { ok: false, ...classifySmtpError(error) };
  } finally {
    try {
      transport.close();
    } catch {
      // 已关闭
    }
  }
}

module.exports = {
  classifySmtpError,
  testSmtp,
  sendMail,
  buildRawMessage,
};
