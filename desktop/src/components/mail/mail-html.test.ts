// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildMailSrcDoc, hasRemoteImages } from "./mail-html";

const colors = {
  background: "#ffffff",
  foreground: "#111111",
  accent: "#0055cc",
  border: "rgba(0,0,0,0.12)",
  fontFamily: "system-ui, sans-serif",
};

describe("邮件 HTML 预处理", () => {
  it("协议相对地址补成 https，未解析的 cid 图移除", () => {
    const doc = buildMailSrcDoc(
      '<p>hello</p><img src="//cdn.example.com/a.png"><img src="cid:broken">',
      true,
      colors,
    );
    expect(doc).toContain('src="https://cdn.example.com/a.png"');
    expect(doc).not.toContain("cid:broken");
    expect(doc).toContain("hello");
  });

  it("data URL 内嵌图保留并允许加载", () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const doc = buildMailSrcDoc(`<img src="${dataUrl}">`, false, colors);
    expect(doc).toContain(dataUrl);
    expect(doc).toContain("img-src data:");
  });

  it("识别远程图片用于展示加载/隐藏开关", () => {
    expect(hasRemoteImages('<img src="https://track.example.com/p.gif">')).toBe(true);
    expect(hasRemoteImages('<img src="//track.example.com/p.gif">')).toBe(true);
    expect(hasRemoteImages('<img src="data:image/gif;base64,AA==">')).toBe(false);
    expect(hasRemoteImages("<p>no image</p>")).toBe(false);
  });
});
