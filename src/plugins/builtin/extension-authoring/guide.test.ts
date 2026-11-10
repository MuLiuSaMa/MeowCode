import { describe, expect, it } from "vitest";
import { pluginAuthoringGuide } from "./guide.js";

describe("pluginAuthoringGuide", () => {
  it("all 覆盖后端、界面、整页与示例", () => {
    const all = pluginAuthoringGuide("all");
    expect(all).toContain("api.registerTool");
    expect(all).toContain("api.registerRpc");
    expect(all).toContain("ctx.slots.register");
    expect(all).toContain("ctx.pages.register");
    expect(all).toContain("message.toolCard");
    expect(all).toContain("openPage");
    expect(all).toContain("不要读仓库源码");
  });

  it("分节返回对应内容，未知 section 回退 all", () => {
    expect(pluginAuthoringGuide("backend")).toContain("api.registerCommand");
    expect(pluginAuthoringGuide("client")).toContain("session.header.actions");
    expect(pluginAuthoringGuide("pages")).toContain("ctx.pages.register");
    expect(pluginAuthoringGuide("examples")).toContain("api.registerRpc");
    expect(pluginAuthoringGuide("unknown" as "all")).toBe(pluginAuthoringGuide("all"));
  });

  it("示例使用真实 API，不出现占位式调用", () => {
    const examples = pluginAuthoringGuide("examples");
    expect(examples).toContain("api.registerCommand({");
    expect(examples).not.toContain("api.command?");
  });
});
