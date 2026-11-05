/**
 * 内置插件元数据（Logo / 显示名 / 介绍 / 详情）。
 *
 * 内置插件不在市场索引里，桌面端「已加载插件」列表拿不到市场条目的
 * 图标与描述，会退化成字母兜底图标 + 「暂无介绍」。这里随包内置一份
 * 元数据，由 loader 填进 PluginDescriptor（iconUrl 直接给 dataUrl，
 * src / dist 布局通用，不依赖额外资源文件拷贝）；详情页的使用说明
 * 由服务端 /marketplace/detail 的 builtin 兜底分支返回。
 *
 * 图标风格与市场图标一致：48×48、rx=12、#181818 圆角方块 + 品牌色 glyph。
 * claude-code-hooks 用 Claude 的十二芒星标（品牌橙 #D97757）。
 */
export type BuiltinPluginMeta = {
  /** 列表显示名（缺省显示插件 id） */
  displayName: string;
  /** 一行介绍（插件页「暂无介绍」处展示） */
  description: string;
  /** SVG 源码（<img> 消费，转 dataUrl 下发） */
  iconSvg: string;
  /** 详情页使用说明（markdown；经 /marketplace/detail 的 builtin 兜底返回） */
  detail: string;
  /** 市场详情兜底条目的 tags */
  tags?: string[];
};

/** Claude 品牌橙。 */
const CLAUDE_ORANGE = "#D97757";

/** 电脑控制：屏幕 + 光标（屏内十字准星），品牌青蓝。 */
const COMPUTER_CONTROL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#181818"/><rect x="10" y="12" width="28" height="19" rx="2.5" fill="none" stroke="#4CC2FF" stroke-width="2.4"/><path d="M24 31v6M17 37h14" fill="none" stroke="#4CC2FF" stroke-width="2.4" stroke-linecap="round"/><circle cx="24" cy="21.5" r="6.5" fill="none" stroke="#4CC2FF" stroke-width="2.2"/><path d="M24 13v17M15.5 21.5h17" stroke="#4CC2FF" stroke-width="2.2" stroke-linecap="round"/></svg>`;

/** Claude 十二芒星：中心 (24,24)、12 条 30° 间隔射线，r=11，圆头描边。 */
const CLAUDE_STARBURST_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#181818"/><path d="M24 24L35 24 M24 24L33.53 29.5 M24 24L29.5 33.53 M24 24L24 35 M24 24L18.5 33.53 M24 24L14.47 29.5 M24 24L13 24 M24 24L14.47 18.5 M24 24L18.5 14.47 M24 24L24 13 M24 24L29.5 14.47 M24 24L33.53 18.5" fill="none" stroke="${CLAUDE_ORANGE}" stroke-width="2.4" stroke-linecap="round"/></svg>`;

const CC_HOOKS_DETAIL = `把 **Claude Code 生态的 hooks 脚本**桥接进 MeowCode：读取 Claude Code 的 settings.json，按相同的事件语义与退出码约定执行你现成的 hook 脚本，无需改写。

## 读取的配置

按以下顺序拼接（全部执行，本地优先）：

1. \`~/.claude/settings.json\`（全局）
2. \`<工作区>/.claude/settings.json\`（项目）
3. \`<工作区>/.claude/settings.local.json\`（项目本地）

## 事件映射

| Claude Code 事件 | MeowCode hook | 行为 |
| --- | --- | --- |
| \`PreToolUse\` | \`tool_call\` | 退出码 2 阻止工具执行（stderr 作为原因返回给模型）；stdout JSON \`permissionDecision: deny\` 同样阻止；\`matcher\` 正则匹配工具名 |
| \`PostToolUse\` | \`tool_result\` | block 决策退化为在工具输出后附注原因（工具已执行，无法撤销） |
| \`UserPromptSubmit\` | \`prompt_submit\` | block 拦截提交；\`additionalContext\` 追加进提交文本 |
| \`Stop\` | \`turn_stop\` | \`decision: block\` / \`continue: false\` 拦截回合收尾并续跑（如强制跑测试）；\`stop_hook_active\` 透传 |
| \`SessionStart\` | \`session_start\` | 仅观察 |

## 执行模型

每个 command 经 shell 子进程运行（macOS / Linux 走 \`sh\`，Windows 走 \`cmd\`），hook 上下文以 Claude Code 的 JSON 格式写入 stdin；每条 command 可单独配置 \`timeout\`（秒，默认 60），超时按非阻断错误放行。

## 信任模型

CC hooks 是**你自己配置的任意代码**，信任级别与 \`run_command\` 的 full 模式相同。不需要时在插件页停用本插件（只写禁用列表，不删任何文件）；Windows 上 \`.sh\` 脚本需写成 \`bash script.sh\`。
`;

