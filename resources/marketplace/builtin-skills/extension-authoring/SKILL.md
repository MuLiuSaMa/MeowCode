---
name: 技能与插件创作
description: 当用户要求为 MeowCode 新建或修改技能（Skill）/插件，把一套流程、知识或工具沉淀成可复用能力时使用。
---

# 技能与插件创作

把用户想要的能力做成 MeowCode 的技能或插件。创建后即为**已安装状态、可直接使用**；不要手写文件路径，也不要让用户自己复制文件。

## 先确认

1. 触发场景：用户想解决什么问题、什么时候会用到它。
2. 形态：
   - **技能**：一套操作指南 / 知识 / 检查清单（Markdown），不执行代码。
   - **插件**：需要新增工具、斜杠命令、后台 hook，或要在界面上加入按钮/卡片/设置页时。
3. id：小写字母、数字、连字符（如 `weekly-report`）；再定一个中文显示名。

## 创建技能：`create_skill`

参数：

- `id`：kebab-case 目录名。
- `name`：中文显示名（可选，缺省用 id）。
- `description`：**必填**，一句话写清「何时使用」，它会进技能索引，决定以后能不能被想起。
- `body`：SKILL.md 正文（Markdown，不含 frontmatter）。
- `always`：默认 false；true 会每轮全文内联，费 token，非必要不开。

调用成功后写入 `~/.meowcode/skills/<id>/SKILL.md`，出现在输入框 `/` 面板与「我的」，下一轮对话起进入技能索引。

## 创建插件：`create_plugin`

插件包写入 `~/.meowcode/plugins/<id>/`：`plugin.json` + `index.ts`，可选 `ui/client.js`。**插件是任意代码，调用前会弹审批**，向用户说明用途后再调用。

写之前先调用 `plugin_authoring_guide`（可选 section：backend / client / pages / examples）取完整 API。**不要阅读仓库源码推断插件接口**，缺什么就查这份速查。

参数：

- `id` / `name`（中文名，必填）/ `description`（一句话介绍，必填）/ `code`（后端源码，必填）。
- `client`：可选界面槽位代码（纯 JS，无 import/export/JSX）。
- `panel`：可选完整面板 HTML（写入 `ui/index.html`，右侧插件面板 iframe 加载）。
- `permissions`：可选，`tools/hooks/commands/storage/rpc/ui/prompt`；缺省按代码推断，`client` 会自动补齐 `ui/rpc/storage/prompt`。

后端代码必须 `export default (api) => { ... }`。最小工具示例：

```ts
export default (api) => {
  api.registerTool({
    name: "word_count",
    description: "统计文本字数",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "要统计的文本" } },
      required: ["text"],
    },
    execute: async (input) => ({
      ok: true,
      output: `字数：${String(input.text ?? "").length}`,
    }),
  });
};
```

后端 API：`api.registerTool` / `api.registerCommand` / `api.registerRpc(method, handler)` / `api.on(hook)` / `api.storage` / `api.logger` / `api.workspace`。

### 界面插件（`client`）

`client` 会被当成 async 函数体，必须返回 `{ apply(ctx) { ... } }`。用 `ctx.slots.register(槽位, 条目, 组件)` 注册组件，组件用 `React.createElement` 返回元素。

可用槽位：

- `session.header.actions`：会话标题栏按钮。
- `composer.actions` / `composer.banner`：输入框动作区/上方横幅。
- `rail.actions`：左侧导航栏按钮（props 带 `view`，可自行判断选中态）。
- `titlebar.actions`：窗口标题栏右侧按钮。
- `home.widgets`：右侧首页信息卡下方的插件卡片。
- `message.toolCard`：按 `key=工具名` 替换该工具的内置卡片。
- `settings.sections`：设置页新增分区（条目带 `title`）。

需要完整页面时用 `ctx.pages.register({ id, title, icon?, order? }, 组件)`：页面会自动出现在左侧导航和页面导航，点开后占满主内容区。页面组件收到的 props 包含 `view`、`sessionId`、`workspace`；用 `ctx.actions.openPage("页面 id")` 切换、`ctx.actions.showChat()` 回对话。

```js
return {
  apply(ctx) {
    return ctx.pages.register(
      { id: "dashboard", title: "数据面板", icon: "📊", order: 10 },
      () => React.createElement("div", null, "Hello from plugin page"),
    );
  },
};
```

示例（后端加一个 RPC，界面加一个标题栏按钮）：

```ts
export default (api) => {
  api.registerRpc("hello", () => ({ ok: true, text: "hi from plugin" }));
};
```

```js
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
```

`ctx` 能力：`slots.register`、`pages.register`、`actions.sendPrompt/insertComposerText/openPanel/toast/openExternal/openPage/openView/showChat`、`store.getState/subscribe`、`rpc.call`、`storage.get/set/delete`、`timers.setTimeout/setInterval`、`logger`；样式用 `styles.insert(css)`。`openView` 可切到内置视图（chat/settings/plugins/git/automation/architecture）。没有 `window`/`document`/`fetch`，误用会报引导错误。

需要复杂界面时也可以传 `panel`：写一段完整 HTML（可内联 CSS/JS），它会成为插件自带面板，用户可从插件页打开。

创建成功后热重载：后端工具下一轮即可调用；界面槽位与面板立即出现（AI 创建的插件免二次授权）。在「已加载插件」与「我的」可见。

## 失败与重试

工具失败会返回具体原因（id 非法 / 覆盖被拒 / 插件加载失败）。按错误修正后再次调用；**只有本功能创建的产物允许覆盖**，市场安装项、内置插件与用户手写文件一律拒改。插件加载失败时会自动回滚旧文件，可以放心修错重试。

## 收尾

告诉用户：做了什么、id/显示名、在哪个列表能看到、怎么用；插件还要说明可用「已加载插件」里的开关停用。
