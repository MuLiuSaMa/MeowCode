import { memo, useLayoutEffect, useMemo, useRef, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { renderMarkdown } from "../../api";
import { escapeHtml, highlightHtml } from "../../code-highlight";
import { decorateFileLinks } from "../../markdown-file-links";
import {
  splitMarkdownBlocks,
  splitStreamingMarkdown,
  type StreamingMarkdownParts,
} from "../../streaming-markdown";
import "./Markdown.css";

/** 聊天代码块上限：流式期间每个增量都会重渲染，过大的块不做高亮 */
const MAX_MARKDOWN_CODE_CHARS = 32_000;

/** 水墨晕染的收干时长，必须与 Markdown.css 的 .mc-ink 动画时长一致 */
const INK_DURATION_MS = 460;

const COPY_ICON = `<svg class="mc-mdcode__icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
const COPIED_ICON = `<svg class="mc-mdcode__icon mc-mdcode__icon--done" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"/></svg>`;

/**
 * marked 产出的 pre>code 逐块做语法高亮（语言来自 language-* 类），
 * 并给每个代码块加右上角复制按钮；行内代码里的文件路径转成文件元素。
 * 输入已经过 DOMPurify 消毒；hljs 输出的 span/class 是安全的。
 */
function decorateMarkdown(html: string, copyLabel: string, interactive: boolean): string {
  if (!html.includes("<pre") && !html.includes("<code")) return html;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    let touched = decorateFileLinks(doc, interactive);
    for (const code of Array.from(doc.querySelectorAll("pre > code"))) {
      const text = code.textContent ?? "";
      if (!text.trim() || text.length > MAX_MARKDOWN_CODE_CHARS) continue;
      const langClass = /language-([\w-]+)/.exec(code.className)?.[1];
      code.innerHTML = highlightHtml(text, langClass);
      touched = true;
    }
    for (const pre of Array.from(doc.querySelectorAll("pre"))) {
      const wrapper = doc.createElement("div");
      wrapper.className = "mc-mdcode";
      pre.replaceWith(wrapper);
      wrapper.appendChild(pre);
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "mc-mdcode__copy";
      button.setAttribute("data-copy-code", "");
      button.setAttribute("aria-label", copyLabel);
      button.title = copyLabel;
      button.innerHTML = `${COPY_ICON}${COPIED_ICON}`;
      wrapper.appendChild(button);
      touched = true;
    }
    return touched ? doc.body.innerHTML : html;
  } catch {
    return html;
  }
}

/** 未闭合围栏按纯文本渲染：不做高亮、不加复制按钮，闭合后由完整渲染接管。 */
function renderOpenFence(parts: NonNullable<StreamingMarkdownParts["openFence"]>): string {
  const className = parts.lang ? ` class="language-${parts.lang}"` : "";
  return `<pre><code${className}>${escapeHtml(parts.body)}</code></pre>`;
}

/**
 * 稳定块的 HTML 缓存。
 *
 * 流式回答每推进一个段落边界，「稳定区」就整体变长一次。如果每次都从头
 * marked + DOMPurify + hljs，长回答的总成本近似 O(n²)。按块缓存后，每块只在
 * 自己第一次出现时渲染一次。
 *
 * key 直接包含块文本：字符串哈希是 O(n)，但比 marked + hljs 便宜两个数量级，
 * 并且能保证「同文本 ⇒ 同 HTML」。LRU 用 Map 的插入序做，够用且无需额外结构。
 *
 * 同时限制条数与 HTML 字符总量：单个 32k 代码块高亮后可能上百 KB，
 * 只按条数淘汰（240 条）在极端情况下会留下几十 MB 字符串。
 */
const blockHtmlCache = new Map<string, string>();
const BLOCK_HTML_CACHE_LIMIT = 240;
const BLOCK_HTML_CACHE_CHARS = 2_000_000;
let blockHtmlCacheChars = 0;

