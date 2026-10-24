import type { ReactNode } from "react";
import { LuArchive, LuInfo, LuPalette, LuBoxes, LuSettings } from "react-icons/lu";
import type { AppInfo, Preferences, ProviderSettings, SessionSummary, Settings } from "../../api";
import { AboutSection } from "./AboutSection";
import { AppearanceSection } from "./AppearanceSection";
import { ArchiveSection } from "./ArchiveSection";
import { GeneralSection } from "./GeneralSection";
import { ModelsSection } from "./ModelsSection";
import "./SettingsPage.css";

export type SettingsSectionId = "general" | "appearance" | "models" | "archive" | "about";

const SECTIONS: Array<{ id: SettingsSectionId; label: string; icon: typeof LuSettings }> = [
  { id: "general", label: "通用", icon: LuSettings },
  { id: "appearance", label: "外观", icon: LuPalette },
  { id: "models", label: "模型", icon: LuBoxes },
  { id: "archive", label: "归档", icon: LuArchive },
  { id: "about", label: "关于", icon: LuInfo },
];

/**
 * 设置页导航栏 —— 放在 AppShell 的 conversations 槽位，即「对话列表」的位置。
 * 设置视图下对话列表与右侧检查器都不渲染，内容面板整个让给设置正文。
 */
export function SettingsNav({
  section,
  onSection,
  onClose,
}: {
  section: SettingsSectionId;
  onSection: (id: SettingsSectionId) => void;
  onClose: () => void;
}) {
  return (
    <nav className="mc-panel mc-panel--conversations mc-settings__nav" aria-label="设置分区">
      <h1 className="mc-settings__heading">设置</h1>
      <ul className="mc-settings__navlist">
        {SECTIONS.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="mc-settings__navitem"
              data-active={section === item.id}
              aria-current={section === item.id ? "page" : undefined}
              onClick={() => onSection(item.id)}
            >
              <item.icon size={15} />
              {item.label}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="mc-settings__back" onClick={onClose}>
        返回对话
      </button>
    </nav>
  );
}

/** 设置页正文 —— 占据主内容面板（对话视图里是 header + 消息 + 输入区的那块）。 */
export function SettingsBody({
  section,
  settings,
  preferences,
  appInfo,
  providers,
  activeProviderId,
  effort,
  sessions,
  archivedSessions,
  onUnarchiveSession,
  onSavePreferences,
  onSaveProviders,
  onChangeEffort,
}: {
  section: SettingsSectionId;
  settings: Settings | null;
  preferences: Preferences;
  appInfo: AppInfo | null;
  providers: ProviderSettings[];
  activeProviderId: string;
  effort: string;
  /** 会话列表（用于把归档路径还原成可读条目） */
  sessions: SessionSummary[];
  archivedSessions: string[];
  onUnarchiveSession: (filePath: string) => void;
  onSavePreferences: (prefs: Partial<Preferences>) => void;
  onSaveProviders: (providers: ProviderSettings[], activeId?: string) => void;
  onChangeEffort: (providerId: string, value: string) => void;
}) {
  const body: Record<SettingsSectionId, ReactNode> = {
    general: (
      <GeneralSection
        closeAction={preferences.closeAction}
        onCloseAction={(value) => onSavePreferences({ closeAction: value })}
      />
    ),
    appearance: (
      <AppearanceSection
        preference={preferences.theme}
        onPreference={(value) => onSavePreferences({ theme: value })}
      />
    ),
    models: (
      <ModelsSection
        providers={providers}
        activeProviderId={activeProviderId}
        effort={effort}
        onChange={onSaveProviders}
        onChangeEffort={onChangeEffort}
      />
    ),
    archive: (
      <ArchiveSection
        sessions={sessions}
        archivedSessions={archivedSessions}
        onUnarchive={onUnarchiveSession}
      />
    ),
    about: <AboutSection appInfo={appInfo} workspace={settings?.workspace} />,
  };

  return <div className="mc-settings__body">{body[section]}</div>;
}
