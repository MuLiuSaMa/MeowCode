import type {
  AppInfo,
  CommunitySubmitPayload,
  GithubAuthStatus,
  GithubDevicePollResult,
  GithubDeviceStartResult,
  MeowEvent,
  UpdateCheckResult,
  UpdateProgress,
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
      /** 插件自带面板的 URL（带 query token）；server 未就绪或非桌面环境返回 null（可重试） */
      pluginUiUrl?(pluginId: string, entry?: string): Promise<string | null>;
      /** 窗口启用了系统亚克力背板：body/root 要画成透明才能露出毛玻璃 */
      readonly acrylic: boolean;
      /** 拖入/选中的本地文件 → 绝对路径（非 Electron 环境返回 null） */
      getFilePath(file: File): string | null;
      getSettings(): Promise<Settings>;
      saveSettings(settings: Settings): Promise<Settings>;
      /** 插件启停（写 settings.plugins 后重启 agent server 生效） */
      setPluginsState(payload: { disabled: string[] }): Promise<Settings>;
      /** Claude Code hooks：启停/运行方式/工作区范围（重启 agent server 生效） */
      saveHooksSettings(payload: {
        enabled: boolean;
        runMode: "auto" | "ask";
        includeWorkspace: boolean;
      }): Promise<Settings>;
      /** 打开已知的 Claude Code hooks 配置文件（路径由主进程解析） */
      openHooksFile(layer: "user" | "project" | "local"): Promise<{
        ok: boolean;
        path?: string;
        missing?: boolean;
        error?: string;
      }>;
      /** GitHub MCP 的 OAuth 连接状态（不含 token） */
      githubAuthStatus(): Promise<GithubAuthStatus>;
      /** 开始 GitHub 设备流授权（返回一次性用户码） */
      githubDeviceStart(): Promise<GithubDeviceStartResult>;
      /** 轮询设备流授权结果 */
      githubDevicePoll(flowId: string): Promise<GithubDevicePollResult>;
      /** 解除本机 GitHub 授权（清 token 并重载 MCP） */
      githubDisconnect(): Promise<{ auth: GithubAuthStatus; warning?: string }>;
      /** 保存手工 Token（Gitee/GitCode PAT、Figma 访问令牌：校验通过后加密保存并热更新 MCP） */
      setMcpCredentials(payload: { env: Record<string, string> }): Promise<SetMcpCredentialsResult>;
      /** 清除手工令牌（解除授权：删本机存储并热更新 MCP） */
      clearMcpToken(payload: { name: string }): Promise<SetMcpCredentialsResult>;
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
      /** 社区市场：当前 GitCode 社区登录名（未连接返回 loggedIn: false） */
      communityUser(): Promise<{ loggedIn: boolean; login: string | null }>;
      /** 社区市场：一键提交条目（fork → 分支 → 上传 → PR），返回 PR 链接 */
      communitySubmit(payload: CommunitySubmitPayload): Promise<{ ok: boolean; prUrl?: string; message?: string }>;
      /** 社区市场：发起删除自己的条目（生成删除 PR） */
      communityDelete(payload: {
        id: string;
        type: "skill" | "plugin" | "mcp";
        name: string;
        author?: string;
      }): Promise<{ ok: boolean; prUrl?: string; message?: string }>;
      /** 订阅社区提交/删除的进度消息；返回取消订阅 */
      onCommunityProgress(listener: (payload: { message: string }) => void): () => void;
      /** 窗口/页签/面板/草稿等界面状态（主进程防抖原子写） */
      getUiState(): Promise<UiState>;
      saveUiState(patch: UiStatePatch): Promise<{ ok: boolean }>;
      pickWorkspace(): Promise<string | null>;
      /** 应用数据目录；改过位置时返回当前生效的自定义目录 */
      getDataLocation(): Promise<{ path: string; defaultPath: string }>;
      /** 选择新的数据目录（原生文件夹选择框）；取消返回 null */
      pickDataDirectory(): Promise<string | null>;
      /** 复制必要数据并重启应用；失败返回错误码 */
      changeDataLocation(target: string): Promise<{
        ok: boolean;
        code?: "same_path" | "not_empty" | "invalid_target" | "copy_failed";
        message?: string;
        restarting?: boolean;
      }>;
      /** 工作区目录是否仍然存在（被删除时输入框上方回退成「选择工作区」） */
      workspaceExists(target: string): Promise<boolean>;
      /** 只写 provider 偏好（思考强度 / 激活模型），不重启 agent server */
      saveProviderPrefs(prefs: {
        providers?: Array<{ id: string; reasoningEffort?: string }>;
        providerId?: string;
        /** 记忆总开关（实时生效走 /config/memory）：关掉后不蒸馏、不注入、不下发记忆工具 */
        memoryEnabled?: boolean;
        /** 自我学习开关（实时生效走 /config/learning） */
        selfLearning?: boolean;
        /** 网络代理模式（实时生效走 /config/proxy） */
        proxyMode?: "direct" | "system" | "manual";
        /** manual 模式下的代理地址 */
        proxyUrl?: string;
        /** 命令沙箱设置（实时生效走 PUT /config/sandbox） */
        sandbox?: {
          enabled?: boolean;
          mode?: "workspace-write";
          writableRoots?: string[];
          allowTemp?: boolean;
          grantTimeoutMs?: number;
          confirmDelete?: boolean;
        };
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
      /** 轻量偏好已保存的广播（悬浮岛据此跟随主题/语言；主窗口自身不依赖它） */
      onPreferencesChanged(listener: (prefs: Settings) => void): () => void;

      /** AI 悬浮岛：上报岛体交互矩形（视口坐标，展开=面板/折叠=胶囊），主进程轮询光标切换穿透 */
      setIslandRect(rect: { x: number; y: number; width: number; height: number }): Promise<void>;
      /** 主进程光标进出岛体的判定结果（穿透已同步切换）：false = 光标已离开岛体 */
      onIslandCursor(listener: (inside: boolean) => void): () => void;
      /** 岛内发出的 prompt 回报主进程广播（主窗口当前会话命中时补用户气泡） */
      notifyIslandPrompt(payload: { sessionId: string; text: string }): Promise<void>;
      /** 悬浮岛发出 prompt 的广播（仅主窗口消费） */
      onIslandPromptSent(listener: (payload: { sessionId: string; text: string }) => void): () => void;
      /** 已导入的自定义字体（外观设置用） */
      listCustomFonts(): Promise<Array<{ family: string; url: string }>>;
      /** 弹系统对话框选字体文件并导入；family 为导入后的展示名 */
      importFont(): Promise<{ ok: boolean; canceled?: boolean; family?: string }>;
      /** 删除已导入的自定义字体 */
      removeCustomFont(family: string): Promise<{ ok: boolean }>;
      /** 导出会话：主进程弹保存框 → 拉 server 内容 → 写盘；filePath 为最终落盘路径 */
      exportSession(payload: {
        filePath: string;
        title?: string;
        format?: "markdown" | "html" | "json";
        includeThinking?: boolean;
        includeTools?: boolean;
        inlineImages?: boolean;
      }): Promise<{ ok: boolean; canceled?: boolean; filePath?: string; bytes?: number; error?: string }>;
      /** 托盘菜单「设置…」触发，切到设置页 */
      onOpenSettings(listener: () => void): () => void;
      /** 推送最近会话给托盘菜单（主进程只做展示与分发；列表或当前会话变化时调用） */
      syncTraySessions(payload: {
        sessions: Array<{
          filePath: string;
          title: string | null;
          createdAt: string;
          messageCount: number;
        }>;
        activeFilePath: string | null;
        /** 当前会话 id：主进程据此判断「前台但看的是别的会话」时仍要弹通知 */
        activeSessionId?: string | null;
      }): Promise<{ ok: boolean }>;
      /** 托盘里点了某个会话（主进程已把窗口唤到前台）：切过去 */
      onTraySwitchSession(listener: (filePath: string) => void): () => void;
      /** 托盘里点了「新对话」 */
      onTrayNewSession(listener: () => void): () => void;
      /** 订阅就绪握手：主进程把窗口加载期间排队的托盘动作补发过来 */
      notifyTrayReady(): Promise<{ ok: boolean }>;

      /** 关闭确认（closeAction=ask）：主进程唤起自绘弹窗，选择回传主进程 */
      onCloseRequest(listener: () => void): () => void;
      respondClose(choice: "tray" | "quit" | "cancel", remember: boolean): Promise<void>;

      /** 应用信息（关于页） */
      getAppInfo(): Promise<AppInfo>;
      /** 检查更新：主进程请求 GitCode releases 并比较版本 */
      checkUpdate(): Promise<UpdateCheckResult>;
      /** 下载更新包（主进程流式下载） */
      downloadUpdate(payload: { url: string; fileName: string }): Promise<{ path: string; size: number }>;
      /** 打开已下载的安装包 */
      openInstaller(filePath: string): Promise<{ launched: boolean; quit: boolean }>;
      /** 下载进度 */
      onUpdateProgress(listener: (progress: UpdateProgress) => void): () => void;

      /** 在资源管理器中打开目录（项目行菜单），返回错误信息或 null */
      openPath(target: string): Promise<string | null>;
      /** 系统「打开方式」应用选择器；返回错误信息或 null */
      openWith(target: string): Promise<string | null>;
      /** 扫描系统里能打开该文件的应用（Windows 注册表 + 图标） */
      detectOpenWith(target: string): Promise<{
        default: {
          name: string;
          exe: string;
          icon?: string | null;
          default?: boolean;
          recommended?: boolean;
        } | null;
        apps: Array<{
          name: string;
          exe: string;
          icon?: string | null;
          default?: boolean;
          recommended?: boolean;
        }>;
        /** Windows 资源管理器图标（data URL）；非 Windows 为 null */
        explorerIcon?: string | null;
      }>;
      /** 异步补全应用图标：exe 路径 → data URL / null */
      openWithIcons(exes: string[]): Promise<Record<string, string | null>>;
      /** 用检测到的具体应用打开文件 */
      openWithApp(exe: string, target: string): Promise<string | null>;
      /** 在系统文件管理器中定位文件 */
      showInFolder(target: string): Promise<string | null>;
      /** 用系统默认浏览器打开 http/https 链接 */
      openExternal(url: string): Promise<string | null>;

      /** 内嵌浏览器（agent 驱动）：回报 webview 绑定，接收建页签/激活指令 */
      bindBrowserTab(payload: { tabId: string; webContentsId: number }): Promise<{ ok: boolean; tabId?: string }>;
      onEnsureBrowserTab(listener: (payload: { requestId: string; url: string }) => void): () => void;
      onSelectBrowserTab(listener: (payload: { tabId: string }) => void): () => void;

      /** 终端（右侧面板终端页签） */
      termCreate(options: {
        cwd?: string;
        cols: number;
        rows: number;
        command?: string;
      }): Promise<{ id: string; shell: string }>;
      termWrite(id: string, data: string): Promise<void>;
      termResize(id: string, cols: number, rows: number): Promise<void>;
      termKill(id: string): Promise<void>;
      termAttach(id: string): Promise<{
        id: string;
        shell: string;
        cwd: string;
        command: string | null;
        cols: number;
        rows: number;
        startedAt: string;
        data: string;
        offset: number;
        bufferStart: number;
        exited: boolean;
        code: number | null;
      } | null>;
      termRead(
        id: string,
        offset?: number,
      ): Promise<{
        id: string;
        data: string;
        offset: number;
        bufferStart: number;
        truncated: boolean;
        exited: boolean;
        code: number | null;
      } | null>;
      /** agent 启动后台任务：主进程请求打开/聚焦对应的终端页签 */
      onEnsureJobTab(listener: (payload: { id: string; command: string }) => void): () => void;
      onTermData(listener: (payload: { id: string; data: string }) => void): () => void;
      onTermExit(listener: (payload: { id: string; code: number }) => void): () => void;
    };
  }
}

export {};
