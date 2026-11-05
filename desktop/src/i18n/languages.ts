import type { LanguagePreference } from "../api";

/** 去掉 "system" 后的具体语种。 */
export type UiLanguage = Exclude<LanguagePreference, "system">;

/**
 * 界面语言清单。nativeName 用该语言自身的写法，刻意不参与翻译——
 * 语言名要用母语读才认得出，翻成别的语言反而找不到。
 */
export const UI_LANGUAGES: Array<{ code: UiLanguage; nativeName: string }> = [
  { code: "zh-CN", nativeName: "简体中文" },
  { code: "zh-TW", nativeName: "繁體中文" },
  { code: "en", nativeName: "English" },
  { code: "ja", nativeName: "日本語" },
  { code: "ko", nativeName: "한국어" },
  { code: "ru", nativeName: "Русский" },
  { code: "de", nativeName: "Deutsch" },
  { code: "fr", nativeName: "Français" },
  { code: "es", nativeName: "Español" },
  { code: "pt", nativeName: "Português" },
  { code: "hi", nativeName: "हिन्दी" },
];

const CODES = new Set<string>(UI_LANGUAGES.map((language) => language.code));

export function isUiLanguage(value: unknown): value is UiLanguage {
  return typeof value === "string" && CODES.has(value);
}

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === "system" || isUiLanguage(value);
}

/** 单个 BCP-47 标签 → 语种；无法归类返回 null。 */
function matchTag(tag: string): UiLanguage | null {
  const normalized = tag.trim().replace(/_/g, "-").toLowerCase();
  if (!normalized) return null;
  if (CODES.has(normalized)) return normalized as UiLanguage;

  const [base, region, script] = normalized.split("-");
  if (base === "zh") {
    // 港澳台与显式繁体标记走繁体，其余（含 zh-SG 等）走简体
    if (region === "tw" || region === "hk" || region === "mo") return "zh-TW";
    if (script === "hant" || normalized.includes("hant")) return "zh-TW";
    return "zh-CN";
  }
  if (CODES.has(base)) return base as UiLanguage;
  return null;
}

/**
 * 偏好 → 实际语种。"system" 按 navigator.languages 顺序找第一个能归类的标签；
 * 全都对不上落 zh-CN（产品源头语言，与改动前行为一致，不给新用户突脸）。
 */
export function resolveUiLanguage(
  preference: LanguagePreference,
  navigatorLanguages: readonly string[],
): UiLanguage {
  if (preference !== "system") return preference;
  for (const tag of navigatorLanguages) {
    const matched = matchTag(tag);
    if (matched) return matched;
  }
  return "zh-CN";
}
