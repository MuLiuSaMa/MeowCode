import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuArrowLeft,
  LuArrowRight,
  LuBoxes,
  LuCheck,
  LuLanguages,
  LuMonitor,
  LuMoon,
  LuPalette,
  LuPlug,
  LuRocket,
  LuSearch,
  LuSun,
  LuX,
} from "react-icons/lu";
import type {
  LanguagePreference,
  ProviderSettings,
  ThemePreference,
} from "../../api";
import {
  CUSTOM_TEMPLATE,
  PROVIDER_CATALOG,
  type ProviderTemplate,
} from "../../data/providerCatalog";
import { currentLanguage } from "../../i18n";
import { UI_LANGUAGES } from "../../i18n/languages";
import { Button } from "../ui/Button";
import { TextField } from "../ui/TextField";
import { ProviderIcon } from "../ui/ProviderIcon";
import { ProviderFormBody, useProviderForm } from "../settings/ProviderFormBody";
import { providerLabel } from "../settings/modelForm";
import type { OnboardingStep } from "./copy";
import "./Onboarding.css";

const THEME_ORDER: ThemePreference[] = ["system", "light", "dark"];
const THEME_ICONS: Record<ThemePreference, typeof LuMonitor> = {
  system: LuMonitor,
  light: LuSun,
  dark: LuMoon,
};
const STEP_ICONS: Record<OnboardingStep, typeof LuMonitor> = {
  language: LuLanguages,
  theme: LuPalette,
  provider: LuBoxes,
  connect: LuPlug,
  finish: LuRocket,
};
/** 表里只存 key：标题在组件内查表，切语言才会跟着刷新。 */
const STEP_TITLE_KEYS: Record<OnboardingStep, string> = {
  language: "language.title",
  theme: "theme.title",
  provider: "provider.title",
  connect: "connect.title",
  finish: "finish.title",
};

/** 未选服务商时占位：connect 步骤不渲染，只是保证 hook 调用顺序稳定 */
const EMPTY_DRAFT: ProviderSettings = {
  id: "",
  name: "",
  baseUrl: "",
  model: "",
  inputModalities: ["text"],
  enabled: true,
};

export type OnboardingProps = {
  initialLanguage: LanguagePreference;
  initialTheme: ThemePreference;
  providers: ProviderSettings[];
  /** 从设置页重新进入：可关闭，且不影响已有配置 */
  replay: boolean;
  onSaveLanguage: (value: LanguagePreference) => void;
  onSaveTheme: (value: ThemePreference) => void;
  onSaveProviders: (entries: ProviderSettings[]) => Promise<boolean>;
  onFinish: () => Promise<void>;
  onClose: () => void;
};

/**
 * 首次启动引导：语言 → 主题 → 服务商 → 接入 → 完成。
 * 未选择服务商时跳过「接入」，从服务商直接到完成页。
 */
