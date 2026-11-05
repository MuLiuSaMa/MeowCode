/**
 * 用户消息首部引用块的解析（纯逻辑，无 React 依赖，便于单测）。
 * 发送时输入框里的 chip 会展开成首部若干行标记，空行之后才是用户正文：
 *   【附件】report.pdf · D:/docs/report.pdf
 *   【技能引用】前端规范 · skill-id
 *   【插件命令】部署 · plugin-id · deploy
 *   （空行）
 *   正文…
 *
 * 时间线与输入框都要把这几行还原成卡片，所以规则只在这里定义一次：
 * 标记格式改动必须同步 `src/agent/file-mentions.ts` 与 `src/agent/runtime.ts`。
 */
// i18n-allow-block-start 以下是消息首部协议标记与解析规则，必须与 src/agent 逐字一致，不翻译
export const ATTACHMENT_PREFIX = "【附件】";
export const SKILL_PREFIX = "【技能引用】";
export const PLUGIN_PREFIX = "【插件引用】";
export const COMMAND_PREFIX = "【插件命令】";

const ATTACHMENT_LINE = /^【附件】(.*?) · (.+)$/;
const SKILL_LINE = /^【技能引用】(.+?) · ([^\n·]+)$/;
const PLUGIN_LINE = /^【插件引用】(.+?) · ([^\n·]+)$/;
const COMMAND_REF = /^【插件命令】(.*?)(?:\n|$)/;
// i18n-allow-block-end

export type AttachmentRef = { name: string; path: string };

export type ReferenceChip =
  | { kind: "skill"; id: string; name: string }
  | { kind: "plugin"; id: string; name: string };

export type PluginCommandHeader = { name: string; pluginId: string; command: string };

export type ParsedUserMessage = {
  /** 插件命令头；非命令消息为 null */
  command: PluginCommandHeader | null;
  /** 附件引用（绝对路径） */
  attachments: AttachmentRef[];
  /** 技能 / 插件引用 */
  chips: ReferenceChip[];
  /** 去掉首部引用块后的正文 */
  body: string;
};

export function parsePluginCommandHeader(content: string): PluginCommandHeader | null {
  const match = COMMAND_REF.exec(content);
  if (!match) return null;
  const parts = match[1].split(" · ");
  if (parts.length < 3) return null;
  const [name, pluginId, command] = parts;
  if (!name.trim() || !pluginId.trim() || !command.trim()) return null;
  return { name: name.trim(), pluginId: pluginId.trim(), command: command.trim() };
}

function attachmentOf(line: string): AttachmentRef | null {
  const match = ATTACHMENT_LINE.exec(line);
  if (!match) return null;
  const name = match[1].trim();
  const path = match[2].trim();
  if (!path) return null;
  return { name: name || path, path };
}

export function parseUserMessage(content: string): ParsedUserMessage {
  const lines = content.split("\n");
  const attachments: AttachmentRef[] = [];
  const chips: ReferenceChip[] = [];
  let index = 0;

  const command = parsePluginCommandHeader(lines[0] ?? "");
  if (command) index = 1;

  // 首部块内可连续出现：附件行 → 技能/插件引用行（命令消息只有附件行）
  while (index < lines.length) {
    const line = lines[index];
    const attachment = attachmentOf(line);
    if (attachment) {
      attachments.push(attachment);
      index += 1;
      continue;
    }
    if (command) break;
    const skill = SKILL_LINE.exec(line);
    if (skill) {
      chips.push({ kind: "skill", id: skill[2].trim(), name: skill[1].trim() });
      index += 1;
      continue;
    }
    const plugin = PLUGIN_LINE.exec(line);
    if (plugin) {
      chips.push({ kind: "plugin", id: plugin[2].trim(), name: plugin[1].trim() });
      index += 1;
      continue;
    }
    break;
  }

  const hasHeader = Boolean(command) || attachments.length > 0 || chips.length > 0;
  if (!hasHeader) return { command: null, attachments: [], chips: [], body: content };
  // 首部块与正文之间约定一个空行
  if (lines[index] === "") index += 1;
  return { command, attachments, chips, body: lines.slice(index).join("\n") };
}

/**
 * 队列 / 待发送列表里的一行预览：只显示正文，没有正文时退回引用名。
 * 不能直接把整段 text 丢进列表 —— 首部会是几行 `【附件】… · D:/…` 标记。
 */
export function queuedPreview(content: string): string {
  const parsed = parseUserMessage(content);
  if (parsed.body.trim()) return parsed.body;
  const names = [
    ...(parsed.command ? [`/${parsed.command.command}`] : []),
    ...parsed.attachments.map((attachment) => attachment.name),
    ...parsed.chips.map((chip) => chip.name),
  ];
  return names.length ? names.join(" · ") : content;
}
