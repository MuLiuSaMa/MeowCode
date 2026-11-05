import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { CustomSelect, type CustomSelectOption } from "../ui/CustomSelect";
import { FieldRow, Section } from "../ui/Section";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Toggle } from "../ui/Toggle";
import type { CloseAction, LanguagePreference, SpeechStyle } from "../../api";
import { UI_LANGUAGES } from "../../i18n/languages";
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
  onToast: (text: string) => void;
}) {
  const { t } = useTranslation("settings");
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
        <FieldRow label={t("speech.field")} hint={t(`speech.desc.${speechStyle}`)}>
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
        <ProxyRows onToast={onToast} />
      </Section>
    </div>
  );
}