export function Onboarding({
  initialLanguage,
  initialTheme,
  providers,
  replay,
  onSaveLanguage,
  onSaveTheme,
  onSaveProviders,
  onFinish,
  onClose,
}: OnboardingProps) {
  const [step, setStep] = useState<OnboardingStep>("language");
  const [language, setLanguage] = useState<LanguagePreference>(initialLanguage);
  const [theme, setTheme] = useState<ThemePreference>(initialTheme);
  const [template, setTemplate] = useState<ProviderTemplate | null>(null);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<ProviderSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [providerSaved, setProviderSaved] = useState(false);

  const { t } = useTranslation("onboarding");
  const StepIcon = STEP_ICONS[step];
  const title = t(STEP_TITLE_KEYS[step]);

  /** 与设置页共用同一份表单逻辑：多模型行、勾选、行内上下文、获取模型列表 */
  const form = useProviderForm({
    draft: draft ?? EMPTY_DRAFT,
    existingLabels: providers.map(providerLabel),
    onSave: (entries) => {
      if (saving) return;
      setSaving(true);
      setError(null);
      void onSaveProviders(entries).then((ok) => {
        setSaving(false);
        if (!ok) {
          setError(t("connect.saveFailed"));
          return;
        }
        setProviderSaved(true);
        setStep("finish");
      });
    },
  });

  // 语言名用各自母语写法、不参与翻译：翻成当前界面语言反而认不出自己要切去哪
  const activeLanguage = language === "system" ? currentLanguage() : language;
  const activeLanguageName =
    UI_LANGUAGES.find((item) => item.code === activeLanguage)?.nativeName ?? activeLanguage;

  const filteredProviders = useMemo(() => {
    const key = query.trim().toLowerCase();
    if (!key) return PROVIDER_CATALOG;
    return PROVIDER_CATALOG.filter(
      (item) => item.id.toLowerCase().includes(key) || item.name.toLowerCase().includes(key),
    );
  }, [query]);

  const customName = t("provider.customName");
  const showCustom = useMemo(() => {
    const key = query.trim().toLowerCase();
    return !key || "custom".includes(key) || customName.toLowerCase().includes(key);
  }, [query, customName]);

  const providerHost = (item: ProviderTemplate) => {
    if (!item.baseUrl) return t("provider.needsEndpoint");
    try {
      return new URL(item.baseUrl).host;
    } catch {
      return item.baseUrl;
    }
  };

  const pickTemplate = (next: ProviderTemplate) => {
    setTemplate(next);
    setDraft({
      id: `provider-${Date.now()}`,
      name: next.id === CUSTOM_TEMPLATE.id ? "" : next.name,
      baseUrl: next.baseUrl,
      model: "",
      protocol: next.protocol,
      templateId: next.id,
      inputModalities: ["text"],
      enabled: true,
    });
    setError(null);
  };

  const chooseLanguage = (value: LanguagePreference) => {
    setLanguage(value);
    onSaveLanguage(value);
  };

  const chooseTheme = (value: ThemePreference) => {
    setTheme(value);
    onSaveTheme(value);
  };

  const back = () => {
    if (step === "theme") setStep("language");
    else if (step === "provider") setStep("theme");
    else if (step === "connect") setStep("provider");
    else if (step === "finish") setStep(template ? "connect" : "provider");
  };

  const next = () => {
    if (step === "language") setStep("theme");
    else if (step === "theme") setStep("provider");
    else if (step === "provider" && template) setStep("connect");
  };

  const skipProvider = () => {
    setTemplate(null);
    setError(null);
    setStep("finish");
  };

  const finish = async () => {
    if (finishing) return;
    setFinishing(true);
    try {
      await onFinish();
    } catch {
      // 失败提示由 App 统一 toast；留在引导页便于重试
    } finally {
      setFinishing(false);
    }
  };

  return (
    <div className="mc-onboarding">
      <div className="mc-onboarding__card">
        {replay ? (
          <button
            type="button"
            className="mc-onboarding__close"
            aria-label={t("actions.close")}
            title={t("actions.close")}
            onClick={onClose}
          >
            <LuX size={16} />
          </button>
        ) : null}

        <header className="mc-onboarding__stephead">
          <span className="mc-onboarding__stepicon" aria-hidden>
            <span key={step} className="mc-onboarding__stepglyph">
              <StepIcon size={22} />
            </span>
          </span>
          <h2 className="mc-onboarding__title">{title}</h2>
        </header>

        <div
          className="mc-onboarding__content"
          data-align={step === "provider" || step === "connect" ? "top" : "center"}
          key={step}
        >
          {step === "language" ? (
            <section className="mc-onboarding__panel mc-onboarding__panel--lang">
              <div className="mc-onboarding__langpreview">
                <span className="mc-onboarding__langtag">{t("language.previewLabel")}</span>
                <p className="mc-onboarding__langtext">{t("language.previewText")}</p>
                <span className="mc-onboarding__langmeta">
                  {t(language === "system" ? "language.systemMeta" : "language.selectedMeta", {
                    language: activeLanguageName,
                  })}
                </span>
              </div>
              <div className="mc-onboarding__langgrid" role="group" aria-label={t("language.label")}>
                <button
                  type="button"
                  className="mc-onboarding__langcard"
                  data-active={language === "system"}
                  aria-pressed={language === "system"}
                  onClick={() => chooseLanguage("system")}
                >
                  <LuMonitor size={16} className="mc-onboarding__langicon" />
                  <span className="mc-onboarding__langname">{t("settings:language.system")}</span>
                  {language === "system" ? (
                    <LuCheck size={15} className="mc-onboarding__langcheck" />
                  ) : null}
                </button>
                {UI_LANGUAGES.map((item) => {
                  const active = language === item.code;
                  return (
                    <button
                      key={item.code}
                      type="button"
                      className="mc-onboarding__langcard"
                      data-active={active}
                      aria-pressed={active}
                      onClick={() => chooseLanguage(item.code)}
                    >
                      <span className="mc-onboarding__langname">{item.nativeName}</span>
                      {active ? <LuCheck size={15} className="mc-onboarding__langcheck" /> : null}
                    </button>
                  );
                })}
              </div>
            </section>
          ) : null}

          {step === "theme" ? (
            <section className="mc-onboarding__panel">
              <p className="mc-onboarding__desc">{t("theme.desc")}</p>
              <div className="mc-onboarding__options">
                {THEME_ORDER.map((value) => {
                  const Icon = THEME_ICONS[value];
                  return (
                    <button
                      key={value}
                      type="button"
                      className="mc-onboarding__option"
                      data-active={theme === value}
                      aria-pressed={theme === value}
                      onClick={() => chooseTheme(value)}
                    >
                      {theme === value ? (
                        <LuCheck className="mc-onboarding__optioncheck" size={14} />
                      ) : null}
                      <span
                        className="mc-onboarding__themepreview"
                        data-preview={value}
                        aria-hidden
                      >
                        <span className="mc-onboarding__themebar" />
                        <span className="mc-onboarding__themebody">
                          <span className="mc-onboarding__themeline" />
                          <span className="mc-onboarding__themeline mc-onboarding__themeline--short" />
                          <span className="mc-onboarding__themeblock" />
                        </span>
                      </span>
                      <span className="mc-onboarding__optionrow">
                        <span className="mc-onboarding__optionicon" aria-hidden>
                          <Icon size={16} />
                        </span>
                        <span className="mc-onboarding__optionname">
                          {t(`theme.options.${value}.label`)}
                        </span>
                      </span>
                      <span className="mc-onboarding__optiondesc">
                        {t(`theme.options.${value}.desc`)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ) : null}

          {step === "provider" ? (
            <section className="mc-onboarding__panel">
              <TextField
                label={t("provider.searchLabel")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("provider.searchPlaceholder")}
              />
              <div className="mc-onboarding__providers">
                {showCustom ? (
                  <button
                    type="button"
                    className="mc-onboarding__provider mc-onboarding__provider--custom"
                    data-active={template?.id === CUSTOM_TEMPLATE.id}
                    aria-pressed={template?.id === CUSTOM_TEMPLATE.id}
                    onClick={() => pickTemplate(CUSTOM_TEMPLATE)}
                  >
                    <ProviderIcon template={CUSTOM_TEMPLATE} size={24} />
                    <span className="mc-onboarding__providertext">
                      <span className="mc-onboarding__providername">
                        {customName}
                      </span>
                      <span className="mc-onboarding__providermeta">
                        {t("provider.customMeta")}
                      </span>
                    </span>
                    {template?.id === CUSTOM_TEMPLATE.id ? <LuCheck size={15} /> : null}
                  </button>
                ) : null}
                {filteredProviders.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="mc-onboarding__provider"
                    data-active={template?.id === item.id}
                    aria-pressed={template?.id === item.id}
                    onClick={() => pickTemplate(item)}
                  >
                    <ProviderIcon template={item} size={24} />
                    <span className="mc-onboarding__providertext">
                      <span className="mc-onboarding__providername">{item.name}</span>
                      <span className="mc-onboarding__providermeta">{providerHost(item)}</span>
                    </span>
                    {template?.id === item.id ? <LuCheck size={15} /> : null}
                  </button>
                ))}
                {!filteredProviders.length && !showCustom ? (
                  <p className="mc-onboarding__empty">
                    <LuSearch size={14} />
                    {t("provider.empty")}
                  </p>
                ) : null}
              </div>
            </section>
          ) : null}

          {step === "connect" && template ? (
            <section className="mc-onboarding__panel">
              <ProviderFormBody controller={form} />
              {error ? <p className="mc-modelform__error">{error}</p> : null}
            </section>
          ) : null}

          {step === "finish" ? (
            <section className="mc-onboarding__panel mc-onboarding__panel--narrow">
              <span className="mc-onboarding__success" aria-hidden>
                <LuCheck size={30} />
              </span>
              <p className="mc-onboarding__desc">{t("finish.desc")}</p>
              {!providers.length && !providerSaved ? (
                <p className="mc-onboarding__note">{t("finish.noProvider")}</p>
              ) : null}
            </section>
          ) : null}
        </div>

        <footer className="mc-onboarding__footer">
          <div className="mc-onboarding__footerleft">
            {step !== "language" ? (
              <Button
                variant="ghost"
                icon={<LuArrowLeft size={14} />}
                onClick={back}
                disabled={saving || finishing}
              >
                {t("actions.back")}
              </Button>
            ) : null}
          </div>
          <div className="mc-onboarding__footerright">
            {step === "provider" ? (
              <Button variant="ghost" onClick={skipProvider}>
                {t("actions.skip")}
              </Button>
            ) : null}
            {step === "connect" ? (
              <Button variant="ghost" onClick={() => setStep("finish")} disabled={saving}>
                {t("actions.later")}
              </Button>
            ) : null}
            {step === "language" || step === "theme" || step === "provider" ? (
              <Button
                variant="primary"
                icon={<LuArrowRight size={14} />}
                onClick={next}
                disabled={step === "provider" && !template}
              >
                {t("actions.next")}
              </Button>
            ) : null}
            {step === "connect" ? (
              <Button variant="primary" onClick={form.submit} disabled={saving}>
                {saving ? t("actions.connecting") : t("actions.connect")}
              </Button>
            ) : null}
            {step === "finish" ? (
              <Button variant="primary" onClick={() => void finish()} disabled={finishing}>
                {finishing ? t("actions.finishing") : t("actions.start")}
              </Button>
            ) : null}
          </div>
        </footer>
      </div>
    </div>
  );
}
