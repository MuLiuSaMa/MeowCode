/**
 * 插件创作 API 速查表：通过工具按需返回给模型，避免它去仓库里翻源码。
 * 内容只描述 create_plugin 能产出的形态，不暴露宿主内部实现。
 * UI 槽位表从 src/plugins/ui-slots.ts 生成，和渲染层共用同一份目录。
 */
import { PLUGIN_UI_SLOTS } from "../../ui-slots.js";

const BACKEND = `## 后端插件（code）

文件形态由 create_plugin 自动生成：plugin.json + index.ts；**不要自己写 manifest**。

\`\`\`ts
export default (api) => {
  api.registerTool({
    name: "word_count",
    description: "统计文本字数",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "要统计的文本" } },
      required: ["text"],
      additionalProperties: false,
    },
    execute: async (input) => ({
      ok: true,
      output: \`字数：\${String(input.text ?? "").length}\`,
    }),
  });
};
\`\`\`

- execute 入参是 Record<string, unknown>；返回 \`{ ok: boolean, output: string }\`。失败用 \`{ ok: false, output: "原因" }\`。
- 工具名用 snake_case，禁止占用内置工具名、task、update_plan 和 browser_ 前缀。
- \`requiresApproval: true\` 可选：每次调用走用户审批。

### 其它后端 API

- \`api.registerCommand({ name, description?, run })\`：注册斜杠命令，run 返回字符串。
- \`api.registerRpc(method, handler)\`：给界面脚本调用；handler(args, { sessionId, workspace })，返回值会 JSON 序列化。
- \`api.on(event, handler)\`：订阅生命周期。可用事件：
  \`tool_call\`、\`tool_result\`、\`prompt_submit\`、\`permission_request\`、\`turn_start\`、\`turn_stop\`、\`turn_end\`、\`session_start\`、\`session_end\`、\`session_info_changed\`、\`model_switch\`、\`subagent_start\`、\`subagent_stop\`、\`compaction_start\`、\`compaction_end\`、\`interrupt\`、\`tool_execution_start\`、\`tool_execution_end\`、\`assistant_message_start\`、\`assistant_message_end\`、\`context_inject\`、\`before_provider_request\`。
- \`api.storage.get/set/delete\`：插件命名空间 KV（异步）。
- \`api.logger\`、\`api.workspace\`。
- \`api.manifest\` / \`api.permissions\`：只读，通常不需要。`;

const CLIENT = `## 界面插件（client）

纯 JS，无 import / export / JSX / TypeScript。代码会被当成 async 函数体执行，必须返回 \`{ apply(ctx) { ... } }\`。

可用符号只有 \`React\`、\`ctx\`、\`styles\`、\`host\`、\`pluginId\`；\`window/document/fetch/setTimeout\` 等全局被遮蔽，误用会抛引导错误。定时器用 \`ctx.timers\`。

\`\`\`js
return {
  apply(ctx) {
    return ctx.slots.register(
      "session.header.actions",
      { id: "hello", order: 10, title: "Hello" },
      () => React.createElement("button", {
        onClick: () => ctx.actions.toast("hi"),
      }, "Hello"),
    );
  },
};
\`\`\`

### 槽位

完整槽位表见 \`plugin_authoring_guide("slots")\`。共 4 种挂载语义：

- \`list\`：全部渲染，按 \`order\` 升序。
- \`keyed\`：按 \`entry.key\` 命中，同 key 只有 \`order\` 最小者生效（例如 \`message.toolCard\` 用工具名）。
- \`single\`：替换内置区域，\`order\` 最小者生效；插件崩溃会自动回退内置 UI。
- \`wrap\`：包裹内置内容，组件收到 \`children\`；不渲染 children 就等于替换整块区域。
  \`order\` 最小者最外层。

\`id\` 在插件内唯一；注册函数返回 disposer。

### ctx

- \`ctx.slots.register(slot, entry, component)\`，返回 disposer。
- \`ctx.pages.register({ id, title, icon?, order? }, component)\`：整页注册（见下节）。
- \`ctx.tabs.register({ id, title, icon?, order? }, component)\`：右侧检查器页签，用 \`ctx.actions.openTab(id)\` 打开。
- \`ctx.hooks.useAppState()\`：在组件里订阅 \`{ sessionId?, workspace?, theme, locale, view, running, mode }\`。
- \`ctx.actions\`：
  \`sendPrompt(text)\`、\`stopTurn()\`、\`insertComposerText(text)\`、\`openFile(path)\`、
  \`openPanel(pluginId)\`、\`openTab(tabId, pluginId?)\`、\`toast(message, kind?)\`、\`openExternal(url)\`、
  \`openPage(pageId, pluginId?)\`、\`openView("chat"|"settings"|"plugins"|"git"|"automation"|"architecture")\`、\`showChat()\`。
- \`ctx.window\`：\`minimize()\`、\`toggleMaximize()\`、\`close()\`、\`isMaximized()\`、\`onStateChange(fn)\`。
- \`ctx.store.getState()\` / \`ctx.store.subscribe(fn)\`。
- \`ctx.rpc.call(method, args?)\`：调用后端 \`registerRpc\` 注册的方法。
- \`ctx.storage.get/set/delete\`。
- \`ctx.timers.setTimeout/setInterval(fn, ms)\`，返回 disposer。
- \`styles.insert(css)\`：注入样式，卸载自动移除。
- \`ctx.logger\`。

### 主题与布局

- 用主题变量而不是写死颜色：\`--bg\`、\`--bg-panel\`、\`--bg-elevated\`、\`--fg\`、\`--fg-subtle\`、\`--border\`、\`--card\`、\`--accent\`、\`--danger\`、\`--radius-sm/md/lg/xl\`、\`--font-sans\`。
- wrap 槽位若只是附加 DOM，根节点用 \`display: contents\`，避免破坏宿主 flex/高度。
- \`shell.overlay\` 层是 \`pointer-events:none\`；浮层根节点自己设 \`pointerEvents:"auto"\`。
- 替换标题栏/窗口控件时，拖动区用 \`WebkitAppRegion:"drag"\`，按钮内用 \`"no-drag"\`。`;

