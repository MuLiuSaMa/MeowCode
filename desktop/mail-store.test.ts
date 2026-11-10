import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createMailStore } = require("./mail-store.cjs") as {
  createMailStore: (options: Record<string, unknown>) => {
    root: string;
    listAccounts: () => Array<Record<string, unknown>>;
    getPassword: (id: string) => string | null;
    saveAccount: (input: Record<string, unknown>, password?: string) => Record<string, unknown>;
    updateAccountSync: (id: string, patch: Record<string, unknown>) => void;
    removeAccount: (id: string) => boolean;
    readFolderCache: (id: string, role: string) => { messages: Array<{ uid: number }> } | null;
    writeFolderCache: (id: string, role: string, cache: Record<string, unknown>) => void;
    readBodyCache: (id: string, uid: number, uidValidity: number) => Record<string, unknown> | null;
    writeBodyCache: (id: string, body: Record<string, unknown>) => void;
    listDrafts: (id?: string) => Array<Record<string, unknown>>;
    saveDraft: (draft: Record<string, unknown>) => Record<string, unknown>;
    deleteDraft: (id: string) => boolean;
    listOutbox: (id?: string) => Array<Record<string, unknown>>;
    addOutboxItem: (item: Record<string, unknown>) => Record<string, unknown>;
    updateOutboxItem: (id: string, patch: Record<string, unknown>) => Record<string, unknown> | null;
    removeOutboxItem: (id: string) => boolean;
  };
};

const tempDirs: string[] = [];

function makeStore(extra: Record<string, unknown> = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "meow-mail-"));
  tempDirs.push(dataDir);
  return {
    dataDir,
    store: createMailStore({
      dataDir,
      encrypt: (value: string) => `enc:${Buffer.from(value, "utf8").toString("base64")}`,
      decrypt: (value: string) => Buffer.from(value.replace(/^enc:/, ""), "base64").toString("utf8"),
      ...extra,
    }),
  };
}

const accountInput = {
  id: "acc_test",
  provider: "qq",
  email: "tester@qq.com",
  displayName: "Tester",
  imap: { host: "imap.qq.com", port: 993, secure: true },
  smtp: { host: "smtp.qq.com", port: 465, secure: true },
  folderRoles: { inbox: "INBOX", sent: "Sent Messages" },
  sync: { intervalMinutes: 5 },
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("账户存储", () => {
  it("密码加密保存且公开数据不含密文", () => {
    const { store, dataDir } = makeStore();
    const saved = store.saveAccount(accountInput, "secret-code");
    expect(saved.passwordOk).toBe(true);
    expect(saved).not.toHaveProperty("passwordEnc");
    expect(store.getPassword("acc_test")).toBe("secret-code");
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, "mail", "accounts.json"), "utf8"));
    expect(raw.accounts[0].passwordEnc).not.toContain("secret-code");
    expect(store.listAccounts()).toHaveLength(1);
  });

  it("编辑时密码留空保留旧密文，填写则替换", () => {
    const { store } = makeStore();
    store.saveAccount(accountInput, "first");
    store.saveAccount({ ...accountInput, displayName: "Renamed" }, "");
    expect(store.getPassword("acc_test")).toBe("first");
    const saved = store.saveAccount({ ...accountInput, displayName: "Renamed" }, "second");
    expect(saved.passwordOk).toBe(true);
    expect(store.getPassword("acc_test")).toBe("second");
  });

  it("解密失败把 passwordOk 置为 false 且不返回密码", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "meow-mail-"));
    tempDirs.push(dataDir);
    const store = createMailStore({
      dataDir,
      encrypt: (value: string) => `enc:${value}`,
      decrypt: () => {
        throw new Error("cannot decrypt");
      },
    });
    store.saveAccount(accountInput, "secret");
    expect(store.getPassword("acc_test")).toBeNull();
    expect(store.listAccounts()[0].passwordOk).toBe(false);
  });

  it("同步状态可更新", () => {
    const { store } = makeStore();
    store.saveAccount(accountInput, "x");
    store.updateAccountSync("acc_test", { lastSyncAt: "2026-11-09T00:00:00.000Z", lastError: null });
    const account = store.listAccounts()[0] as { sync: Record<string, unknown> };
    expect(account.sync.lastSyncAt).toBe("2026-11-09T00:00:00.000Z");
    expect(account.sync.intervalMinutes).toBe(5);
  });
});

