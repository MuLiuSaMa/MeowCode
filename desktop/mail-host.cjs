/**
 * 邮件主进程编排：IPC、同步心跳、每账户互斥与退避、发送队列、事件推送、退出清理。
 * 与 terminals.cjs 一样是 root 级 CJS，由 main.cjs 注册。
 */
const fs = require("node:fs");
const path = require("node:path");
const { dialog } = require("electron");
const { createMailStore } = require("./mail-store.cjs");
const imap = require("./mail-imap.cjs");
const smtp = require("./mail-smtp.cjs");
const queue = require("./mail-outbox.cjs");
const {
  ROLE_KEYS,
  collectMessages,
  filterByCategory,
  computeCounts,
} = require("./mail-folders.cjs");

const HEARTBEAT_MS = 60_000;
const STARTUP_SYNC_DELAY_MS = 3_000;
const DEFAULT_PAGE_SIZE = 80;
const MAX_PAGE_SIZE = 200;

const GROW_ROLES = {
  inbox: ["inbox"],
  unread: ["inbox"],
  sent: ["sent"],
  drafts: ["drafts"],
  trash: ["trash"],
  junk: ["junk"],
  all: ROLE_KEYS,
  outbox: [],
};

function emptyCounts() {
  return { all: 0, inbox: 0, unread: 0, drafts: 0, outbox: 0, sent: 0, trash: 0, junk: 0 };
}

function textPreview(text, html) {
  const source =
    (typeof text === "string" && text.trim()) ||
    (typeof html === "string" ? html.replace(/<[^>]+>/g, " ") : "");
  return source.replace(/\s+/g, " ").trim().slice(0, 160);
}

function safeFilename(name) {
  const base = path.basename(String(name || "attachment"));
  const cleaned = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return cleaned.slice(0, 180) || "attachment";
}

function sortItems(items) {
  return items.sort((a, b) => (Number(b.sortAt) || 0) - (Number(a.sortAt) || 0));
}

