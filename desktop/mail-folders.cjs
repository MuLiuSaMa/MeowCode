/**
 * 邮件文件夹角色与分类的纯函数：无 Electron 依赖，供主进程与单测共用。
 * 角色映射优先 special-use 标记，其次按中英文文件夹名兜底。
 */

const ROLE_KEYS = ["inbox", "sent", "drafts", "trash", "junk"];
const CATEGORY_KEYS = ["all", "inbox", "unread", "drafts", "outbox", "sent", "trash", "junk"];

const SPECIAL_ROLES = {
  sent: "sent",
  drafts: "drafts",
  trash: "trash",
  junk: "junk",
};

const NAME_HINTS = {
  sent: [
    "sent",
    "sent items",
    "sent messages",
    "sent mail",
    "sent-mail",
    "已发送",
    "已发送邮件",
    "发件箱",
    "寄件备份",
    "寄件備份",
    "送信済み",
    "送信済みメール",
    "보낸 편지함",
    "보낸편지함",
    "gesendet",
    "envoyés",
    "enviados",
    "отправленные",
  ],
  drafts: [
    "drafts",
    "draft",
    "草稿",
    "草稿箱",
    "草稿夾",
    "下書き",
    "임시 보관함",
    "임시보관함",
    "entwürfe",
    "brouillons",
    "borradores",
    "черновики",
  ],
  trash: [
    "trash",
    "deleted",
    "deleted items",
    "deleted messages",
    "bin",
    "已删除",
    "已刪除",
    "垃圾桶",
    "废件箱",
    "ゴミ箱",
    "削除済み",
    "휴지통",
    "papierkorb",
    "corbeille",
    "papelera",
    "корзина",
  ],
  junk: [
    "junk",
    "spam",
    "junk email",
    "junk e-mail",
    "垃圾邮件",
    "垃圾郵件",
    "广告邮件",
    "廣告郵件",
    "迷惑メール",
    "스팸",
    "spamverdacht",
    "indésirables",
    "correo no deseado",
    "спам",
  ],
};

function normalize(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\\+/, "")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ");
}

function mailboxFlags(mailbox) {
  const raw = mailbox && mailbox.flags;
  const list = raw instanceof Set ? [...raw] : Array.isArray(raw) ? raw : [];
  return new Set(list.map((flag) => String(flag).toLowerCase()));
}

function isSelectable(mailbox) {
  if (!mailbox || typeof mailbox.path !== "string" || !mailbox.path) return false;
  const flags = mailboxFlags(mailbox);
  const special = normalize(mailbox.specialUse);
  return (
    !flags.has("\\noselect") &&
    !flags.has("\\nonexistent") &&
    special !== "noselect" &&
    special !== "nonexistent"
  );
}

function mailboxName(mailbox) {
  const name = typeof mailbox.name === "string" && mailbox.name ? mailbox.name : mailbox.path;
  const delimiter = typeof mailbox.delimiter === "string" ? mailbox.delimiter : "";
  if (!delimiter) return name;
  const parts = name.split(delimiter).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : name;
}

/**
 * @param {Array<{path:string,name?:string,specialUse?:string,flags?:Iterable<string>}>} mailboxes
 * @returns {{inbox:string|null,sent:string|null,drafts:string|null,trash:string|null,junk:string|null}}
 */
function mapFolderRoles(mailboxes) {
  const roles = { inbox: null, sent: null, drafts: null, trash: null, junk: null };
  const list = Array.isArray(mailboxes) ? mailboxes.filter(isSelectable) : [];
  const used = new Set();

  for (const mailbox of list) {
    if (mailbox.path.toUpperCase() === "INBOX") {
      roles.inbox = mailbox.path;
      used.add(mailbox.path);
      break;
    }
  }

  for (const mailbox of list) {
    if (used.has(mailbox.path)) continue;
    const special = normalize(mailbox.specialUse);
    const role = SPECIAL_ROLES[special];
    if (role && !roles[role]) {
      roles[role] = mailbox.path;
      used.add(mailbox.path);
    }
  }

  const names = new Map();
  for (const mailbox of list) {
    if (used.has(mailbox.path)) continue;
    names.set(mailbox.path, normalize(mailboxName(mailbox)));
  }

  for (const role of ["sent", "drafts", "trash", "junk"]) {
    if (roles[role]) continue;
    const hints = NAME_HINTS[role];
    for (const [path, name] of names) {
      if (roles[role]) break;
      if (!used.has(path) && hints.includes(name)) {
        roles[role] = path;
        used.add(path);
      }
    }
  }

  return roles;
}

