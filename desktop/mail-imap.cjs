/**
 * IMAP 客户端：文件夹发现、UID 增量同步、正文/附件拉取、已读、移动删除、APPEND。
 * 连接按需建立、用完即断（首版轮询，不保持 IDLE 长连接）。
 */
const fs = require("node:fs");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const { mapFolderRoles, ROLE_KEYS } = require("./mail-folders.cjs");

const APP_VERSION = require("./package.json").version;
const HEADER_FETCH_LIMIT = 200;
const MESSAGE_LIMIT = 500;
const FLAG_SYNC_LIMIT = 100;
const BODY_MAX_BYTES = 25 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 60_000;
// 空闲式 socket 超时挡不住慢速吐数据的服务器：单次同步再加一个墙钟总时限，到点强制断连
const SYNC_DEADLINE_MS = 180_000;

function createClient(account, auth, overrides = {}) {
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure !== false,
    auth: { user: account.email, pass: auth?.password ?? "" },
    clientInfo: { name: "MeowCode", version: APP_VERSION, vendor: "MeowCode" },
    disableAutoIdle: true,
    logger: false,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    tls: { rejectUnauthorized: true, servername: account.imap.host },
    ...overrides,
  });
  // 连接销毁后的异步错误不能让主进程崩掉；操作错误由各 await 捕获
  client.on("error", () => {});
  return client;
}

function classifyMailError(error) {
  const detail = String(error?.message ?? error ?? "");
  const code = String(error?.code ?? "").toUpperCase();
  if (/unsafe login/i.test(detail)) return { code: "unsafe_login", detail };
  if (
    /authentication|auth[\s_-]*failed|invalid credentials|login failed|login denied/i.test(detail) ||
    code.includes("AUTH")
  ) {
    return { code: "auth_failed", detail };
  }
  if (/certificate|self-signed|self signed|altname|CERT_/i.test(detail) || code.includes("CERT")) {
    return { code: "tls_error", detail };
  }
  if (code === "ETIMEDOUT" || code === "CONNECT_TIMEOUT" || /timed? ?out/i.test(detail)) {
    return { code: "timeout", detail };
  }
  if (
    ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH"].includes(code) ||
    /getaddrinfo|econnrefused|econnreset|network/i.test(detail)
  ) {
    return { code: "network_error", detail };
  }
  return { code: "imap_error", detail };
}

function describeFolders(mailboxes, roles) {
  const byPath = new Map(Object.entries(roles).map(([role, path]) => [path, role]));
  return (mailboxes || []).map((mailbox) => ({
    path: mailbox.path,
    name: mailbox.name,
    specialUse: mailbox.specialUse ?? null,
    role: byPath.get(mailbox.path) ?? null,
  }));
}

function addressText(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) => {
      if (!item) return "";
      if (item.name && item.address) return `${item.name} <${item.address}>`;
      return item.address ?? item.name ?? "";
    })
    .filter(Boolean);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 邮件里的 logo/配图常用 cid: 引用内嵌附件；直接把 related 图片转成 data URL，
 * 这样即使远程图片被隐藏，正文内嵌图也能正常显示。
 */
function embedInlineImages(html, attachments) {
  if (!html) return html;
  let budget = 5 * 1024 * 1024;
  let output = html;
  for (const attachment of attachments) {
    const cid = String(attachment?.cid || "").trim().replace(/^<|>$/g, "");
    const content = attachment?.content;
    const type = String(attachment?.contentType || "");
    if (!cid || !Buffer.isBuffer(content) || !/^image\//i.test(type)) continue;
    if (content.length > budget) continue;
    budget -= content.length;
    const dataUrl = `data:${type};base64,${content.toString("base64")}`;
    const variants = new Set([cid, encodeURIComponent(cid), cid.replace(/@/g, "%40")]);
    for (const variant of variants) {
      if (!variant) continue;
      output = output.replace(new RegExp(`cid:${escapeRegExp(variant)}`, "gi"), dataUrl);
    }
  }
  // 没嵌入成功的 cid 图会变成裂图标，直接移除
  return output.replace(/<img\b[^>]*\bsrc\s*=\s*["']cid:[^"']*["'][^>]*>/gi, "");
}

function hasAttachmentParts(node) {
  if (!node || typeof node !== "object") return false;
  const disposition = String(node.disposition ?? "").toLowerCase();
  const filename = node.dispositionParameters && typeof node.dispositionParameters === "object"
    ? node.dispositionParameters.filename
    : "";
  if (disposition === "attachment" || filename) return true;
  return Array.isArray(node.childNodes) && node.childNodes.some(hasAttachmentParts);
}

function toIsoDate(value, fallback = null) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  const stamp = Date.parse(String(value ?? ""));
  if (Number.isFinite(stamp)) return new Date(stamp).toISOString();
  return fallback;
}

