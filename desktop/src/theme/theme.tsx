import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { ThemePalette, ThemePreference } from "../api";

export type ResolvedTheme = "light" | "dark";

/** 与 index.html 里的防闪色内联脚本共用同一个 key。 */
const STORAGE_KEY = "meow:theme";
/** 配色镜像：同样给 index.html 的内联脚本用，避免首帧先按经典色画一遍。 */
const PALETTE_STORAGE_KEY = "meow:palette";

/** 配色白名单，必须与 api.ts 的 ThemePalette 和 main.cjs 的 PALETTES 一致。 */
export const PALETTE_VALUES: ThemePalette[] = [
  "classic",
  "lava",
  "bee",
  "mint",
  "parchment",
  "harmony",
];

export function isPalette(value: unknown): value is ThemePalette {
  return typeof value === "string" && (PALETTE_VALUES as string[]).includes(value);
}

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

/** 读配色镜像（用于首帧之前就定下配色，避免 classic → 目标色的跳变）。 */
export function readStoredPalette(): ThemePalette {
  try {
    const value = localStorage.getItem(PALETTE_STORAGE_KEY);
    if (isPalette(value)) return value;
  } catch {
    // localStorage 不可用时忽略
  }
  return "classic";
}

/**
 * 明暗与配色是两个正交维度，一次写两个属性：
 * 分两次写会在中间态渲染出一帧「目标明暗 + 旧配色」的错色。
 */
export function applyTheme(resolved: ResolvedTheme, palette: ThemePalette = "classic"): void {
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.palette = palette;
}

type ThemeContextValue = {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  /** 当前配色：classic 表示不加任何覆盖，走 tokens.css 的中性观感 */
  palette: ThemePalette;
  setPreference: (next: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * 受控的主题 Provider：偏好由 App 持有（来自 settings），
 * 这里负责解析 `system`、监听系统切换、并把结果写到 `<html data-theme/data-palette>`。
 */
export function ThemeProvider({
  preference,
  palette = "classic",
  onPreferenceChange,
  children,
}: {
  preference: ThemePreference;
  /** 配色方案；缺省 classic（悬浮岛等独立入口不传，保持中性观感） */
  palette?: ThemePalette;
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
    applyTheme(resolved, palette);
    // 镜像到 localStorage，供 index.html 的内联脚本在下次启动首帧前使用
    try {
      localStorage.setItem(STORAGE_KEY, resolved);
      localStorage.setItem(PALETTE_STORAGE_KEY, palette);
    } catch {
      // 忽略
    }
  }, [resolved, palette]);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolved, palette, setPreference: onPreferenceChange }),
    [preference, resolved, palette, onPreferenceChange],
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
