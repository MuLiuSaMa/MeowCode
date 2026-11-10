import { describe, expect, it } from "vitest";
import { parseAddress, senderAvatarUrl, senderInitial } from "./mail-meta";

describe("发件人头像", () => {
  it("QQ 号使用 QQ 头像，foxmail 同样处理", () => {
    expect(senderAvatarUrl("1185992698@qq.com")).toBe(
      "https://q1.qlogo.cn/g?b=sdk&nk=1185992698&s=100",
    );
    expect(senderAvatarUrl("123456@foxmail.com")).toContain("qlogo.cn");
    expect(senderAvatarUrl("news@qq.com")).toBe("https://qq.com/favicon.ico");
  });

  it("其他邮箱使用站点图标，大小写与空值处理", () => {
    expect(senderAvatarUrl("noreply@GitHub.com")).toBe("https://github.com/favicon.ico");
    expect(senderAvatarUrl("a@example.org")).toBe("https://example.org/favicon.ico");
    expect(senderAvatarUrl("a@mail.microsoft.com")).toBe("https://microsoft.com/favicon.ico");
    expect(senderAvatarUrl("a@foo.com.cn")).toBe("https://foo.com.cn/favicon.ico");
    expect(senderAvatarUrl("")).toBeNull();
    expect(senderAvatarUrl("not-an-email")).toBeNull();
  });

  it("显示名与地址拆分、字母回退", () => {
    expect(parseAddress("Alex Chen <alex@example.com>")).toEqual({
      name: "Alex Chen",
      address: "alex@example.com",
    });
    expect(parseAddress("linyi@example.com")).toEqual({ name: "", address: "linyi@example.com" });
    expect(senderInitial("GitHub", "noreply@github.com")).toBe("G");
    expect(senderInitial("", "3229278207@qq.com")).toBe("3");
    expect(senderInitial("林一", "")).toBe("林");
  });
});
