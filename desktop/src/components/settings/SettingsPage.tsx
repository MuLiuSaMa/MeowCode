import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  LuArchive,
  LuBrain,
  LuFolder,
  LuGitFork,
  LuHistory,
  LuImport,
  LuInfo,
  LuKeyboard,
  LuListChecks,
  LuPalette,
  LuBoxes,
  LuPanelTop,
  LuSettings,
  LuShield,
  LuShieldCheck,
  LuSparkles,
  LuWebhook,
} from "react-icons/lu";
import {
  setInstructionSettings,
  type AppInfo,
  type Preferences,
  type ProviderSettings,
  type SessionSummary,
  type Settings,
  type ThemePalette,
  type UpdateInfo,
} from "../../api";
import { AboutSection } from "./AboutSection";
import { AppearanceSection } from "./AppearanceSection";
import { ApprovalsSection } from "./ApprovalsSection";
import { ArchiveSection } from "./ArchiveSection";
import { DataImportSection } from "./DataImportSection";
import { GeneralSection } from "./GeneralSection";
import { HooksSection } from "./HooksSection";
import { IslandSection } from "./IslandSection";
import { LearningSection } from "./LearningSection";
import { MemorySection } from "./MemorySection";
import { ModelsSection } from "./ModelsSection";
import { ProjectsSection } from "./ProjectsSection";
import { RewindSection } from "./RewindSection";
import { RulesSection } from "./RulesSection";
import { SandboxSection } from "./SandboxSection";
import { ShortcutsSection } from "./ShortcutsSection";
import { WorktreeSection } from "./WorktreeSection";
import "./SettingsPage.css";

import { LuPuzzle } from "react-icons/lu";
import { PluginContribution } from "../../plugins/PluginSlot";
import { usePluginSlot } from "../../plugins/runtime";

export type CoreSettingsSectionId =
  | "general"
  | "appearance"
  | "shortcuts"
  | "island"
  | "projects"
  | "worktree"
  | "rewind"
  | "rules"
  | "approvals"
  | "hooks"
  | "sandbox"
  | "dataImport"
  | "models"
  | "memory"
  | "learning"
  | "archive"
  | "about";

/** 插件贡献的分区 id：plugin:<pluginId>:<entryId>。 */
export type SettingsSectionId = CoreSettingsSectionId | `plugin:${string}`;

/** 表里只存 key：模块顶层调 t() 会在 import 期求值，切语言不刷新。 */
const SECTIONS: Array<{
  id: CoreSettingsSectionId;
  labelKey: string;
  icon: typeof LuSettings;
  divider?: boolean;
  /** 实验性分区：导航里挂一个小标记，避免用户以为它是稳定能力 */
  beta?: boolean;
}> = [
  { id: "general", labelKey: "sections.general", icon: LuSettings },
  { id: "appearance", labelKey: "sections.appearance", icon: LuPalette },
  { id: "shortcuts", labelKey: "sections.shortcuts", icon: LuKeyboard },
  { id: "island", labelKey: "sections.island", icon: LuPanelTop },
  { id: "projects", labelKey: "sections.projects", icon: LuFolder },
  { id: "models", labelKey: "sections.models", icon: LuBoxes, divider: true },
  { id: "memory", labelKey: "sections.memory", icon: LuBrain },
  { id: "learning", labelKey: "sections.learning", icon: LuSparkles, beta: true },
  { id: "archive", labelKey: "sections.archive", icon: LuArchive },
  { id: "worktree", labelKey: "sections.worktree", icon: LuGitFork },
  { id: "rewind", labelKey: "sections.rewind", icon: LuHistory },
  { id: "rules", labelKey: "sections.rules", icon: LuListChecks },
  { id: "approvals", labelKey: "sections.approvals", icon: LuShieldCheck },
  { id: "hooks", labelKey: "sections.hooks", icon: LuWebhook },
  { id: "sandbox", labelKey: "sections.sandbox", icon: LuShield, beta: true },
  { id: "dataImport", labelKey: "sections.dataImport", icon: LuImport },
  { id: "about", labelKey: "sections.about", icon: LuInfo, divider: true },
];