function summaryFromFetch(message) {
  const envelope = message.envelope || {};
  const from = Array.isArray(envelope.from) ? envelope.from[0] : null;
  return {
    uid: message.uid,
    messageId: typeof envelope.messageId === "string" ? envelope.messageId : "",
    subject: typeof envelope.subject === "string" ? envelope.subject : "",
    fromName: from?.name ?? "",
    fromAddr: from?.address ?? "",
    to: addressText(envelope.to),
    date: toIsoDate(envelope.date ?? message.internalDate, new Date().toISOString()),
    seen: message.flags instanceof Set ? message.flags.has("\\Seen") : false,
    flagged: message.flags instanceof Set ? message.flags.has("\\Flagged") : false,
    size: Number(message.size) || 0,
    hasAttachments: hasAttachmentParts(message.bodyStructure),
    snippet: "",
  };
}

function growLimitFor(role, grow, cachedCount) {
  if (!grow || !Array.isArray(grow.roles) || !grow.roles.includes(role)) return null;
  const extra = Math.min(200, Math.max(1, Number(grow.extra) || 200));
  return Math.min(MESSAGE_LIMIT, Math.max(cachedCount + extra, HEADER_FETCH_LIMIT));
}

async function syncRole(client, { role, folder, cached, grow }) {
  const mailbox = await client.mailboxOpen(folder, { readOnly: true });
  const uidValidity = Number(mailbox?.uidValidity) || 0;
  const previous = cached && Number(cached.uidValidity) === uidValidity ? cached : null;
  const existing = previous?.messages ?? [];
  const existingByUid = new Map(existing.map((item) => [item.uid, item]));
  const allUids = (await client.search({ all: true }, { uid: true })) || [];
  const alive = new Set(allUids);
  const growLimit = growLimitFor(role, grow, existing.length);

  let targetUids = [];
  let nextLastUid = allUids.length ? allUids.reduce((max, uid) => (uid > max ? uid : max), 0) : 0;
  if (growLimit) {
    targetUids = allUids.slice(-growLimit).filter((uid) => !existingByUid.has(uid));
  } else if (previous && existing.length) {
    const pending = allUids
      .filter((uid) => uid > (Number(previous.lastUid) || 0))
      .filter((uid) => !existingByUid.has(uid))
      .sort((a, b) => a - b);
    // 一次最多补 200 条；没补完就让 lastUid 停在已拉取的位置，下一轮继续，避免漏信
    targetUids = pending.slice(0, HEADER_FETCH_LIMIT);
    if (pending.length > HEADER_FETCH_LIMIT) nextLastUid = targetUids[targetUids.length - 1];
  } else {
    targetUids = allUids.slice(-HEADER_FETCH_LIMIT);
  }

  let added = 0;
  if (targetUids.length) {
    const fetched = await client.fetchAll(
      targetUids,
      { uid: true, envelope: true, flags: true, size: true, bodyStructure: true },
      { uid: true },
    );
    for (const message of fetched) {
      const summary = summaryFromFetch(message);
      const old = existingByUid.get(summary.uid);
      if (old?.snippet) summary.snippet = old.snippet;
      existingByUid.set(summary.uid, summary);
      added += 1;
    }
  }

  const flagUids = [...existingByUid.keys()].sort((a, b) => b - a).slice(0, FLAG_SYNC_LIMIT);
  if (flagUids.length) {
    try {
      const rows = await client.fetchAll(flagUids, { uid: true, flags: true }, { uid: true });
      for (const row of rows) {
        const item = existingByUid.get(row.uid);
        if (!item || !(row.flags instanceof Set)) continue;
        item.seen = row.flags.has("\\Seen");
        item.flagged = row.flags.has("\\Flagged");
      }
    } catch {
      // 标记同步失败不影响已拉到的邮件
    }
  }

  const messages = [...existingByUid.values()]
    .filter((item) => alive.has(item.uid))
    .sort((a, b) => b.uid - a.uid)
    .slice(0, MESSAGE_LIMIT);

  return {
    folder,
    role,
    uidValidity,
    lastUid: nextLastUid,
    messages,
    syncedAt: new Date().toISOString(),
    added,
  };
}

