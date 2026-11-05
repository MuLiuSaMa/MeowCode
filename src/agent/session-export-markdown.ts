/**
 * 会话导出的 Markdown 渲染。
 *
 * 三个必须做对的细节（都来自参考实现踩过的坑）：
 *  1. 代码围栏用「比正文里最长反引号串更长」的定界符，否则正文里的 ``` 会把块提前截断；
 *  2. 正文里未闭合的围栏要补齐，否则后面的 `</details>` 被吞进代码块；
 *  3. 代码块外把 `<details` / `<summary` 转义，避免用户正文破坏我们的折叠结构。
 * 正文标签用英文（Markdown 导出常被当技术产物分享），会话标题与对话内容保持原语言。
 */
import type { ExportDoc, ExportImage, ExportItem, ExportTurn } from "./session-export.js";

export type MarkdownOptions = {
  exportedAt?: string;
  /** 源会话文件路径（写进元信息，便于回溯） */
  sourcePath?: string;
  /** 单条工具输出截断长度，默认 8000 字符；0 = 不截断 */
  maxToolOutput?: number;
  /** 图片是否内联 base64（默认 true）；false 时写 `assets/<file>` 相对路径 */
  inlineImages?: boolean;
};

const DEFAULT_MAX_TOOL_OUTPUT = 8_000;

