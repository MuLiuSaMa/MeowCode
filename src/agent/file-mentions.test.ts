import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildFileMentionContext,
  collectInjectedPaths,
  extractAttachmentPaths,
  extractFileMentions,
  mentionPathKey,
  mentionTokenBudget,
  referenceLabel,
  stripReferenceHeader,
} from "./file-mentions";
import type { ChatMessage } from "./types";

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "meowcode-mention-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  return workspace;
}

describe("extractFileMentions", () => {
  it("finds bare and quoted paths at word boundaries", () => {
    expect(extractFileMentions("read @src/app.ts and @\"docs/a b.md\"")).toEqual([
      "src/app.ts",
      "docs/a b.md",
    ]);
    expect(extractFileMentions("邮箱 foo@bar.com 不算")).toEqual([]);
    expect(extractFileMentions("@a.ts，@b.ts。")).toEqual(["a.ts", "b.ts"]);
  });

  it("deduplicates repeated mentions", () => {
    expect(extractFileMentions("@a.ts @a.ts @b.ts")).toEqual(["a.ts", "b.ts"]);
  });
});

describe("mentionTokenBudget", () => {
  it("scales with the context window and stays inside its bounds", () => {
    expect(mentionTokenBudget(null)).toBe(8_000);
    expect(mentionTokenBudget(undefined)).toBe(8_000);
    // 小窗口不会被单次 @ 吃掉太多
    expect(mentionTokenBudget(32_000)).toBe(2_000);
    expect(mentionTokenBudget(128_000)).toBe(6_400);
    expect(mentionTokenBudget(200_000)).toBe(10_000);
    // 大窗口封顶，避免 @ 变成无限预算
    expect(mentionTokenBudget(1_000_000)).toBe(12_000);
  });
});

