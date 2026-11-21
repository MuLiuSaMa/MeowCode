// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { decorateFileLinks } from "./markdown-file-links";

function render(html: string, interactive = true): Document {
  const doc = new DOMParser().parseFromString(html, "text/html");
  decorateFileLinks(doc, interactive);
  return doc;
}

describe("decorateFileLinks", () => {
  it("行内代码里的文件路径 → 可点击的文件元素", () => {
    const doc = render('<p>改了 <code>desktop/src/island/IslandApp.tsx</code> 这个文件</p>');
    const chip = doc.querySelector(".mc-mdfile");
    expect(chip).not.toBeNull();
    expect(chip?.tagName).toBe("BUTTON");
    expect(chip?.getAttribute("data-open-file")).toBe("desktop/src/island/IslandApp.tsx");
    expect(chip?.getAttribute("type")).toBe("button");
    expect(chip?.getAttribute("title")).toBe("desktop/src/island/IslandApp.tsx");
    // 只显示文件名，不显示整条路径
    expect(chip?.querySelector(".mc-mdfile__name")?.textContent).toBe("IslandApp.tsx");
    expect(chip?.textContent).toBe("IslandApp.tsx");
    // 图标按语法类型注入品牌色
    const icon = chip?.querySelector("svg.mc-fileicon");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("style")).toContain("--file-tint");
  });

  it("命令 / 函数名 / 版本号保持代码样式", () => {
    const doc = render(
      "<p><code>pnpm typecheck</code> <code>run_powercfg</code> <code>v1.2.3</code></p>",
    );
    expect(doc.querySelectorAll(".mc-mdfile")).toHaveLength(0);
    expect(doc.querySelectorAll("code")).toHaveLength(3);
  });

  it("代码块里的路径不动", () => {
    const doc = render("<pre><code>src/App.tsx\nfoo.ts</code></pre>");
    expect(doc.querySelectorAll(".mc-mdfile")).toHaveLength(0);
    expect(doc.querySelector("pre > code")?.textContent).toBe("src/App.tsx\nfoo.ts");
  });

  it("没有右侧面板时渲染成静态元素而不是按钮", () => {
    const doc = render("<p><code>island.css</code></p>", false);
    const chip = doc.querySelector(".mc-mdfile");
    expect(chip?.tagName).toBe("SPAN");
    expect(chip?.hasAttribute("data-open-file")).toBe(false);
    expect(chip?.textContent).toBe("island.css");
  });

  it("同一段正文里文件和普通代码混合时各归各的", () => {
    const doc = render(
      "<ul><li><code>src-tauri/src/optimization.rs</code></li><li><code>cargo check</code></li><li><code>README.md</code></li></ul>",
    );
    const chips = Array.from(doc.querySelectorAll(".mc-mdfile"));
    expect(chips).toHaveLength(2);
    expect(chips.map((chip) => chip.getAttribute("data-open-file"))).toEqual([
      "src-tauri/src/optimization.rs",
      "README.md",
    ]);
    expect(doc.querySelectorAll("code")).toHaveLength(1);
    expect(doc.querySelector("code")?.textContent).toBe("cargo check");
  });
});