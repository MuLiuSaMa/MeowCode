import { promises as fs } from "node:fs";
import path from "node:path";
import { estimateTokens } from "./context.js";
import { isWithinWorkspace, resolveWithinWorkspace } from "./paths.js";
import { readPdfText } from "./pdf.js";
import { sliceLinesForModel } from "./read-slice.js";
import type { ChatMessage } from "./types.js";

const MAX_MENTION_FILES = 8;
const MAX_FILE_BYTES = 2_000_000;
const BINARY_SNIFF_BYTES = 4_096;
/** 每个文件至少给这么多 token 的预览，保证 8 个文件都有可辨认的头部。 */
const MIN_PER_FILE_TOKENS = 800;
/** 单文件上限：约 200 行代码，再多就该让模型用 offset 续读而不是一次塞满。 */
const MAX_PER_FILE_TOKENS = 5_000;
const DEFAULT_TOKEN_BUDGET = 8_000;

/** @路径 或 @"带空格的路径"；只在词首匹配，避免把邮箱当成文件引用。 */
const MENTION_PATTERN =
  /(?:^|[\s(（,，;；、。])@(?:"([^"]+)"|([^\s@，。；：、！？"'()（）[\]{}<>]+))/g;

/**
 * 首行必须与 `isInjectedUserMessage`（context.ts）的 startsWith 字面量一致 ——
 * 裁剪逻辑靠它识别"运行时注入的 user 消息"，改这里要同步改那里。
 * 首句保持原样（startsWith 依赖），附件说明追加在后面。
 */
const INTRO =
  "The user referenced these workspace files with @mentions. " +
  "Explicit attachments are pre-loaded as well (their paths may be outside the workspace). " +
  "Their contents are pre-loaded below as read_file results: continue from where a result stops instead of reading the whole file again.";

/** 附件引用行（与 desktop/src/user-references.ts 同格式）：`【附件】展示名 · 绝对路径` */
export const ATTACHMENT_PREFIX = "【附件】";
const ATTACHMENT_LINE = /^【附件】(.*?) · (.+)$/;

/** 所有注入块都带 `{"path":"..."}`，去重时统一从这里提取。 */
const INJECTED_PATH_PATTERN = /\{"path":"((?:[^"\\]|\\.)*)"\}/g;

/**
 * 明确不是文本的扩展名：不读内容，只交付路径引用。
 * 用黑名单而不是白名单 —— `.dat` / `.proto` / 无扩展名文件也可能是文本，
 * 漏判会让用户 @ 了却拿不到内容，比多读 4KB 嗅探更糟。其余扩展名交给 NUL 嗅探兜底。
 */
const BINARY_FILE_PATTERN =
  /^\.(7z|a|avi|bin|bmp|bz2|class|db|dll|docx?|dylib|eot|exe|flac|gif|gz|ico|jar|jpeg|jpg|m4a|mkv|mov|mp3|mp4|o|odt|otf|pdf|png|pptx?|pyc|so|sqlite3?|tar|tiff?|ttf|wav|webm|webp|woff2?|xlsx?|xz|zip)$/i;

export interface MentionOptions {
  /** 单轮 @ 注入的总 token 预算；不传用 8k。 */
  tokenBudget?: number;
  /** 本会话已注入过的路径（`collectInjectedPaths` 产出），命中的只给占位。 */
  seen?: ReadonlySet<string>;
  /**
   * 本会话内被写/改过的文件（绝对路径，经 `mentionPathKey` 归一）。
   * 命中的路径即使出现在 `seen` 里也重新注入 —— 历史里那份内容已经过期。
   * 重新注入成功后从集合中删除，避免之后每轮都全量重读。
   */
  mutated?: Set<string>;
}

/** 绝对路径比较键：统一分隔符，Windows 上忽略大小写（D:\a 与 d:/a 是同一文件）。 */
export function mentionPathKey(absolutePath: string): string {
  const slashed = absolutePath.replace(/\\/g, "/");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}

