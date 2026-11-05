import { describe, expect, it } from "vitest";
import { BUILTIN_PLUGIN_META, builtinDetailFallback, builtinMeta, iconSvgToDataUrl } from "./builtin-meta";

describe("builtin 插件元数据", () => {
  it("claude-code-hooks 有显示名、介绍、图标与详情", () => {
    const meta = builtinMeta("claude-code-hooks");
    expect(meta).toBeDefined();
    expect(meta!.displayName).toBe("Claude Code hooks 桥接");
    expect(meta!.description.length).toBeGreaterThan(20);
    expect(meta!.iconSvg.startsWith("<svg")).toBe(true);
    expect(meta!.iconSvg).toContain('viewBox="0 0 48 48"');
    // Claude 十二芒星：12 条射线 + 品牌橙
    expect(meta!.iconSvg).toContain("#D97757");
    expect(meta!.iconSvg.match(/M24 24L/g)).toHaveLength(12);
    // 详情：事件映射表与退出码语义
    expect(meta!.detail).toContain("PreToolUse");
    expect(meta!.detail).toContain("settings.json");
    expect(meta!.detail.length).toBeGreaterThan(200);
  });

  it("computer-control 有显示名、介绍、图标与详情", () => {
    const meta = builtinMeta("computer-control");
    expect(meta).toBeDefined();
    expect(meta!.displayName).toBe("电脑控制");
    expect(meta!.description.length).toBeGreaterThan(20);
    expect(meta!.iconSvg.startsWith("<svg")).toBe(true);
    expect(meta!.iconSvg).toContain('viewBox="0 0 48 48"');
    expect(meta!.iconSvg).toContain("#4CC2FF");
    expect(meta!.detail).toContain("computer_screenshot");
    expect(meta!.detail).toContain("computer_click");
    expect(meta!.detail).toContain("授权");
    expect(meta!.detail.length).toBeGreaterThan(200);
    expect(BUILTIN_PLUGIN_META["computer-control"].tags).toContain("computer");
  });

  it("未知 id 返回 undefined", () => {
    expect(builtinMeta("nope")).toBeUndefined();
  });

  it("iconSvgToDataUrl 产出可解码的 base64 dataUrl", () => {
    const url = iconSvgToDataUrl(BUILTIN_PLUGIN_META["claude-code-hooks"].iconSvg);
    expect(url.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const decoded = Buffer.from(url.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8");
    expect(decoded).toBe(BUILTIN_PLUGIN_META["claude-code-hooks"].iconSvg);
  });
});

describe("builtinDetailFallback", () => {
  it("内置 id 合成市场条目 + 详情 markdown", () => {
    const result = builtinDetailFallback("claude-code-hooks");
    expect(result).not.toBeNull();
    expect(result!.item).toMatchObject({
      id: "claude-code-hooks",
      type: "plugin",
      name: "Claude Code hooks 桥接",
      category: "内置",
      source: "builtin",
    });
    expect(result!.detail).toContain("PreToolUse");
  });

  it("非内置 id 返回 null（不走兜底，让市场自己报 not_found）", () => {
    expect(builtinDetailFallback("ghost")).toBeNull();
    expect(builtinDetailFallback("demo-plugin")).toBeNull();
  });
});
