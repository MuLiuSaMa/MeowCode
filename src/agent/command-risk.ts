import type { CommandRisk, CommandRiskCategory } from "./types.js";

/** 类别 → 严重档：high = 不可逆/凭据/任意代码执行；medium = 可逆但敏感。 */
const CATEGORY_LEVEL: Record<CommandRiskCategory, "medium" | "high"> = {
  disk_system: "high",
  recursive_delete: "high",
  credential_access: "high",
  remote_exec: "high",
  inline_exec: "high",
  destructive_git: "high",
  env_dump: "medium",
  system_config: "medium",
  privilege_escalation: "medium",
  process_kill: "medium",
  publish_deploy: "medium",
};

/** 磁盘根目录 / 系统目录 / 系统盘变量；用于递归删除类命令的二次判定。 */
const DANGEROUS_TARGET =
  /(?:[a-z]:[\\/](?=$|[\s*?"'])|%systemdrive%|\$env:systemdrive|[a-z]:[\\/]windows\b)/i;

/** 工作区外/用户目录/家目录：递归删除命中即弹审批（相对 node_modules 等不拦）。 */
const OUTSIDE_TARGET =
  /(?:^|[\s"'`=])(?:[a-z]:[\\/]|\\\\|~[\\/]|~(?=\s|$)|\$home\b|%userprofile%|\$env:userprofile|\.\.(?:[\\/]|(?=\s|$)))/i;

/** 本机凭据目录：命令能直接读到它们时，auto 模式必须停下来问一次。 */
const CREDENTIAL_PATH =
  /(?:^|[\s"'`=])(?:~[\\/]|\$home[\\/]|%userprofile%[\\/]|\$env:userprofile[\\/]|[a-z]:\\users\\[^\\\s"'`]+[\\/])(?:\.ssh\b|\.aws\b|\.azure\b|\.kube\b|\.docker\b|\.config\\gcloud\b|\.gnupg\b)/i;
const CREDENTIAL_FILE =
  /\b(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|\.git-credentials|\.netrc|_netrc|\.pypirc|\.npmrc)\b/i;
const ENV_DUMP =
  /\b(?:printenv)\b|\b(?:get-childitem|gci|get-item|dir|ls)\s+(?:env:|environment::)|\b(?:dir|set)\s+env:(?:\s|$)|\bgetenvironmentvariables\b/i;

/** 下载即执行：Auto 模式最危险的组合，必须弹审批。 */
const REMOTE_EXEC =
  /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|start-bitstransfer|bitsadmin)\b[^\r\n]*\|\s*(?:iex|invoke-expression|sh|bash|zsh|pwsh|powershell|cmd)\b/i;
const INLINE_EXEC =
  /\b(?:iex|invoke-expression)\s*(?:\(|\s)|(?:^|\s)-encodedcommand\b|\bcertutil\b[^\r\n]*-urlcache/i;

const SYSTEM_COMMANDS =
  /^\s*(?:&|\.)?\s*(?:setx|reg(?:\.exe)?\s+(?:add|delete|import|copy|restore)|schtasks(?:\.exe)?|sc(?:\.exe)?\s+(?:config|start|stop|delete|failure)|new-service|set-executionpolicy|icacls(?:\.exe)?|takeown(?:\.exe)?|netsh(?:\.exe)?|dism(?:\.exe)?|wmic(?:\.exe)?|gpupdate|mountvol|diskpart|bcdedit|vssadmin)\b/i;
const PRIVILEGE = /^\s*(?:sudo|runas|gsudo)\b|^\s*start-process\b[^\r\n]*-verb\s+runas\b/i;
const PROCESS_KILL = /^\s*(?:taskkill(?:\.exe)?|stop-process|pkill|killall)\b/i;

const DESTRUCTIVE_GIT =
  /^\s*git\s+(?:push\b[^\r\n]*(?:--force\b|-f(?:\s|$))|reset\s+--hard\b|clean\b[^\r\n]*(?:^|\s)-[a-z]*f[a-z]*(?=\s|$)|branch\s+[^\r\n]*(?:-D(?:\s|$)|--delete\s+--force\b)|filter-branch\b|update-ref\s+-d\b)/i;

const PUBLISH_OR_DEPLOY =
  /^\s*(?:npm|pnpm|yarn|bun)\s+publish\b|^\s*cargo\s+publish\b|^\s*twine\s+upload\b|^\s*(?:pip|python\s+-m\s+pip)\s+.*\b(?:upload|twine)\b|^\s*docker\s+push\b|^\s*kubectl\s+(?:delete|apply|replace|drain|cordon)\b|^\s*terraform\s+(?:apply|destroy|import)\b|^\s*gh\s+release\b|^\s*vercel\b[^\r\n]*--prod\b|^\s*wrangler\s+deploy\b|^\s*(?:firebase|netlify)\s+deploy\b/i;

const RECURSIVE_DELETE =
  /^\s*(?:&|\.)?\s*(?:remove-item|rm|rd|rmdir|del|erase)(?:\.exe)?\b/i;
const RECURSIVE_FLAG = /(?:^|\s)(?:-recurse\b|-[a-z]*r[a-z]*(?=\s|$))|(?:^|\s)\/s(?:\s|$)/i;
const MIRROR_COPY = /^\s*robocopy\b[^\r\n]*\/mir\b/i;

/** 去掉 `&`、`cmd /c`、`powershell -Command` 外壳：内层命令也要按首词判定。 */
function normalizeSegment(segment: string): string {
  let next = segment.trim().replace(/^&\s*/, "");
  for (;;) {
    const prev = next;
    next = next
      .replace(
        /^(?:cmd(?:\.exe)?\s+\/c|powershell(?:\.exe)?\s+(?:-command|-c)|pwsh(?:\.exe)?\s+(?:-command|-c))\s+/i,
        "",
      )
      .trim();
    if (next === prev) return next;
  }
}

/** 命令按连接符切段：`;`、换行、`|`（含 `||`）、`&&`；逐段判定，避免长命令里藏后半段。 */
function segmentsOf(text: string): string[] {
  return text
    .split(/[;\r\n|]|&&/)
    .map(normalizeSegment)
    .filter(Boolean);
}

/**
 * 文件/目录删除命令识别（用于「文件删除确认」设置）。
 * 复用 segmentsOf 的 shell 解包与分段，避免长命令里藏后半段；
 * 只做启发式，不参与风险分级。
 */
const FILE_DELETE_SEGMENT =
  /^(?:&|\.)?\s*(?:(?:remove-item|del|erase|rmdir|rd|rm|unlink)(?:\.exe)?\b|remove(?:\.exe)?(?=\s|$))|^\s*git\s+clean\b|^\s*robocopy\b[^\r\n]*\/mir\b|^\s*\[system\.io\.(?:file|directory)\]::delete\b/i;

export function isFileDeletionCommand(command: string): boolean {
  return segmentsOf(command).some((segment) =>
    FILE_DELETE_SEGMENT.test(segment.replace(/^["']+/, "")),
  );
}

/**
 * 保守的高风险命令特征：只用于审批提示，不做拦截。
 *
 * 注意：这是 auto 模式的启发式护栏，不是沙箱 —— 永远存在绕过面。
 * 真正的执行边界靠 run_code/子进程的隔离（见 code-mode.ts）与 full 模式的显式授权。
 */
export function assessCommandRisk(command: string): CommandRisk | undefined {
  const text = command.trim();
  if (!text) return undefined;

  const reasons: string[] = [];
  const categories = new Set<CommandRiskCategory>();
  const add = (category: CommandRiskCategory, label: string, matched: boolean) => {
    if (matched) {
      reasons.push(label);
      categories.add(category);
    }
  };
  const segments = segmentsOf(text);

  add("disk_system", "diskpart 可以修改磁盘分区", /\bdiskpart(?:\.exe)?\b/i.test(text));
  add("disk_system", "format 会格式化磁盘", /(?:^|[;&|\r\n]\s*)format(?:\.com)?\s+[a-z]:/i.test(text));
  add(
    "disk_system",
    "reg delete 会删除系统注册表项",
    /\breg(?:\.exe)?\s+delete\s+(?:hklm|hkcr|hku|hkey_local_machine|hkey_classes_root|hkey_users)\b/i.test(
      text,
    ),
  );
  add("disk_system", "bcdedit 会修改启动配置", /\bbcdedit(?:\.exe)?\b/i.test(text));
  add(
    "system_config",
    "关机会中断当前系统会话",
    /\b(?:shutdown(?:\.exe)?|restart-computer|stop-computer|reset-computer)\b/i.test(text),
  );
  add(
    "disk_system",
    "清除或初始化磁盘会破坏数据",
    /\b(?:clear-disk|initialize-disk|format-volume)\b/i.test(text),
  );
  add(
    "disk_system",
    "删除卷影副本会影响系统还原",
    /\bvssadmin(?:\.exe)?\b[^\r\n]*\bdelete\b[^\r\n]*\bshadows\b/i.test(text),
  );

  add(
    "recursive_delete",
    "递归删除磁盘根目录或系统目录",
    segments.some(
      (segment) =>
        /\b(?:remove-item|rm)\b/i.test(segment) &&
        /-recurse\b/i.test(segment) &&
        DANGEROUS_TARGET.test(segment),
    ),
  );
  add(
    "recursive_delete",
    "递归删除磁盘根目录",
    segments.some(
      (segment) =>
        /\b(?:del|erase|rd|rmdir)(?:\.exe)?\b/i.test(segment) &&
        /(?:^|\s)\/s(?:\s|$)/i.test(segment) &&
        DANGEROUS_TARGET.test(segment),
    ),
  );

  add("credential_access", "会读取本机凭据（SSH / 云平台 / 包管理器）", CREDENTIAL_PATH.test(text));
  add("credential_access", "会读取私钥或凭据文件", CREDENTIAL_FILE.test(text));
  add("env_dump", "会导出全部环境变量（可能包含密钥）", ENV_DUMP.test(text));
  add("remote_exec", "会下载并直接执行远程脚本", REMOTE_EXEC.test(text));
  add("inline_exec", "会在当前 shell 内动态执行代码", INLINE_EXEC.test(text));

  for (const segment of segments) {
    add("system_config", "会修改系统或安全配置", SYSTEM_COMMANDS.test(segment));
    add("privilege_escalation", "会尝试提权", PRIVILEGE.test(segment));
    add("process_kill", "会结束其他进程", PROCESS_KILL.test(segment));
    add("destructive_git", "会执行破坏性 git 操作（强制推送 / 硬重置 / 强制清理）", DESTRUCTIVE_GIT.test(segment));
    add("publish_deploy", "会发布或部署到远端", PUBLISH_OR_DEPLOY.test(segment));
    add(
      "recursive_delete",
      "会递归删除工作区外的路径",
      RECURSIVE_DELETE.test(segment) &&
        RECURSIVE_FLAG.test(segment) &&
        OUTSIDE_TARGET.test(segment),
    );
    add("recursive_delete", "robocopy /MIR 会镜像删除目标目录内容", MIRROR_COPY.test(segment));
  }

  if (!reasons.length) return undefined;
  const level = [...categories].some((category) => CATEGORY_LEVEL[category] === "high")
    ? "high"
    : "medium";
  return { level, categories: [...categories], reasons };
}