export function extractFileMentions(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const quoted = match[1];
    const raw = quoted ?? match[2] ?? "";
    // 裸路径可能被句尾标点粘住；引号里的路径保持原样
    const value = (quoted !== undefined ? raw : raw.replace(/[,;:!?]+$/, "")).trim();
    if (!value || found.includes(value)) continue;
    found.push(value);
  }
  return found;
}

/**
 * 首部块（空行之前）里的附件行 → 绝对路径。
 *
 * 只认首部块：正文里手打的 `【附件】…` 不该触发任意路径读取。附件来自用户在
 * 文件选择器/拖拽里显式挑选的文件，因此**允许工作区外**的绝对路径
 * （@mention 仍然只解析工作区内相对路径，两者信任级别不同）。
 */
export function extractAttachmentPaths(text: string): string[] {
  const head = text.trimStart().split("\n\n", 1)[0];
  if (!head.includes(ATTACHMENT_PREFIX)) return [];
  const paths: string[] = [];
  for (const line of head.split("\n")) {
    const match = ATTACHMENT_LINE.exec(line.trim());
    if (!match) continue;
    const value = match[2].trim();
    if (!value || paths.includes(value)) continue;
    paths.push(value);
  }
  return paths;
}

/** 首部引用块的四种行前缀（与 desktop/src/user-references.ts 保持一致）。 */
const REFERENCE_PREFIXES = [ATTACHMENT_PREFIX, "【技能引用】", "【插件引用】", "【插件命令】"];

/** 首部块是否整体由引用行组成；正文里偶然出现类似行不算。 */
function headIsReferences(text: string): { head: string; body: string } | null {
  const trimmed = text.trimStart();
  const blank = trimmed.indexOf("\n\n");
  const head = blank < 0 ? trimmed : trimmed.slice(0, blank);
  const lines = head.split("\n").filter((line) => line.length > 0);
  if (!lines.length) return null;
  if (!lines.every((line) => REFERENCE_PREFIXES.some((prefix) => line.startsWith(prefix)))) {
    return null;
  }
  return { head, body: blank < 0 ? "" : trimmed.slice(blank + 2).trim() };
}

/**
 * 去掉首部引用块，返回用户真正写下的正文（可能为空）。
 * 标题生成、会话列表预览都不该把 `【附件】a · D:/…` 当成用户的话。
 */
export function stripReferenceHeader(text: string): string {
  const parsed = headIsReferences(text);
  return parsed ? parsed.body : text.trim();
}

/**
 * 引用块的简短标签（`附件：a.ts、b.pdf · 技能：x`），用于"只挂附件没写正文"的场景
 * —— 标题生成至少能拿到文件名，而不是一串绝对路径。
 */
export function referenceLabel(text: string): string {
  const parsed = headIsReferences(text);
  if (!parsed) return "";
  const groups: Array<{ label: string; names: string[] }> = [
    { label: "附件", names: [] },
    { label: "技能", names: [] },
    { label: "插件", names: [] },
  ];
  for (const line of parsed.head.split("\n")) {
    const attachment = ATTACHMENT_LINE.exec(line.trim());
    if (attachment) {
      groups[0].names.push(attachment[1].trim() || attachment[2].trim());
      continue;
    }
    const skill = /^【技能引用】(.+?) · [^\n·]+$/.exec(line.trim());
    if (skill) {
      groups[1].names.push(skill[1].trim());
      continue;
    }
    const plugin = /^【插件(?:引用|命令)】(.+?)(?: · |$)/.exec(line.trim());
    if (plugin) groups[2].names.push(plugin[1].trim());
  }
  return groups
    .filter((group) => group.names.length)
    .map((group) => `${group.label}：${group.names.join("、")}`)
    .join(" · ");
}

/** 单轮 @ 注入的 token 预算：跟随上下文窗口，夹在 [2k, 12k]。 */
export function mentionTokenBudget(contextWindow?: number | null): number {
  if (!contextWindow || contextWindow <= 0) return DEFAULT_TOKEN_BUDGET;
  return Math.min(12_000, Math.max(2_000, Math.round(contextWindow * 0.05)));
}

