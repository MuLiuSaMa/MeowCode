/**
 * 危险命令门禁插件（适配自 metis-main examples/extensions/permission-gate.ts）
 *
 * 拦截高危 shell 命令（rm -rf / sudo / chmod 777 等）。MeowCode 无进程内确认 UI，
 * 默认直接 block 并把原因作为工具结果返回给模型；用 /gate allow 临时放行下一回合。
 */
import type { PluginFactory } from "meowcode";

const DANGEROUS = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive\b.*--force\b|--force\b.*--recursive\b)/i,
  /\bsudo\b/i,
  /\b(chmod|chown)\b[^|;&]*777/i,
  /\b(format|diskpart)\b/i,
  /\b(del|rd)\s+\/[sq]\b/i,
];

const factory: PluginFactory = (api) => {
  let bypassTurns = 0;

  api.on("tool_call", (event) => {
    if (event.tool !== "run_command") return;
    if (bypassTurns > 0) return; // 放行窗口
    const command = String((event.input as { command?: unknown }).command ?? "");
    const hit = DANGEROUS.find((pattern) => pattern.test(command));
    if (hit) {
      return {
        block: true,
        reason: `危险命令被插件拦截（命中 ${hit}）。如需执行，请让用户在对话中发送 /gate allow 后重试。`,
      };
    }
  });

  api.registerCommand({
    name: "gate",
    description: "危险命令门禁：/gate allow 临时放行一回合，/gate strict 恢复拦截",
    run: (args) => {
      if (args.trim() === "allow") {
        bypassTurns += 1;
        return "门禁已临时放行本回合的危险命令。";
      }
      bypassTurns = 0;
      return "门禁已恢复严格拦截。";
    },
  });

  api.logger.info("permission-gate loaded（危险命令拦截）");
};

export default factory;
