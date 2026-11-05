/** 子进程环境：剔除 MeowCode 自身与用户凭据，保留系统/路径等基础变量。 */

/** 这些变量即使命中敏感词也保留（系统运行必需） */
const SAFE_ENV_NAMES = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "OS",
]);

/** 凭据类环境变量：命令不应该能读到用户的 token/key/secret */
const SENSITIVE_ENV_PATTERN =
  /(^|_)(KEY|KEYS|TOKEN|TOKENS|SECRET|SECRETS|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|AUTH|COOKIE|SESSION)(_|$)/i;
// 只拦真正指向凭据的变量；AWS_REGION / NPM_CONFIG_* 这类普通配置继续继承
const SENSITIVE_ENV_PREFIXES = ["KUBECONFIG", "PGPASSFILE", "NETRC"];

/**
 * 子进程环境：剔除 MeowCode 自身与用户凭据，保留系统/路径等基础变量。
 * 与 codex 的 shell_environment_policy 同思路：命令默认不该继承 API key。
 */
export function commandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (/^meowcode_/i.test(key)) continue;
    const upper = key.toUpperCase();
    if (SAFE_ENV_NAMES.has(upper)) {
      result[key] = value;
      continue;
    }
    if (SENSITIVE_ENV_PATTERN.test(key)) continue;
    if (SENSITIVE_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) continue;
    result[key] = value;
  }
  return result;
}

/** Windows env 大小写不敏感：先按不区分大小写删旧键，避免同一次 spawn 里出现重复键。 */
export function withPythonUtf8Env(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const key of Object.keys(env)) {
    if (/^PYTHONUTF8$/i.test(key) || /^PYTHONIOENCODING$/i.test(key)) delete env[key];
  }
  env.PYTHONUTF8 = "1";
  env.PYTHONIOENCODING = "utf-8";
  return env;
}
