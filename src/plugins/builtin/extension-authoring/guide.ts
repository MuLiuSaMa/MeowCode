/**
 * 插件创作 API 速查表：通过工具按需返回给模型，避免它去仓库里翻源码。
 * 内容只描述 create_plugin 能产出的形态，不暴露宿主内部实现。
 */

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

| 槽位 | props | 说明 |
|---|---|---|
| \`rail.actions\` | \`{ view }\` | 左侧导航栏按钮 |
| \`titlebar.actions\` | \`{}\` | 标题栏右侧按钮 |
| \`home.widgets\` | \`{}\` | 右侧首页统计卡下方 |
| \`session.header.actions\` | \`{ sessionId, running, mode }\` | 会话标题栏 |
| \`composer.banner\` | \`{ text }\` | 输入框上方横幅 |
| \`composer.actions\` | \`{ text, setText, submit, disabled }\` | 输入框动作区 |
| \`message.toolCard\` | \`{ tool, status }\` | 用 entry.key=工具名替换内置卡片 |
| \`settings.sections\` | \`{}\` | 设置页分区，entry 带 title |

list 槽位按 \`order\` 升序；\`id\` 在插件内唯一。

### ctx

- \`ctx.slots.register(slot, entry, component)\`，返回 disposer。
- \`ctx.pages.register({ id, title, icon?, order? }, component)\`：整页注册（见下节）。
- \`ctx.actions\`：\`sendPrompt(text)\`、\`insertComposerText(text)\`、\`openPanel(pluginId)\`、\`toast(message, kind?)\`、\`openExternal(url)\`、\`openPage(pageId, pluginId?)\`、\`openView("chat"|"settings"|"plugins"|"git"|"automation"|"architecture")\`、\`showChat()\`。
- \`ctx.store.getState()\` → \`{ sessionId?, workspace?, theme, locale, view }\`；\`ctx.store.subscribe(fn)\`。
- \`ctx.rpc.call(method, args?)\`：调用后端 \`registerRpc\` 注册的方法。
- \`ctx.storage.get/set/delete\`。
- \`ctx.timers.setTimeout/setInterval(fn, ms)\`，返回 disposer。
- \`styles.insert(css)\`：注入样式，卸载自动移除。
- \`ctx.logger\`。`;

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
- 创建成功后热重载：后端工具下一轮可用，界面立即出现（AI 创建免二次授权）。
- **不要读仓库源码推断 API**；缺信息就调用本工具对应 section。`;

const SECTIONS = {
  all: [BACKEND, CLIENT, PAGES, EXAMPLES].join("\n\n"),
  backend: BACKEND,
  client: CLIENT,
  pages: PAGES,
  examples: EXAMPLES,
} as const;

export type GuideSection = keyof typeof SECTIONS;

export function pluginAuthoringGuide(section: GuideSection = "all"): string {
  return SECTIONS[section] ?? SECTIONS.all;
}