/** 从历史消息里收集已注入过的路径，供同会话去重使用。 */
export function collectInjectedPaths(messages: readonly ChatMessage[]): Set<string> {
  const paths = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user" || typeof message.content !== "string") continue;
    for (const match of message.content.matchAll(INJECTED_PATH_PATTERN)) {
      // 块里的 path 是 JSON.stringify 出来的，反斜杠要反转义后才是真实路径
      paths.add(normalizePath(unescapeJsonString(match[1])));
    }
  }
  return paths;
}

function unescapeJsonString(value: string): string {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value;
  }
}

/**
 * 读取 @ 引用 / 显式附件的文件，拼成注入给模型的上下文。
 *
 * 做法照搬 ZCode：**把 @ 内容伪装成一次已经发生过的 read_file 调用**。
 * 三个收益：① 预算天然复用工具的切片器，不需要第二套规则；② 格式与工具结果
 * 同构，模型不会怀疑内容不完整而重读一遍；③ 续读提示与工具一字不差。
 *
 * 越界路径、目录、二进制和读取失败都静默跳过，绝不阻塞回合。
 * 附件（`【附件】` 行）按绝对路径读，不受工作区限制；@mention 仍只解析工作区内。
 */
export async function buildFileMentionContext(
  workspace: string,
  text: string,
  options: MentionOptions = {},
): Promise<string | null> {
  // 附件优先占位：它们是用户显式挑选的，不能因为同一条消息里的 @ 太多被挤掉
  const entries: Array<{ mention: string; target: string }> = [];
  const takenKeys = new Set<string>();
  for (const attachment of extractAttachmentPaths(text)) {
    if (entries.length >= MAX_MENTION_FILES) break;
    if (!path.isAbsolute(attachment)) continue;
    const target = path.resolve(attachment);
    const key = mentionPathKey(target);
    if (takenKeys.has(key)) continue;
    takenKeys.add(key);
    entries.push({ mention: attachment, target });
  }
  for (const mention of extractFileMentions(text)) {
    if (entries.length >= MAX_MENTION_FILES) break;
    // 先解析绝对路径：占位判定与"编辑后失效"都要用同一个真实路径做键
    let target: string;
    try {
      target = await resolveWithinWorkspace(workspace, mention);
    } catch {
      // 不存在 / 越界：跳过
      continue;
    }
    const key = mentionPathKey(target);
    if (takenKeys.has(key)) continue;
    takenKeys.add(key);
    entries.push({ mention, target });
  }
  if (!entries.length) return null;

  const budget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  // 均分而不是先到先得：超出总预算时让第 4 个文件之后静默消失，比多花几千 token 糟得多
  const perFile = Math.max(
    MIN_PER_FILE_TOKENS,
    Math.min(MAX_PER_FILE_TOKENS, Math.floor(budget / entries.length)),
  );

  const seen = new Set<string>();
  for (const value of options.seen ?? []) seen.add(normalizePath(value));

  const sections: string[] = [];
  for (const { mention, target } of entries) {
    const key = mentionPathKey(target);
    const inside = isWithinWorkspace(workspace, target);
    // 工作区外的附件工具读不到（read_file 有路径守卫），提示语要说清这层限制
    const outsideNote = inside
      ? undefined
      : "outside the workspace, so file tools cannot open it — ask the user to copy it into the workspace if you need more";
    const wasMutated = options.mutated?.has(key) === true;
    // 「已读过」占位只对工具能重新打开的文件成立：工作区外的附件模型没法自己再读，
    // 占位等于让它凭空回忆内容 —— 这类附件每轮都重新注入（预算按 perFile 封顶）。
    if (inside && !wasMutated && seen.has(normalizePath(mention))) {
      sections.push(renderAlreadyLoaded(mention));
      continue;
    }
    try {
      const info = await fs.stat(target);
      if (!info.isFile()) continue;
      // PDF 走文本层抽取（与 read_file 同一条链路），扫描件只交付路径
      if (path.extname(target).toLowerCase() === ".pdf") {
        const pdf = await readPdfText({
          file: target,
          name: path.basename(target),
          workspace,
        });
        if (pdf.ok && !pdf.scanned) {
          sections.push(renderFileResult(mention, pdf.output, perFile));
        } else {
          sections.push(
            renderPathReference(
              mention,
              info.size,
              pdf.ok
                ? `scanned PDF with no usable text layer${outsideNote ? `; ${outsideNote}` : ""}`
                : outsideNote,
            ),
          );
        }
        options.mutated?.delete(key);
        continue;
      }
      if (info.size > MAX_FILE_BYTES) continue;
      // 明确二进制：只交付路径引用，读出来是乱码，纯粹浪费预算
      if (isBinaryPath(target)) {
        sections.push(renderPathReference(mention, info.size, outsideNote));
        options.mutated?.delete(key);
        continue;
      }
      const content = await readHead(target, info.size, perFile);
      if (!content) continue;
      // 扩展名看不出来的（.dat / 无后缀）：靠 NUL 嗅探兜底
      if (content.slice(0, BINARY_SNIFF_BYTES).includes("\0")) {
        sections.push(renderPathReference(mention, info.size, outsideNote));
        options.mutated?.delete(key);
        continue;
      }
      sections.push(renderFileResult(mention, content, perFile));
      // 新鲜内容已经进历史：后续再 @ 同一个文件可以回到占位
      options.mutated?.delete(key);
    } catch {
      // 读取失败：跳过
    }
  }
  if (!sections.length) return null;
  return [INTRO, "", sections.join("\n\n")].join("\n");
}

