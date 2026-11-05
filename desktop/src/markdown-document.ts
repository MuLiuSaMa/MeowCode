import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import anchor from "markdown-it-anchor";
import footnote from "markdown-it-footnote";
import deflist from "markdown-it-deflist";
import mark from "markdown-it-mark";
import sub from "markdown-it-sub";
import sup from "markdown-it-sup";
import ins from "markdown-it-ins";
import abbr from "markdown-it-abbr";
import container from "markdown-it-container";
import githubAlerts from "markdown-it-github-alerts";
import texmath from "markdown-it-texmath";
import multimdTable from "markdown-it-multimd-table";
import implicitFigures from "markdown-it-implicit-figures";
import attrs from "markdown-it-attrs";
import linkAttributes from "markdown-it-link-attributes";
import { full as emoji } from "markdown-it-emoji";
import katex from "katex";
import DOMPurify from "dompurify";
import { highlightHtml } from "./code-highlight";

/**
 * 文档级 Markdown 渲染（文件预览 / 计划页签）。
 *
 * 与聊天的 marked 渲染分开：文档预览要完整支持 OpenMD 同款能力 ——
 * KaTeX 公式（行内/块级/环境）、原始 HTML 标签、脚注、定义列表、告警、
 * 多行表格、任务列表、emoji、Mermaid（由组件异步接管）。
 *
 * 安全边界沿用 OpenMD 的宽消毒策略，但额外禁掉 style/link/meta/base：
 * 文档里的 CSS 不能改整个应用界面，脚本、事件属性和 srcdoc 一律移除。
 */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function stripBom(source: string): string {
  return source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
}

/** 去掉开头的 YAML frontmatter：预览只展示正文，不把元数据当内容渲染。 */
export function stripFrontmatter(source: string): string {
  const text = stripBom(source);
  const match = text.match(FRONTMATTER_RE);
  return match ? text.slice(match[0].length) : text;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function highlightCode(code: string, lang: string): string {
  // Mermaid 交给组件的异步渲染器，不能先按代码高亮
  if (lang.toLowerCase() === "mermaid") return escapeHtml(code);
  return highlightHtml(code, lang || undefined);
}

let iframeHookInstalled = false;

function installIframeHook(): void {
  if (iframeHookInstalled) return;
  iframeHookInstalled = true;
  DOMPurify.addHook("uponSanitizeElement", (node) => {
    if (!(node instanceof Element) || node.tagName.toLowerCase() !== "iframe") return;
    node.setAttribute("sandbox", "allow-same-origin");
    node.setAttribute("referrerpolicy", "no-referrer");
  });
}

/**
 * 宽消毒：未知 HTML 标签也保留（badge、<kbd>、<details> 等），
 * 但脚本、事件属性、srcdoc、危险协议和全局样式标签都不放行。
 */
export function sanitizeDocumentHtml(raw: string): string {
  installIframeHook();
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true, mathMl: true, svg: true },
    ADD_TAGS: () => true,
    ADD_ATTR: (name) => !/^on/i.test(name) && name.toLowerCase() !== "srcdoc",
    FORBID_TAGS: ["script", "style", "link", "meta", "base"],
    FORBID_ATTR: ["srcdoc"],
    ALLOW_UNKNOWN_PROTOCOLS: false,
    KEEP_CONTENT: true,
  }) as string;
}

let renderer: InstanceType<typeof MarkdownIt> | null = null;

function makeRenderer(): InstanceType<typeof MarkdownIt> {
  const instance = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
    highlight: (code, lang) => highlightCode(code, lang),
  });

  instance.use(taskLists, { enabled: false, label: true });
  instance.use(footnote);
  instance.use(deflist);
  instance.use(mark);
  instance.use(sub);
  instance.use(sup);
  instance.use(ins);
  instance.use(abbr);
  instance.use(texmath, {
    engine: katex,
    delimiters: ["dollars", "brackets", "beg_end"],
    katexOptions: { throwOnError: false, strict: "ignore" },
  });
  instance.use(emoji);
  instance.use(githubAlerts, { markers: "*" });
  instance.use(container, "admonition");
  instance.use(multimdTable, {
    multiline: true,
    rowspan: true,
    headerless: true,
    multibody: true,
    autolabel: true,
  });
  instance.use(implicitFigures, { figcaption: true, link: false });
  // markdown-it-attrs 的类型没有暴露 allowedAttributes，这里按其运行时约定传参
  instance.use(attrs as never, {
    allowedAttributes: [
      "id",
      "class",
      "style",
      "width",
      "height",
      "align",
      "title",
      "target",
      "rel",
    ],
  } as never);
  instance.use(linkAttributes, {
    matcher: (href: string) => /^(?:https?:)?\/\//i.test(href),
    attrs: { target: "_blank", rel: "noopener noreferrer" },
  });
  instance.use(anchor, {
    // 保留 CJK：[^\p{L}\p{N}] 会把中文标题清成空 slug
    slugify: (value: string) =>
      value
        .toLowerCase()
        .trim()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/\s+/g, "-"),
  });
  return instance;
}

export type MarkdownDocumentRender = {
  html: string;
  wordCount: number;
};

export function renderMarkdownDocument(markdown: string): MarkdownDocumentRender {
  if (!renderer) renderer = makeRenderer();
  const content = stripFrontmatter(markdown ?? "");
  const wordCount = content.trim().split(/\s+/).filter(Boolean).length;
  return {
    html: sanitizeDocumentHtml(renderer.render(content)),
    wordCount,
  };
}