const COMPUTER_CONTROL_DETAIL = `让 agent 看到、点到、打出你的电脑：截屏、鼠标点击、键盘输入、滚动、拖拽、窗口切换、剪贴板读写，共 10 个 \`computer_*\` 工具。实现参考 UI-TARS-desktop（Electron desktopCapturer 截图 + SendInput 注入）与 Anthropic computer-use 的动作空间。

## 工作方式

1. 先 \`computer_screenshot\` 截屏（自动缩放到 ≤1280 宽并随结果返回图片）；
2. 用 \`computer_click\` / \`computer_scroll\` / \`computer_drag\` 操作——坐标以**最近一次截图的像素空间**为准，插件自动换算成屏幕物理坐标（含 DPI 缩放）；
3. \`computer_type\` 打字走「剪贴板 + CtrlV」（Unicode/IME 可靠，会临时占用并恢复剪贴板）；
4. 每个动作后再截屏确认结果，逐步推进。

## 窗口与剪贴板

\`computer_window_list\` 列出可见窗口（标题/hwnd/进程名），\`computer_window_activate\` 把窗口切到前台；\`computer_clipboard\` 读写文本剪贴板。

## 已知边界

- 仅支持 Windows；需要桌面会话（锁屏 / 远程会话断开时截图为黑屏或失败）
- 以管理员身份运行的窗口收不到普通权限的注入输入（UIPI 系统限制）
- 个别应用（全屏独占 / 反作弊 / 部分游戏）对合成输入不敏感
- 打字用剪贴板粘贴实现，剪贴板文本会被临时替换（尽力恢复）

## 授权模型

**在插件页启用本插件 = 授权 agent 控制这台电脑**，工具调用不再逐次弹审批；会话时间线里每个动作可见、可中止。不需要时在插件页停用即可。
`;

export const BUILTIN_PLUGIN_META: Record<string, BuiltinPluginMeta> = {
  "claude-code-hooks": {
    displayName: "Claude Code hooks 桥接",
    description:
      "读取 ~/.claude 与工作区 .claude 下的 settings.json，把 Claude Code 生态的 hook 脚本桥接进 MeowCode：PreToolUse / PostToolUse / UserPromptSubmit / Stop / SessionStart 五个事件，退出码与 JSON stdout 语义与 Claude Code 一致。脚本即配即用，不需要时在插件页停用。",
    iconSvg: CLAUDE_STARBURST_SVG,
    detail: CC_HOOKS_DETAIL,
    tags: ["claude-code", "hooks"],
  },
  "computer-control": {
    displayName: "电脑控制",
    description:
      "让 agent 看到并操作这台电脑：截屏、鼠标点击、键盘输入、滚动、拖拽、窗口切换、剪贴板读写（10 个 computer_* 工具）。坐标以最近一次截图的像素空间为准并自动换算 DPI。启用插件即授权 agent 控机，时间线里每个动作可见可中止。",
    iconSvg: COMPUTER_CONTROL_SVG,
    detail: COMPUTER_CONTROL_DETAIL,
    tags: ["computer", "windows", "automation"],
  },
};

/** SVG 源码 → dataUrl（<img> 走不了 Bearer 头，随 JSON 返回最简单）。 */
export function iconSvgToDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/** 取内置插件元数据；非内置 id 返回 undefined。 */
export function builtinMeta(pluginId: string): BuiltinPluginMeta | undefined {
  return BUILTIN_PLUGIN_META[pluginId];
}

/** 市场索引 not_found 时的内置详情兜底：合成 MarketplaceItem + 详情 markdown。 */
export function builtinDetailFallback(
  id: string,
): { item: Record<string, unknown>; detail: string } | null {
  const meta = builtinMeta(id);
  if (!meta) return null;
  return {
    item: {
      id,
      type: "plugin",
      name: meta.displayName,
      description: meta.description,
      category: "内置",
      source: "builtin",
      tags: meta.tags ?? [],
      version: "1.0",
    },
    detail: meta.detail,
  };
}