/**
 * 只读文件头部。预算按 token 算，UTF-8 下 CJK 最多 3 字节/字符，取 8 倍字节
 * 保证切得够；同时避免 fs.readFile 那样把 2MB 全搬进内存再扔掉 97%。
 */
async function readHead(file: string, size: number, tokenLimit: number): Promise<string> {
  const bytes = Math.min(size, tokenLimit * 8);
  if (bytes >= size) return fs.readFile(file, "utf8");
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    // 切点可能落在多字节序列中间：丢掉没有换行符的残尾，别把 U+FFFD 塞给模型
    const lastNewline = text.lastIndexOf("\n");
    return lastNewline > 0 ? text.slice(0, lastNewline) : text;
  } finally {
    await handle.close();
  }
}

/** 扩展名明确是二进制；无扩展名的按文本处理（Makefile / Dockerfile / LICENSE）。 */
function isBinaryPath(file: string): boolean {
  const ext = path.extname(file);
  if (!ext) return false;
  return BINARY_FILE_PATTERN.test(ext);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** 伪装成 read_file 的调用与结果，切片器与工具共用，续读提示同款。 */
function renderFileResult(mention: string, content: string, tokenLimit: number): string {
  const slice = sliceLinesForModel(content, { budget: tokenLimit, cost: estimateTokens });
  return [
    "<system-reminder>",
    `Called the read_file tool with the following input: ${JSON.stringify({ path: mention })}`,
    "</system-reminder>",
    "<system-reminder>",
    "Result of calling the read_file tool:",
    slice.text,
    "</system-reminder>",
  ].join("\n");
}

/** 同会话内已注入过：只留锚点，省掉重复的全量开销。 */
function renderAlreadyLoaded(mention: string): string {
  return [
    "<system-reminder>",
    `Already read earlier in this conversation: ${JSON.stringify({ path: mention })}`,
    "Re-read it only if you need its current contents.",
    "</system-reminder>",
  ].join("\n");
}

/** 二进制 / 未知扩展名 / 扫描版 PDF：只给路径，让模型按需用工具读。 */
function renderPathReference(mention: string, size: number, note?: string): string {
  return [
    "<system-reminder>",
    `Attached non-text file: ${JSON.stringify({ path: mention })} (${size} bytes)`,
    note
      ? `Its contents were not inlined: ${note}.`
      : "Its contents were not inlined because it is not a text file.",
    "Use the read_file / read_video tool if you need to inspect it.",
    "</system-reminder>",
  ].join("\n");
}