function messageId(accountId, role, uidValidity, uid) {
  return `${accountId}:${role}:${uidValidity}:${uid}`;
}

function sortByDateDesc(items) {
  return items.sort((a, b) => {
    const left = Number(a.sortAt ?? a.date ?? 0);
    const right = Number(b.sortAt ?? b.date ?? 0);
    return right - left;
  });
}

/** 服务器文件夹邮件合并（不含本地草稿与未发送）。 */
function collectMessages(accountId, caches) {
  const list = [];
  for (const role of ROLE_KEYS) {
    const cache = caches && caches[role];
    if (!cache || !Array.isArray(cache.messages)) continue;
    for (const message of cache.messages) {
      list.push({
        ...message,
        id: messageId(accountId, role, cache.uidValidity, message.uid),
        accountId,
        role,
        uidValidity: cache.uidValidity,
        folder: cache.folder,
        sortAt: Date.parse(message.date) || 0,
      });
    }
  }
  // 部分服务商会把 SMTP 发出的邮件自动存进已发送；我们同时 APPEND 会产生同
  // Message-ID 的两份，展示与计数都按角色内 Message-ID 去重。
  const seen = new Set();
  const deduped = list.filter((item) => {
    if (!item.messageId) return true;
    const key = `${item.accountId}:${item.role}:${item.messageId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return sortByDateDesc(deduped);
}

function filterByCategory(messages, category) {
  const list = Array.isArray(messages) ? messages : [];
  switch (category) {
    case "inbox":
      return sortByDateDesc(list.filter((item) => item.role === "inbox"));
    case "unread":
      return sortByDateDesc(list.filter((item) => item.role === "inbox" && item.seen === false));
    case "sent":
      return sortByDateDesc(list.filter((item) => item.role === "sent"));
    case "trash":
      return sortByDateDesc(list.filter((item) => item.role === "trash"));
    case "junk":
      return sortByDateDesc(list.filter((item) => item.role === "junk"));
    case "all":
      return sortByDateDesc([...list]);
    default:
      return [];
  }
}

function countUnread(messages, role) {
  return messages.filter((item) => item.role === role && item.seen === false).length;
}

/**
 * 分类计数。本地草稿计入 drafts 与 all；未发送只计入 outbox。
 * @param {{messages:Array, localDrafts?:Array, outbox?:Array}} input
 */
function computeCounts({ messages, localDrafts = [], outbox = [] }) {
  const list = Array.isArray(messages) ? messages : [];
  const drafts = Array.isArray(localDrafts) ? localDrafts : [];
  const queue = Array.isArray(outbox) ? outbox : [];
  return {
    all: list.length + drafts.length,
    inbox: countUnread(list, "inbox"),
    unread: countUnread(list, "inbox"),
    drafts: list.filter((item) => item.role === "drafts").length + drafts.length,
    outbox: queue.filter((item) => item.status !== "sent").length,
    sent: list.filter((item) => item.role === "sent").length,
    trash: list.filter((item) => item.role === "trash").length,
    junk: countUnread(list, "junk"),
  };
}

module.exports = {
  ROLE_KEYS,
  CATEGORY_KEYS,
  NAME_HINTS,
  mapFolderRoles,
  normalize,
  messageId,
  collectMessages,
  filterByCategory,
  computeCounts,
  sortByDateDesc,
  mailboxName,
};