function renderMarkdownBlockCached(
  text: string,
  copyLabel: string,
  interactive: boolean,
): string {
  const key = `${interactive ? "1" : "0"}\u0000${copyLabel}\u0000${text}`;
  const cached = blockHtmlCache.get(key);
  if (cached !== undefined) return cached;
  const html = decorateMarkdown(renderMarkdown(text), copyLabel, interactive);
  blockHtmlCache.set(key, html);
  blockHtmlCacheChars += html.length;
  while (
    blockHtmlCache.size > 0 &&
    (blockHtmlCache.size > BLOCK_HTML_CACHE_LIMIT || blockHtmlCacheChars > BLOCK_HTML_CACHE_CHARS)
  ) {
    const oldest = blockHtmlCache.keys().next().value;
    if (oldest === undefined) break;
    blockHtmlCacheChars -= blockHtmlCache.get(oldest)?.length ?? 0;
    blockHtmlCache.delete(oldest);
  }
  return html;
}

/**
 * 水墨晕染：把 [start, end) 的文本按「出生批次」拆成若干 .mc-ink 段，
 * 每段用负的动画延迟把「已经存活了多久」接回去 —— 流式每个增量都会整块
 * 重写尾部 innerHTML、动画节点必然重建，靠 delay 续上进度才不会重播/闪烁。
 * 只拆文本节点、不搬元素结构，行内代码 / 文件胶囊 / 链接都保持原样。
 */
type InkRun = { start: number; end: number; ageMs: number };

function wrapInkRuns(root: HTMLElement, runs: InkRun[]): void {
  // 先收集所有文本节点及其起始下标：拆分节点会改变遍历结果
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Array<{ node: Text; start: number }> = [];
  let offset = 0;
  let current = walker.nextNode();
  while (current) {
    const node = current as Text;
    nodes.push({ node, start: offset });
    offset += node.data.length;
    current = walker.nextNode();
  }
  for (const { node, start } of nodes) {
    const nodeEnd = start + node.data.length;
    // 从后往前拆，前面的本地偏移不会被 splitText 影响
    for (let index = runs.length - 1; index >= 0; index -= 1) {
      const run = runs[index];
      const from = Math.max(run.start, start);
      const to = Math.min(run.end, nodeEnd);
      if (to <= from) continue;
      const localFrom = from - start;
      const localTo = to - start;
      const suffix = localFrom > 0 ? node.splitText(localFrom) : node;
      if (localTo - localFrom < suffix.data.length) suffix.splitText(localTo - localFrom);
      const span = document.createElement("span");
      span.className = "mc-ink";
      span.style.animationDelay = `-${Math.round(run.ageMs)}ms`;
      suffix.parentNode?.replaceChild(span, suffix);
      span.appendChild(suffix);
    }
  }
}

/**
 * 稳定区的一个块。html 没变时 React.memo 直接跳过，DOM 也不重建 ——
 * 这是把流式渲染从「每次增量重排全文」压到「只重排最后一块」的关键。
 */
const MarkdownBlock = memo(function MarkdownBlock({
  html,
  ink = false,
}: {
  html: string;
  /** 流式尾部：新到的字走水墨晕染 */
  ink?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  /** 上一次提交后的纯文本：与本次求公共前缀，前缀之后就是新到的字 */
  const prevTextRef = useRef("");
  /** 每个字符的出生时间：DOM 重建后用它还原动画进度 */
  const birthsRef = useRef<number[]>([]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const text = el.textContent ?? "";
    const prev = prevTextRef.current;
    prevTextRef.current = text;
    if (!ink || text === prev) return;
    const now = performance.now();
    const max = Math.min(prev.length, text.length);
    let prefix = 0;
    while (prefix < max && prev.charCodeAt(prefix) === text.charCodeAt(prefix)) prefix += 1;
    // 前缀的字沿用出生时间；整段被换掉（换块 / 重连回填）就当这批全新生
    const births = prefix === 0 && prev.length > 0 ? [] : birthsRef.current.slice(0, prefix);
    while (births.length < text.length) births.push(now);
    birthsRef.current = births;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    // 还在收干窗口里的字才包：从后往前找第一个没到期的字符
    let start = text.length;
    while (start > 0 && now - births[start - 1] < INK_DURATION_MS) start -= 1;
    if (start >= text.length) return;
    // 同一批（同一时刻出生）的字共用一个进度，跨批必须拆段，否则老批次的
    // 延迟会把新批次一起提前收干
    const runs: InkRun[] = [];
    let index = start;
    while (index < text.length) {
      const birth = births[index];
      let next = index + 1;
      while (next < text.length && births[next] === birth) next += 1;
      runs.push({ start: index, end: next, ageMs: now - birth });
      index = next;
    }
    wrapInkRuns(el, runs);
  }, [html, ink]);
  return (
    <div ref={ref} className="mc-mdblock" dangerouslySetInnerHTML={{ __html: html }} />
  );
});

