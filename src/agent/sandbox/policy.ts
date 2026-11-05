import path from "node:path";
import {
  DEFAULT_SANDBOX_SETTINGS,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  MAX_SANDBOX_TIMEOUT_MS,
  MIN_SANDBOX_TIMEOUT_MS,
  type SandboxSettings,
} from "./types.js";

/** 把 settings.json / env 里的沙箱段归一化；非法值一律回落到关闭，绝不静默当已开。 */
export function normalizeSandboxSettings(
  raw: unknown,
  platform: NodeJS.Platform = process.platform,
): SandboxSettings {
  const parsed =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const modeSupported = parsed.mode === undefined || parsed.mode === "workspace-write";
  const enabled = parsed.enabled === true && platform === "win32" && modeSupported;
  const writableRoots = normalizeRoots(parsed.writableRoots, platform);
  const allowTemp = parsed.allowTemp !== false;
  const grantTimeoutMs =
    typeof parsed.grantTimeoutMs === "number" && Number.isFinite(parsed.grantTimeoutMs)
      ? Math.min(
          MAX_SANDBOX_TIMEOUT_MS,
          Math.max(MIN_SANDBOX_TIMEOUT_MS, Math.round(parsed.grantTimeoutMs)),
        )
      : DEFAULT_SANDBOX_TIMEOUT_MS;
  return {
    enabled,
    mode: "workspace-write",
    writableRoots,
    allowTemp,
    grantTimeoutMs,
    confirmDelete: parsed.confirmDelete === true,
  };
}

function normalizeRoots(raw: unknown, platform: NodeJS.Platform): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const value = item.trim();
    if (!value || !path.isAbsolute(value)) continue;
    const key = platform === "win32" ? value.toLowerCase() : value;
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(value);
  }
  return roots;
}

/** MEOWCODE_SANDBOX = JSON；解析失败视为关闭并报错，不静默当已开。 */
export function readSandboxSettingsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SandboxSettings {
  const raw = env.MEOWCODE_SANDBOX;
  if (!raw) return { ...DEFAULT_SANDBOX_SETTINGS };
  try {
    return normalizeSandboxSettings(JSON.parse(raw));
  } catch (error) {
    console.error(
      `[sandbox] ignoring invalid MEOWCODE_SANDBOX: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { ...DEFAULT_SANDBOX_SETTINGS };
  }
}

let current: SandboxSettings = { ...DEFAULT_SANDBOX_SETTINGS };

/** 进程级单例：exec 层在每条命令启动时读取，天然覆盖前台/侧边/后台/子 agent。 */
export function getSandboxSettings(): SandboxSettings {
  return current;
}

export function setSandboxSettings(next: unknown): SandboxSettings {
  current = normalizeSandboxSettings(next);
  return current;
}

export function resetSandboxSettingsForTests(): void {
  current = { ...DEFAULT_SANDBOX_SETTINGS };
}
