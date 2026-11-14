import { describe, expect, it } from "vitest";
import { extractPlanPreview } from "./plan-preview";

describe("extractPlanPreview", () => {
  it("标题取文档第一个 Markdown 标题，内容是后续行", () => {
    const doc = [
      "# 随手计划：给会话加一个「复制回复」按钮",
      "",
      "一句话：给助手消息加一个复制按钮。",
      "为什么是它：范围小、零新增依赖。",
      "## 目标",
      "完成后可以一键复制。",
    ].join("\n");
    const preview = extractPlanPreview(doc, "计划文档");
    expect(preview.title).toBe("随手计划：给会话加一个「复制回复」按钮");
    expect(preview.body).toContain("一句话：给助手消息加一个复制按钮。");
    expect(preview.body).toContain("为什么是它：范围小、零新增依赖。");
    expect(preview.title).not.toBe("计划文档");
  });

  it("没有标题时退回第一行，再没有才用文件名", () => {
    expect(extractPlanPreview("先做一件事\n再补一句", "2026-11-14-plan.md").title).toBe("先做一件事");
    expect(extractPlanPreview("\n\n", "2026-11-14-plan.md")).toEqual({
      title: "2026-11-14-plan.md",
      body: "",
    });
  });

  it("跳过 frontmatter、引用符号与分隔线", () => {
    const doc = ["---", "status: draft", "---", "# 真实标题", "> 引用内容", "---", "- 列表项"].join("\n");
    const preview = extractPlanPreview(doc, "fallback");
    expect(preview.title).toBe("真实标题");
    expect(preview.body).toContain("引用内容");
    expect(preview.body).toContain("列表项");
    expect(preview.body).not.toContain("status");
  });
});