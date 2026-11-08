import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CustomSelect, type CustomSelectOption } from "../ui/CustomSelect";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { FieldRow, Section } from "../ui/Section";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Toggle } from "../ui/Toggle";
import {
  getProviderFallback,
  setProviderFallback,
  type CloseAction,
  type LanguagePreference,
  type SpeechStyle,
} from "../../api";
import { UI_LANGUAGES } from "../../i18n/languages";
import { DataLocationSection } from "./DataLocationSection";
import { ProxyRows } from "./ProxyRows";

/** 表里只存 key 与值：标签在组件里查表，切语言才会跟着刷新。 */
const CLOSE_ACTIONS: CloseAction[] = ["ask", "tray", "quit"];
const SPEECH_STYLES: SpeechStyle[] = ["normal", "tafei", "dazui"];

export function GeneralSection({
  closeAction,
  onCloseAction,
  language,
  onLanguage,
  speechStyle,
  onSpeechStyleChange,
  silentUpdate,
  onSilentUpdateChange,
  notifications,
  onNotificationsChange,
  nextPromptSuggestions,
  onNextPromptSuggestionsChange,
  onToast,
}: {
  closeAction: CloseAction;
  onCloseAction: (value: CloseAction) => void;
  language: LanguagePreference;
  onLanguage: (value: LanguagePreference) => void;
  /** 用户可见回复的语色：普通 / 永雏塔菲 */
  speechStyle: SpeechStyle;
  onSpeechStyleChange: (value: SpeechStyle) => void;
  /** 检查到新版本时是否后台静默下载（默认开） */
  silentUpdate: boolean;
  onSilentUpdateChange: (value: boolean) => void;
  /** 回合结束 / 需要审批 / 被中断时是否弹系统通知（默认开） */
  notifications: boolean;
  onNotificationsChange: (value: boolean) => void;
  /** 输入建议：回合结束后预测下一句（默认关，开启前确认额外 token） */
  nextPromptSuggestions: boolean;
  onNextPromptSuggestionsChange: (value: boolean) => void;
  onToast: (text: string) => void;
}) {
  const { t } = useTranslation("settings");
  const [confirmPromptSuggestions, setConfirmPromptSuggestions] = useState(false);
  /** 供应商故障转移：null = 还没从服务端拿到当前值（默认关） */
  const [providerFallback, setProviderFallbackState] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    getProviderFallback()
      .then((result) => {
        if (!cancelled) setProviderFallbackState(result.enabled);
      })
      .catch(() => {
        // 查询失败按默认值（关）展示，避免开关卡在加载态
        if (!cancelled) setProviderFallbackState(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleProviderFallback = async (value: boolean) => {
    const previous = providerFallback;
    setProviderFallbackState(value); // 乐观更新：失败回滚
    try {
      await setProviderFallback(value); // 运行中的 server 立即生效（新会话与存活的 runtime 一起切）
      // 落盘供下次启动传 env；走 saveProviderPrefs，不重启 agent server
      await window.meow.saveProviderPrefs({ providerFallback: value });
    } catch (error) {
      setProviderFallbackState(previous ?? false);
      onToast(error instanceof Error ? error.message : t("general.providerFallback.toggleFailed"));
    }
  };
  // 语言名用各自母语写法、不参与翻译：翻成当前界面语言反而认不出自己要切去哪
  const languageOptions = useMemo<CustomSelectOption<LanguagePreference>[]>(
    () => [
      { value: "system", label: t("language.system") },
      ...UI_LANGUAGES.map((item) => ({ value: item.code, label: item.nativeName })),
    ],
    [t],
  );
  const closeOptions = useMemo(
    () => CLOSE_ACTIONS.map((value) => ({ value, label: t(`close.options.${value}`) })),
    [t],
  );
  const speechOptions = useMemo<CustomSelectOption<SpeechStyle>[]>(
    () => SPEECH_STYLES.map((value) => ({ value, label: t(`speech.options.${value}`) })),
    [t],
  );

  return (
    <div className="mc-settings__inner">
      <Section title={t("language.section")} description={t("language.description")}>
        <FieldRow label={t("language.title")}>
          <CustomSelect
            value={language}
            options={languageOptions}
            onChange={onLanguage}
            ariaLabel={t("language.title")}
          />
        </FieldRow>
      </Section>

      {/* 其余运行期偏好收进一张卡：一条条列出来比拆成四张卡更好扫 */}
      <Section title={t("general.section")} description={t("general.desc")}>
        <FieldRow label={t("speech.field")} hint={t("speech.desc")}>
          <CustomSelect
            value={speechStyle}
            options={speechOptions}
            onChange={onSpeechStyleChange}
            ariaLabel={t("speech.section")}
          />
        </FieldRow>
        <FieldRow label={t("close.field")} hint={t(`close.desc.${closeAction}`)}>
          <SegmentedControl
            value={closeAction}
            options={closeOptions}
            onChange={onCloseAction}
            ariaLabel={t("close.section")}
          />
        </FieldRow>
        <FieldRow label={t("update.field")} hint={t(silentUpdate ? "update.desc.on" : "update.desc.off")}>
          <Toggle checked={silentUpdate} onChange={onSilentUpdateChange} label={t("update.field")} />
        </FieldRow>
        <FieldRow
          label={t("general.notify.field")}
          hint={t(notifications ? "general.notify.desc.on" : "general.notify.desc.off")}
        >
          <Toggle
            checked={notifications}
            onChange={onNotificationsChange}
            label={t("general.notify.field")}
          />
        </FieldRow>
        <FieldRow
          label={t("general.promptSuggestions.field")}
          hint={t("general.promptSuggestions.desc")}
        >
          <Toggle
            checked={nextPromptSuggestions}
            onChange={(value) => {
              if (value) {
                setConfirmPromptSuggestions(true);
                return;
              }
              onNextPromptSuggestionsChange(false);
            }}
            label={t("general.promptSuggestions.field")}
          />
        </FieldRow>
        <FieldRow
          label={t("general.providerFallback.field")}
          hint={t("general.providerFallback.desc")}
        >
          <Toggle
            checked={providerFallback ?? false}
            disabled={providerFallback === null}
            onChange={(value) => void toggleProviderFallback(value)}
            label={t("general.providerFallback.field")}
          />
        </FieldRow>
        <ProxyRows onToast={onToast} />
      </Section>

      <DataLocationSection onToast={onToast} />

      <Dialog
        open={confirmPromptSuggestions}
        onClose={() => setConfirmPromptSuggestions(false)}
        labelledBy="mc-prompt-suggestions-title"
      >
        <span className="mc-dialog__title" id="mc-prompt-suggestions-title">
          {t("general.promptSuggestions.confirmTitle")}
        </span>
        <p className="mc-dialog__desc">{t("general.promptSuggestions.confirmHow")}</p>
        <p className="mc-dialog__desc">{t("general.promptSuggestions.confirmCost")}</p>
        <div className="mc-dialog__footer">
          <Button onClick={() => setConfirmPromptSuggestions(false)}>{t("actions.cancel")}</Button>
          <Button
            variant="primary"
            onClick={() => {
              setConfirmPromptSuggestions(false);
              onNextPromptSuggestionsChange(true);
            }}
          >
            {t("general.promptSuggestions.enable")}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