describe("文件夹与正文缓存", () => {
  it("文件夹缓存按 UID 倒序裁剪", () => {
    const { store } = makeStore({ folderMessageLimit: 3 });
    store.writeFolderCache("acc_test", "inbox", {
      folder: "INBOX",
      uidValidity: 9,
      lastUid: 5,
      messages: [
        { uid: 2, subject: "b" },
        { uid: 5, subject: "e" },
        { uid: 1, subject: "a" },
        { uid: 4, subject: "d" },
      ],
    });
    const cache = store.readFolderCache("acc_test", "inbox");
    expect(cache?.messages.map((item) => item.uid)).toEqual([5, 4, 2]);
  });

  it("正文缓存按上限淘汰旧文件", () => {
    const { store, dataDir } = makeStore({ bodyCacheLimit: 2 });
    for (let uid = 1; uid <= 4; uid += 1) {
      store.writeBodyCache("acc_test", { uid, uidValidity: 1, html: `<p>${uid}</p>`, attachments: [] });
    }
    const dir = path.join(dataDir, "mail", "cache", "acc_test", "bodies");
    expect(fs.readdirSync(dir)).toHaveLength(2);
    expect(store.readBodyCache("acc_test", 4, 1)).toMatchObject({ uid: 4 });
  });
});

describe("草稿与发送队列", () => {
  it("草稿增改删", () => {
    const { store } = makeStore();
    const draft = store.saveDraft({
      accountId: "acc_test",
      to: "a@b.com",
      subject: "hello",
      text: "body",
      attachments: [{ path: "C:\\tmp\\a.txt", name: "a.txt", size: 3 }],
    });
    expect(store.listDrafts("acc_test")).toHaveLength(1);
    expect(draft.id).toMatch(/^draft_/);
    store.saveDraft({ ...draft, subject: "updated" });
    expect(store.listDrafts("acc_test")[0].subject).toBe("updated");
    expect(store.deleteDraft(String(draft.id))).toBe(true);
    expect(store.listDrafts()).toHaveLength(0);
  });

  it("队列状态流转与移除", () => {
    const { store } = makeStore();
    const item = store.addOutboxItem({
      accountId: "acc_test",
      to: "a@b.com",
      subject: "queued",
      text: "body",
    });
    expect(item.status).toBe("queued");
    const failed = store.updateOutboxItem(String(item.id), { status: "failed", lastError: "smtp" });
    expect(failed?.status).toBe("failed");
    expect(store.listOutbox("acc_test")).toHaveLength(1);
    expect(store.removeOutboxItem(String(item.id))).toBe(true);
    expect(store.listOutbox()).toHaveLength(0);
  });

  it("删除账户会清理缓存、草稿和队列", () => {
    const { store, dataDir } = makeStore();
    store.saveAccount(accountInput, "x");
    store.writeFolderCache("acc_test", "inbox", { folder: "INBOX", uidValidity: 1, messages: [] });
    store.writeBodyCache("acc_test", { uid: 1, uidValidity: 1 });
    store.saveDraft({ accountId: "acc_test", subject: "draft" });
    store.addOutboxItem({ accountId: "acc_test", subject: "queue" });
    expect(store.removeAccount("acc_test")).toBe(true);
    expect(store.listAccounts()).toHaveLength(0);
    expect(store.listDrafts()).toHaveLength(0);
    expect(store.listOutbox()).toHaveLength(0);
    expect(fs.existsSync(path.join(dataDir, "mail", "cache", "acc_test"))).toBe(false);
  });
});