/**
 * 设置页导航栏 —— 放在 AppShell 的 conversations 槽位，即「对话列表」的位置。
 * 设置视图下对话列表与右侧检查器都不渲染，内容面板整个让给设置正文。
 */
export function SettingsNav({
  section,
  onSection,
}: {
  section: SettingsSectionId;
  onSection: (id: SettingsSectionId) => void;
}) {
  const { t } = useTranslation("settings");
  const pluginSections = usePluginSlot("settings.sections");
  return (
    <nav className="mc-panel mc-panel--conversations mc-settings__nav" aria-label={t("nav.ariaLabel")}>
      <h1 className="mc-settings__heading">{t("nav.heading")}</h1>
      <ul className="mc-settings__navlist">
        {SECTIONS.map((item) => (
          <Fragment key={item.id}>
            {item.divider ? <li className="mc-settings__navdivider" role="presentation" /> : null}
            <li>
              <button
                type="button"
                className="mc-settings__navitem"
                data-active={section === item.id}
                aria-current={section === item.id ? "page" : undefined}
                onClick={() => onSection(item.id)}
              >
                <item.icon size={15} />
                {t(item.labelKey)}
                {item.beta ? <span className="mc-settings__navbeta">BETA</span> : null}
              </button>
            </li>
          </Fragment>
        ))}
        {pluginSections.map((contribution) => {
          const id = `plugin:${contribution.pluginId}:${contribution.entry.id}` as SettingsSectionId;
          return (
            <li key={id}>
              <button
                type="button"
                className="mc-settings__navitem"
                data-active={section === id}
                aria-current={section === id ? "page" : undefined}
                onClick={() => onSection(id)}
              >
                <LuPuzzle size={15} />
                {contribution.entry.title ?? contribution.entry.id}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** 设置页正文 —— 占据主内容面板（对话视图里是 header + 消息 + 输入区的那块）。 */
export function SettingsBody({
  section,
  settings: _settings,
  preferences,
  themePalette,
  appInfo,
  providers,
  activeProviderId,
  mailAiProviderId,
  onChangeMailAiProvider,
  effort,
  turnRunning,
  sessions,
  archivedSessions,
  workspace,
  projects,
  activeProject,
  projectNames,
  onAddProject,
  onRenameProject,
  onRemoveProject,
  onUnarchiveSession,
  onDeleteArchivedSession,
  onDeleteAllArchived,
  onSavePreferences,
  onSaveProviders,
  onToggleProvider,
  onChangeEffort,
  updateRelease,
  onUpdateDiscovered,
  onOpenUpdate,
  fontFamily,
  codeFontFamily,
  customFonts,
  onFontChange,
  onCodeFontChange,
  onImportFont,
  onRemoveFont,
  onToast,
  onReloadSessions,
}: {
  section: SettingsSectionId;
  settings: Settings | null;
  preferences: Preferences;
  /**
   * 当前实际生效的配色（App 的 themePalette）。
   * 不用 preferences.palette：那是落盘回执，读它会让选中态比界面慢一拍，
   * 回执里漏字段时更会「界面换了、选中态不动」。
   */
  themePalette: ThemePalette;
  appInfo: AppInfo | null;
  providers: ProviderSettings[];
  activeProviderId: string;
  /** 邮件「AI 写」使用的模型 id；空串 = 跟随聊天 */
  mailAiProviderId: string;
  onChangeMailAiProvider: (providerId: string) => void;
  effort: string;
  /** 任意会话有回合在跑：保存模型会重启 agent 服务，需要确认 */
  turnRunning: boolean;
  /** 会话列表（用于把归档路径还原成可读条目） */
  sessions: SessionSummary[];
  archivedSessions: string[];
  /** 当前工作区（会话 cwd 优先）：记忆分区里「项目记忆」跟随它 */
  workspace: string | null;
  /** 已添加的项目（工作区）列表 */
  projects: string[];
  /** 当前项目（会话 cwd 优先，其次默认工作区） */
  activeProject: string;
  projectNames: Record<string, string>;
  onAddProject: () => void;
  /** 只改显示名；空名恢复文件夹名 */
  onRenameProject: (cwd: string, name: string) => void;
  /** 只从列表隐藏，不删除会话与磁盘文件 */
  onRemoveProject: (cwd: string) => void;
  onUnarchiveSession: (filePath: string) => void;
  /** 删除单个归档会话（文件一起删） */
  onDeleteArchivedSession: (filePath: string) => void;
  /** 删除全部归档会话（文件一起删） */
  onDeleteAllArchived: () => void;
  onSavePreferences: (prefs: Partial<Preferences>) => void;
  onSaveProviders: (providers: ProviderSettings[], activeId?: string) => void;
  /** 启用/停用单个模型：轻量保存，不重启 agent server */
  onToggleProvider: (providerId: string, enabled: boolean) => void;
  onChangeEffort: (providerId: string, value: string) => void;
  /** 已发现的新版本（App 启动静默检查的结果，关于页按钮据此变样） */
  updateRelease: UpdateInfo | null;
  /** 关于页手动检查发现新版本：只记录，不弹窗 */
  onUpdateDiscovered: (release: UpdateInfo) => void;
  /** 打开更新弹窗（下载 + 安装） */
  onOpenUpdate: () => void;
  /** 界面字体（空串 = 默认 MiSans） */
  fontFamily: string;
  /** 代码字体（空串 = 默认等宽栈） */
  codeFontFamily: string;
  /** 已导入的自定义字体展示名 */
  customFonts: string[];
  onFontChange: (value: string) => void;
  onCodeFontChange: (value: string) => void;
  /** 导入字体文件；返回导入后的展示名（取消/失败返回 null） */
  onImportFont: () => Promise<string | null>;
  /** 删除已导入的字体；删除成功返回 true（当前选中的字体被删时外观页自行重置） */
  onRemoveFont: (family: string) => Promise<boolean>;
  /** 右上角轻提示（如「已是最新版本」） */
  onToast: (text: string) => void;
  /** 数据导入落盘后刷新会话列表（导入的摘要会话要立刻出现在侧栏） */
  onReloadSessions: () => void;
}) {
  const pluginSections = usePluginSlot("settings.sections");
  const updateInstructionSettings = async (
    patch: Partial<Pick<Preferences, "includeAgentsMd" | "includeClaudeMd">>,
  ) => {
    try {
      await setInstructionSettings(patch);
      onSavePreferences(patch);
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error));
    }
  };

  const body: Record<CoreSettingsSectionId, ReactNode> = {
    general: (
      <GeneralSection
        closeAction={preferences.closeAction}
        onCloseAction={(value) => onSavePreferences({ closeAction: value })}
        language={preferences.language ?? "system"}
        onLanguage={(value) => onSavePreferences({ language: value })}
        speechStyle={preferences.speechStyle ?? "normal"}
        onSpeechStyleChange={(value) => onSavePreferences({ speechStyle: value })}
        progressPillDismiss={preferences.progressPillDismiss ?? "commit"}
        onProgressPillDismissChange={(value) => onSavePreferences({ progressPillDismiss: value })}
        silentUpdate={preferences.silentUpdate ?? true}
        onSilentUpdateChange={(value) => onSavePreferences({ silentUpdate: value })}
        notifications={preferences.notifications ?? true}
        onNotificationsChange={(value) => onSavePreferences({ notifications: value })}
        announcements={preferences.announcements ?? true}
        onAnnouncementsChange={(value) => onSavePreferences({ announcements: value })}
        nextPromptSuggestions={preferences.nextPromptSuggestions ?? false}
        onNextPromptSuggestionsChange={(value) =>
          onSavePreferences({ nextPromptSuggestions: value })
        }
        providers={providers}
        mailAiProviderId={mailAiProviderId}
        onChangeMailAiProvider={onChangeMailAiProvider}
        onToast={onToast}
      />
    ),
    appearance: (
      <AppearanceSection
        preference={preferences.theme}
        onPreference={(value) => onSavePreferences({ theme: value })}
        palette={themePalette}
        onPalette={(value) => onSavePreferences({ palette: value })}
        fontFamily={fontFamily}
        codeFontFamily={codeFontFamily}
        customFonts={customFonts}
        onFontChange={onFontChange}
        onCodeFontChange={onCodeFontChange}
        onImportFont={onImportFont}
        onRemoveFont={onRemoveFont}
      />
    ),
    shortcuts: <ShortcutsSection />,
    projects: (
      <ProjectsSection
        projects={projects}
        activeProject={activeProject}
        projectNames={projectNames}
        onAddProject={onAddProject}
        onRenameProject={onRenameProject}
        onRemoveProject={onRemoveProject}
      />
    ),
    island: (
      <IslandSection
        floatingIsland={preferences.floatingIsland ?? false}
        onFloatingIslandChange={(value) => onSavePreferences({ floatingIsland: value })}
      />
    ),
    worktree: (
      <WorktreeSection
        fetchUpstream={preferences.worktreeFetchUpstream ?? false}
        onFetchUpstreamChange={(value) =>
          onSavePreferences({ worktreeFetchUpstream: value })
        }
        autoCleanup={preferences.worktreeAutoCleanup ?? true}
        onAutoCleanupChange={(value) =>
          onSavePreferences({ worktreeAutoCleanup: value })
        }
        maxKeep={preferences.worktreeMaxKeep ?? 15}
        onMaxKeepChange={(value) => onSavePreferences({ worktreeMaxKeep: value })}
      />
    ),
    rewind: (
      <RewindSection
        enabled={preferences.rewindSnapshots ?? true}
        onEnabledChange={(value) => onSavePreferences({ rewindSnapshots: value })}
        keepCheckpoints={preferences.rewindKeepCheckpoints ?? 120}
        onKeepCheckpointsChange={(value) =>
          onSavePreferences({ rewindKeepCheckpoints: value })
        }
        maxTotalMb={preferences.rewindMaxTotalMb ?? 512}
        onMaxTotalMbChange={(value) => onSavePreferences({ rewindMaxTotalMb: value })}
      />
    ),
    rules: (
      <RulesSection
        workspace={workspace}
        includeAgentsMd={preferences.includeAgentsMd ?? true}
        onIncludeAgentsMdChange={(value) =>
          void updateInstructionSettings({ includeAgentsMd: value })
        }
        includeClaudeMd={preferences.includeClaudeMd ?? true}
        onIncludeClaudeMdChange={(value) =>
          void updateInstructionSettings({ includeClaudeMd: value })
        }
        onToast={onToast}
      />
    ),
    hooks: <HooksSection turnRunning={turnRunning} onToast={onToast} />,
    approvals: <ApprovalsSection workspace={workspace} onToast={onToast} />,
    sandbox: <SandboxSection onToast={onToast} />,
    dataImport: <DataImportSection onToast={onToast} onImported={onReloadSessions} />,
    models: (
      <ModelsSection
        providers={providers}
        activeProviderId={activeProviderId}
        effort={effort}
        turnRunning={turnRunning}
        onChange={onSaveProviders}
        onChangeEffort={onChangeEffort}
        onToggleProvider={onToggleProvider}
      />
    ),
    memory: <MemorySection workspace={workspace} onToast={onToast} />,
    learning: <LearningSection onToast={onToast} />,
    archive: (
      <ArchiveSection
        sessions={sessions}
        archivedSessions={archivedSessions}
        onUnarchive={onUnarchiveSession}
        onDelete={onDeleteArchivedSession}
        onDeleteAll={onDeleteAllArchived}
      />
    ),
    about: (
      <AboutSection
        appInfo={appInfo}
        updateRelease={updateRelease}
        onUpdateDiscovered={onUpdateDiscovered}
        onOpenUpdate={onOpenUpdate}
        onToast={onToast}
      />
    ),
  };

  // 插件分区：plugin:<pluginId>:<entryId>，按 id 精确取一条贡献
  const pluginContribution = (() => {
    if (!section.startsWith("plugin:")) return null;
    const rest = section.slice("plugin:".length);
    const separator = rest.indexOf(":");
    if (separator <= 0) return null;
    const pluginId = rest.slice(0, separator);
    const entryId = rest.slice(separator + 1);
    return (
      pluginSections.find(
        (contribution) =>
          contribution.pluginId === pluginId && contribution.entry.id === entryId,
      ) ?? null
    );
  })();

  return (
    <div className="mc-settings__body">
      {pluginContribution ? (
        <PluginContribution contribution={pluginContribution} props={{}} />
      ) : (
        body[section as CoreSettingsSectionId]
      )}
    </div>
  );
}
