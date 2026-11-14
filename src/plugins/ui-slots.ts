/**
 * 插件 UI 槽位目录（单一来源）。
 *
 * 桌面渲染层用它推导 SlotName 并在注册时校验；Agent 侧的插件创作工具用同一份
 * 数据生成 API 速查，避免两处手写漂移。纯数据，不引入 React / Node 依赖。
 */

export type PluginSlotKind = "list" | "keyed" | "single" | "wrap" | "page" | "tab";

export type PluginSlotGroup =
  | "navigation"
  | "shell"
  | "chat"
  | "composer"
  | "inspector"
  | "settings"
  | "files";

/**
 * none          只追加，不改内置 UI
 * shadows-built-in  替换内置区域
 * wraps-built-in    包裹内置内容（插件可丢弃 children 实现替换）
 */
export type PluginSlotRisk = "none" | "shadows-built-in" | "wraps-built-in";

export type PluginSlotDefinition = {
  /** ctx.slots.register 的第一个参数 */
  name: string;
  kind: PluginSlotKind;
  group: PluginSlotGroup;
  /** 人类可读位置 */
  location: string;
  /** 一句话说明 */
  summary: string;
  /** 组件收到的 props（TS 形状） */
  props: string;
  risk: PluginSlotRisk;
  /** keyed 槽位：entry.key 的取值域 */
  keyDomain?: string;
};

/**
 * 全部可用槽位。order：list/keyed/single 取 order 最小者优先；wrap 按 order
 * 升序嵌套（最小者最外层）。
 */
