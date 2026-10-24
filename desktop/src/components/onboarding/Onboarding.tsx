import { useMemo, useState } from "react";
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
import { Button } from "../ui/Button";
import { CustomSelect } from "../ui/CustomSelect";
import { TextField } from "../ui/TextField";
import { ProviderIcon } from "../ui/ProviderIcon";
import { ModelFormFields } from "../settings/ModelFormFields";
import { buildProvider } from "../settings/modelForm";
import {
  LANGUAGE_OPTIONS,
  ONBOARDING_COPY,
  resolveOnboardingLocale,
  type OnboardingStep,
} from "./copy";
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

function emptyProvider(): ProviderSettings {
  return {
    id: "",
    name: "",
    baseUrl: "",
    model: "",
    inputModalities: ["text"],
    enabled: true,
  };
}

export type OnboardingProps = {
  initialLanguage: LanguagePreference;
  initialTheme: ThemePreference;
  providers: ProviderSettings[];
  /** 从设置页重新进入：可关闭，且不影响已有配置 */
  replay: boolean;
  onSaveLanguage: (value: LanguagePreference) => void;
  onSaveTheme: (value: ThemePreference) => void;
  onSaveProvider: (provider: ProviderSettings) => Promise<boolean>;
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
  onSaveProvider,
  onFinish,
  onClose,
}: OnboardingProps) {
  const [step, setStep] = useState<OnboardingStep>("language");
  const [language, setLanguage] = useState<LanguagePreference>(initialLanguage);
  const [theme, setTheme] = useState<ThemePreference>(initialTheme);
  const [template, setTemplate] = useState<ProviderTemplate | null>(null);
  const [query, setQuery] = useState("");
  const [form, setForm] = useState<ProviderSettings>(emptyProvider);
  const [contextInput, setContextInput] = useState("");
  const [maxInput, setMaxInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [providerSaved, setProviderSaved] = useState(false);

  const copy = ONBOARDING_COPY[resolveOnboardingLocale(language)];
  const StepIcon = STEP_ICONS[step];

  const title =
    step === "language"
      ? copy.language.title
      : step === "theme"
        ? copy.theme.title
        : step === "provider"
          ? copy.provider.title
          : step === "connect"
            ? copy.connect.title
            : copy.finish.title;

  const filteredProviders = useMemo(() => {
    const key = query.trim().toLowerCase();
    if (!key) return PROVIDER_CATALOG;
    return PROVIDER_CATALOG.filter(
      (item) => item.id.toLowerCase().includes(key) || item.name.toLowerCase().includes(key),
    );
  }, [query]);

  const showCustom = useMemo(() => {
    const key = query.trim().toLowerCase();
    return !key || "custom".includes(key) || "自定义".includes(query.trim());
  }, [query]);

  const providerHost = (item: ProviderTemplate) => {
    if (!item.baseUrl) return copy.provider.needsEndpoint;
    try {
      return new URL(item.baseUrl).host;
    } catch {
      return item.baseUrl;
    }
  };

  const pickTemplate = (next: ProviderTemplate) => {
    setTemplate(next);
    setForm({
      id: `provider-${Date.now()}`,
      name: next.id === CUSTOM_TEMPLATE.id ? "" : next.name,
      baseUrl: next.baseUrl,
      model: "",
      protocol: next.protocol,
      templateId: next.id,
      inputModalities: ["text"],
      enabled: true,
    });
    setContextInput("");
    setMaxInput("");
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

  const saveProvider = async () => {
    if (!template || saving) return;
    const result = buildProvider(
      form,
      contextInput,
      maxInput,
      providers.map((item) => item.model),
    );
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSaving(true);
    setError(null);
    const ok = await onSaveProvider(result.provider);
    setSaving(false);
    if (!ok) {
      setError(copy.connect.saveFailed);
      return;
    }
    setProviderSaved(true);
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
            aria-label={copy.actions.close}
            title={copy.actions.close}
            onClick={onClose}
          >
            <LuX size={16} />
          </button>
        ) : null}

        <header className="mc-onboarding__stephead">
          <span className="mc-onboarding__stepicon" aria-hidden>
            <StepIcon size={22} />
          </span>
          <h2 className="mc-onboarding__title">{title}</h2>
        </header>

        <div
          className="mc-onboarding__content"
          data-align={step === "provider" || step === "connect" ? "top" : "center"}
          key={step}
        >
          {step === "language" ? (
            <section className="mc-onboarding__panel mc-onboarding__panel--narrow">
              <div className="mc-onboarding__langpreview">
                <span className="mc-onboarding__langtag">{copy.language.previewLabel}</span>
                <p className="mc-onboarding__langtext">{copy.language.previewText}</p>
                <span className="mc-onboarding__langmeta">
                  {language === "system" ? copy.language.systemMeta : copy.language.zhMeta}
                </span>
              </div>
              <CustomSelect
                ariaLabel={copy.language.label}
                placement="top"
                value={language}
                options={LANGUAGE_OPTIONS}
                onChange={(value) => chooseLanguage(value)}
              />
            </section>
          ) : null}

          {step === "theme" ? (
            <section className="mc-onboarding__panel">
              <p className="mc-onboarding__desc">{copy.theme.desc}</p>
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
                          {copy.theme.options[value].label}
                        </span>
                      </span>
                      <span className="mc-onboarding__optiondesc">
                        {copy.theme.options[value].desc}
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
                label={copy.provider.searchLabel}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={copy.provider.searchPlaceholder}
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
                        {copy.provider.customName}
                      </span>
                      <span className="mc-onboarding__providermeta">
                        {copy.provider.customMeta}
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
                    {copy.provider.empty}
                  </p>
                ) : null}
              </div>
            </section>
          ) : null}

          {step === "connect" && template ? (
            <section className="mc-onboarding__panel">
              <ModelFormFields
                form={form}
                contextInput={contextInput}
                maxInput={maxInput}
                onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
                onContextInputChange={setContextInput}
                onMaxInputChange={setMaxInput}
              />
              {error ? <p className="mc-modelform__error">{error}</p> : null}
            </section>
          ) : null}

          {step === "finish" ? (
            <section className="mc-onboarding__panel mc-onboarding__panel--narrow">
              <span className="mc-onboarding__success" aria-hidden>
                <LuCheck size={30} />
              </span>
              <p className="mc-onboarding__desc">{copy.finish.desc}</p>
              {!providers.length && !providerSaved ? (
                <p className="mc-onboarding__note">{copy.finish.noProvider}</p>
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
                {copy.actions.back}
              </Button>
            ) : null}
          </div>
          <div className="mc-onboarding__footerright">
            {step === "provider" ? (
              <Button variant="ghost" onClick={skipProvider}>
                {copy.actions.skip}
              </Button>
            ) : null}
            {step === "connect" ? (
              <Button variant="ghost" onClick={() => setStep("finish")} disabled={saving}>
                {copy.actions.later}
              </Button>
            ) : null}
            {step === "language" || step === "theme" || step === "provider" ? (
              <Button
                variant="primary"
                icon={<LuArrowRight size={14} />}
                onClick={next}
                disabled={step === "provider" && !template}
              >
                {copy.actions.next}
              </Button>
            ) : null}
            {step === "connect" ? (
              <Button variant="primary" onClick={() => void saveProvider()} disabled={saving}>
                {saving ? copy.actions.connecting : copy.actions.connect}
              </Button>
            ) : null}
            {step === "finish" ? (
              <Button variant="primary" onClick={() => void finish()} disabled={finishing}>
                {finishing ? copy.actions.finishing : copy.actions.start}
              </Button>
            ) : null}
          </div>
        </footer>
      </div>
    </div>
  );
}
