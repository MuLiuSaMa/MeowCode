/**
 * 技能与插件创作（内置插件）。
 *
 * 给 agent 两个工具，把「用户想要的新能力」直接做成已安装的技能或插件：
 *  - create_skill  → 写 ~/.meowcode/skills/<id>/SKILL.md，写「我的」标记，刷新技能索引；
 *  - create_plugin → 写 ~/.meowcode/plugins/<id>.ts，写「我的」标记，热重载插件系统。
 * 落盘、校验、覆盖策略与热更新都由宿主（api.host → src/server/extensions.ts）负责，
 * 插件本身不碰文件系统。插件是任意代码，create_plugin 每次调用先走审批流。
 */
import type { ToolResult } from "../../../agent/types.js";
import type { PluginAPI, PluginFactory } from "../../types.js";
import { pluginAuthoringGuide, type GuideSection } from "./guide.js";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function failed(error: string): ToolResult {
  return { ok: false, output: error };
}

const extensionAuthoringPlugin: PluginFactory = (api: PluginAPI) => {
  const host = api.host;
  if (!host) {
    api.logger.info("extension-authoring: host capability missing; tools not registered");
    return;
  }

  // 用户提到插件时在历史尾部注入一条提示（缓存安全），把模型引到速查工具而不是翻源码
  api.on("context_inject", (event) => {
    if (!/插件|plugin/i.test(event.text)) return;
    return {
      notes: [
        "【插件创作】先调用 plugin_authoring_guide 取 API 速查，再用 create_plugin 创建；不要阅读仓库源码来推断插件接口。创建/修改完成后不要截图或操作电脑验证：界面会自动热重载，需要视觉确认时直接请用户看。",
      ],
    };
  });

  // 插件 API 速查：按需返回，避免模型去仓库翻源码推断接口
  api.registerTool({
    name: "plugin_authoring_guide",
    description:
      "写 MeowCode 插件前先调用：返回完整插件 API 速查（后端工具/命令/RPC/hook、整站 UI 槽位、pages、右栏页签、ctx、示例与规则）。不要阅读仓库源码来推断插件 API。创建/修改后不要截图验证，界面会自动热重载。",
    parameters: {
      type: "object",
      properties: {
        section: {
          type: "string",
          enum: ["all", "backend", "client", "slots", "pages", "examples"],
          description: "只看某一节；缺省 all",
        },
      },
      additionalProperties: false,
    },
    execute: async (input) => {
      const raw = asString(input.section).trim();
      const section: GuideSection = [
        "all",
        "backend",
        "client",
        "slots",
        "pages",
        "examples",
      ].includes(raw)
        ? (raw as GuideSection)
        : "all";
      return { ok: true, output: pluginAuthoringGuide(section) };
    },
  });

  api.registerTool({
    name: "create_skill",
    description:
      "创建或覆盖一个 MeowCode 技能：把流程/知识写成 SKILL.md，安装到全局 ~/.meowcode/skills/<id>，创建后立即出现在「我的」与输入框 / 面板，下一轮即可被索引使用。用户要求把某套做法沉淀成可复用技能时调用。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "kebab-case 英文 id（技能目录名），如 weekly-report" },
        name: { type: "string", description: "技能中文显示名（缺省用 id）" },
        description: {
          type: "string",
          description: "一句话触发描述：说明什么时候该用这个技能（必填）",
        },
        body: { type: "string", description: "技能正文 Markdown（不含 frontmatter）" },
        always: {
          type: "boolean",
          description: "true = 每轮全文内联进上下文；默认 false，只进索引，按需 read_file 更省 token",
        },
      },
      required: ["id", "description", "body"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const id = asString(input.id).trim();
      const name = asString(input.name).trim();
      const result = await host.createSkill({
        id,
        ...(name ? { name } : {}),
        description: asString(input.description),
        body: asString(input.body),
        ...(input.always === true ? { always: true } : {}),
      });
      if (!result.ok) return failed(`创建技能失败（${result.stage}）：${result.error}`);
      return {
        ok: true,
        output: [
          `技能已创建：${result.id}`,
          `路径：${result.path}`,
          "状态：已安装（「我的」与输入框 / 面板可见），下一轮对话起可被技能索引加载。",
        ].join("\n"),
      };
    },
  });

  api.registerTool({
    name: "create_plugin",
    description:
      "创建或覆盖一个 MeowCode 插件包（写入全局 ~/.meowcode/plugins/<id>/：plugin.json + index.ts，可带 ui/client.js 或 ui/index.html），成功后热重载，新工具/命令/界面槽位/整页/右栏页签立刻可用；界面可挂到标题栏、导航、会话列表、聊天流、消息、输入框、设置页、右栏、文件树菜单，也可包裹/替换外壳。写之前先调用 plugin_authoring_guide 取完整 API（slots 分区有全部槽位），不要翻仓库源码。插件是任意代码，调用前会弹审批。需要新增工具、命令或界面入口时调用；已有技能能覆盖的场景不要建插件。创建/修改成功后不要用 computer_screenshot 或 browser_* 截图验证，界面会自动热重载；需要视觉确认时请用户看。",
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "kebab-case 英文 id（插件目录名），如 word-count" },
        name: { type: "string", description: "插件中文显示名（必填）" },
        description: { type: "string", description: "一句话介绍（必填）" },
        code: {
          type: "string",
          description:
            "后端源码，必须 `export default (api) => { ... }`；用 api.registerTool / registerCommand / api.on(hook) 注册能力，也可用 api.registerRpc 供界面调用",
        },
        permissions: {
          type: "array",
          items: {
            type: "string",
            enum: ["tools", "hooks", "commands", "storage", "rpc", "ui", "prompt"],
          },
          description:
            "权限声明；缺省按代码推断（后端基础权限 + registerRpc → rpc）。传 client 会自动补 ui/rpc/storage/prompt，传 panel 自动补 ui",
        },
        client: {
          type: "string",
          description:
            "可选界面代码（纯 JS，无 import/export/JSX）。会被当成 async 函数体执行，必须 return { apply(ctx) { ... } }。可用 ctx.pages.register({ id, title, icon?, order? }, 组件) 注册整页（自动进左栏与页面导航，ctx.actions.openPage(id) 打开）；也可用 ctx.slots.register 注册槽位：rail.actions、titlebar.actions、home.widgets、session.header.actions、composer.banner、composer.actions、message.toolCard（key=工具名替换内置卡片）、settings.sections。React 用 React.createElement；ctx.actions.sendPrompt/insertComposerText/toast/openExternal/openPage/showChat、ctx.rpc.call、ctx.storage、ctx.timers、styles.insert 均可用。",
        },
        panel: {
          type: "string",
          description:
            "可选完整面板 HTML（写入 ui/index.html，右侧插件面板用 iframe 加载）。适合复杂界面，可内联 CSS/JS；简单按钮优先用 client 槽位。",
        },
      },
      required: ["id", "name", "description", "code"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const client = asString(input.client);
      const panel = asString(input.panel);
      const permissions = Array.isArray(input.permissions)
        ? input.permissions.filter((item): item is string => typeof item === "string")
        : undefined;
      const result = await host.createPlugin({
        id: asString(input.id).trim(),
        name: asString(input.name),
        description: asString(input.description),
        code: asString(input.code),
        ...(client ? { client } : {}),
        ...(panel ? { panel } : {}),
        ...(permissions && permissions.length > 0
          ? { permissions: permissions as Parameters<typeof host.createPlugin>[0]["permissions"] }
          : {}),
      });
      if (!result.ok) return failed(`创建插件失败（${result.stage}）：${result.error}`);
      const toolLine = result.toolNames?.length ? `\n新工具：${result.toolNames.join(", ")}` : "";
      const uiLine = [
        result.client ? "\n界面：已写入 ui/client.js，槽位随热重载立即生效（AI 创建免二次授权）。" : "",
        result.panel ? "\n面板：已写入 ui/index.html，可在插件页/「我的」打开面板。" : "",
      ].join("");
      const warnLine = result.error ? `\n注意：${result.error}` : "";
      return {
        ok: true,
        output: [
          `插件已创建并加载：${result.id}`,
          `路径：${result.path}${toolLine}${uiLine}${warnLine}`,
          "状态：已安装（「已加载插件」与「我的」可见），下一轮即可调用新工具；可在插件页停用。",
        ].join("\n"),
      };
    },
  });
};

export default extensionAuthoringPlugin;
