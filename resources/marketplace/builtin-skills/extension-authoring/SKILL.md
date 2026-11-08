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
   - **插件**：需要新增工具或斜杠命令、要跑代码时。
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

单文件插件，写入 `~/.meowcode/plugins/<id>.ts`。**插件是任意代码，调用前会弹审批**，向用户说明用途后再调用。

参数：`id` / `name`（中文名，必填）/ `description`（一句话介绍，必填）/ `code`（完整源码）。

代码必须 `export default (api) => { ... }`。最小示例：

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

可用 API：`api.registerTool` / `api.registerCommand` / `api.on(hook)` / `api.storage` / `api.logger` / `api.workspace`。斜杠命令用 `api.registerCommand({ name, description, run })`。

创建成功后会热重载，新工具下一轮即可调用；在「已加载插件」与「我的」可见。

## 失败与重试

工具失败会返回具体原因（id 非法 / 覆盖被拒 / 插件加载失败）。按错误修正后再次调用；**只有本功能创建的产物允许覆盖**，市场安装项、内置插件与用户手写文件一律拒改。插件加载失败时会自动回滚旧文件，可以放心修错重试。

## 收尾

告诉用户：做了什么、id/显示名、在哪个列表能看到、怎么用；插件还要说明可用「已加载插件」里的开关停用。
