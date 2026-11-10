/**
 * 邮件本地存储：accounts / 文件夹缓存 / 正文缓存 / 草稿 / 发送队列。
 * 全部落在 userData/mail 下，密码由外部注入的 encrypt/decrypt 处理，永不明文落盘。
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { readJsonWithBackup, writeJsonAtomic } = require("./persist.cjs");
const { ROLE_KEYS, CATEGORY_KEYS } = require("./mail-folders.cjs");

const DEFAULT_INTERVAL_MINUTES = 5;
const DEFAULT_BODY_LIMIT = 300;
const DEFAULT_FOLDER_LIMIT = 500;
const OUTBOX_SENT_TTL_MS = 5 * 60 * 1000;

function isoNow() {
  return new Date().toISOString();
}

function cleanText(value, max = 400) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function cleanAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => ({
      path: typeof item?.path === "string" ? item.path : "",
      name: cleanText(item?.name, 240) || (typeof item?.path === "string" ? path.basename(item.path) : ""),
      size: Number.isFinite(item?.size) ? Number(item.size) : 0,
    }))
    .filter((item) => item.path);
}

function cleanAddressList(value) {
  const parts = Array.isArray(value) ? value : String(value ?? "").split(/[,;]/);
  return parts.map((item) => cleanText(item, 400)).filter(Boolean);
}

function cleanServerConfig(input, kind) {
  const source = input && typeof input === "object" ? input : {};
  const portDefault = kind === "imap" ? 993 : 465;
  const port = Number(source.port);
  return {
    host: cleanText(source.host, 240),
    port: Number.isFinite(port) && port > 0 && port < 65536 ? Math.trunc(port) : portDefault,
    secure: source.secure !== false,
    ...(kind === "smtp" ? { requireTLS: Boolean(source.requireTLS) } : {}),
  };
}

function cleanFolderRoles(input) {
  const roles = {};
  for (const role of ROLE_KEYS) {
    const value = input && typeof input[role] === "string" ? input[role].trim() : "";
    roles[role] = value || null;
  }
  return roles;
}

function clampInterval(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value)) return DEFAULT_INTERVAL_MINUTES;
  return Math.min(60, Math.max(1, Math.trunc(value)));
}

function publicAccount(account) {
  return {
    id: account.id,
    provider: account.provider,
    email: account.email,
    displayName: account.displayName,
    imap: account.imap,
    smtp: account.smtp,
    folderRoles: account.folderRoles,
    sync: account.sync,
    hasPassword: Boolean(account.passwordEnc),
    passwordOk: account.passwordOk !== false,
    createdAt: account.createdAt,
  };
}

function createMailStore({
  dataDir,
  encrypt,
  decrypt,
  bodyCacheLimit = DEFAULT_BODY_LIMIT,
  folderMessageLimit = DEFAULT_FOLDER_LIMIT,
}) {
  if (typeof dataDir !== "string" || !dataDir) throw new Error("mail store: dataDir required");
  if (typeof encrypt !== "function" || typeof decrypt !== "function") {
    throw new Error("mail store: encrypt/decrypt required");
  }

  const root = path.join(dataDir, "mail");
  const accountsPath = path.join(root, "accounts.json");
  const draftsPath = path.join(root, "drafts.json");
  const outboxPath = path.join(root, "outbox.json");
  const cacheRoot = path.join(root, "cache");

  fs.mkdirSync(root, { recursive: true });

  function cacheDir(accountId) {
    return path.join(cacheRoot, accountId);
  }

  function bodiesDir(accountId) {
    return path.join(cacheDir(accountId), "bodies");
  }

  function readAccountsFile() {
    const parsed = readJsonWithBackup(accountsPath, () => ({ version: 1, accounts: [] }));
    if (!parsed || !Array.isArray(parsed.accounts)) return { version: 1, accounts: [] };
    return { version: 1, accounts: parsed.accounts.filter((item) => item && item.id) };
  }

  function listAccounts() {
    return readAccountsFile().accounts.map(publicAccount);
  }

  function getAccount(accountId) {
    const account = readAccountsFile().accounts.find((item) => item.id === accountId);
    return account ? publicAccount(account) : null;
  }

  function getPassword(accountId) {
    const file = readAccountsFile();
    const account = file.accounts.find((item) => item.id === accountId);
    if (!account || !account.passwordEnc) return null;
    try {
      const value = decrypt(account.passwordEnc);
      if (!value) throw new Error("empty password");
      if (account.passwordOk === false) {
        account.passwordOk = true;
        writeJsonAtomic(accountsPath, file);
      }
      return value;
    } catch {
      if (account.passwordOk !== false) {
        account.passwordOk = false;
        writeJsonAtomic(accountsPath, file);
      }
      return null;
    }
  }

  function saveAccount(input, password) {
    if (!input || typeof input !== "object") throw new Error("account required");
    const file = readAccountsFile();
    const index = file.accounts.findIndex((item) => item.id === input.id);
    const existing = index >= 0 ? file.accounts[index] : null;
    const email = cleanText(input.email, 320) || existing?.email || "";
    if (!email || !email.includes("@")) throw new Error("invalid email");
    const account = {
      id:
        existing?.id ||
        cleanText(input.id, 120).replace(/[\\/:*?"<>|]/g, "").replace(/^\.+/, "") ||
        `acc_${crypto.randomUUID()}`,
      provider: cleanText(input.provider, 60) || existing?.provider || "custom",
      email: email.toLowerCase(),
      displayName: cleanText(input.displayName, 120) || existing?.displayName || email,
      imap: cleanServerConfig(input.imap ?? existing?.imap, "imap"),
      smtp: cleanServerConfig(input.smtp ?? existing?.smtp, "smtp"),
      folderRoles: cleanFolderRoles(input.folderRoles ?? existing?.folderRoles),
      sync: {
        intervalMinutes: clampInterval(input.sync?.intervalMinutes ?? existing?.sync?.intervalMinutes),
        lastSyncAt: existing?.sync?.lastSyncAt ?? null,
        lastError: existing?.sync?.lastError ?? null,
        backoffUntil: existing?.sync?.backoffUntil ?? null,
      },
      passwordEnc: existing?.passwordEnc ?? "",
      passwordOk: existing?.passwordOk !== false,
      createdAt: existing?.createdAt ?? isoNow(),
    };
    if (typeof password === "string" && password.trim()) {
      const value = password.trim();
      account.passwordEnc = encrypt(value);
      account.passwordOk = true;
    }
    if (!account.passwordEnc) account.passwordOk = false;
    if (index >= 0) file.accounts[index] = account;
    else file.accounts.push(account);
    writeJsonAtomic(accountsPath, file);
    return publicAccount(account);
  }

  function updateAccountSync(accountId, patch) {
    const file = readAccountsFile();
    const account = file.accounts.find((item) => item.id === accountId);
    if (!account) return;
    account.sync = {
      ...account.sync,
      ...(patch && typeof patch === "object" ? patch : {}),
    };
    writeJsonAtomic(accountsPath, file);
  }

  function updateAccountFolderRoles(accountId, folderRoles) {
    const file = readAccountsFile();
    const account = file.accounts.find((item) => item.id === accountId);
    if (!account) return;
    account.folderRoles = cleanFolderRoles(folderRoles);
    writeJsonAtomic(accountsPath, file);
  }

  function readDraftsFile() {
    const parsed = readJsonWithBackup(draftsPath, () => ({ version: 1, drafts: [] }));
    const drafts = Array.isArray(parsed?.drafts) ? parsed.drafts : [];
    return { version: 1, drafts: drafts.filter((item) => item && item.id) };
  }

  function listDrafts(accountId) {
    const drafts = readDraftsFile().drafts;
    return accountId ? drafts.filter((item) => item.accountId === accountId) : drafts;
  }

  function saveDraft(input) {
    if (!input || typeof input !== "object") throw new Error("draft required");
    const file = readDraftsFile();
    const id = cleanText(input.id, 120) || `draft_${crypto.randomUUID()}`;
    const index = file.drafts.findIndex((item) => item.id === id);
    const existing = index >= 0 ? file.drafts[index] : null;
    const draft = {
      id,
      accountId: cleanText(input.accountId, 120) || existing?.accountId || "",
      to: cleanAddressList(input.to ?? existing?.to),
      cc: cleanAddressList(input.cc ?? existing?.cc),
      bcc: cleanAddressList(input.bcc ?? existing?.bcc),
      subject: cleanText(input.subject, 500),
      text: typeof input.text === "string" ? input.text : "",
      attachments: cleanAttachments(input.attachments ?? existing?.attachments),
      inReplyTo: cleanText(input.inReplyTo, 1000) || null,
      references: cleanText(input.references, 4000) || null,
      updatedAt: isoNow(),
    };
    if (index >= 0) file.drafts[index] = draft;
    else file.drafts.unshift(draft);
    file.drafts = file.drafts.slice(0, 500);
    writeJsonAtomic(draftsPath, file);
    return draft;
  }

  function deleteDraft(id) {
    const file = readDraftsFile();
    const next = file.drafts.filter((item) => item.id !== id);
    if (next.length === file.drafts.length) return false;
    file.drafts = next;
    writeJsonAtomic(draftsPath, file);
    return true;
  }

  function readOutboxFile() {
    const parsed = readJsonWithBackup(outboxPath, () => ({ version: 1, items: [] }));
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    return { version: 1, items: items.filter((item) => item && item.id) };
  }

  function purgeSentOutbox(items) {
    const cutoff = Date.now() - OUTBOX_SENT_TTL_MS;
    return items.filter((item) => {
      if (item.status !== "sent") return true;
      const stamp = Date.parse(item.updatedAt ?? item.createdAt ?? "");
      return Number.isFinite(stamp) && stamp > cutoff;
    });
  }

  function listOutbox(accountId) {
    const items = purgeSentOutbox(readOutboxFile().items);
    return (accountId ? items.filter((item) => item.accountId === accountId) : items).sort(
      (a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0),
    );
  }

  function addOutboxItem(input) {
    if (!input || typeof input !== "object") throw new Error("outbox item required");
    const file = readOutboxFile();
    const item = {
      id: `outbox_${crypto.randomUUID()}`,
      accountId: cleanText(input.accountId, 120),
      status: "queued",
      attempts: 0,
      lastError: null,
      smtpOk: false,
      payload: {
        to: cleanAddressList(input.to),
        cc: cleanAddressList(input.cc),
        bcc: cleanAddressList(input.bcc),
        subject: cleanText(input.subject, 500),
        text: typeof input.text === "string" ? input.text : "",
        attachments: cleanAttachments(input.attachments),
        inReplyTo: cleanText(input.inReplyTo, 1000) || null,
        references: cleanText(input.references, 4000) || null,
      },
      createdAt: isoNow(),
      updatedAt: isoNow(),
    };
    file.items = purgeSentOutbox(file.items);
    file.items.push(item);
    writeJsonAtomic(outboxPath, file);
    return item;
  }

  function updateOutboxItem(id, patch) {
    const file = readOutboxFile();
    const item = file.items.find((entry) => entry.id === id);
    if (!item) return null;
    Object.assign(item, patch && typeof patch === "object" ? patch : {}, { updatedAt: isoNow() });
    file.items = purgeSentOutbox(file.items);
    writeJsonAtomic(outboxPath, file);
    return item;
  }

  function removeOutboxItem(id) {
    const file = readOutboxFile();
    const next = file.items.filter((item) => item.id !== id);
    if (next.length === file.items.length) return false;
    file.items = next;
    writeJsonAtomic(outboxPath, file);
    return true;
  }

  function readFolderCache(accountId, role) {
    if (!ROLE_KEYS.includes(role)) return null;
    const file = path.join(cacheDir(accountId), `${role}.json`);
    const parsed = readJsonWithBackup(file, () => null);
    if (!parsed || !Array.isArray(parsed.messages)) return null;
    return {
      folder: typeof parsed.folder === "string" ? parsed.folder : "",
      role,
      uidValidity: Number(parsed.uidValidity) || 0,
      lastUid: Number(parsed.lastUid) || 0,
      syncedAt: parsed.syncedAt ?? null,
      messages: parsed.messages.filter((item) => item && Number.isFinite(item.uid)),
    };
  }

  function writeFolderCache(accountId, role, cache) {
    if (!ROLE_KEYS.includes(role)) throw new Error(`unknown role: ${role}`);
    const messages = Array.isArray(cache?.messages) ? cache.messages : [];
    const trimmed = [...messages]
      .sort((a, b) => (Number(b.uid) || 0) - (Number(a.uid) || 0))
      .slice(0, folderMessageLimit);
    const value = {
      folder: typeof cache?.folder === "string" ? cache.folder : "",
      role,
      uidValidity: Number(cache?.uidValidity) || 0,
      lastUid: Number(cache?.lastUid) || 0,
      syncedAt: cache?.syncedAt ?? isoNow(),
      messages: trimmed,
    };
    writeJsonAtomic(path.join(cacheDir(accountId), `${role}.json`), value, { pretty: false });
    return value;
  }

  function deleteFolderCache(accountId, role) {
    if (!ROLE_KEYS.includes(role)) return;
    try {
      fs.unlinkSync(path.join(cacheDir(accountId), `${role}.json`));
    } catch {
      // 不存在时忽略
    }
  }

  function bodyPath(accountId, uid, uidValidity) {
    return path.join(bodiesDir(accountId), `${uid}.${uidValidity}.json`);
  }

  function readBodyCache(accountId, uid, uidValidity) {
    const parsed = readJsonWithBackup(bodyPath(accountId, uid, uidValidity), () => null);
    return parsed && typeof parsed === "object" ? parsed : null;
  }

  function pruneBodies(accountId) {
    const dir = bodiesDir(accountId);
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    if (entries.length <= bodyCacheLimit) return;
    const files = entries
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const file = path.join(dir, name);
        try {
          return { file, mtime: fs.statSync(file).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
    for (const entry of files.slice(bodyCacheLimit)) {
      try {
        fs.unlinkSync(entry.file);
      } catch {
        // best effort
      }
    }
  }

  function writeBodyCache(accountId, body) {
    const uid = Number(body?.uid);
    const uidValidity = Number(body?.uidValidity);
    if (!Number.isFinite(uid) || !Number.isFinite(uidValidity)) throw new Error("invalid body key");
    writeJsonAtomic(bodyPath(accountId, uid, uidValidity), { ...body, fetchedAt: isoNow() }, { pretty: false });
    pruneBodies(accountId);
  }

  function clearAccountCache(accountId) {
    fs.rmSync(cacheDir(accountId), { recursive: true, force: true });
  }

  function removeAccount(accountId) {
    const file = readAccountsFile();
    const next = file.accounts.filter((item) => item.id !== accountId);
    if (next.length === file.accounts.length) return false;
    file.accounts = next;
    writeJsonAtomic(accountsPath, file);

    const drafts = readDraftsFile();
    drafts.drafts = drafts.drafts.filter((item) => item.accountId !== accountId);
    writeJsonAtomic(draftsPath, drafts);

    const outbox = readOutboxFile();
    outbox.items = outbox.items.filter((item) => item.accountId !== accountId);
    writeJsonAtomic(outboxPath, outbox);

    clearAccountCache(accountId);
    return true;
  }

  return {
    root,
    listAccounts,
    getAccount,
    getPassword,
    saveAccount,
    updateAccountSync,
    updateAccountFolderRoles,
    clearAccountCache,
    removeAccount,
    readFolderCache,
    writeFolderCache,
    deleteFolderCache,
    readBodyCache,
    writeBodyCache,
    listDrafts,
    saveDraft,
    deleteDraft,
    listOutbox,
    addOutboxItem,
    updateOutboxItem,
    removeOutboxItem,
  };
}

module.exports = {
  createMailStore,
  CATEGORY_KEYS,
  ROLE_KEYS,
  DEFAULT_INTERVAL_MINUTES,
};
