/**
 * 内置示例插件：安全守卫（tool_call 拦截危险命令 + prompt_submit 过滤注入模式）。
 */
import type { PluginFactory } from "meowcode";

const DESTRUCTIVE = /rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b|del\s+\/[sq]|format\s+[a-z]:/i;

const factory: PluginFactory = (api) => {
  api.on("tool_call", (event) => {
    if (event.tool === "run_command") {
      const command = String((event.input as { command?: unknown }).command ?? "");
      if (DESTRUCTIVE.test(command)) {
        return { block: true, reason: `destructive command: ${command}` };
      }
    }
  });

  api.on("prompt_submit", (event) => {
    if (/请?忽略(之前|以上)的所有(指令|规则)/.test(event.text)) {
      return { block: true, reason: "prompt-injection pattern detected" };
    }
  });

  api.logger.info("guard loaded（危险命令与注入模式拦截）");
};

export default factory;
