/**
 * 会话总结命令插件（适配自 metis-main examples/extensions/summarize.ts）
 *
 * /summarize 命令：生成一条结构化总结 prompt，让模型对当前会话做阶段小结。
 */
import type { PluginFactory } from "meowcode";

const factory: PluginFactory = (api) => {
  api.registerCommand({
    name: "summarize",
    description: "总结当前会话的进展（目标/已完成/待办/风险）",
    run: (args) => {
      const focus = args.trim();
      return [
        "请对当前会话做一份结构化总结，包含：",
        "1. 目标 —— 用户最初想完成什么",
        "2. 已完成 —— 已落地的改动与验证结果",
        "3. 待办 —— 尚未完成的事项（如有顺序请排序）",
        "4. 风险 —— 已知问题与注意事项",
        focus ? `\n重点围绕：${focus}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    },
  });

  api.logger.info("summarize loaded（/summarize 命令）");
};

export default factory;
