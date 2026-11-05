import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { ThemePreference } from "../api";

export type ResolvedTheme = "light" | "dark";

/** 与 index.html 里的防闪色内联脚本共用同一个 key。 */
const STORAGE_KEY = "meow:theme";

export function systemTheme(): ResolvedTheme {
  if (typeof matchMedia !== "function") return "dark";
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** 读 localStorage 镜像（用于首帧之前就定下主题）。 */
export function readStoredTheme(): ResolvedTheme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark") return value;
  } catch {
    // localStorage 不可用时忽略
  }
  return systemTheme();
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

export function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.dataset.theme = resolved;
}

type ThemeContextValue = {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * 受控的主题 Provider：偏好由 App 持有（来自 settings），
 * 这里负责解析 `system`、监听系统切换、并把结果写到 `<html data-theme>`。
 */
export function ThemeProvider({
  preference,
  onPreferenceChange,
  children,
}: {
  preference: ThemePreference;
  onPreferenceChange: (next: ThemePreference) => void;
  children: ReactNode;
}) {
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(preference));

  // 跟随系统：偏好为 system 时监听 OS 明暗切换
  useEffect(() => {
    const update = () => setResolved(resolveTheme(preference));
    update();
    if (typeof matchMedia !== "function") return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [preference]);

  useEffect(() => {
    applyTheme(resolved);
    // 镜像到 localStorage，供 index.html 的内联脚本在下次启动首帧前使用
    try {
      localStorage.setItem(STORAGE_KEY, resolved);
    } catch {
      // 忽略
    }
  }, [resolved]);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolved, setPreference: onPreferenceChange }),
    [preference, resolved, onPreferenceChange],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  // 内部约定被破坏时的开发期报错；放在这里取译文，避免模块顶层求值
  const { t } = useTranslation("shell");
  if (!context) throw new Error(t("theme.providerMissing"));
  return context;
}