describe("buildFileMentionContext", () => {
  it("reads workspace files and skips paths outside the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "meowcode-mention-"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(root, "secret.txt"), "top secret", "utf8");
    await writeFile(path.join(workspace, "a.txt"), "file A", "utf8");

    const context = await buildFileMentionContext(workspace, "@a.txt @../secret.txt");
    expect(context).toContain('{"path":"a.txt"}');
    // 行号前缀与 read_file 一致，模型才能按行续读
    expect(context).toContain("1: file A");
    expect(context).not.toContain("top secret");
  });

  it("impersonates a read_file call so the model does not re-read", async () => {
    const workspace = await makeWorkspace();
    await writeFile(path.join(workspace, "a.ts"), "export const a = 1;", "utf8");

    const context = await buildFileMentionContext(workspace, "@a.ts");
    expect(context).toContain("Called the read_file tool with the following input");
    expect(context).toContain("Result of calling the read_file tool:");
    expect(context).toContain("1: export const a = 1;");
  });

  it("gives every mention a preview instead of dropping the tail", async () => {
    const workspace = await makeWorkspace();
    for (let index = 1; index <= 8; index += 1) {
      await writeFile(path.join(workspace, `f${index}.txt`), `content ${index}`, "utf8");
    }
    const text = Array.from({ length: 8 }, (_, index) => `@f${index + 1}.txt`).join(" ");
    const context = await buildFileMentionContext(workspace, text, { tokenBudget: 8_000 });

    // 旧实现到第 4 个文件就 break，后面 5 个静默消失
    for (let index = 1; index <= 8; index += 1) {
      expect(context).toContain(`{"path":"f${index}.txt"}`);
      expect(context).toContain(`content ${index}`);
    }
  });

  it("clips long files at a line boundary with a continuation hint", async () => {
    const workspace = await makeWorkspace();
    const lines = Array.from({ length: 300 }, (_, index) => `const value${index} = ${index};`);
    await writeFile(path.join(workspace, "big.ts"), lines.join("\n"), "utf8");

    const context = await buildFileMentionContext(workspace, "@big.ts", { tokenBudget: 800 });
    expect(context).toContain("1: const value0 = 0;");
    expect(context).toContain("more lines; use offset=");
    // 预算外的尾部内容不该出现
    expect(context).not.toContain("300: const value299 = 299;");
  });

  it("only references binary extensions by path", async () => {
    const workspace = await makeWorkspace();
    await writeFile(path.join(workspace, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const context = await buildFileMentionContext(workspace, "@logo.png");
    expect(context).toContain("Attached non-text file");
    expect(context).toContain('{"path":"logo.png"}');
  });

  it("falls back to a path reference when the sniffed head contains NUL", async () => {
    const workspace = await makeWorkspace();
    await writeFile(path.join(workspace, "blob.dat"), Buffer.from([0, 1, 2, 3]));

    const context = await buildFileMentionContext(workspace, "@blob.dat");
    expect(context).toContain("Attached non-text file");
  });

  it("leaves a placeholder for files already injected in this conversation", async () => {
    const workspace = await makeWorkspace();
    await writeFile(path.join(workspace, "a.ts"), "export const a = 1;", "utf8");
    await writeFile(path.join(workspace, "b.ts"), "export const b = 2;", "utf8");

    const context = await buildFileMentionContext(workspace, "@a.ts @b.ts", {
      seen: new Set(["a.ts"]),
    });
    expect(context).toContain("Already read earlier in this conversation");
    expect(context).not.toContain("export const a = 1;");
    expect(context).toContain("1: export const b = 2;");
  });

  it("re-injects a file that was edited after the earlier injection", async () => {
    const workspace = await makeWorkspace();
    const file = path.join(workspace, "a.ts");
    await writeFile(file, "export const a = 2;", "utf8");
    // runtime 用真实路径登记"改过的文件"；这里模拟同一套键
    const mutated = new Set([mentionPathKey(await realpath(file))]);

    const context = await buildFileMentionContext(workspace, "@a.ts", {
      seen: new Set(["a.ts"]),
      mutated,
    });
    // 旧内容已经过期：不能再给"已读"占位
    expect(context).not.toContain("Already read earlier");
    expect(context).toContain("1: export const a = 2;");
    // 新鲜内容进入历史后，失效标记被消费，避免之后每轮都全量重读
    expect(mutated.size).toBe(0);
  });
});

describe("collectInjectedPaths", () => {
  it("recovers injected paths from user messages only", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: 'The user referenced these workspace files with @mentions.\n{"path":"src/a.ts"}',
      },
      { role: "assistant", content: 'noise {"path":"src/ignored.ts"}' },
      {
        role: "user",
        content: 'Already read earlier in this conversation: {"path":"./src\\\\b.ts"}',
      },
    ];
    expect([...collectInjectedPaths(messages)].sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

/** 最小合法 PDF（每页一行文本），用于验证附件走 PDF 文本层通道。 */
function buildPdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const kids = pages.map((_, index) => `${4 + index * 2} 0 R`);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((text, index) => {
    const contentId = 5 + index * 2;
    objects[4 + index * 2] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let index = 1; index < objects.length; index += 1) {
    offsets[index] = Buffer.byteLength(out, "latin1");
    out += `${index} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let index = 1; index < objects.length; index += 1) {
    out += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("extractAttachmentPaths", () => {
  it("reads attachment lines from the head block only", () => {
    const text = [
      "【附件】a.ts · D:/outside/a.ts",
      "【技能引用】skill · demo",
      "",
      "正文里手打的不算：",
      "【附件】evil · /etc/passwd",
    ].join("\n");
    expect(extractAttachmentPaths(text)).toEqual(["D:/outside/a.ts"]);
  });

  it("keeps a command header above the attachment lines", () => {
    const text = "【插件命令】部署 · p · deploy\n【附件】b.log · D:/logs/b.log\n\n/deploy now";
    expect(extractAttachmentPaths(text)).toEqual(["D:/logs/b.log"]);
  });

  it("deduplicates and ignores empty paths", () => {
    const text = ["【附件】a · D:/a.ts", "【附件】a · D:/a.ts", "【附件】blank ·  "].join("\n");
    expect(extractAttachmentPaths(text)).toEqual(["D:/a.ts"]);
  });

  it("returns nothing when there are no attachment lines", () => {
    expect(extractAttachmentPaths("普通消息")).toEqual([]);
  });
});

describe("buildFileMentionContext attachments", () => {
  const OUTSIDE = path.join(tmpdir(), "meowcode-outside-attachment");

  async function makeOutsideFile(name: string, content: string): Promise<string> {
    await mkdir(OUTSIDE, { recursive: true });
    const file = path.join(OUTSIDE, name);
    await writeFile(file, content);
    return file;
  }

  it("inlines a text file that lives outside the workspace", async () => {
    const file = await makeOutsideFile("outside.ts", "export const answer = 42;\n");
    const workspace = await makeWorkspace();
    const context = await buildFileMentionContext(
      workspace,
      `【附件】outside.ts · ${file}\n\n解释这个文件`,
    );
    expect(context).toBeTruthy();
    expect(context).toContain("export const answer = 42;");
    expect(context).toContain(JSON.stringify({ path: file }));
  });

  it("keeps @mentions restricted to the workspace", async () => {
    const file = await makeOutsideFile("secret.ts", "TOPSECRET\n");
    const workspace = await makeWorkspace();
    const context = await buildFileMentionContext(workspace, `@${file}`);
    expect(context).toBeNull();
  });

  it("does not inline the same file twice (attachment wins over @mention)", async () => {
    const file = await makeOutsideFile("dup.ts", "DUPLICATE-CONTENT\n");
    const workspace = await makeWorkspace();
    const context = await buildFileMentionContext(workspace, `【附件】dup.ts · ${file}\n\n@${file}`);
    expect(context?.match(/DUPLICATE-CONTENT/g)).toHaveLength(1);
  });

  it("extracts the text layer of an attached PDF", async () => {
    const file = await makeOutsideFile(
      "report.pdf",
      buildPdf(["alpha ".repeat(40), "beta ".repeat(40)]).toString("latin1"),
    );
    const workspace = await makeWorkspace();
    const context = await buildFileMentionContext(
      workspace,
      `【附件】report.pdf · ${file}\n\n总结这份报告`,
    );
    expect(context).toContain("[page 1]");
    expect(context).toContain("[page 2]");
    expect(context).toContain("beta beta");
  });

  it("only gives a path reference for a scanned PDF outside the workspace", async () => {
    const file = await makeOutsideFile("scan.pdf", buildPdf(["", ""]).toString("latin1"));
    const workspace = await makeWorkspace();
    const context = await buildFileMentionContext(workspace, `【附件】scan.pdf · ${file}`);
    expect(context).toContain("scanned PDF with no usable text layer");
    expect(context).toContain("outside the workspace");
  });

  it("re-injects an outside attachment every turn (the model cannot reopen it)", async () => {
    const file = await makeOutsideFile("again.ts", "AGAIN-CONTENT\n");
    const workspace = await makeWorkspace();
    const text = `【附件】again.ts · ${file}\n\n继续`;
    const first = await buildFileMentionContext(workspace, text);
    expect(first).toContain("AGAIN-CONTENT");
    const second = await buildFileMentionContext(workspace, text, {
      seen: collectInjectedPaths([{ role: "user", content: first! }]),
    });
    expect(second).toContain("AGAIN-CONTENT");
    expect(second).not.toContain("Already read earlier");
  });

  it("uses the placeholder for a workspace attachment the tools can reopen", async () => {
    const workspace = await makeWorkspace();
    await writeFile(path.join(workspace, "inside.ts"), "INSIDE-CONTENT\n");
    const text = "【附件】inside.ts · inside.ts\n\n继续";
    const absolute = path.join(workspace, "inside.ts");
    const first = await buildFileMentionContext(workspace, `【附件】inside.ts · ${absolute}\n\n继续`);
    expect(first).toContain("INSIDE-CONTENT");
    const second = await buildFileMentionContext(
      workspace,
      `【附件】inside.ts · ${absolute}\n\n继续`,
      { seen: collectInjectedPaths([{ role: "user", content: first! }]) },
    );
    expect(second).toContain("Already read earlier in this conversation");
    expect(second).not.toContain("INSIDE-CONTENT");
    // 附件必须是绝对路径（相对路径会被忽略，避免"附件"绕过工作区守卫）
    expect(text).toContain("inside.ts");
    expect(await buildFileMentionContext(workspace, text)).toBeNull();
  });
});

describe("stripReferenceHeader / referenceLabel", () => {
  const text = [
    "【附件】report.pdf · D:/docs/report.pdf",
    "【附件】app.ts · D:/src/app.ts",
    "【技能引用】前端规范 · skill-1",
    "",
    "按规范重构一下",
  ].join("\n");

  it("returns the user's own words", () => {
    expect(stripReferenceHeader(text)).toBe("按规范重构一下");
  });

  it("keeps plain messages untouched", () => {
    expect(stripReferenceHeader("普通消息")).toBe("普通消息");
    expect(referenceLabel("普通消息")).toBe("");
  });

  it("returns an empty body for attachment-only messages", () => {
    const only = "【附件】a.ts · D:/a.ts";
    expect(stripReferenceHeader(only)).toBe("");
    expect(referenceLabel(only)).toBe("附件：a.ts");
  });

  it("lists attachments, skills and plugins for the fallback label", () => {
    expect(referenceLabel(text)).toBe("附件：report.pdf、app.ts · 技能：前端规范");
    expect(referenceLabel("【插件命令】部署 · p · deploy\n\n/deploy")).toBe("插件：部署");
  });

  it("does not strip a body that merely looks like a reference block", () => {
    const body = "正文\n\n【附件】x · D:/x";
    expect(stripReferenceHeader(body)).toBe(body);
  });
});