const PAGES = `## 插件整页（pages）

\`\`\`js
return {
  apply(ctx) {
    return ctx.pages.register(
      { id: "dashboard", title: "数据面板", icon: "📊", order: 10 },
      (props) => React.createElement("div", {
        style: { padding: 8 },
      }, "session: " + (props.sessionId || "none")),
    );
  },
};
\`\`\`

- 页面自动出现在左侧 Rail 与页面导航；打开后占满主内容区，容器已负责滚动与内边距。
- 页面组件 props：\`{ view, sessionId?, workspace? }\`。
- 用 \`ctx.actions.openPage("dashboard")\` 打开；跨插件用 \`openPage(pageId, pluginId)\`；回对话用 \`ctx.actions.showChat()\`。
- 插件停用/卸载时，停留在该页会自动退回对话。
- 想带完整 HTML 面板就改用 \`panel\` 参数（iframe），页面里优先用 React 组件。`;

const SLOT_GROUP_LABELS: Record<string, string> = {
  navigation: "导航 / 标题栏",
  shell: "外壳（可包裹/替换）",
  chat: "聊天与消息",
  composer: "输入框",
  inspector: "右侧检查器",
  settings: "设置页",
  files: "文件树",
};

const SLOT_RISK_LABELS: Record<string, string> = {
  none: "追加",
  "shadows-built-in": "替换内置",
  "wraps-built-in": "包裹内置",
};