/** 用比正文更长一档的围栏包裹，正文里的 ``` 不会提前闭合。 */
function fenced(content: string, lang = ""): string {
  const runs = content.match(/`{3,}/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 2);
  const marker = "`".repeat(longest + 1);
  return `${marker}${lang}\n${content}\n${marker}`;
}

/** 正文里围栏数量为奇数时补一个，防止后续内容被吞。 */
function closeUnfinishedFence(text: string): string {
  const fences = text.match(/^ {0,3}(`{3,})/gm) ?? [];
  return fences.length % 2 === 1 ? `${text}\n\`\`\`` : text;
}

/** 代码块外把 HTML 折叠标签转义，代码块内保持原样。 */
function escapeWrapperTags(text: string): string {
  const lines = text.split("\n");
  let inFence = false;
  return lines
    .map((line) => {
      if (/^ {0,3}`{3,}/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line.replace(/<(\/?)(details|summary)\b/gi, "&lt;$1$2");
    })
    .join("\n");
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length ? `> ${line}` : ">"))
    .join("\n");
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (max <= 0 || text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n… [truncated, ${text.length} chars total]`, truncated: true };
}

function renderImage(image: ExportImage, inline: boolean): string {
  const label = image.name ?? "image";
  if (inline && image.data) {
    return `![${label}](data:${image.mimeType};base64,${image.data})`;
  }
  if (image.file) {
    return `![${label}](${inline ? "" : "assets/"}${image.file})`;
  }
  if (image.data) {
    return `![${label}](data:${image.mimeType};base64,${image.data})`;
  }
  return `*[${label}]*`;
}

function renderInput(input: unknown): string {
  try {
    return fenced(JSON.stringify(input, null, 2) ?? String(input), "json");
  } catch {
    return fenced(String(input), "text");
  }
}

function renderToolBlock(items: ExportItem[], maxToolOutput: number): string {
  const tools = items.filter((item): item is Extract<ExportItem, { kind: "tool" }> => item.kind === "tool");
  if (tools.length === 0) return "";
  const names = tools.map((item) => item.call.tool);
  const unique = [...new Set(names)];
  const summary = `Tool calls ×${tools.length} · ${unique.join(", ")}`;
  const body = tools
    .map((item, index) => {
      const output = clip(item.call.output ?? "", maxToolOutput);
      const parts = [
        `#### ${index + 1}. \`${item.call.tool}\``,
        "",
        "**Input**",
        "",
        renderInput(item.call.input),
        "",
        "**Result**",
        "",
        fenced(output.text, "text"),
      ];
      return parts.join("\n");
    })
    .join("\n\n");

  return [
    "<details>",
    `<summary>${summary}</summary>`,
    "",
    body,
    "",
    "</details>",
  ].join("\n");
}

function renderItems(items: ExportItem[], options: Required<Pick<MarkdownOptions, "maxToolOutput" | "inlineImages">>): string[] {
  const blocks: string[] = [];
  for (const item of items) {
    if (item.kind === "user") {
      blocks.push(quote(escapeWrapperTags(closeUnfinishedFence(item.text))));
      for (const image of item.images) {
        blocks.push(renderImage(image, options.inlineImages));
      }
      for (const doc of item.documents) {
        blocks.push(`*Document: ${doc.name ?? doc.mimeType}*`);
      }
      continue;
    }
    if (item.kind === "assistant") {
      if (item.thinking) {
        blocks.push(
          ["<details>", "<summary>Thinking</summary>", "", item.thinking.trim(), "", "</details>"].join(
            "\n",
          ),
        );
      }
      if (item.text.trim()) {
        blocks.push(escapeWrapperTags(closeUnfinishedFence(item.text)));
      }
      continue;
    }
    if (item.kind === "approval") {
      const verdict = item.approved ? "approved" : "denied";
      const extra = item.reason ? ` (${item.reason})` : "";
      blocks.push(`> **Approval**: \`${item.tool}\` → ${verdict}${extra}`);
    }
    // tool 由 renderToolBlock 统一折叠，这里跳过
  }
  return blocks;
}

function renderTurn(
  turn: ExportTurn,
  options: Required<Pick<MarkdownOptions, "maxToolOutput" | "inlineImages">>,
): string {
  const blocks = renderItems(turn.items, options);
  const toolBlock = renderToolBlock(turn.items, options.maxToolOutput);
  if (toolBlock) blocks.push(toolBlock);
  if (!blocks.length) return "";
  const heading =
    turn.status && turn.status !== "completed" ? `> **Turn status**: ${turn.status}${turn.error ? ` — ${turn.error}` : ""}\n\n` : "";
  return `${heading}${blocks.join("\n\n")}`;
}

function formatUsage(usage: ExportDoc["usage"]): string {
  const parts: string[] = [];
  if (usage.inputTokens) parts.push(`in ${usage.inputTokens}`);
  if (usage.outputTokens) parts.push(`out ${usage.outputTokens}`);
  if (usage.cacheReadTokens) parts.push(`cache read ${usage.cacheReadTokens}`);
  if (usage.cacheWriteTokens) parts.push(`cache write ${usage.cacheWriteTokens}`);
  return parts.join(" · ");
}

export function renderMarkdown(doc: ExportDoc, options: MarkdownOptions = {}): string {
  const resolved = {
    maxToolOutput: options.maxToolOutput ?? DEFAULT_MAX_TOOL_OUTPUT,
    inlineImages: options.inlineImages !== false,
  };
  const exportedAt = options.exportedAt ?? new Date().toISOString();
  const title = doc.session.title?.trim() || `Session ${doc.session.id.slice(0, 8)}`;

  const meta: string[] = [`# ${title}`, ""];
  const push = (label: string, value: string | undefined) => {
    if (value && value.trim()) meta.push(`- ${label}: ${value}`);
  };
  push("Session ID", `\`${doc.session.id}\``);
  push("Workspace", `\`${doc.session.cwd}\``);
  push("Created", doc.session.createdAt);
  push("Messages", String(doc.session.messageCount));
  if (doc.session.providerId || doc.session.model) {
    push("Model", `\`${doc.session.providerId ?? "?"} / ${doc.session.model ?? "?"}\``);
  }
  if (doc.session.worktree) {
    push("Worktree", `${doc.session.worktree.branch} (${doc.session.worktree.path})`);
  }
  const usage = formatUsage(doc.usage);
  push("Usage", usage);
  push("Exported", exportedAt);
  if (options.sourcePath) push("Source", `\`${options.sourcePath}\``);

  const sections: string[] = [meta.join("\n")];

  const turns = [...doc.turns, ...(doc.loose ? [doc.loose] : [])];
  turns.forEach((turn) => {
    const body = renderTurn(turn, resolved);
    if (body) sections.push(body);
  });

  for (const checkpoint of doc.checkpoints) {
    const label = checkpoint.label ? ` — ${checkpoint.label}` : "";
    const files = checkpoint.fileChanges.length
      ? `\n\n${checkpoint.fileChanges.map((file) => `- \`${file}\``).join("\n")}`
      : "";
    sections.push(`> **Checkpoint**${label} · ${checkpoint.timestamp}${files}`);
  }

  if (doc.compactions.length) {
    const list = doc.compactions
      .map((item, index) => `### Compaction ${index + 1}\n\n${item.summary.trim()}`)
      .join("\n\n");
    sections.push(`<details>\n<summary>Compactions ×${doc.compactions.length}</summary>\n\n${list}\n\n</details>`);
  }

  return `${sections.join("\n\n---\n\n")}\n`;
}
