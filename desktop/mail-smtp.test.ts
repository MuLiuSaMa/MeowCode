import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const smtp = require("./mail-smtp.cjs") as {
  buildRawMessage: (
    account: Record<string, unknown>,
    payload: Record<string, unknown>,
  ) => Promise<{ raw: Buffer; messageId: string }>;
  classifySmtpError: (error: unknown) => { code: string; detail: string };
};

const account = {
  displayName: "测试发件人",
  email: "tester@example.com",
  smtp: { host: "smtp.example.com", port: 465, secure: true },
};

const tempDir = mkdtempSync(path.join(tmpdir(), "meowcode-smtp-"));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

describe("SMTP raw 邮件生成", () => {
  it("Bcc 只进 envelope，不写进邮件头", async () => {
    const { raw, messageId } = await smtp.buildRawMessage(account, {
      to: ["alice@example.com"],
      cc: ["carol@example.com"],
      bcc: ["secret@example.com"],
      subject: "测试主题",
      text: "hello",
      attachments: [],
    });
    const text = raw.toString("utf8");
    expect(text).toContain("To: alice@example.com");
    expect(text).toContain("Cc: carol@example.com");
    expect(text).not.toMatch(/^Bcc:/im);
    expect(text).toContain("hello");
    expect(messageId).toBeTruthy();
  });

  it("缺少附件文件时归类为 attachment_missing", () => {
    expect(smtp.classifySmtpError(Object.assign(new Error("no such file"), { code: "ENOENT" })).code).toBe(
      "attachment_missing",
    );
    expect(smtp.classifySmtpError(new Error("Invalid login")).code).toBe("auth_failed");
    expect(smtp.classifySmtpError(new Error("Connection timeout")).code).toBe("timeout");
  });

  it("附件总大小超过 25MB 时拒绝构建，不进入 SMTP", async () => {
    const first = path.join(tempDir, "first.bin");
    const second = path.join(tempDir, "second.bin");
    writeFileSync(first, Buffer.alloc(13 * 1024 * 1024));
    writeFileSync(second, Buffer.alloc(13 * 1024 * 1024));
    await expect(
      smtp.buildRawMessage(account, {
        to: ["alice@example.com"],
        subject: "big",
        text: "hi",
        attachments: [
          { name: "first.bin", path: first },
          { name: "second.bin", path: second },
        ],
      }),
    ).rejects.toMatchObject({ code: "ATTACHMENT_TOO_LARGE" });
  });

  it("小附件正常构建", async () => {
    const small = path.join(tempDir, "note.txt");
    writeFileSync(small, "hello");
    const { raw } = await smtp.buildRawMessage(account, {
      to: ["alice@example.com"],
      subject: "small",
      text: "hi",
      attachments: [{ name: "note.txt", path: small }],
    });
    expect(raw.toString("utf8")).toContain("note.txt");
  });

  it("ATTACHMENT_TOO_LARGE 归类为 attachment_too_large", () => {
    expect(
      smtp.classifySmtpError(
        Object.assign(new Error("attachments exceed 25MB"), { code: "ATTACHMENT_TOO_LARGE" }),
      ).code,
    ).toBe("attachment_too_large");
  });
});