export function Markdown({
  content,
  className,
  streaming,
  onOpenFile,
}: {
  content: string;
  className?: string;
  /** 流式输出：稳定块复用上次 HTML，只重解析尾部 */
  streaming?: boolean;
  /** 点击正文里的文件元素 → 宿主打开右侧面板（不传则渲染成不可点的静态元素） */
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useTranslation("common");
  const copyLabel = t("copyCode");
  /** 入口回调可能每次渲染都换引用，但 HTML 只按「有没有」决定可不可点 */
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const interactive = Boolean(onOpenFile);
  const parts = useMemo(
    () => (streaming ? splitStreamingMarkdown(content ?? "") : null),
    [content, streaming],
  );
  const stable = parts?.stable ?? "";
  const tail = parts?.tail ?? "";
  const openFence = parts?.openFence;
  const fullHtml = useMemo(
    () =>
      streaming ? "" : decorateMarkdown(renderMarkdown(content ?? ""), copyLabel, interactive),
    [content, copyLabel, streaming, interactive],
  );
  const stableBlocks = useMemo(() => {
    if (!streaming || !stable) return [];
    // 每个块单独渲染并缓存：稳定区只会在尾部增长，前面的块命中缓存后不再重算
    return splitMarkdownBlocks(stable).map((block) =>
      renderMarkdownBlockCached(block, copyLabel, interactive),
    );
  }, [streaming, stable, copyLabel, interactive]);
  const tailHtml = useMemo(() => {
    if (!streaming) return "";
    if (openFence) return renderOpenFence(openFence);
    return decorateMarkdown(renderMarkdown(tail), copyLabel, interactive);
  }, [streaming, openFence, tail, copyLabel, interactive]);

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    /* 正文里的文件元素：打开右侧文件页签（路径来自渲染时写进 data 属性的相对路径） */
    const fileButton = target.closest("button[data-open-file]") as HTMLButtonElement | null;
    if (fileButton) {
      const path = fileButton.dataset.openFile ?? "";
      if (path) {
        event.preventDefault();
        onOpenFileRef.current?.(path);
      }
      return;
    }

    const copyButton = target.closest("button[data-copy-code]") as HTMLButtonElement | null;
    if (copyButton) {
      const code = copyButton.parentElement?.querySelector("pre")?.textContent ?? "";
      const clipboard = navigator.clipboard;
      if (!code || !clipboard) return;
      void clipboard
        .writeText(code)
        .then(() => {
          copyButton.setAttribute("data-copied", "true");
          copyButton.setAttribute("aria-label", t("copied"));
          copyButton.title = t("copied");
          window.setTimeout(() => {
            if (!copyButton.isConnected) return;
            delete copyButton.dataset.copied;
            copyButton.setAttribute("aria-label", copyLabel);
            copyButton.title = copyLabel;
          }, 1600);
        })
        .catch(() => undefined);
      return;
    }

    /* 聊天里的链接不在应用窗口内跳转：http/https 交系统浏览器 */
    const anchor = target.closest?.("a");
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) void window.meow.openExternal(href);
  };

  const shellClass = ["mc-markdown", className ?? ""].filter(Boolean).join(" ");

  // 流式：稳定区按块渲染，未变化的块由 memo 跳过；尾部单独一块。
  // 非流式保持原来的单容器 innerHTML，避免影响工具视图等依赖直接子选择器的样式。
  if (streaming) {
    return (
      <div className={shellClass} onClick={handleClick}>
        {stableBlocks.map((blockHtml, index) => (
          <MarkdownBlock key={index} html={blockHtml} />
        ))}
        {/* 尾部为空时不要渲染空块：否则它成了 :last-child，最后一个段落的
            margin-bottom 清不掉，底部会多出 10px。 */}
        {tailHtml ? <MarkdownBlock html={tailHtml} ink /> : null}
      </div>
    );
  }

  return (
    <div
      className={shellClass}
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: fullHtml }}
    />
  );
}
