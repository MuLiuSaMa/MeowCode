/**
 * 系统通知插件（适配自 metis-main examples/extensions/notify.ts）
 *
 * 回合结束时弹 Windows Toast 通知；非 Windows 或通知失败静默忽略。
 * 适配：metis agent_end → MeowCode turn_end；去掉终端 OSC（MeowCode 是桌面应用，server 无 TTY）。
 */
import type { PluginFactory } from "meowcode";

function windowsToast(title: string, body: string): void {
  const { execFile } = require("node:child_process") as typeof import("node:child_process");
  const type = "Windows.UI.Notifications";
  const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
  const template = `[${type}.ToastTemplateType]::ToastText01`;
  const toast = `[${type}.ToastNotification]::new($xml)`;
  const script = [
    `${mgr} > $null`,
    `$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
    `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body.replace(/'/g, "''")}')) > $null`,
    `[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
  ].join("; ");
  execFile("powershell.exe", ["-NoProfile", "-Command", script], () => undefined);
}

const factory: PluginFactory = (api) => {
  api.on("turn_end", (event) => {
    if (process.platform !== "win32") return;
    const body =
      event.status === "completed" ? "回合已完成，等待你的输入" : `回合结束（${event.status}）`;
    try {
      windowsToast("MeowCode", body);
    } catch {
      // 通知失败不影响回合
    }
  });
  api.logger.info("notify loaded（回合结束 Windows 通知）");
};

export default factory;
