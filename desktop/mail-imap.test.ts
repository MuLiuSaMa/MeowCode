import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const imap = require("./mail-imap.cjs") as {
  embedInlineImages: (
    html: string,
    attachments: Array<Record<string, unknown>>,
  ) => string;
};

const png = Buffer.from("89504e470d0a1a0a", "hex");

describe("cid 内嵌图片", () => {
  it("把 related 图片换成 data URL，并处理百分号编码的 cid", () => {
    const html =
      '<p>x</p><img src="cid:logo%40mail"><img src="cid:photo@mail">';
    const output = imap.embedInlineImages(html, [
      { cid: "logo@mail", contentType: "image/png", content: png },
      { cid: "<photo@mail>", contentType: "image/jpeg", content: png },
    ]);
    expect(output).toContain("data:image/png;base64,");
    expect(output).toContain("data:image/jpeg;base64,");
    expect(output).not.toContain("cid:");
    expect(output).toContain("<p>x</p>");
  });

  it("无法嵌入的 cid 图直接移除，不影响其它正文", () => {
    const output = imap.embedInlineImages('<p>body</p><img src="cid:missing">', []);
    expect(output).toBe("<p>body</p>");
  });

  it("非图片附件不会被塞进正文", () => {
    const output = imap.embedInlineImages('<img src="cid:doc">', [
      { cid: "doc", contentType: "application/pdf", content: png },
    ]);
    expect(output).toBe("");
  });
});
