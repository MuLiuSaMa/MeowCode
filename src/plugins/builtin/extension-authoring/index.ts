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
      "创建或覆盖一个 MeowCode 单文件插件（写入全局 ~/.meowcode/plugins/<id>.ts），成功后热重载、工具立刻可用。插件是任意代码，调用前会弹审批。用户要新增工具或斜杠命令时调用；已有技能能覆盖的场景不要建插件。",
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "kebab-case 英文 id（文件名），如 word-count" },
        name: { type: "string", description: "插件中文显示名（必填）" },
        description: { type: "string", description: "一句话介绍（必填）" },
        code: {
          type: "string",
          description:
            "完整插件源码，必须 `export default (api) => { ... }`；用 api.registerTool/registerCommand 注册能力",
        },
      },
      required: ["id", "name", "description", "code"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const result = await host.createPlugin({
        id: asString(input.id).trim(),
        name: asString(input.name),
        description: asString(input.description),
        code: asString(input.code),
      });
      if (!result.ok) return failed(`创建插件失败（${result.stage}）：${result.error}`);
      const toolLine = result.toolNames?.length ? `\n新工具：${result.toolNames.join(", ")}` : "";
      const warnLine = result.error ? `\n注意：${result.error}` : "";
      return {
        ok: true,
        output: [
          `插件已创建并加载：${result.id}`,
          `路径：${result.path}${toolLine}${warnLine}`,
          "状态：已安装（「已加载插件」与「我的」可见），下一轮即可调用新工具；可在插件页停用。",
        ].join("\n"),
      };
    },
  });
};

export default extensionAuthoringPlugin;