async function testImap(account, auth) {
  const client = createClient(account, auth, { verifyOnly: true, includeMailboxes: true });
  try {
    await client.connect();
    const mailboxes = client.mailboxList ?? [];
    const roles = mapFolderRoles(mailboxes);
    return { ok: true, roles, folders: describeFolders(mailboxes, roles) };
  } catch (error) {
    return { ok: false, ...classifyMailError(error) };
  } finally {
    try {
      await client.logout();
    } catch {
      // verifyOnly 会自动断开
    }
  }
}

async function syncAccount({ account, auth, caches, grow }) {
  const client = createClient(account, auth);
  const result = { ok: true, roles: null, folders: [], caches: {}, warnings: [] };
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    client.close();
  }, SYNC_DEADLINE_MS);
  const deadlineResult = () => ({
    ok: false,
    code: "timeout",
    detail: "sync_deadline",
    roles: null,
    folders: [],
    caches: {},
    warnings: [],
  });
  try {
    await client.connect();
    const mailboxes = await client.list();
    const roles = mapFolderRoles(mailboxes);
    result.roles = roles;
    result.folders = describeFolders(mailboxes, roles);
    for (const role of ROLE_KEYS) {
      if (timedOut) break;
      const folder = roles[role];
      if (!folder) continue;
      try {
        result.caches[role] = await syncRole(client, {
          role,
          folder,
          cached: caches ? caches[role] : null,
          grow,
        });
      } catch (error) {
        result.warnings.push({ role, ...classifyMailError(error) });
      }
    }
    // 超时丢弃部分缓存：lastUid 未推进，下一轮从头增量，不会漏信
    if (timedOut) return deadlineResult();
    result.ok = Object.keys(result.caches).length > 0 || result.warnings.length === 0;
    if (!result.ok) {
      const first = result.warnings[0];
      result.code = first?.code ?? "imap_error";
      result.detail = first?.detail ?? "";
    }
    return result;
  } catch (error) {
    if (timedOut) return deadlineResult();
    return { ok: false, ...classifyMailError(error), roles: null, folders: [], caches: {}, warnings: [] };
  } finally {
    clearTimeout(deadline);
    try {
      if (timedOut) client.close();
      else await client.logout();
    } catch {
      // 连接已断开
    }
  }
}

async function fetchMessage({ account, auth, role, folder, uid, markSeen = true }) {
  const client = createClient(account, auth);
  try {
    await client.connect();
    const open = await client.mailboxOpen(folder, { readOnly: false });
    const uidValidity = Number(open?.uidValidity) || 0;
    const meta = await client.fetchOne(uid, { uid: true, size: true, flags: true }, { uid: true });
    if (!meta) return { ok: false, code: "not_found", detail: "" };
    if ((Number(meta.size) || 0) > BODY_MAX_BYTES) {
      return { ok: false, code: "too_large", detail: `${meta.size} bytes` };
    }
    const fetched = await client.fetchOne(uid, { uid: true, source: true }, { uid: true });
    if (!fetched?.source) return { ok: false, code: "not_found", detail: "" };
    const parsed = await simpleParser(fetched.source);
    const from = parsed.from?.value?.[0];
    const rawAttachments = parsed.attachments || [];
    const attachments = rawAttachments.map((item, index) => ({
      index,
      filename: item.filename || `attachment-${index + 1}`,
      mimeType: item.contentType || "application/octet-stream",
      size: Number(item.size) || item.content?.length || 0,
      contentId: item.cid || null,
      related: Boolean(item.related),
      inline: Boolean(item.cid),
    }));
    const html = embedInlineImages(
      typeof parsed.html === "string" ? parsed.html : null,
      rawAttachments,
    );
    if (markSeen && meta.flags instanceof Set && !meta.flags.has("\\Seen")) {
      try {
        await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
      } catch {
        // 已读回写失败不影响正文展示
      }
    }
    return {
      ok: true,
      message: {
        uid,
        uidValidity,
        role,
        folder,
        messageId: parsed.messageId || "",
        subject: parsed.subject || "",
        from: {
          name: from?.name ?? "",
          address: from?.address ?? "",
        },
        to: addressText(parsed.to?.value),
        cc: addressText(parsed.cc?.value),
        date: toIsoDate(parsed.date, new Date().toISOString()),
        text: parsed.text || "",
        html,
        attachments,
        inReplyTo: parsed.inReplyTo || null,
        references: Array.isArray(parsed.references)
          ? parsed.references.join(" ")
          : parsed.references || null,
      },
    };
  } catch (error) {
    return { ok: false, ...classifyMailError(error) };
  } finally {
    try {
      await client.logout();
    } catch {
      // 连接已断开
    }
  }
}

