import type {
  AppInfo,
  GithubAuthStatus,
  GithubDevicePollResult,
  GithubDeviceStartResult,
  MeowEvent,
  OauthConnectPollResult,
  OauthConnectStartResult,
  OauthPlatform,
  OauthPlatformStatus,
  OauthSaveAppPayload,
  OauthVerifyResult,
  Preferences,
  SetMcpCredentialsResult,
  Settings,
  UiState,
} from "./api";

type UiStatePatch = Omit<Partial<UiState>, "drafts"> & {
  drafts?: Record<string, { text: string; updatedAt: string } | null>;
};

/** 主进程从 ZCode 内置配置同步来的模型规则（精简后的 modelRules）。 */
type ModelProfilesPayload = {
  revision: number | null;
  fetchedAt: number;
  profiles: Array<{
    match: string;
    values?: string[];
    contextWindow?: number;
    maxOutputTokens?: number;
    supportsImage?: boolean;
  }>;
};

declare global {
  interface Window {
    meow: {
      request(path: string, init?: RequestInit): Promise<unknown>;
    /** 会话落盘图片的绝对 URL（带 query token）；server 未就绪或非桌面环境返回 null */
    assetUrl?(file: string): string | null;
      /** 窗口启用了系统亚克力背板：body/root 要画成透明才能露出毛玻璃 */
      readonly acrylic: boolean;
      /** 拖入/选中的本地文件 → 绝对路径（非 Electron 环境返回 null） */
      getFilePath(file: File): string | null;
      getSettings(): Promise<Settings>;
      saveSettings(settings: Settings): Promise<Settings>;
      /** 插件启停（写 settings.plugins 后重启 agent server 生效） */
      setPluginsState(payload: { disabled: string[] }): Promise<Settings>;
      /** GitHub MCP 的 OAuth 连接状态（不含 token） */
      githubAuthStatus(): Promise<GithubAuthStatus>;
      /** 开始 GitHub 设备流授权（返回一次性用户码） */
      githubDeviceStart(): Promise<GithubDeviceStartResult>;
      /** 轮询设备流授权结果 */
      githubDevicePoll(flowId: string): Promise<GithubDevicePollResult>;
      /** 解除本机 GitHub 授权（清 token 并重载 MCP） */
      githubDisconnect(): Promise<{ auth: GithubAuthStatus; warning?: string }>;
      /** 保存 Gitee/GitCode 手工 Token（校验通过后加密保存并热更新 MCP） */
      setMcpCredentials(payload: { env: Record<string, string> }): Promise<SetMcpCredentialsResult>;
      /** Gitee/GitCode OAuth 连接状态（不含 token/secret） */
      oauthStatus(): Promise<Record<OauthPlatform, OauthPlatformStatus>>;
      /** 保存平台的 OAuth 应用凭据（Client ID 留空=用内置应用；client secret 加密存本机） */
      oauthSaveApp(payload: OauthSaveAppPayload): Promise<{ ok: boolean; message?: string }>;
      /** 校验平台的 Client ID / Client Secret 是否配对（不换 token，只探针） */
      oauthVerifyApp(payload: {
        platform: OauthPlatform;
        clientId?: string;
        clientSecret?: string;
      }): Promise<OauthVerifyResult>;
      /** 开始平台 OAuth 浏览器授权（返回授权页地址） */
      oauthConnectStart(payload: { platform: OauthPlatform }): Promise<OauthConnectStartResult>;
      /** 轮询平台 OAuth 授权结果 */
      oauthConnectPoll(payload: { platform: OauthPlatform }): Promise<OauthConnectPollResult>;
      /** 取消进行中的平台 OAuth 授权 */
      oauthConnectCancel(payload: { platform: OauthPlatform }): Promise<{ ok: boolean }>;
      /** 解除平台 OAuth（清 token 并重载 MCP；回退到手工 PAT） */
      oauthDisconnect(payload: { platform: OauthPlatform }): Promise<{ warning?: string }>;
      /** 窗口/页签/面板/草稿等界面状态（主进程防抖原子写） */
      getUiState(): Promise<UiState>;
      saveUiState(patch: UiStatePatch): Promise<{ ok: boolean }>;
      pickWorkspace(): Promise<string | null>;
      /** 工作区目录是否仍然存在（被删除时输入框上方回退成「选择工作区」） */
      workspaceExists(target: string): Promise<boolean>;
      /** 只写 provider 偏好（思考强度 / 激活模型），不重启 agent server */
      saveProviderPrefs(prefs: {
        providers?: Array<{ id: string; reasoningEffort?: string }>;
        providerId?: string;
      }): Promise<Settings>;
      onEvent(listener: (event: MeowEvent) => void): () => void;
      /** 模型规则：主进程定期从 ZCode 内置配置同步（档位 / 上下文 / 输出 / 图片输入） */
      getModelProfiles(): Promise<ModelProfilesPayload | null>;
      onModelProfiles(listener: (payload: ModelProfilesPayload) => void): () => void;

      /** 自绘标题栏的窗口操作 */
      minimizeWindow(): Promise<void>;
      toggleMaximizeWindow(): Promise<boolean>;
      closeWindow(): Promise<void>;
      getWindowState(): Promise<{ isMaximized: boolean }>;
      onWindowStateChange(listener: (state: { isMaximized: boolean }) => void): () => void;

      /** 轻量偏好：主题 / 关闭方式（只写盘，不重启 agent server；读取走 getSettings） */
      savePreferences(prefs: Partial<Preferences>): Promise<Preferences>;
      /** 托盘菜单「设置…」触发，切到设置页 */
      onOpenSettings(listener: () => void): () => void;

      /** 关闭确认（closeAction=ask）：主进程唤起自绘弹窗，选择回传主进程 */
      onCloseRequest(listener: () => void): () => void;
      respondClose(choice: "tray" | "quit" | "cancel", remember: boolean): Promise<void>;

      /** 应用信息（关于页） */
      getAppInfo(): Promise<AppInfo>;

      /** 在资源管理器中打开目录（项目行菜单），返回错误信息或 null */
      openPath(target: string): Promise<string | null>;
      /** 用系统默认浏览器打开 http/https 链接 */
      openExternal(url: string): Promise<string | null>;

      /** 内嵌浏览器（agent 驱动）：回报 webview 绑定，接收建页签/激活指令 */
      bindBrowserTab(payload: { tabId: string; webContentsId: number }): Promise<{ ok: boolean; tabId?: string }>;
      onEnsureBrowserTab(listener: (payload: { requestId: string; url: string }) => void): () => void;
      onSelectBrowserTab(listener: (payload: { tabId: string }) => void): () => void;

      /** 终端（右侧面板终端页签） */
      termCreate(options: { cwd?: string; cols: number; rows: number }): Promise<{ id: string; shell: string }>;
      termWrite(id: string, data: string): Promise<void>;
      termResize(id: string, cols: number, rows: number): Promise<void>;
      termKill(id: string): Promise<void>;
      onTermData(listener: (payload: { id: string; data: string }) => void): () => void;
      onTermExit(listener: (payload: { id: string; code: number }) => void): () => void;
    };
  }
}

export {};
