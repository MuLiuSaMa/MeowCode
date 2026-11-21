/**
 * 流式 Markdown 切分：把已经稳定的块与仍在增长的尾部拆开。
 *
 * 流式期间只重解析尾部，稳定块复用上次 HTML —— 避免每个 delta 都全量
 * marked + DOMPurify + hljs。边界只取保守位置：
 *  - 已闭合围栏代码块的结束行；
 *  - 围栏外空行，且下一个非空行是安全顶层块（不缩进、非引用/表格/HTML、
 *    非列表标记）——避免把列表或引用块临时拆成两块。
 *
 * 找不到边界时全部当尾部；文本结束在未闭合围栏内时，围栏正文交给调用方
 * 按纯文本渲染（不做高亮、不加复制按钮），闭合后再走完整渲染。
 */

export type StreamingMarkdownParts = {
  stable: string;
  tail: string;
  openFence?: { lang?: string; body: string };
};

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const LIST_MARKER_RE = /^([-*+]|\d+[.)])(\s|$)/;

function infoLang(info: string): string | undefined {
  const first = info.trim().split(/\s+/)[0] ?? "";
  return /^[\w-]+$/.test(first) ? first : undefined;
}

/**
 * 下一个非空行能不能安全地当作新块起点：列表/引用/表格/缩进/HTML 都继续留在尾部。
 * 字符类 `[>|<]` 同时覆盖引用 `>`、表格 `|` 和 HTML 起始标签 `<`。
 */
function isSafeTopLevel(line: string): boolean {
  if (!line || /^\s/.test(line)) return false;
  if (/^[>|<]/.test(line)) return false;
  if (LIST_MARKER_RE.test(line)) return false;
  return true;
}

export function splitStreamingMarkdown(text: string): StreamingMarkdownParts {
  if (!text) return { stable: "", tail: "" };

  const lines = text.split("\n");
  let offset = 0;
  let fence: { char: string; length: number } | null = null;
  let openFence: { lang?: string; bodyStart: number; start: number } | null = null;
  let lastBoundary = 0;
  let pendingBlank: number | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const lineEnd = offset + raw.length + (index < lines.length - 1 ? 1 : 0);
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

    if (fence) {
      const close = FENCE_CLOSE_RE.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        fence = null;
        openFence = null;
        lastBoundary = lineEnd;
        pendingBlank = null;
      }
      offset = lineEnd;
      continue;
    }

    const open = FENCE_OPEN_RE.exec(line);
    if (open) {
      if (pendingBlank !== null) {
        lastBoundary = pendingBlank;
        pendingBlank = null;
      }
      const lang = infoLang(open[2]);
      fence = { char: open[1][0], length: open[1].length };
      openFence = { ...(lang ? { lang } : {}), bodyStart: lineEnd, start: offset };
    } else if (!line.trim()) {
      pendingBlank = lineEnd;
    } else if (pendingBlank !== null) {
      if (isSafeTopLevel(line)) lastBoundary = pendingBlank;
      pendingBlank = null;
    }
    offset = lineEnd;
  }

  if (openFence) {
    return {
      stable: text.slice(0, openFence.start),
      tail: "",
      openFence: {
        ...(openFence.lang ? { lang: openFence.lang } : {}),
        body: text.slice(openFence.bodyStart),
      },
    };
  }
  // 结尾停在空行上：直接把空行纳入稳定区（后面不会再长出新块）
  if (pendingBlank !== null) lastBoundary = pendingBlank;
  return { stable: text.slice(0, lastBoundary), tail: text.slice(lastBoundary) };
}

/**
 * 把「稳定区」再切成块，供调用方做块级 memo：流式时只让最后一块重新渲染。
 *
 * 边界规则必须与 {@link splitStreamingMarkdown} 一致（空行 + 下一个非空行是安全
 * 顶层块）。只按空行切会把松散列表拆成两个 `<ul>`、把引用拆成两个 `<blockquote>`，
 * 间距和语义都会变 —— 这是块级渲染最容易踩的坑。
 *
 * 退化路径：文档里出现 link reference definition（`[x]: url`）或脚注定义时，
 * 整篇返回一块 —— 这些定义可以被任意位置的引用使用，拆开渲染会让前面的引用失效。
 */
const LINK_DEFINITION_RE = /^ {0,3}\[[^\]\^][^\]]*\]:[ \t]/m;
const FOOTNOTE_DEFINITION_RE = /^ {0,3}\[\^[^\]]+\]:[ \t]/m;

/** 只在区间内有非空白内容时成块：避免「围栏闭合 + 空行」产生纯空白块。 */
function pushBlock(blocks: string[], text: string, start: number, end: number): void {
  if (end <= start) return;
  const chunk = text.slice(start, end);
  if (!chunk.trim()) return;
  blocks.push(chunk);
}

export function splitMarkdownBlocks(text: string): string[] {
  if (!text) return [];
  if (LINK_DEFINITION_RE.test(text) || FOOTNOTE_DEFINITION_RE.test(text)) return [text];

  const lines = text.split("\n");
  const blocks: string[] = [];
  let fence: { char: string; length: number } | null = null;
  let blockStart = 0;
  let pendingBlank: number | null = null;
  let offset = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const lineEnd = offset + raw.length + (index < lines.length - 1 ? 1 : 0);
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

    if (fence) {
      const close = FENCE_CLOSE_RE.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        fence = null;
        // 已闭合的围栏自身就是安全边界
        pushBlock(blocks, text, blockStart, lineEnd);
        blockStart = lineEnd;
        pendingBlank = null;
      }
      offset = lineEnd;
      continue;
    }

    const open = FENCE_OPEN_RE.exec(line);
    if (open) {
      // 围栏本身就是安全顶层块：空行之后可以直接切
      if (pendingBlank !== null && isSafeTopLevel(line)) {
        pushBlock(blocks, text, blockStart, pendingBlank);
        blockStart = pendingBlank;
      }
      pendingBlank = null;
      fence = { char: open[1][0], length: open[1].length };
    } else if (!line.trim()) {
      pendingBlank = lineEnd;
    } else if (pendingBlank !== null) {
      // 与 splitStreamingMarkdown 同规则：列表/引用/表格/缩进继续留在当前块
      if (isSafeTopLevel(line)) {
        pushBlock(blocks, text, blockStart, pendingBlank);
        blockStart = pendingBlank;
      }
      pendingBlank = null;
    }
    offset = lineEnd;
  }

  // 收尾也用 pushBlock：全文只有空行时不能产出一个纯空白块
  pushBlock(blocks, text, blockStart, text.length);
  return blocks;
}
