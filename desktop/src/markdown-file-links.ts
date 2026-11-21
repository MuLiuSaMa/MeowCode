import { inlineFileLabel, inlineFilePathOf } from "./file-links";
import { fileIconMarkup } from "./components/ui/FileIcon";

/**
 * 把正文里的行内代码文件路径替换成「文件元素」（类型图标 + 文件名）。
 *
 * 单独成模块的原因：这是纯 DOM 变换，不依赖 React 渲染管线，
 * 可以直接用 jsdom 单测，不用把整个聊天 Markdown 组件拉起来。
 */

/**
 * @param doc 已由 marked + DOMPurify 渲染好的文档
 * @param interactive 有右侧面板的宿主才渲染成按钮（否则是静态元素）
 * @returns 是否有代码块被替换
 */
export function decorateFileLinks(doc: Document, interactive: boolean): boolean {
  let touched = false;
  for (const code of Array.from(doc.querySelectorAll("code"))) {
    // 代码块里的内容不是「文中提到的文件」：整段源码保持原样
    if (code.closest("pre")) continue;
    const path = inlineFilePathOf(code.textContent ?? "");
    if (!path) continue;
    const chip = doc.createElement(interactive ? "button" : "span");
    chip.className = "mc-mdfile";
    chip.title = path;
    if (interactive) {
      chip.setAttribute("type", "button");
      chip.setAttribute("data-open-file", path);
    }
    chip.innerHTML = `${fileIconMarkup(path, 12)}<span class="mc-mdfile__name"></span>`;
    const name = chip.querySelector(".mc-mdfile__name");
    if (name) name.textContent = inlineFileLabel(path);
    code.replaceWith(chip);
    touched = true;
  }
  return touched;
}