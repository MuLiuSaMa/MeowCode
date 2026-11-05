import { describe, expect, it } from "vitest";
import { describeContent, redactRecord, redactText } from "./redact.js";

describe("redactText", () => {
  it("抹掉常见密钥形态与 URL 查询串", () => {
    const text =
      "Authorization: Bearer abcdefghijklmnop key=sk-1234567890abcdef url?token=secret123&x=1";
    const out = redactText(text);
    expect(out).not.toContain("sk-1234567890abcdef");
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).not.toContain("secret123");
    expect(out).toContain("x=1");
  });

  it("GitHub / Slack / AWS 形态", () => {
    const out = redactText(
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789 xoxb-1234567890 AKIAABCDEFGHIJKLMNOP",
    );
    expect(out).not.toContain("ghp_");
    expect(out).not.toContain("xoxb-");
    expect(out).not.toContain("AKIA");
  });
});

describe("redactRecord", () => {
  it("按敏感键名整字段替换，嵌套也不漏", () => {
    const out = redactRecord({
      apiKey: "plain",
      nested: { authorization: "Bearer x", token: "t", safe: "ok" },
      list: [{ password: "p" }],
    });
    expect(out.apiKey).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).authorization).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).token).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).safe).toBe("ok");
    expect((out.list as Array<Record<string, unknown>>)[0].password).toBe("[REDACTED]");
  });

  it("循环引用深度上限不抛错", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 10; index += 1) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    expect(() => redactRecord(deep)).not.toThrow();
  });
});

describe("describeContent", () => {
  it("只返回长度与短摘要", () => {
    const info = describeContent("const a = 1;");
    expect(info.chars).toBe(12);
    expect(info.sha256).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(info)).not.toContain("const a");
  });
});