async function downloadAttachment({ account, auth, folder, uid, index, targetPath }) {
  const client = createClient(account, auth);
  try {
    await client.connect();
    await client.mailboxOpen(folder, { readOnly: true });
    const meta = await client.fetchOne(uid, { uid: true, size: true }, { uid: true });
    if (!meta) return { ok: false, code: "not_found", detail: "" };
    if ((Number(meta.size) || 0) > BODY_MAX_BYTES) {
      return { ok: false, code: "too_large", detail: `${meta.size} bytes` };
    }
    const fetched = await client.fetchOne(uid, { uid: true, source: true }, { uid: true });
    if (!fetched?.source) return { ok: false, code: "not_found", detail: "" };
    const parsed = await simpleParser(fetched.source);
    const attachment = (parsed.attachments || [])[Number(index)];
    if (!attachment) return { ok: false, code: "not_found", detail: "" };
    fs.writeFileSync(targetPath, attachment.content);
    return {
      ok: true,
      path: targetPath,
      filename: attachment.filename || `attachment-${Number(index) + 1}`,
      size: attachment.content?.length || 0,
    };
  } catch (error) {
    return { ok: false, ...classifyMailError(error) };
  } finally {
    try {
      await client.logout();
    } catch {
      // 连接已断开
    }
  }
}

async function setSeen({ account, auth, folder, uids, seen }) {
  const list = (Array.isArray(uids) ? uids : []).map(Number).filter(Number.isFinite);
  if (!list.length) return { ok: true };
  const client = createClient(account, auth);
  try {
    await client.connect();
    await client.mailboxOpen(folder, { readOnly: false });
    if (seen) await client.messageFlagsAdd(list, ["\\Seen"], { uid: true });
    else await client.messageFlagsRemove(list, ["\\Seen"], { uid: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, ...classifyMailError(error) };
  } finally {
    try {
      await client.logout();
    } catch {
      // 连接已断开
    }
  }
}

async function deleteMessage({ account, auth, folder, role, uid, trashPath }) {
  const client = createClient(account, auth);
  try {
    await client.connect();
    await client.mailboxOpen(folder, { readOnly: false });
    if (role === "trash" || !trashPath) {
      await client.messageDelete(uid, { uid: true });
      try {
        await client.mailboxClose();
      } catch {
        // CLOSE 失败时消息已带 \Deleted，连接断开后由服务端按策略回收
      }
      return { ok: true, permanent: true };
    }
    try {
      const moved = await client.messageMove(uid, trashPath, { uid: true });
      if (!moved) throw new Error("move failed");
    } catch {
      await client.messageCopy(uid, trashPath, { uid: true });
      await client.messageDelete(uid, { uid: true });
      try {
        await client.mailboxClose();
      } catch {
        // 同上
      }
    }
    return { ok: true, permanent: false };
  } catch (error) {
    return { ok: false, ...classifyMailError(error) };
  } finally {
    try {
      await client.logout();
    } catch {
      // 连接已断开
    }
  }
}

async function appendMessage({ account, auth, folder, raw }) {
  const client = createClient(account, auth);
  try {
    await client.connect();
    const result = await client.append(folder, raw, ["\\Seen"]);
    return { ok: Boolean(result), uid: result?.uid ?? null };
  } catch (error) {
    return { ok: false, ...classifyMailError(error) };
  } finally {
    try {
      await client.logout();
    } catch {
      // 连接已断开
    }
  }
}

module.exports = {
  createClient,
  classifyMailError,
  describeFolders,
  testImap,
  syncAccount,
  fetchMessage,
  downloadAttachment,
  setSeen,
  deleteMessage,
  appendMessage,
  embedInlineImages,
  BODY_MAX_BYTES,
};
