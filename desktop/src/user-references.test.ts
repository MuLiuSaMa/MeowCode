import { describe, expect, it } from "vitest";
import { parsePluginCommandHeader, parseUserMessage, queuedPreview } from "./user-references";

describe("parseUserMessage", () => {
  it("returns a plain message untouched", () => {
    const parsed = parseUserMessage("你好，帮我看看这个项目");
    expect(parsed.command).toBeNull();
    expect(parsed.attachments).toEqual([]);
    expect(parsed.chips).toEqual([]);
    expect(parsed.body).toBe("你好，帮我看看这个项目");
  });

  it("extracts attachment cards from the head block", () => {
    const parsed = parseUserMessage(
      ["【附件】report.pdf · D:/docs/report.pdf", "【附件】a b.ts · /home/u/a b.ts", "", "总结一下"].join(
        "\n",
      ),
    );
    expect(parsed.attachments).toEqual([
      { name: "report.pdf", path: "D:/docs/report.pdf" },
      { name: "a b.ts", path: "/home/u/a b.ts" },
    ]);
    expect(parsed.body).toBe("总结一下");
  });

  it("keeps skills and plugins after attachments", () => {
    const parsed = parseUserMessage(
      [
        "【附件】a.ts · D:/a.ts",
        "【技能引用】前端规范 · skill-1",
        "【插件引用】部署 · plugin-1",
        "",
        "按规范改一下",
      ].join("\n"),
    );
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.chips).toEqual([
      { kind: "skill", id: "skill-1", name: "前端规范" },
      { kind: "plugin", id: "plugin-1", name: "部署" },
    ]);
    expect(parsed.body).toBe("按规范改一下");
  });

  it("parses a plugin command with attachments and hides the expanded body", () => {
    const content = [
      "【插件命令】部署服务 · plugin-deploy · deploy",
      "【附件】env · D:/app/.env",
      "",
      "/deploy --prod",
    ].join("\n");
    const parsed = parseUserMessage(content);
    expect(parsed.command).toEqual({
      name: "部署服务",
      pluginId: "plugin-deploy",
      command: "deploy",
    });
    expect(parsed.attachments).toEqual([{ name: "env", path: "D:/app/.env" }]);
    // 首部块之后的指令正文照常保留（UI 上 command chip 已经代表它）
    expect(parsed.body).toBe("/deploy --prod");
  });

  it("does not treat attachment-looking body lines as attachments", () => {
    const parsed = parseUserMessage("正文\n\n【附件】x · /etc/passwd");
    expect(parsed.attachments).toEqual([]);
    expect(parsed.body).toBe("正文\n\n【附件】x · /etc/passwd");
  });

  it("tolerates a missing blank separator", () => {
    const parsed = parseUserMessage("【附件】a.ts · D:/a.ts");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.body).toBe("");
  });

  it("keeps an empty attachment name usable", () => {
    const parsed = parseUserMessage("【附件】 · D:/a.ts\n\nhi");
    expect(parsed.attachments).toEqual([{ name: "D:/a.ts", path: "D:/a.ts" }]);
  });
});

describe("parsePluginCommandHeader", () => {
  it("requires name, plugin id and command", () => {
    expect(parsePluginCommandHeader("【插件命令】部署 · p · deploy")).toEqual({
      name: "部署",
      pluginId: "p",
      command: "deploy",
    });
    expect(parsePluginCommandHeader("【插件命令】部署 · p")).toBeNull();
    expect(parsePluginCommandHeader("普通消息")).toBeNull();
  });
});

describe("queuedPreview", () => {
  it("shows only the body when there is one", () => {
    expect(queuedPreview("【附件】a.ts · D:/a.ts\n\n改一下这个文件")).toBe("改一下这个文件");
  });

  it("falls back to reference names for attachment-only messages", () => {
    expect(queuedPreview("【附件】a.ts · D:/a.ts\n【附件】b.pdf · D:/b.pdf")).toBe(
      "a.ts · b.pdf",
    );
  });

  it("includes the command name when nothing else is written", () => {
    expect(queuedPreview("【插件命令】部署 · p · deploy\n\n/deploy")).toBe("/deploy");
  });

  it("returns plain content unchanged", () => {
    expect(queuedPreview("普通消息")).toBe("普通消息");
  });
});
