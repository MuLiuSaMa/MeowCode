import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const outbox = require("./mail-outbox.cjs") as {
  nextAction: (item: Record<string, unknown> | null) => string | null;
  markSending: (item: Record<string, unknown>) => Record<string, unknown>;
  markSmtpOk: () => Record<string, unknown>;
  markSmtpFailed: (detail: string) => Record<string, unknown>;
  markSent: () => Record<string, unknown>;
  markAppendFailed: (detail: string) => Record<string, unknown>;
  resetInterrupted: (items: Array<Record<string, unknown>>) => Array<Record<string, unknown>>;
};

describe("未发送队列状态机", () => {
  it("SMTP 未成功时发 SMTP，已成功时只补 APPEND", () => {
    expect(outbox.nextAction(null)).toBeNull();
    expect(outbox.nextAction({ status: "queued", smtpOk: false })).toBe("send");
    expect(outbox.nextAction({ status: "failed", smtpOk: false })).toBe("send");
    expect(outbox.nextAction({ status: "failed", smtpOk: true })).toBe("append");
    expect(outbox.nextAction({ status: "sending", smtpOk: true })).toBe("append");
    expect(outbox.nextAction({ status: "sent", smtpOk: true })).toBeNull();
  });

  it("发送成功但 APPEND 失败时保留 smtpOk，重试不会重复投递", () => {
    const item = { attempts: 0 };
    expect(outbox.markSending(item)).toEqual({ status: "sending", attempts: 1, lastError: null });
    expect(outbox.markSmtpOk()).toMatchObject({ smtpOk: true, status: "sending" });
    const failed = outbox.markAppendFailed("append");
    expect(failed).toMatchObject({ status: "failed", smtpOk: true, lastError: "append" });
    expect(outbox.nextAction({ ...item, ...failed })).toBe("append");
    expect(outbox.markSent()).toMatchObject({ status: "sent" });
  });

  it("SMTP 失败回到 failed 并重新尝试发送", () => {
    const failed = outbox.markSmtpFailed("auth_failed");
    expect(failed).toMatchObject({ status: "failed", smtpOk: false, lastError: "auth_failed" });
    expect(outbox.nextAction(failed)).toBe("send");
  });

  it("崩溃残留的 sending 项：已确认 SMTP 的续跑 APPEND，未确认的转 failed 等手动重试", () => {
    expect(
      outbox.resetInterrupted([
        { id: "a", status: "sending", smtpOk: false },
        { id: "b", status: "sending", smtpOk: true },
        { id: "c", status: "failed" },
        { id: "d", status: "sent" },
      ]),
    ).toEqual([
      { id: "a", patch: { status: "failed", smtpOk: false, lastError: "interrupted" } },
      { id: "b", patch: { status: "queued" } },
    ]);
  });
});
