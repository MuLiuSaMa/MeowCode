import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const folders = require("./mail-folders.cjs") as {
  mapFolderRoles: (mailboxes: unknown[]) => Record<string, string | null>;
  collectMessages: (accountId: string, caches: Record<string, unknown>) => Array<Record<string, unknown>>;
  filterByCategory: (messages: Array<Record<string, unknown>>, category: string) => Array<Record<string, unknown>>;
  computeCounts: (input: Record<string, unknown>) => Record<string, number>;
  messageId: (accountId: string, role: string, uidValidity: unknown, uid: number) => string;
};

describe("文件夹角色映射", () => {
  it("优先使用 special-use 标记", () => {
    const roles = folders.mapFolderRoles([
      { path: "INBOX", name: "INBOX", flags: new Set() },
      { path: "[Gmail]/Sent Mail", name: "Sent Mail", specialUse: "\\Sent" },
      { path: "[Gmail]/Drafts", name: "Drafts", specialUse: "\\Drafts" },
      { path: "[Gmail]/Trash", name: "Trash", specialUse: "\\Trash" },
      { path: "[Gmail]/Spam", name: "Spam", specialUse: "\\Junk" },
      { path: "[Gmail]/All Mail", name: "All Mail", specialUse: "\\All" },
    ]);
    expect(roles).toEqual({
      inbox: "INBOX",
      sent: "[Gmail]/Sent Mail",
      drafts: "[Gmail]/Drafts",
      trash: "[Gmail]/Trash",
      junk: "[Gmail]/Spam",
    });
  });

  it("无 special-use 时按中英文名称兜底", () => {
    const roles = folders.mapFolderRoles([
      { path: "INBOX", name: "收件箱" },
      { path: "Sent Messages", name: "Sent Messages" },
      { path: "草稿箱", name: "草稿箱" },
      { path: "已删除", name: "已删除" },
      { path: "垃圾邮件", name: "垃圾邮件" },
    ]);
    expect(roles).toEqual({
      inbox: "INBOX",
      sent: "Sent Messages",
      drafts: "草稿箱",
      trash: "已删除",
      junk: "垃圾邮件",
    });
  });

  it("跳过不可选与 \\All 文件夹，并处理层级名称", () => {
    const roles = folders.mapFolderRoles([
      { path: "INBOX" },
      { path: "Drafts/Sub", name: "Drafts/Sub", delimiter: "/", specialUse: "\\Noselect" },
      { path: "[Gmail]/Sent Mail", name: "Sent Mail", delimiter: "/" },
      { path: "全部邮件", name: "全部邮件", specialUse: "\\All" },
    ]);
    expect(roles.sent).toBe("[Gmail]/Sent Mail");
    expect(roles.drafts).toBeNull();
    expect(roles.trash).toBeNull();
  });

  it("大小写不敏感且不重复占用角色", () => {
    const roles = folders.mapFolderRoles([
      { path: "inbox" },
      { path: "SENT", name: "SENT" },
      { path: "Sent Items", name: "Sent Items", specialUse: "\\Sent" },
    ]);
    expect(roles.inbox).toBe("inbox");
    expect(roles.sent).toBe("Sent Items");
  });
});

describe("分类与计数", () => {
  const caches = {
    inbox: {
      folder: "INBOX",
      uidValidity: 10,
      messages: [
        { uid: 1, date: "2026-11-09T08:00:00.000Z", seen: false, subject: "a" },
        { uid: 2, date: "2026-11-08T08:00:00.000Z", seen: true, subject: "b" },
      ],
    },
    sent: {
      folder: "Sent",
      uidValidity: 11,
      messages: [{ uid: 3, date: "2026-11-07T08:00:00.000Z", seen: true, subject: "c" }],
    },
    drafts: {
      folder: "Drafts",
      uidValidity: 12,
      messages: [{ uid: 4, date: "2026-11-06T08:00:00.000Z", seen: true, subject: "d" }],
    },
    trash: {
      folder: "Trash",
      uidValidity: 13,
      messages: [{ uid: 5, date: "2026-11-05T08:00:00.000Z", seen: false, subject: "e" }],
    },
    junk: {
      folder: "Junk",
      uidValidity: 14,
      messages: [{ uid: 6, date: "2026-11-04T08:00:00.000Z", seen: false, subject: "f" }],
    },
  };

  const messages = folders.collectMessages("acc1", caches);

  it("收集消息带上稳定 id 并按时间倒序", () => {
    expect(messages.map((item) => item.subject)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(messages[0].id).toBe(folders.messageId("acc1", "inbox", 10, 1));
  });

  it("未读只统计收件箱，全部包含垃圾与已删除", () => {
    expect(folders.filterByCategory(messages, "unread").map((item) => item.subject)).toEqual(["a"]);
    expect(folders.filterByCategory(messages, "all").length).toBe(6);
    expect(folders.filterByCategory(messages, "junk").map((item) => item.subject)).toEqual(["f"]);
  });

  it("同角色内相同 Message-ID 去重（服务商自动保存 + APPEND）", () => {
    const duplicated = folders.collectMessages("acc1", {
      sent: {
        folder: "Sent",
        uidValidity: 20,
        messages: [
          { uid: 30, messageId: "<same@x>", date: "2026-11-09T10:00:00.000Z" },
          { uid: 29, messageId: "<same@x>", date: "2026-11-09T09:59:00.000Z" },
          { uid: 28, messageId: "<other@x>", date: "2026-11-09T09:00:00.000Z" },
        ],
      },
    });
    expect(duplicated.map((item) => item.uid)).toEqual([30, 28]);
  });

  it("计数口径：本地草稿计入草稿与全部，未发送单独计数", () => {
    const counts = folders.computeCounts({
      messages,
      localDrafts: [{ id: "draft:1" }],
      outbox: [{ status: "failed" }, { status: "sent" }],
    });
    expect(counts).toEqual({
      all: 7,
      inbox: 1,
      unread: 1,
      drafts: 2,
      outbox: 1,
      sent: 1,
      trash: 1,
      junk: 1,
    });
  });
});
