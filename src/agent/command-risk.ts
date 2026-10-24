import type { CommandRisk } from "./types.js";

/** 磁盘根目录 / 系统目录 / 系统盘变量；用于递归删除类命令的二次判定。 */
const DANGEROUS_TARGET =
  /(?:[a-z]:[\\/](?=$|[\s*?"'])|%systemdrive%|\$env:systemdrive|[a-z]:[\\/]windows\b)/i;

/** 保守的高风险命令特征：只用于审批提示，不做拦截。 */
export function assessCommandRisk(command: string): CommandRisk | undefined {
  const text = command.trim();
  if (!text) return undefined;

  const reasons: string[] = [];
  const add = (label: string, matched: boolean) => {
    if (matched) reasons.push(label);
  };

  add("diskpart 可以修改磁盘分区", /\bdiskpart(?:\.exe)?\b/i.test(text));
  add("format 会格式化磁盘", /(?:^|[;&|\r\n]\s*)format(?:\.com)?\s+[a-z]:/i.test(text));
  add(
    "reg delete 会删除系统注册表项",
    /\breg(?:\.exe)?\s+delete\s+(?:hklm|hkcr|hku|hkey_local_machine|hkey_classes_root|hkey_users)\b/i.test(
      text,
    ),
  );
  add("bcdedit 会修改启动配置", /\bbcdedit(?:\.exe)?\b/i.test(text));
  add(
    "关机会中断当前系统会话",
    /\b(?:shutdown(?:\.exe)?|restart-computer|stop-computer|reset-computer)\b/i.test(text),
  );
  add(
    "清除或初始化磁盘会破坏数据",
    /\b(?:clear-disk|initialize-disk|format-volume)\b/i.test(text),
  );
  add(
    "删除卷影副本会影响系统还原",
    /\bvssadmin(?:\.exe)?\b[^\r\n]*\bdelete\b[^\r\n]*\bshadows\b/i.test(text),
  );

  const segments = text.split(/[;\r\n|]/);
  add(
    "递归删除磁盘根目录或系统目录",
    segments.some(
      (segment) =>
        /\b(?:remove-item|rm)\b/i.test(segment) &&
        /-recurse\b/i.test(segment) &&
        DANGEROUS_TARGET.test(segment),
    ),
  );
  add(
    "递归删除磁盘根目录",
    segments.some(
      (segment) =>
        /\b(?:del|erase|rd|rmdir)(?:\.exe)?\b/i.test(segment) &&
        /(?:^|\s)\/s(?:\s|$)/i.test(segment) &&
        DANGEROUS_TARGET.test(segment),
    ),
  );

  return reasons.length ? { level: "high", reasons } : undefined;
}
