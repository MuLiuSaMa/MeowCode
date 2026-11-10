import type { IconType } from "react-icons";
import {
  LuClock3,
  LuFileText,
  LuInbox,
  LuLayers,
  LuMailOpen,
  LuSend,
  LuShieldAlert,
  LuTrash2,
} from "react-icons/lu";
import type { MailCategory } from "../../mail/types";

export const CATEGORY_ORDER: MailCategory[] = [
  "all",
  "inbox",
  "unread",
  "drafts",
  "outbox",
  "sent",
  "trash",
  "junk",
];

export const CATEGORY_ICON: Record<MailCategory, IconType> = {
  all: LuLayers,
  inbox: LuInbox,
  unread: LuMailOpen,
  drafts: LuFileText,
  outbox: LuClock3,
  sent: LuSend,
  trash: LuTrash2,
  junk: LuShieldAlert,
};

export function accountColor(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return `mc-mail__avatar--${hash % 6}`;
}

export function accountInitial(name: string, email: string): string {
  const source = (name || email || "?").trim();
  return source.slice(0, 1).toUpperCase();
}

/** 列表/阅读页按发件人（已发送按收件人）取头像首字。 */
export function senderInitial(name: string, email: string): string {
  if (!name && email) {
    const local = email.split("@")[0] || email;
    return (Array.from(local)[0] || "?").toUpperCase();
  }
  return (Array.from((name || email || "?").trim())[0] || "?").toUpperCase();
}

const SECOND_LEVEL_SUFFIXES = new Set([
  "com.cn",
  "net.cn",
  "org.cn",
  "gov.cn",
  "com.tw",
  "com.hk",
  "co.uk",
  "org.uk",
  "co.jp",
  "co.kr",
  "com.au",
  "com.br",
]);

function registrableDomain(domain: string): string {
  const parts = domain.split(".").filter(Boolean);
  if (parts.length <= 2) return domain;
  const lastTwo = parts.slice(-2).join(".");
  return SECOND_LEVEL_SUFFIXES.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

/** QQ 号取真实 QQ 头像；其他发件人取站点图标，加载失败时组件回退字母头像。 */
export function senderAvatarUrl(address: string): string | null {
  const email = String(address || "").trim().toLowerCase();
  const [local, domain] = email.split("@");
  if (!local || !domain) return null;
  if (/^\d{5,12}$/.test(local) && (/(^|\.)qq\.com$/.test(domain) || domain === "foxmail.com")) {
    return `https://q1.qlogo.cn/g?b=sdk&nk=${local}&s=100`;
  }
  return `https://${registrableDomain(domain)}/favicon.ico`;
}

export function parseAddress(value: string): { name: string; address: string } {
  const text = String(value || "").trim();
  const match = /^(.*?)\s*<([^>]+)>$/.exec(text);
  if (match) return { name: match[1].trim().replace(/^["']|["']$/g, ""), address: match[2].trim() };
  return { name: "", address: text };
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const text = index === 0 || value >= 10 ? Math.round(value).toString() : value.toFixed(1);
  return `${text} ${units[index]}`;
}
