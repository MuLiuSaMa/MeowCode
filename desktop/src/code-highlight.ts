/**
 * 语法高亮：highlight.js（core + 按需注册），主题色走 CSS 令牌（--code-tok-*，
 * 见 theme/tokens.css 与 theme/code-highlight.css），深浅主题自动适配。
 *
 * 文件预览需要「按行渲染」（行号列逐行对齐），而 hljs 的 span 会跨行——
 * highlightToLines 把高亮 HTML 按换行拆成每行独立 HTML：跨行的 span 在行尾闭合、
 * 在下一行重新打开，多行注释/模板字符串的着色因此逐行保留。
 */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import less from "highlight.js/lib/languages/less";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGS: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  bash,
  c,
  cpp,
  csharp,
  css,
  dockerfile,
  diff,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  less,
  lua,
  makefile,
  markdown,
  php,
  powershell,
  python,
  ruby,
  rust,
  scss,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};
for (const [id, def] of Object.entries(LANGS)) hljs.registerLanguage(id, def);

/** 扩展名 → hljs 语言 id；识别不出返回 undefined（走 auto/纯文本） */
const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  json: "json",
  jsonc: "json",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  cs: "csharp",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "powershell",
  psm1: "powershell",
  yml: "yaml",
  yaml: "yaml",
  md: "markdown",
  markdown: "markdown",
  sql: "sql",
  php: "php",
  rb: "ruby",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  swift: "swift",
  lua: "lua",
  diff: "diff",
  patch: "diff",
};

/** 超过这个长度的文本不做高亮（DOM 拆行是 O(节点) 的，大文件没必要拖慢渲染） */
const MAX_HIGHLIGHT_CHARS = 512 * 1024;
/** auto 探测只看前缀；relevance 太低视为纯文本 */
const AUTO_SAMPLE_CHARS = 4_096;
const AUTO_MIN_RELEVANCE = 5;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 文件名/扩展名 → 语言 id；Dockerfile/Makefile 这类无扩展名文件按文件名识别 */
export function languageForFile(filePath: string): string | undefined {
  const name = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile" || name === "gnumakefile") return "makefile";
  const ext = name.includes(".") ? (name.split(".").pop() ?? "") : "";
  return LANG_BY_EXT[ext];
}

function resolveLanguage(code: string, hint: string | undefined): string | null {
  if (hint) {
    // 直接语言 id（"json"/"ts" 等 Markdown language-* 类）优先，其次按文件路径取扩展名
    if (hljs.getLanguage(hint)) return hint;
    const byExt = languageForFile(hint);
    if (byExt && hljs.getLanguage(byExt)) return byExt;
  }
  const sample = code.slice(0, AUTO_SAMPLE_CHARS);
  const auto = hljs.highlightAuto(sample);
  return auto.relevance >= AUTO_MIN_RELEVANCE ? (auto.language ?? null) : null;
}

/** 高亮整段代码 → 单份 HTML（span class 走 hljs-*，颜色在 CSS 令牌里配主题） */
export function highlightHtml(code: string, filePath?: string): string {
  if (!code || code.length > MAX_HIGHLIGHT_CHARS) return escapeHtml(code);
  try {
    const language = resolveLanguage(code, filePath);
    if (!language) return escapeHtml(code);
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

/**
 * 高亮并按 \n 拆成每行 HTML（返回数组长度恒等于代码行数）。
 * 跨行的 hljs span 在行尾补闭合、下一行行首重开——多行注释/字符串逐行保持颜色。
 */
export function highlightToLines(code: string, filePath?: string): string[] {
  if (!code) return [];
  if (code.length > MAX_HIGHLIGHT_CHARS) return code.split("\n").map(escapeHtml);
  let html: string;
  try {
    const language = resolveLanguage(code, filePath);
    html = language
      ? hljs.highlight(code, { language, ignoreIllegals: true }).value
      : escapeHtml(code);
  } catch {
    return code.split("\n").map(escapeHtml);
  }

  if (typeof DOMParser === "undefined") {
    // 非 DOM 环境（vitest node）：退回纯转义的逐行文本（渲染进程总有 DOMParser）
    return code.split("\n").map(escapeHtml);
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  const lines: string[] = [];
  let current = "";
  const pushLine = () => {
    lines.push(current);
    current = "";
  };

  const walk = (node: Node, openTags: string[]): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const parts = (node.textContent ?? "").split("\n");
      for (let index = 0; index < parts.length; index += 1) {
        if (index > 0) {
          // 行尾闭合本行打开的 span，下一行行首按原嵌套重开
          current += openTags.map(() => "</span>").join("");
          pushLine();
          current += openTags.join("");
        }
        current += escapeHtml(parts[index]);
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    const tag = `<span class="${element.className}">`;
    current += tag;
    for (const child of Array.from(element.childNodes)) walk(child, [...openTags, tag]);
    current += "</span>";
  };

  for (const child of Array.from(doc.body.childNodes)) walk(child, []);
  pushLine();
  return lines;
}
