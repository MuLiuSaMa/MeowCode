import i18n from "i18next";
import type { Resource } from "i18next";
import { initReactI18next } from "react-i18next";
import type { LanguagePreference } from "../api";
import { isUiLanguage, resolveUiLanguage, type UiLanguage } from "./languages";

/** 按文案域切命名空间，不按文件切：88 个组件文件会炸出 88 个 ns。 */
export const NAMESPACES = [
  "common",
  "shell",
  "composer",
  "chat",
  "git",
  "panel",
  "marketplace",
  "architecture",
  "settings",
  "onboarding",
  "errors",
] as const;

export type Namespace = (typeof NAMESPACES)[number];

export const DEFAULT_NAMESPACE: Namespace = "common";

/**
 * 语言偏好的 localStorage 镜像。首帧只能同步读它——异步 settings 要等 IPC，
 * 必然先渲染中文再切语言。key 与 index.html 内联脚本一致，改动要同时改两处。
 */
export const LANGUAGE_STORAGE_KEY = "meow:language";

const SOURCE_LANGUAGE: UiLanguage = "zh-CN";

function readStoredPreference(): LanguagePreference | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return raw === "system" || isUiLanguage(raw) ? raw : null;
  } catch {
    return null;
  }
}

function writeStoredPreference(preference: LanguagePreference): void {
  try {
    localStorage?.setItem(LANGUAGE_STORAGE_KEY, preference);
  } catch {
    // 镜像只是提速手段，写失败就退回异步 settings
  }
}

function browserLanguages(): string[] {
  if (typeof navigator === "undefined") return [];
  const listed = Array.isArray(navigator.languages) ? Array.from(navigator.languages) : [];
  const single = typeof navigator.language === "string" ? [navigator.language] : [];
  return [...listed, ...single];
}

function setDocumentLang(language: UiLanguage): void {
  if (typeof document !== "undefined") document.documentElement.lang = language;
}

/** 当前生效语种（i18n 未初始化时回落到源头语言，格式化函数也依赖它）。 */
export function currentLanguage(): UiLanguage {
  const language = i18n.language;
  return isUiLanguage(language) ? language : SOURCE_LANGUAGE;
}

/** 已存偏好；镜像缺失时按 "system" 处理。同步可读，供首帧前的组件取用。 */
export function getStoredPreference(): LanguagePreference {
  return readStoredPreference() ?? "system";
}

/** 偏好 → 实际语种，不改动全局状态，供启动前的同步判断使用。 */
export function resolvePreference(preference: LanguagePreference): UiLanguage {
  return resolveUiLanguage(preference, browserLanguages());
}

type JsonModules = Record<string, unknown>;

/** locales/<lng>/<ns>.json 全量静态注册：11 语 JSON 打包后仅几十 KB，不值得异步。 */
function buildResources(): Resource {
  const modules = import.meta.glob("./locales/*/*.json", {
    eager: true,
    import: "default",
  }) as JsonModules;
  const resources: Record<string, Record<string, object>> = {};
  for (const [file, content] of Object.entries(modules)) {
    const matched = /^\.\/locales\/([^/]+)\/([^/]+)\.json$/.exec(file);
    if (!matched || !content || typeof content !== "object") continue;
    const [, language, namespace] = matched;
    (resources[language] ??= {})[namespace] = content as Record<string, object>;
  }
  return resources as Resource;
}

/** 在 createRoot 之前调用，保证首帧就有译文。 */
export function setupI18n(): typeof i18n {
  if (i18n.isInitialized) return i18n;
  const language = resolvePreference(readStoredPreference() ?? "system");
  setDocumentLang(language);
  void i18n.use(initReactI18next).init({
    resources: buildResources(),
    lng: language,
    // 漏翻要显示中文，别用英文兜底——那会把「没翻」伪装成「翻好了」
    fallbackLng: [SOURCE_LANGUAGE],
    ns: [...NAMESPACES],
    defaultNS: DEFAULT_NAMESPACE,
    fallbackNS: DEFAULT_NAMESPACE,
    // React 自己会转义，i18next 再转一次会出现 &amp;
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  return i18n;
}

/**
 * 切换界面语言：写镜像 + 改 document.lang + 通知 i18next。
 * IPC 落盘由调用方（savePreferences）负责，这里不等待，切换才即时。
 */
export function applyLanguage(preference: LanguagePreference): UiLanguage {
  const language = resolvePreference(preference);
  writeStoredPreference(preference);
  setDocumentLang(language);
  void i18n.changeLanguage(language);
  return language;
}

/** settings IPC 回来后对账一次：镜像可能滞后于磁盘上的偏好（换机、清缓存）。 */
export function syncLanguageFromSettings(preference: LanguagePreference | undefined): void {
  const language = resolvePreference(preference ?? "system");
  writeStoredPreference(preference ?? "system");
  setDocumentLang(language);
  if (language !== currentLanguage()) void i18n.changeLanguage(language);
}

/** 非组件模块（没有 hook 可用）直接拿实例：`i18n.t("ns:key")`。 */
export default i18n;
