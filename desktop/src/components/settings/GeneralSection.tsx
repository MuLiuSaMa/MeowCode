import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CustomSelect, type CustomSelectOption } from "../ui/CustomSelect";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { FieldRow, Section } from "../ui/Section";
import { Toggle } from "../ui/Toggle";
import {
  getProviderFallback,
  setProviderFallback,
  type CloseAction,
  type LanguagePreference,
  type Preferences,
  type ProgressPillDismiss,
  type SpeechStyle,
} from "../../api";
import { UI_LANGUAGES } from "../../i18n/languages";
import { DataLocationSection } from "./DataLocationSection";
import { ProxyRows } from "./ProxyRows";

/** 表里只存 key 与值：标签在组件里查表，切语言才会跟着刷新。 */
const CLOSE_ACTIONS: CloseAction[] = ["ask", "tray", "quit"];
const SPEECH_STYLES: SpeechStyle[] = ["normal", "tafei", "dazui"];
const PILL_DISMISS_MODES: ProgressPillDismiss[] = ["commit", "turn-end"];
type DefaultPermissionMode = NonNullable<Preferences["defaultPermissionMode"]>;
const DEFAULT_PERMISSION_MODES: DefaultPermissionMode[] = ["read-only", "ask", "auto", "full"];
const DEFAULT_PERMISSION_KEYS: Record<DefaultPermissionMode, string> = {
  "read-only": "readOnly",
  ask: "ask",
  auto: "auto",
  full: "full",
};

export function GeneralSection({
  closeAction,
  onCloseAction,
  language,
  onLanguage,
  speechStyle,
  onSpeechStyleChange,
  progressPillDismiss,
  onProgressPillDismissChange,
  silentUpdate,
  onSilentUpdateChange,
  notifications,
  onNotificationsChange,
  announcements,
  onAnnouncementsChange,
  showViewTabs,
  onShowViewTabsChange,
  nextPromptSuggestions,
  onNextPromptSuggestionsChange,
  defaultPermissionMode,
  onDefaultPermissionModeChange,
  onToast,
}: {
  closeAction: CloseAction;
  onCloseAction: (value: CloseAction) => void;
  language: LanguagePreference;
  onLanguage: (value: LanguagePreference) => void;
  /** 用户可见回复的语色：普通 / 永雏塔菲 */
  speechStyle: SpeechStyle;
  onSpeechStyleChange: (value: SpeechStyle) => void;
  /** 输入框上方信息胶囊的收起时机：提交后 / 对话结束后 */
  progressPillDismiss: ProgressPillDismiss;
  onProgressPillDismissChange: (value: ProgressPillDismiss) => void;
  /** 检查到新版本时是否后台静默下载（默认开） */
  silentUpdate: boolean;
  onSilentUpdateChange: (value: boolean) => void;
  /** 回合结束 / 需要审批 / 被中断时是否弹系统通知（默认开） */
  notifications: boolean;
  onNotificationsChange: (value: boolean) => void;
  /** 标题栏公告条：是否显示官方公告（默认开） */
  announcements: boolean;
  onAnnouncementsChange: (value: boolean) => void;
  /** 主区域顶部「对话 / 轨迹」悬浮胶囊（默认开） */
  showViewTabs: boolean;
  onShowViewTabsChange: (value: boolean) => void;
  /** 输入建议：回合结束后预测下一句（默认关，开启前确认额外 token） */
  nextPromptSuggestions: boolean;
  onNextPromptSuggestionsChange: (value: boolean) => void;
  /** 新建对话时默认使用的工具权限模式 */
  defaultPermissionMode: DefaultPermissionMode;
  onDefaultPermissionModeChange: (value: DefaultPermissionMode) => void;
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
  /** 「提交后消失 / 对话结束后消失」：只影响渲染层何时收起信息胶囊 */
  const pillDismissOptions = useMemo<CustomSelectOption<ProgressPillDismiss>[]>(
    () => PILL_DISMISS_MODES.map((value) => ({ value, label: t(`progressPill.options.${value}`) })),
    [t],
  );
  const defaultPermissionOptions = useMemo<CustomSelectOption<DefaultPermissionMode>[]>(
    () =>
      DEFAULT_PERMISSION_MODES.map((value) => ({
        value,
        label: t(`composer:permission.${DEFAULT_PERMISSION_KEYS[value]}.label`),
        description: t(`composer:permission.${DEFAULT_PERMISSION_KEYS[value]}.desc`),
      })),
    [t],
  );

  return (
    <div className="mc-settings__inner">
      <Section title={t("general.section")} description={t("general.desc")}>
        <FieldRow label={t("language.title")}>
          <CustomSelect
            value={language}
            options={languageOptions}
            onChange={onLanguage}
            ariaLabel={t("language.title")}
          />
        </FieldRow>
        <FieldRow label={t("close.field")} hint={t("close.desc")}>
          <CustomSelect
            value={closeAction}
            options={closeOptions}
            onChange={onCloseAction}
            ariaLabel={t("close.field")}
          />
        </FieldRow>
        <FieldRow label={t("update.field")} hint={t("update.desc")}>
          <Toggle checked={silentUpdate} onChange={onSilentUpdateChange} label={t("update.field")} />
        </FieldRow>
        <FieldRow
          label={t("general.notify.field")}
          hint={t("general.notify.desc")}
        >
          <Toggle
            checked={notifications}
            onChange={onNotificationsChange}
            label={t("general.notify.field")}
          />
        </FieldRow>
        <FieldRow
          label={t("general.announcement.field")}
          hint={t("general.announcement.desc")}
        >
          <Toggle
            checked={announcements}
            onChange={onAnnouncementsChange}
            label={t("general.announcement.field")}
          />
        </FieldRow>
        <FieldRow label={t("general.viewTabs.field")} hint={t("general.viewTabs.desc")}>
          <Toggle
            checked={showViewTabs}
            onChange={onShowViewTabsChange}
            label={t("general.viewTabs.field")}
          />
        </FieldRow>
        <ProxyRows onToast={onToast} />
        <FieldRow
          label={t("progressPill.field")}
          hint={t("progressPill.desc")}
        >
          <CustomSelect
            value={progressPillDismiss}
            options={pillDismissOptions}
            onChange={onProgressPillDismissChange}
            ariaLabel={t("progressPill.field")}
          />
        </FieldRow>
      </Section>

      <Section title={t("general.other.section")}>
        <FieldRow
          label={t("general.defaultPermission.field")}
          hint={t("general.defaultPermission.desc")}
        >
          <CustomSelect
            value={defaultPermissionMode}
            options={defaultPermissionOptions}
            onChange={onDefaultPermissionModeChange}
            ariaLabel={t("general.defaultPermission.field")}
          />
        </FieldRow>
        <FieldRow label={t("speech.field")} hint={t("speech.desc")}>
          <CustomSelect
            value={speechStyle}
            options={speechOptions}
            onChange={onSpeechStyleChange}
            ariaLabel={t("speech.section")}
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
