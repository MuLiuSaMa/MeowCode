import type { LanguagePreference, ThemePreference } from "../../api";

/** 引导步骤。未选择服务商时 connect 会被跳过。 */
export type OnboardingStep = "language" | "theme" | "provider" | "connect" | "finish";

export type OnboardingLocale = "zh-CN";

export const LANGUAGE_OPTIONS: Array<{ value: LanguagePreference; label: string }> = [
  { value: "system", label: "跟随系统" },
  { value: "zh-CN", label: "简体中文" },
];

/**
 * 目前只有简体中文词条；system 也解析到 zh-CN。
 * 新增语种时在这里按 navigator.language 扩展，并给 ONBOARDING_COPY 补一份词条即可。
 */
export function resolveOnboardingLocale(preference: LanguagePreference): OnboardingLocale {
  void preference;
  return "zh-CN";
}

type Copy = {
  actions: {
    back: string;
    next: string;
    skip: string;
    later: string;
    connect: string;
    connecting: string;
    start: string;
    finishing: string;
    close: string;
  };
  language: {
    title: string;
    label: string;
    previewLabel: string;
    previewText: string;
    systemMeta: string;
    zhMeta: string;
  };
  theme: {
    title: string;
    desc: string;
    options: Record<ThemePreference, { label: string; desc: string }>;
  };
  provider: {
    title: string;
    searchLabel: string;
    searchPlaceholder: string;
    empty: string;
    customName: string;
    customMeta: string;
    needsEndpoint: string;
  };
  connect: {
    title: string;
    saveFailed: string;
  };
  finish: {
    title: string;
    desc: string;
    noProvider: string;
  };
};

const ZH_CN: Copy = {
  actions: {
    back: "上一步",
    next: "继续",
    skip: "跳过",
    later: "稍后配置",
    connect: "完成接入",
    connecting: "正在接入…",
    start: "开始使用",
    finishing: "正在完成…",
    close: "关闭引导",
  },
  language: {
    title: "选择语言",
    label: "语言",
    previewLabel: "语言预览",
    previewText: "你好，欢迎使用 MeowCode。",
    systemMeta: "跟随系统 · 当前为简体中文",
    zhMeta: "界面语言 · 简体中文",
  },
  theme: {
    title: "选择主题",
    desc: "选择后立即生效，稍后也可以随时在设置 → 外观中更改。",
    options: {
      system: { label: "跟随系统", desc: "实时跟随 Windows 的浅色 / 深色设置" },
      light: { label: "浅色", desc: "始终使用浅色界面" },
      dark: { label: "深色", desc: "始终使用深色界面" },
    },
  },
  provider: {
    title: "选择 AI 服务商",
    searchLabel: "搜索服务商",
    searchPlaceholder: "按名称或 id 搜索，例如 deepseek",
    empty: "没有匹配的服务商 —— 可以试试「自定义服务商」",
    customName: "自定义服务商",
    customMeta: "手动填写端点与密钥",
    needsEndpoint: "需填写端点",
  },
  connect: {
    title: "接入 AI 服务商",
    saveFailed: "接入失败，请检查配置后重试。",
  },
  finish: {
    title: "准备就绪",
    desc: "设置已完成，现在可以开始使用 MeowCode 了。",
    noProvider: "尚未配置模型，可以稍后在设置 → 模型中添加。",
  },
};

export const ONBOARDING_COPY: Record<OnboardingLocale, Copy> = {
  "zh-CN": ZH_CN,
};