function renderSlotTable(): string {
  // props 里含联合类型竖线，落进 Markdown 表格前必须转义
  const cell = (value: string) => value.replace(/\|/g, "\\|");
  const groups = new Map<string, (typeof PLUGIN_UI_SLOTS)[number][]>();
  for (const slot of PLUGIN_UI_SLOTS) {
    const list = groups.get(slot.group) ?? [];
    list.push(slot);
    groups.set(slot.group, list);
  }
  const lines: string[] = [];
  for (const [group, slots] of groups) {
    lines.push(`**${SLOT_GROUP_LABELS[group] ?? group}**`, "");
    lines.push("| 槽位 | kind | 位置 | props | 风险 |", "|---|---|---|---|---|");
    for (const slot of slots) {
      lines.push(
        `| \`${slot.name}\` | ${slot.kind} | ${cell(slot.location)} | \`${cell(slot.props)}\` | ${SLOT_RISK_LABELS[slot.risk] ?? slot.risk} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

const SLOTS = `## 全站 UI 槽位

${renderSlotTable()}
### 示例：列表追加

\`\`\`js
return {
  apply(ctx) {
    return ctx.slots.register("titlebar.actions", { id: "hello", order: 10 }, () =>
      React.createElement("button", { onClick: () => ctx.actions.toast("hi") }, "Hello"),
    );
  },
};
\`\`\`

### 示例：替换工具卡（keyed）

\`\`\`js
return {
  apply(ctx) {
    return ctx.slots.register(
      "message.toolCard",
      { id: "grep-card", key: "grep", order: 10 },
      (props) => React.createElement("div", null, "我的 grep 卡片"),
    );
  },
};
\`\`\`

### 示例：替换发送按钮（single）

\`\`\`js
return {
  apply(ctx) {
    return ctx.slots.register(
      "composer.submit",
      { id: "send", order: 10 },
      (props) => React.createElement("button", {
        className: "mc-sendbtn",
        disabled: props.disabled || props.streaming,
        onClick: () => props.send(),
      }, "↑"),
    );
  },
};
\`\`\`

### 示例：包裹聊天区（wrap）

\`\`\`js
return {
  apply(ctx) {
    return ctx.slots.register(
      "chat.view",
      { id: "wrap", order: 10 },
      (props) => React.createElement("div", {
        style: { display: "contents" },
      },
        React.createElement("div", { style: {
          position: "absolute", top: 6, left: 6,
          pointerEvents: "auto",
        } }, "session: " + (props.sessionId || "none")),
        props.children,
      ),
    );
  },
};
\`\`\`

### 示例：全局浮层

\`\`\`js
return {
  apply(ctx) {
    return ctx.slots.register("shell.overlay", { id: "dock", order: 10 }, () =>
      React.createElement("div", {
        style: {
          position: "fixed", right: 20, bottom: 20,
          pointerEvents: "auto", padding: 10,
          background: "var(--bg-elevated)", border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)", color: "var(--fg)",
        },
      }, "浮动面板"),
    );
  },
};
\`\`\`

### 示例：右侧检查器页签

\`\`\`js
return {
  apply(ctx) {
    const off = ctx.tabs.register(
      { id: "stats", title: "统计", icon: "📊", order: 10 },
      (props) => React.createElement("div", { style: { padding: 12 } }, "tab: " + props.tabId),
    );
    const button = ctx.slots.register("rail.actions", { id: "open-stats", order: 20 }, () =>
      React.createElement("button", {
        className: "mc-rail__btn",
        onClick: () => ctx.actions.openTab("stats"),
      }, "S"),
    );
    return () => {
      button();
      off();
    };
  },
};
\`\`\`

### 样式约定

- 左侧导航按钮用 \`className: "mc-rail__btn"\`；文件树菜单条目用 \`className: "mc-wstree__menuitem"\`；
  窗口控件用 \`className: "mc-winbtn"\`；输入框图标按钮用 \`className: "mc-composer__icon"\`。
- 其余样式自己用 \`styles.insert(css)\` 注入，并优先使用主题变量。

### 外壳级风险

\`shell.root\`、\`shell.rail\`、\`shell.content\`、\`shell.titlebar\` 等 wrap 槽位可以替换整个应用外壳。
必须保留 children 或提供等价控件；插件崩溃时宿主会回退原生 UI。
用户可用 \`Ctrl+Alt+Shift+P\` 进入安全模式（不加载任何界面插件）恢复。`;

const EXAMPLES = `## 组合示例

### 工具 + 命令

\`\`\`ts
export default (api) => {
  api.registerTool({
    name: "project_stats",
    description: "统计当前工作区文件数",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async (_input, ctx) => ({ ok: true, output: "workspace: " + ctx.workspace }),
  });
  api.registerCommand({ name: "stats", description: "显示统计", run: () => "stats" });
};
\`\`\`

### RPC + 标题栏按钮

后端：

\`\`\`ts
export default (api) => {
  api.registerRpc("hello", () => ({ text: "hi from plugin" }));
};
\`\`\`

界面：

\`\`\`js
return {
  apply(ctx) {
    return ctx.slots.register(
      "session.header.actions",
      { id: "hello", order: 10, title: "Hello" },
      () => React.createElement("button", {
        onClick: async () => {
          const data = await ctx.rpc.call("hello", {});
          ctx.actions.toast(data.text);
        },
      }, "Hello"),
    );
  },
};
\`\`\`

### 自带面板

\`panel\` 传完整 HTML 字符串即可，右侧插件面板用 iframe 加载，可内联 CSS/JS。

## 规则

- id：小写字母/数字/连字符，1-64 位。反馈错误时按错误修正后重试。
- 权限按代码自动补齐；不需要手写 permissions。
- 只有本工具创建的产物允许覆盖；内置/市场/手写文件会被拒绝。
- 创建/修改成功后热重载：后端工具下一轮可用，界面立即出现（AI 创建免二次授权）。
- **不要截图或操作电脑验证 UI**：界面会自动热重载，需要视觉确认时请用户看。
- **不要读仓库源码推断 API**；缺信息就调用本工具对应 section。`;

const SECTIONS = {
  all: [BACKEND, CLIENT, SLOTS, PAGES, EXAMPLES].join("\n\n"),
  backend: BACKEND,
  client: CLIENT,
  slots: SLOTS,
  pages: PAGES,
  examples: EXAMPLES,
} as const;

export type GuideSection = keyof typeof SECTIONS;

export function pluginAuthoringGuide(section: GuideSection = "all"): string {
  return SECTIONS[section] ?? SECTIONS.all;
}
