import { describe, expect, it } from "vitest";
import { PLUGIN_UI_SLOTS } from "../../ui-slots.js";
import { pluginAuthoringGuide } from "./guide.js";

describe("pluginAuthoringGuide", () => {
  it("all 覆盖后端、界面、整页与示例", () => {
    const all = pluginAuthoringGuide("all");
    expect(all).toContain("api.registerTool");
    expect(all).toContain("api.registerRpc");
    expect(all).toContain("ctx.slots.register");
    expect(all).toContain("ctx.pages.register");
    expect(all).toContain("message.toolCard");
    expect(all).toContain("shell.root");
    expect(all).toContain("openPage");
    expect(all).toContain("不要读仓库源码");
  });

  it("分节返回对应内容，未知 section 回退 all", () => {
    expect(pluginAuthoringGuide("backend")).toContain("api.registerCommand");
    expect(pluginAuthoringGuide("client")).toContain("ctx.slots.register");
    expect(pluginAuthoringGuide("slots")).toContain("session.header.actions");
    expect(pluginAuthoringGuide("pages")).toContain("ctx.pages.register");
    expect(pluginAuthoringGuide("examples")).toContain("api.registerRpc");
    expect(pluginAuthoringGuide("unknown" as "all")).toBe(pluginAuthoringGuide("all"));
  });

  it("slots 分区覆盖目录里的全部槽位与自动生成的挂载示例", () => {
    const slots = pluginAuthoringGuide("slots");
    for (const slot of PLUGIN_UI_SLOTS) {
      expect(slots).toContain(`\`${slot.name}\``);
    }
    expect(slots).toContain("list");
    expect(slots).toContain("keyed");
    expect(slots).toContain("single");
    expect(slots).toContain("wrap");
    expect(slots).toContain("ctx.tabs.register");
    expect(slots).toContain("shell.overlay");
  });

  it("示例使用真实 API，不出现占位式调用", () => {
    const examples = pluginAuthoringGuide("examples");
    expect(examples).toContain("api.registerCommand({");
    expect(examples).not.toContain("api.command?");
  });
});