function createMailHost({ ipcMain, getWindow, dataDir, encrypt, decrypt }) {
  const store = createMailStore({ dataDir, encrypt, decrypt });
  const syncLocks = new Map();
  const syncing = new Set();
  let disposed = false;
  let heartbeat = null;
  let startupTimer = null;
  let outboxRunning = false;
  let outboxDone = Promise.resolve();
  let settleOutbox = null;

  function emit(event) {
    try {
      const win = typeof getWindow === "function" ? getWindow() : null;
      if (win && !win.isDestroyed()) win.webContents.send("meow:mail-event", event);
    } catch {
      // 窗口已销毁
    }
  }

  function readCaches(accountId) {
    const caches = {};
    for (const role of ROLE_KEYS) caches[role] = store.readFolderCache(accountId, role);
    return caches;
  }

  function accountsFor(accountId) {
    const accounts = store.listAccounts();
    if (!accountId || accountId === "unified") return accounts;
    return accounts.filter((account) => account.id === accountId);
  }

  function countsFor(accountId) {
    const accounts = accountsFor(accountId);
    const messages = accounts.flatMap((account) => collectMessages(account.id, readCaches(account.id)));
    const localDrafts = store.listDrafts(accountId === "unified" ? undefined : accountId);
    const outbox = store.listOutbox(accountId === "unified" ? undefined : accountId).filter(
      (item) => item.status !== "sent",
    );
    return computeCounts({ messages, localDrafts, outbox });
  }

  function accountsPayload() {
    return {
      accounts: store.listAccounts().map((account) => ({
        ...account,
        counts: countsFor(account.id),
        syncing: syncing.has(account.id),
      })),
      unified: countsFor("unified"),
    };
  }

  function draftItem(draft) {
    const sortAt = Date.parse(draft.updatedAt) || 0;
    return {
      kind: "draft",
      id: `draft:${draft.id}`,
      draftId: draft.id,
      accountId: draft.accountId,
      subject: draft.subject || "",
      fromName: "",
      fromAddr: "",
      to: draft.to || [],
      date: draft.updatedAt,
      sortAt,
      seen: true,
      hasAttachments: (draft.attachments || []).length > 0,
      snippet: textPreview(draft.text, ""),
      serverDraft: false,
    };
  }

  function outboxItem(item) {
    const payload = item.payload || {};
    const sortAt = Date.parse(item.createdAt) || 0;
    return {
      kind: "outbox",
      id: `outbox:${item.id}`,
      outboxId: item.id,
      accountId: item.accountId,
      subject: payload.subject || "",
      fromName: "",
      fromAddr: "",
      to: payload.to || [],
      date: item.createdAt,
      sortAt,
      seen: true,
      hasAttachments: (payload.attachments || []).length > 0,
      snippet: textPreview(payload.text, ""),
      status: item.status,
      lastError: item.lastError || null,
      attempts: item.attempts || 0,
    };
  }

  function listPayload({ accountId = "unified", category = "inbox", offset = 0, limit = DEFAULT_PAGE_SIZE }) {
    const accounts = accountsFor(accountId);
    const ids = new Set(accounts.map((account) => account.id));
    const messages = accounts.flatMap((account) => collectMessages(account.id, readCaches(account.id)));
    const localDrafts = store.listDrafts(accountId === "unified" ? undefined : accountId)
      .filter((draft) => !draft.accountId || ids.has(draft.accountId))
      .map(draftItem);
    const queueItems = store.listOutbox(accountId === "unified" ? undefined : accountId)
      .filter((item) => ids.has(item.accountId) && item.status !== "sent")
      .map(outboxItem);

    let items;
    if (category === "outbox") {
      items = queueItems;
    } else if (category === "drafts") {
      items = [
        ...messages.filter((message) => message.role === "drafts").map((message) => ({
          ...message,
          kind: "message",
          serverDraft: true,
        })),
        ...localDrafts,
      ];
    } else if (category === "all") {
      items = [...messages.map((message) => ({ ...message, kind: "message" })), ...localDrafts];
    } else {
      items = filterByCategory(messages, category).map((message) => ({ ...message, kind: "message" }));
    }

    sortItems(items);
    const start = Math.max(0, Number(offset) || 0);
    const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(limit) || DEFAULT_PAGE_SIZE));
    return {
      items: items.slice(start, start + size),
      total: items.length,
      hasMore: start + size < items.length,
    };
  }

  function updateLocalMessage(accountId, role, uid, patch) {
    if (!ROLE_KEYS.includes(role)) return false;
    const cache = store.readFolderCache(accountId, role);
    if (!cache) return false;
    const message = cache.messages.find((item) => item.uid === Number(uid));
    if (!message) return false;
    Object.assign(message, patch);
    store.writeFolderCache(accountId, role, cache);
    return true;
  }

  function removeLocalMessage(accountId, role, uid) {
    if (!ROLE_KEYS.includes(role)) return false;
    const cache = store.readFolderCache(accountId, role);
    if (!cache) return false;
    const next = cache.messages.filter((item) => item.uid !== Number(uid));
    if (next.length === cache.messages.length) return false;
    cache.messages = next;
    store.writeFolderCache(accountId, role, cache);
    return true;
  }

  async function authForAccount(accountId) {
    const account = store.getAccount(accountId);
    if (!account) return { ok: false, code: "not_found", detail: "" };
    const password = store.getPassword(accountId);
    if (!password) return { ok: false, code: "decrypt_failed", detail: "" };
    return { ok: true, account, auth: { type: "password", password } };
  }

  async function handleMessage(payload) {
    const session = await authForAccount(payload.accountId);
    if (!session.ok) return session;
    const { account } = session;
    const credential = session.auth;
    const uid = Number(payload.uid);
    const role = ROLE_KEYS.includes(payload.role) ? payload.role : "inbox";
    const cache = store.readFolderCache(account.id, role);
    const folder = cache?.folder || payload.folder;
    const uidValidity = Number(payload.uidValidity) || Number(cache?.uidValidity) || 0;
    if (!folder || !Number.isFinite(uid)) return { ok: false, code: "not_found", detail: "" };

    const cached = store.readBodyCache(account.id, uid, uidValidity);
    // 旧缓存里的 cid 内嵌图尚未转 data URL；命中时重新拉取一次
    const staleInlineImages =
      cached && typeof cached.html === "string" && /<img\b[^>]*\bsrc\s*=\s*["']cid:/i.test(cached.html);
    if (cached && !staleInlineImages) {
      const changed = updateLocalMessage(account.id, role, uid, {
        seen: true,
        snippet: cached.snippet || textPreview(cached.text, cached.html),
        hasAttachments: (cached.attachments || []).length > 0,
      });
      if (changed) emit({ type: "counts-changed" });
      return { ok: true, message: { ...cached, accountId: account.id } };
    }

    const result = await imap.fetchMessage({ account, auth: credential, role, folder, uid });
    if (!result.ok) return result;
    const body = {
      ...result.message,
      accountId: account.id,
      snippet: textPreview(result.message.text, result.message.html),
    };
    store.writeBodyCache(account.id, body);
    const changed = updateLocalMessage(account.id, role, uid, {
      seen: true,
      uidValidity,
      snippet: body.snippet,
      hasAttachments: (body.attachments || []).length > 0,
    });
    if (changed) emit({ type: "counts-changed" });
    return { ok: true, message: body };
  }

  async function handleSeen(payload) {
    const items = Array.isArray(payload.items) ? payload.items : [];
    if (!items.length) return { ok: true };
    const groups = new Map();
    for (const item of items) {
      const accountId = String(item.accountId || "");
      const role = ROLE_KEYS.includes(item.role) ? item.role : "inbox";
      const cache = store.readFolderCache(accountId, role);
      const folder = cache?.folder || item.folder;
      if (!accountId || !folder) continue;
      const key = `${accountId}\u0000${folder}`;
      const group = groups.get(key) ?? { accountId, folder, uids: [], role };
      group.uids.push(Number(item.uid));
      groups.set(key, group);
    }
    let firstError = null;
    for (const group of groups.values()) {
      const session = await authForAccount(group.accountId);
      if (!session.ok) {
        firstError = firstError || session;
        continue;
      }
      const result = await imap.setSeen({
        account: session.account,
        auth: session.auth,
        folder: group.folder,
        uids: group.uids,
        seen: payload.seen !== false,
      });
      if (!result.ok) {
        firstError = firstError || result;
        continue;
      }
      for (const uid of group.uids) {
        updateLocalMessage(group.accountId, group.role, uid, { seen: payload.seen !== false });
      }
    }
    emit({ type: "counts-changed" });
    return firstError || { ok: true };
  }

  async function handleDelete(payload) {
    const session = await authForAccount(payload.accountId);
    if (!session.ok) return session;
    const { account } = session;
    const credential = session.auth;
    const uid = Number(payload.uid);
    const role = ROLE_KEYS.includes(payload.role) ? payload.role : "inbox";
    const cache = store.readFolderCache(account.id, role);
    const folder = cache?.folder || payload.folder;
    if (!folder || !Number.isFinite(uid)) return { ok: false, code: "not_found", detail: "" };
    const result = await imap.deleteMessage({
      account,
      auth: credential,
      folder,
      role,
      uid,
      trashPath: account.folderRoles?.trash || null,
    });
    if (!result.ok) return result;
    removeLocalMessage(account.id, role, uid);
    emit({ type: "counts-changed" });
    void syncOne(account.id, { manual: true });
    return { ok: true, permanent: result.permanent };
  }

  async function handleAttachment(payload) {
    const session = await authForAccount(payload.accountId);
    if (!session.ok) return session;
    const { account } = session;
    const credential = session.auth;
    const role = ROLE_KEYS.includes(payload.role) ? payload.role : "inbox";
    const cache = store.readFolderCache(account.id, role);
    const folder = cache?.folder || payload.folder;
    const uid = Number(payload.uid);
    const uidValidity = Number(payload.uidValidity) || Number(cache?.uidValidity) || 0;
    const index = Number(payload.index);
    if (!folder || !Number.isFinite(uid) || !Number.isFinite(index)) {
      return { ok: false, code: "not_found", detail: "" };
    }
    let body = store.readBodyCache(account.id, uid, uidValidity);
    if (!body) {
      const fetched = await handleMessage({ accountId: account.id, role, folder, uid, uidValidity });
      if (!fetched.ok) return fetched;
      body = fetched.message;
    }
    const attachment = (body.attachments || [])[index];
    if (!attachment) return { ok: false, code: "not_found", detail: "" };
    const win = typeof getWindow === "function" ? getWindow() : null;
    const options = { defaultPath: safeFilename(attachment.filename) };
    const picked =
      win && !win.isDestroyed()
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);
    if (picked.canceled || !picked.filePath) return { ok: true, canceled: true };
    return imap.downloadAttachment({
      account,
      auth: credential,
      folder,
      uid,
      index,
      targetPath: picked.filePath,
    });
  }

  async function processOutbox() {
    if (outboxRunning || disposed) return;
    outboxRunning = true;
    outboxDone = new Promise((resolve) => {
      settleOutbox = resolve;
    });
    let current = null;
    let currentSmtpOk = false;
    try {
      while (!disposed) {
        const item = store.listOutbox().find((entry) => entry.status === "queued");
        if (!item) break;
        current = item;
        currentSmtpOk = Boolean(item.smtpOk);
        const session = await authForAccount(item.accountId);
        if (!session.ok) {
          store.updateOutboxItem(item.id, queue.markSmtpFailed(session.code));
          emit({ type: "outbox-changed" });
          current = null;
          continue;
        }
        const { account } = session;
        const credential = session.auth;
        store.updateOutboxItem(item.id, queue.markSending(item));
        emit({ type: "outbox-changed" });

        let raw = null;
        if (queue.nextAction(item) === "send") {
          const sent = await smtp.sendMail(account, credential, item.payload);
          if (!sent.ok) {
            store.updateOutboxItem(
              item.id,
              queue.markSmtpFailed(`${sent.code}: ${sent.detail || ""}`.trim()),
            );
            emit({ type: "outbox-changed" });
            current = null;
            continue;
          }
          raw = sent.raw;
          // SMTP 已接受：即便下面落盘抛错，手动重试也只补 APPEND，不重发
          currentSmtpOk = true;
          store.updateOutboxItem(item.id, queue.markSmtpOk());
          emit({ type: "outbox-changed" });
        } else {
          try {
            raw = (await smtp.buildRawMessage(account, item.payload)).raw;
          } catch (error) {
            store.updateOutboxItem(
              item.id,
              queue.markAppendFailed(`append_build_failed: ${error?.message ?? error}`),
            );
            emit({ type: "outbox-changed" });
            current = null;
            continue;
          }
        }

        const sentFolder = account.folderRoles?.sent;
        if (sentFolder) {
          const appended = await imap.appendMessage({
            account,
            auth: credential,
            folder: sentFolder,
            raw,
          });
          if (!appended.ok) {
            store.updateOutboxItem(
              item.id,
              queue.markAppendFailed(`${appended.code}: ${appended.detail || ""}`.trim()),
            );
            emit({ type: "outbox-changed" });
            current = null;
            continue;
          }
        }
        store.removeOutboxItem(item.id);
        emit({ type: "outbox-changed" });
        current = null;
        void syncOne(account.id, { manual: true });
      }
    } catch (error) {
      // 意外抛错（如 store 写盘 ENOSPC）：把当前 item 落回 failed，保留 smtpOk 使重试只 append；
      // 绝不能让 void processOutbox() 变成主进程未处理拒绝
      if (current) {
        try {
          const detail = `internal_error: ${error?.message ?? error}`;
          store.updateOutboxItem(
            current.id,
            currentSmtpOk ? queue.markAppendFailed(detail) : queue.markSmtpFailed(detail),
          );
          emit({ type: "outbox-changed" });
        } catch {
          // store 本身可能就是抛错源
        }
      }
    } finally {
      outboxRunning = false;
      const settle = settleOutbox;
      settleOutbox = null;
      settle?.();
      // 退出循环与刚入队的发送请求可能擦肩而过，补一次唤醒
      let hasQueued = false;
      try {
        hasQueued = !disposed && store.listOutbox().some((entry) => entry.status === "queued");
      } catch {
        hasQueued = false;
      }
      if (hasQueued) setTimeout(() => void processOutbox(), 0);
    }
  }

  function syncOne(accountId, { grow = null, manual = false } = {}) {
    if (disposed) return Promise.resolve({ ok: false, code: "disposed" });
    const running = syncLocks.get(accountId);
    if (running) return running;
    const task = (async () => {
      try {
        const account = store.getAccount(accountId);
        if (!account) return { ok: false, code: "not_found", detail: "" };
        if (!manual && Number(account.sync?.backoffUntil) > Date.now()) {
          return { ok: false, code: "backoff", detail: "" };
        }
        const session = await authForAccount(accountId);
        if (!session.ok) {
          const patch = { lastError: session.code };
          // 凭证解密失败（密码/授权码失效）不要每个心跳都撞：退避 30 分钟
          if (session.code === "decrypt_failed") patch.backoffUntil = Date.now() + 30 * 60_000;
          store.updateAccountSync(accountId, patch);
          emit({ type: "sync-error", accountId, code: session.code, detail: session.detail });
          return session;
        }
        syncing.add(accountId);
        emit({ type: "sync-start", accountId });
        const result = await imap.syncAccount({
          account: session.account,
          auth: session.auth,
          caches: readCaches(accountId),
          grow,
        });
        if (!result.ok) {
          const interval = Math.max(1, Number(account.sync?.intervalMinutes) || 5);
          const failures = (Number(account.sync?.consecutiveFailures) || 0) + 1;
          // 指数退避封顶 30 分钟；鉴权失败直接顶格，避免反复撞锁定的账户
          const minutes = result.code === "auth_failed" ? 30 : Math.min(interval * 2 ** failures, 30);
          store.updateAccountSync(accountId, {
            lastError: `${result.code}: ${result.detail || ""}`.trim(),
            backoffUntil: Date.now() + minutes * 60_000,
            consecutiveFailures: failures,
          });
          emit({ type: "sync-error", accountId, code: result.code, detail: result.detail });
          return result;
        }
        // 同步期间账户可能已被删除：不要用迟到的结果把缓存写回来
        if (!store.getAccount(accountId)) return { ok: false, code: "not_found", detail: "" };
        for (const role of ROLE_KEYS) {
          if (result.caches[role]) store.writeFolderCache(accountId, role, result.caches[role]);
        }
        if (result.roles) store.updateAccountFolderRoles(accountId, result.roles);
        store.updateAccountSync(accountId, {
          lastSyncAt: new Date().toISOString(),
          lastError: result.warnings.length
            ? `${result.warnings[0].role}:${result.warnings[0].code}`
            : null,
          backoffUntil: null,
          consecutiveFailures: 0,
        });
        emit({ type: "sync-done", accountId, warnings: result.warnings.length });
        emit({ type: "counts-changed" });
        return result;
      } catch (error) {
        const detail = String(error?.message ?? error);
        try {
          const account = store.getAccount(accountId);
          const interval = Math.max(1, Number(account?.sync?.intervalMinutes) || 5);
          const failures = (Number(account?.sync?.consecutiveFailures) || 0) + 1;
          store.updateAccountSync(accountId, {
            lastError: "internal_error",
            backoffUntil: Date.now() + Math.min(interval * 2 ** failures, 30) * 60_000,
            consecutiveFailures: failures,
          });
        } catch {
          // store 写盘失败不应掩盖原始错误
        }
        emit({ type: "sync-error", accountId, code: "internal_error", detail });
        return { ok: false, code: "internal_error", detail };
      } finally {
        syncing.delete(accountId);
        syncLocks.delete(accountId);
      }
    })();
    syncLocks.set(accountId, task);
    return task;
  }

  function growFromCategory(category, extra) {
    const roles = GROW_ROLES[category] || [];
    if (!roles.length) return null;
    return { roles, extra: Math.min(200, Math.max(1, Number(extra) || 200)) };
  }

  async function syncPayload(payload) {
    const accountId = payload.accountId || "unified";
    const ids = accountsFor(accountId).map((account) => account.id);
    if (accountId !== "unified" && !ids.length) return { ok: false, code: "not_found", detail: "" };
    if (!ids.length) return { ok: true, results: [] };
    const grow = growFromCategory(payload.category, payload.extra);
    const results = [];
    for (const id of ids) {
      const result = await syncOne(id, { grow, manual: true });
      results.push({
        accountId: id,
        ok: Boolean(result.ok),
        code: result.code ?? null,
        detail: result.detail ?? null,
        warnings: result.warnings?.length ?? 0,
      });
    }
    return { ok: results.some((item) => item.ok) || results.length === 0, results };
  }

  function registerHandlers() {
    const safe = (fn) => async (_event, payload) => {
      try {
        return await fn(payload && typeof payload === "object" ? payload : {});
      } catch (error) {
        return { ok: false, code: "internal_error", detail: String(error?.message ?? error) };
      }
    };

    ipcMain.handle("meow:mail-accounts-list", async () => {
      try {
        return accountsPayload();
      } catch {
        return { accounts: [], unified: emptyCounts() };
      }
    });
    ipcMain.handle("meow:mail-counts", async (_event, payload) => {
      try {
        return countsFor(payload?.accountId || "unified");
      } catch {
        return emptyCounts();
      }
    });
    ipcMain.handle("meow:mail-list", async (_event, payload) => {
      try {
        return listPayload(payload || {});
      } catch {
        return { items: [], total: 0, hasMore: false };
      }
    });
    ipcMain.handle("meow:mail-outbox-list", async (_event, payload) => {
      try {
        const accountId = payload?.accountId;
        const items = store
          .listOutbox(accountId === "unified" ? undefined : accountId)
          .filter((item) => item.status !== "sent")
          .map(outboxItem);
        return { items };
      } catch {
        return { items: [] };
      }
    });
    ipcMain.handle("meow:mail-drafts-list", async (_event, payload) => {
      try {
        const accountId = payload?.accountId;
        return { drafts: store.listDrafts(accountId === "unified" ? undefined : accountId) };
      } catch {
        return { drafts: [] };
      }
    });

    ipcMain.handle(
      "meow:mail-accounts-save",
      safe(async (payload) => {
        if (!payload.account) return { ok: false, code: "invalid_account", detail: "" };
        const before = payload.account.id ? store.getAccount(payload.account.id) : null;
        const account = store.saveAccount(payload.account, payload.password);
        if (before && before.email !== account.email) store.clearAccountCache(account.id);
        emit({ type: "account-changed", accountId: account.id });
        setTimeout(() => void syncOne(account.id, { manual: true }), 100);
        return { ok: true, account };
      }),
    );
    ipcMain.handle(
      "meow:mail-accounts-remove",
      safe(async (payload) => {
        const removed = store.removeAccount(payload.accountId || payload.id);
        if (removed) emit({ type: "account-changed", accountId: payload.accountId || payload.id });
        return { ok: removed };
      }),
    );
    ipcMain.handle(
      "meow:mail-accounts-test",
      safe(async (payload) => {
        const stored = payload.accountId ? store.getAccount(payload.accountId) : null;
        const account = {
          ...(stored || {}),
          ...(payload.account || {}),
        };
        const rawPassword =
          (typeof payload.password === "string" && payload.password.trim()) ||
          (payload.accountId ? store.getPassword(payload.accountId) : null) ||
          "";
        const password = rawPassword;
        let credential = null;
        if (payload.accountId && !password) {
          const session = await authForAccount(payload.accountId);
          if (!session.ok) return session;
          credential = session.auth;
        } else if (password) {
          credential = { type: "password", password };
        }
        if (!account.email || !account.imap?.host || !credential) {
          return { ok: false, code: "missing_credentials", detail: "" };
        }
        const smtpTask = account.smtp?.host
          ? smtp.testSmtp(account, credential)
          : Promise.resolve({ ok: false, code: "missing_credentials", detail: "" });
        const [imapResult, smtpResult] = await Promise.all([
          imap.testImap(account, credential),
          smtpTask,
        ]);
        return { ok: true, imap: imapResult, smtp: smtpResult };
      }),
    );
    ipcMain.handle(
      "meow:mail-pick-attachments",
      safe(async () => {
        const win = typeof getWindow === "function" ? getWindow() : null;
        const options = { properties: ["openFile", "multiSelections"] };
        const picked =
          win && !win.isDestroyed()
            ? await dialog.showOpenDialog(win, options)
            : await dialog.showOpenDialog(options);
        if (picked.canceled) return { ok: true, files: [] };
        return {
          ok: true,
          files: picked.filePaths.map((filePath) => {
            let size = 0;
            try {
              size = fs.statSync(filePath).size;
            } catch {
              // 文件可能刚被移走；发送时还会再报错
            }
            return { path: filePath, name: path.basename(filePath), size };
          }),
        };
      }),
    );
    ipcMain.handle("meow:mail-sync", safe(syncPayload));
    ipcMain.handle("meow:mail-message", safe(handleMessage));
    ipcMain.handle("meow:mail-message-seen", safe(handleSeen));
    ipcMain.handle("meow:mail-message-delete", safe(handleDelete));
    ipcMain.handle("meow:mail-attachment-download", safe(handleAttachment));
    ipcMain.handle(
      "meow:mail-drafts-save",
      safe(async (payload) => {
        const draft = store.saveDraft(payload.draft || {});
        emit({ type: "drafts-changed" });
        return { ok: true, draft };
      }),
    );
    ipcMain.handle(
      "meow:mail-drafts-delete",
      safe(async (payload) => {
        const removed = store.deleteDraft(payload.id);
        if (removed) emit({ type: "drafts-changed" });
        return { ok: removed };
      }),
    );
    ipcMain.handle(
      "meow:mail-send",
      safe(async (payload) => {
        const session = await authForAccount(payload.accountId);
        if (!session.ok) return session;
        const recipients = (Array.isArray(payload.to) ? payload.to : [payload.to])
          .map((item) => String(item || ""))
          .join(",");
        if (!recipients.includes("@")) return { ok: false, code: "no_recipient", detail: "" };
        const item = store.addOutboxItem(payload);
        if (payload.draftId) {
          store.deleteDraft(payload.draftId);
          emit({ type: "drafts-changed" });
        }
        emit({ type: "outbox-changed" });
        void processOutbox();
        return { ok: true, outboxId: item.id };
      }),
    );
    ipcMain.handle(
      "meow:mail-outbox-retry",
      safe(async (payload) => {
        const item = store.listOutbox().find((entry) => entry.id === payload.id);
        if (!item) return { ok: false, code: "not_found", detail: "" };
        store.updateOutboxItem(item.id, { status: "queued" });
        emit({ type: "outbox-changed" });
        void processOutbox();
        return { ok: true };
      }),
    );
    ipcMain.handle(
      "meow:mail-outbox-delete",
      safe(async (payload) => {
        const removed = store.removeOutboxItem(payload.id);
        if (removed) emit({ type: "outbox-changed" });
        return { ok: removed };
      }),
    );
  }

  function start() {
    registerHandlers();
    const interrupted = queue.resetInterrupted(store.listOutbox());
    for (const entry of interrupted) store.updateOutboxItem(entry.id, entry.patch);
    startupTimer = setTimeout(() => {
      for (const account of store.listAccounts()) void syncOne(account.id);
      void processOutbox();
    }, STARTUP_SYNC_DELAY_MS);
    heartbeat = setInterval(() => {
      if (disposed) return;
      const now = Date.now();
      for (const account of store.listAccounts()) {
        if (syncing.has(account.id)) continue;
        const interval = Math.max(1, Number(account.sync?.intervalMinutes) || 5);
        const last = Date.parse(account.sync?.lastSyncAt || "") || 0;
        const backoff = Number(account.sync?.backoffUntil) || 0;
        if (backoff > now) continue;
        if (now - last >= interval * 60_000) void syncOne(account.id);
      }
      void processOutbox();
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
    return { store };
  }

  async function dispose() {
    disposed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (startupTimer) clearTimeout(startupTimer);
    heartbeat = null;
    startupTimer = null;
    // 退出时给当前发件一个短暂收尾窗口；即使没等完，S2 也保证重启不会重复投递
    await Promise.race([
      outboxDone,
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        timer.unref?.();
      }),
    ]);
  }

  const api = {
    store,
    start,
    dispose,
    syncOne,
    syncPayload,
    processOutbox,
    accountsPayload,
    countsFor,
    listPayload,
  };
  return api;
}

module.exports = { createMailHost, emptyCounts };