export const PLUGIN_UI_SLOTS = [
  {
    name: "pages",
    kind: "page",
    group: "navigation",
    location: "左侧导航 + 主内容整页",
    summary: "注册一个整页，自动出现在左侧导航与页面导航里。",
    props: "{ view: string; sessionId?: string; workspace?: string }",
    risk: "none",
  },
  {
    name: "rail.actions",
    kind: "list",
    group: "navigation",
    location: "左侧导航按钮区",
    summary: "在导航按钮之间追加图标按钮。",
    props: "{ view: string }",
    risk: "none",
  },
  {
    name: "rail.footer.actions",
    kind: "list",
    group: "navigation",
    location: "左侧导航栏底部（更新图标上方）",
    summary: "在导航栏底部追加图标按钮。",
    props: "{}",
    risk: "none",
  },
  {
    name: "titlebar.actions",
    kind: "list",
    group: "navigation",
    location: "标题栏右侧、窗口控件左侧",
    summary: "在标题栏右侧追加按钮。",
    props: "{}",
    risk: "none",
  },
  {
    name: "titlebar.leading",
    kind: "list",
    group: "navigation",
    location: "标题栏 Logo / 公告之后、右侧动作之前",
    summary: "在标题栏左侧区域追加内容。",
    props: "{}",
    risk: "none",
  },
  {
    name: "titlebar.controls",
    kind: "single",
    group: "navigation",
    location: "标题栏最右侧窗口控件组",
    summary: "替换最小化/最大化/关闭按钮；替换后必须自行提供等价控件。",
    props: "{ maximized: boolean }",
    risk: "shadows-built-in",
  },
  {
    name: "shell.root",
    kind: "wrap",
    group: "shell",
    location: "应用最外层（含标题栏、导航、主内容）",
    summary: "包裹整个应用外壳；返回 children 保留原 UI，丢弃 children 即整窗替换。",
    props: "{} & { children }",
    risk: "wraps-built-in",
  },
  {
    name: "shell.titlebar",
    kind: "wrap",
    group: "shell",
    location: "顶部标题栏整体",
    summary: "包裹标题栏；可用 display:contents 避免影响布局。",
    props: "{ announcements: boolean } & { children }",
    risk: "wraps-built-in",
  },
  {
    name: "shell.rail",
    kind: "wrap",
    group: "shell",
    location: "左侧导航栏整体",
    summary: "包裹左侧导航栏。",
    props: "{ view: string } & { children }",
    risk: "wraps-built-in",
  },
  {
    name: "shell.conversations",
    kind: "wrap",
    group: "shell",
    location: "左列会话列表 / 各视图导航",
    summary: "包裹左列内容。",
    props: "{ view: string } & { children }",
    risk: "wraps-built-in",
  },
  {
    name: "shell.content",
    kind: "wrap",
    group: "shell",
    location: "主内容面板（聊天/设置/插件页等所有视图）",
    summary: "包裹主内容区；丢弃 children 即接管所有主视图。",
    props: "{ view: string } & { children }",
    risk: "wraps-built-in",
  },
  {
    name: "shell.inspector",
    kind: "wrap",
    group: "shell",
    location: "右侧检查器整体",
    summary: "包裹右侧检查器（仅在打开时存在）。",
    props: "{ open: boolean } & { children }",
    risk: "wraps-built-in",
  },
  {
    name: "shell.overlay",
    kind: "list",
    group: "shell",
    location: "全窗口 fixed 浮层",
    summary: "渲染浮层内容；层本身 pointer-events:none，交互元素需自行开启。",
    props: "{ view: string }",
    risk: "none",
  },
  {
    name: "home.widgets",
    kind: "list",
    group: "inspector",
    location: "右栏首页统计卡下方",
    summary: "在检查器新标签页追加内容。",
    props: "{}",
    risk: "none",
  },
  {
    name: "session.header.actions",
    kind: "list",
    group: "chat",
    location: "会话标题栏右侧",
    summary: "在会话标题栏追加按钮。",
    props: "{ sessionId?: string; running: boolean; mode: string }",
    risk: "none",
  },
  {
    name: "session.header.leading",
    kind: "list",
    group: "chat",
    location: "会话标题左侧",
    summary: "在会话标题前追加内容。",
    props: "{ sessionId?: string; title?: string; workspace?: string }",
    risk: "none",
  },
  {
    name: "conversations.header.actions",
    kind: "list",
    group: "navigation",
    location: "会话列表「新聊天」行",
    summary: "在会话列表顶部操作行追加按钮。",
    props: "{}",
    risk: "none",
  },
  {
    name: "conversations.footer",
    kind: "list",
    group: "navigation",
    location: "会话列表底部",
    summary: "在会话列表底部追加内容。",
    props: "{}",
    risk: "none",
  },
  {
    name: "settings.view",
    kind: "wrap",
    group: "settings",
    location: "设置页正文",
    summary: "包裹设置页正文（左侧设置导航仍在外壳里）。",
    props: "{ section: string } & { children }",
    risk: "wraps-built-in",
  },
  {
    name: "settings.sections",
    kind: "list",
    group: "settings",
    location: "设置页导航 + 正文分区",
    summary: "注册一个设置分区；entry 的 title 是导航显示名。",
    props: "{}",
    risk: "none",
  },
  {
    name: "chat.view",
    kind: "wrap",
    group: "chat",
    location: "聊天区（消息流 + 输入框）",
    summary: "包裹整个聊天区；可读 items 自绘聊天界面。",
    props: "{ sessionId?: string; workspace?: string; streaming: boolean; canUse: boolean; items: unknown[] } & { children }",
    risk: "wraps-built-in",
  },
  {
    name: "chat.empty",
    kind: "single",
    group: "chat",
    location: "空会话欢迎区",
    summary: "替换空会话欢迎页。",
    props: "{ canUse: boolean }",
    risk: "shadows-built-in",
  },
  {
    name: "message.list.before",
    kind: "list",
    group: "chat",
    location: "消息流顶部",
    summary: "在消息流最上方追加内容。",
    props: "{ count: number; loading: boolean }",
    risk: "none",
  },
  {
    name: "message.list.after",
    kind: "list",
    group: "chat",
    location: "消息流底部（建议行之后）",
    summary: "在消息流最下方追加内容。",
    props: "{ count: number; loading: boolean }",
    risk: "none",
  },
  {
    name: "timeline.turn.tail",
    kind: "list",
    group: "chat",
    location: "每轮末尾耗时条之后",
    summary: "在本轮信息条之后追加内容。",
    props: "{ turnIndex: number; durationMs?: number; endedAt?: string; usage?: unknown; markdown: string }",
    risk: "none",
  },
  {
    name: "message.user.before",
    kind: "list",
    group: "chat",
    location: "用户消息气泡上方",
    summary: "在用户消息前追加内容。",
    props: "{ content: string; images?: unknown[]; messageIndex?: number }",
    risk: "none",
  },
  {
    name: "message.user.after",
    kind: "list",
    group: "chat",
    location: "用户消息气泡下方",
    summary: "在用户消息后追加内容。",
    props: "{ content: string; images?: unknown[]; messageIndex?: number }",
    risk: "none",
  },
  {
    name: "message.user.actions",
    kind: "list",
    group: "chat",
    location: "用户消息 hover 操作区",
    summary: "在用户消息气泡内追加操作按钮。",
    props: "{ content: string; images?: unknown[]; messageIndex?: number }",
    risk: "none",
  },
  {
    name: "message.assistant.before",
    kind: "list",
    group: "chat",
    location: "助手消息上方",
    summary: "在助手消息前追加内容。",
    props: "{ content: string; streaming: boolean; messageIndex?: number }",
    risk: "none",
  },
  {
    name: "message.assistant.after",
    kind: "list",
    group: "chat",
    location: "助手消息下方",
    summary: "在助手消息后追加内容。",
    props: "{ content: string; streaming: boolean; messageIndex?: number }",
    risk: "none",
  },
  {
    name: "message.assistant.body",
    kind: "wrap",
    group: "chat",
    location: "助手 Markdown 正文",
    summary: "包裹助手正文；丢弃 children 即替换 Markdown 渲染。",
    props: "{ content: string; streaming: boolean; messageIndex?: number } & { children }",
    risk: "wraps-built-in",
  },
  {
    name: "message.assistant.actions",
    kind: "list",
    group: "chat",
    location: "助手消息操作区",
    summary: "在助手消息正文后追加操作按钮。",
    props: "{ content: string; streaming: boolean; messageIndex?: number }",
    risk: "none",
  },
  {
    name: "message.toolCard",
    kind: "keyed",
    group: "chat",
    location: "工具行展开体（entry.key = 工具名）",
    summary: "替换指定工具的展开视图；同 key 只有 order 最小者生效。",
    props: "{ tool: unknown; status: string }",
    risk: "shadows-built-in",
    keyDomain: "工具名，如 run_command / read_file",
  },
  {
    name: "composer.banner",
    kind: "list",
    group: "composer",
    location: "输入框上方横幅",
    summary: "在输入框上方追加横幅。",
    props: "{ text: string }",
    risk: "none",
  },
  {
    name: "composer.actions",
    kind: "list",
    group: "composer",
    location: "输入框左工具区",
    summary: "在输入框左侧工具区追加按钮。",
    props: "{ text: string; setText: (text: string) => void; submit: () => void; disabled: boolean }",
    risk: "none",
  },
  {
    name: "composer.before",
    kind: "list",
    group: "composer",
    location: "输入框卡片上方",
    summary: "在输入框卡片上方追加内容。",
    props: "{ text: string; disabled: boolean }",
    risk: "none",
  },
  {
    name: "composer.right",
    kind: "list",
    group: "composer",
    location: "输入框右工具区（模型选择器前）",
    summary: "在输入框右侧工具区追加按钮。",
    props: "{ text: string; disabled: boolean }",
    risk: "none",
  },
  {
    name: "composer.submit",
    kind: "single",
    group: "composer",
    location: "发送 / 停止按钮",
    summary: "替换发送/停止按钮；替换后必须自行调用 send / stop。",
    props: "{ text: string; streaming: boolean; disabled: boolean; send: () => void; stop: () => void }",
    risk: "shadows-built-in",
  },
  {
    name: "composer.wrap",
    kind: "wrap",
    group: "composer",
    location: "整个输入框卡片",
    summary: "包裹输入框卡片；丢弃 children 即替换整个输入区。",
    props: "{ text: string; setText: (text: string) => void; send: () => void; stop: () => void; streaming: boolean; disabled: boolean } & { children }",
    risk: "wraps-built-in",
  },
  {
    name: "rightpanel.tabs",
    kind: "tab",
    group: "inspector",
    location: "右侧检查器页签（组件注册）",
    summary: "注册一个检查器页签，用 ctx.actions.openTab 打开。",
    props: "{ sessionId?: string; workspace?: string; tabId: string }",
    risk: "none",
  },
  {
    name: "fileTree.contextMenu",
    kind: "list",
    group: "files",
    location: "右侧文件树右键菜单",
    summary: "在文件/文件夹/空白处右键菜单追加操作。",
    props: "{ target: { kind: 'file' | 'folder' | 'root'; path?: string; name?: string }; closeMenu: () => void }",
    risk: "none",
  },
] as const satisfies readonly PluginSlotDefinition[];

export type PluginSlotName = (typeof PLUGIN_UI_SLOTS)[number]["name"];

export const PLUGIN_SLOT_MAP: Record<PluginSlotName, PluginSlotDefinition> = Object.fromEntries(
  PLUGIN_UI_SLOTS.map((slot) => [slot.name, slot]),
) as Record<PluginSlotName, PluginSlotDefinition>;

export const PLUGIN_SLOT_NAMES: readonly PluginSlotName[] = PLUGIN_UI_SLOTS.map(
  (slot) => slot.name,
);

/** 运行时校验：插件脚本里的字符串槽位名可能拼错，拼错时返回 undefined。 */
export function pluginSlotDefinition(name: string): PluginSlotDefinition | undefined {
  return (PLUGIN_SLOT_MAP as Record<string, PluginSlotDefinition>)[name];
}
