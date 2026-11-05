const { contextBridge, ipcRenderer, webUtils } = require("electron");

// 会话图片资产基址：只缓存成功值；server 未就绪时返回 null，下次调用会重取
// （窗口加载早于 agent server fork，一次性 invoke 会把 null 固化成永久失败）
let assetBase = null;
async function resolveAssetBase() {
  if (assetBase) return assetBase;
  try {
    const base = await ipcRenderer.invoke("meow:asset-base");
    // null 不缓存：server 起来后要能拿到
    if (base) assetBase = base;
  } catch {
    // 主进程未就绪，下次再取
  }
  return assetBase;
}
void resolveAssetBase(); // 预热：多数情况下窗口加载完 server 已就绪

contextBridge.exposeInMainWorld("meow", {
  request: (path, init) => ipcRenderer.invoke("meow:request", path, init),
  /** 会话落盘图片的绝对 URL（带 query token）；server 未就绪时返回 null */
  assetUrl: (file) => {
    if (!assetBase || !file) return null;
    return `${assetBase.serverUrl}/session/asset?file=${encodeURIComponent(file)}&token=${encodeURIComponent(assetBase.token)}`;
  },
  /** 插件自带面板的 URL（带 query token：iframe 带不了 Authorization 头）；server 未就绪返回 null（可重试） */
  pluginUiUrl: async (pluginId, entry = "index.html") => {
    if (!pluginId) return null;
    const base = await resolveAssetBase();
    if (!base) return null;
    return `${base.serverUrl}/plugin-ui/${encodeURIComponent(pluginId)}/${encodeURIComponent(entry)}?token=${encodeURIComponent(base.token)}`;
  },
  /** 窗口是否启用了系统亚克力背板（渲染层据此把 body/root 画成透明） */
  acrylic: process.argv.includes("--meow-backdrop=acrylic"),
  /** 拖入/选中的本地文件 → 绝对路径（Electron 32+ 的 File.path 已移除，改走 webUtils） */
  getFilePath: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
  getSettings: () => ipcRenderer.invoke("meow:get-settings"),
  saveSettings: (settings) => ipcRenderer.invoke("meow:save-settings", settings),
  /** 插件启停（写 settings.plugins 后重启 agent server 生效） */
  setPluginsState: (payload) => ipcRenderer.invoke("meow:set-plugins-state", payload),
  /** Claude Code hooks：启停/运行方式/工作区范围（重启 agent server 生效） */
  saveHooksSettings: (payload) => ipcRenderer.invoke("meow:save-hooks-settings", payload),
  /** 打开已知的 Claude Code hooks 配置文件（layer: user/project/local） */
  openHooksFile: (layer) => ipcRenderer.invoke("meow:open-hooks-file", layer),
  /** GitHub MCP 的 OAuth 设备流：token 只在主进程加密保存，渲染层只拿状态/设备码 */
  githubAuthStatus: () => ipcRenderer.invoke("meow:github-auth-status"),
  githubDeviceStart: () => ipcRenderer.invoke("meow:github-device-start"),
  githubDevicePoll: (flowId) => ipcRenderer.invoke("meow:github-device-poll", flowId),
  githubDisconnect: () => ipcRenderer.invoke("meow:github-disconnect"),
  /** 手工 Token（Gitee/GitCode PAT、Figma 访问令牌：主进程校验后加密保存并热更新 MCP） */
  setMcpCredentials: (payload) => ipcRenderer.invoke("meow:set-mcp-credentials", payload),
  /** 清除手工令牌（解除授权：删本机存储并热更新 MCP） */
  clearMcpToken: (payload) => ipcRenderer.invoke("meow:clear-mcp-token", payload),
  /** Gitee / GitCode OAuth（浏览器授权，Client Secret 只存本机） */
  oauthStatus: () => ipcRenderer.invoke("meow:oauth-status"),
  oauthSaveApp: (payload) => ipcRenderer.invoke("meow:oauth-save-app", payload),
  oauthConnectStart: (payload) => ipcRenderer.invoke("meow:oauth-connect-start", payload),
  oauthConnectPoll: (payload) => ipcRenderer.invoke("meow:oauth-connect-poll", payload),
  oauthConnectCancel: (payload) => ipcRenderer.invoke("meow:oauth-connect-cancel", payload),
  oauthDisconnect: (payload) => ipcRenderer.invoke("meow:oauth-disconnect", payload),
  /** 社区市场（GitCode 收录仓库）：当前登录名 / 提交条目 / 删除条目 */
  communityUser: () => ipcRenderer.invoke("meow:community-user"),
  communitySubmit: (payload) => ipcRenderer.invoke("meow:community-submit", payload),
  communityDelete: (payload) => ipcRenderer.invoke("meow:community-delete", payload),
  onCommunityProgress: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("meow:community-progress", wrapped);
    return () => ipcRenderer.removeListener("meow:community-progress", wrapped);
  },
  /** 窗口/页签/面板/草稿等界面状态（主进程防抖原子写） */
  getUiState: () => ipcRenderer.invoke("meow:get-ui-state"),
  saveUiState: (patch) => ipcRenderer.invoke("meow:save-ui-state", patch),
  pickWorkspace: () => ipcRenderer.invoke("meow:pick-workspace"),
  /** 工作区目录是否仍然存在（被删除时输入框上方回退成「选择工作区」） */
  workspaceExists: (target) => ipcRenderer.invoke("meow:workspace-exists", target),
  /** 只写 provider 偏好（思考强度），不重启 agent server */
  saveProviderPrefs: (prefs) => ipcRenderer.invoke("meow:save-provider-prefs", prefs),
  onEvent: (listener) => {
    const wrapped = (_event, payload) => {
      // 主进程合帧：一批高频增量打包成 { batch: [...] }，逐条回放；
      // 单条事件保持原 payload（向后兼容旧主进程格式）
      if (payload && Array.isArray(payload.batch)) {
        for (const item of payload.batch) listener(item);
        return;
      }
      listener(payload);
    };
    ipcRenderer.on("meow:event", wrapped);
    return () => ipcRenderer.removeListener("meow:event", wrapped);
  },

  // ---- 自绘标题栏的窗口操作 ----
  minimizeWindow: () => ipcRenderer.invoke("meow:window-minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("meow:window-toggle-maximize"),
  closeWindow: () => ipcRenderer.invoke("meow:window-close"),
  getWindowState: () => ipcRenderer.invoke("meow:window-state"),
  onWindowStateChange: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("meow:window-state", wrapped);
    return () => ipcRenderer.removeListener("meow:window-state", wrapped);
  },

  // ---- 轻量偏好：主题 / 关闭方式（只写盘，不重启 agent server）----
  savePreferences: (prefs) => ipcRenderer.invoke("meow:save-preferences", prefs),
  /** 轻量偏好已保存的广播（悬浮岛据此跟随主题/语言；主窗口自身不依赖它） */
  onPreferencesChanged: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("meow:preferences-changed", wrapped);
    return () => ipcRenderer.removeListener("meow:preferences-changed", wrapped);
  },

  // ---- AI 悬浮岛 ----
  /** 上报岛体交互矩形（视口坐标，展开=面板/折叠=胶囊）；主进程轮询光标据此切换穿透 */
  setIslandRect: (rect) => ipcRenderer.invoke("meow:island-rect", rect),
  /** 主进程光标进出岛体的判定结果（穿透已同步切换）：false = 光标已离开岛体 */
  onIslandCursor: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("meow:island-cursor", wrapped);
    return () => ipcRenderer.removeListener("meow:island-cursor", wrapped);
  },
  /** 点击胶囊 → 显示/聚焦主窗口 */
  openMainFromIsland: () => ipcRenderer.invoke("meow:island-open-main"),
  /** 岛内发出的 prompt 回报主进程广播（主窗口当前会话命中时补用户气泡） */
  notifyIslandPrompt: (payload) => ipcRenderer.invoke("meow:island-notify-prompt", payload),
  /** 悬浮岛发出 prompt 的广播（仅主窗口消费） */
  onIslandPromptSent: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("meow:island-prompt-sent", wrapped);
    return () => ipcRenderer.removeListener("meow:island-prompt-sent", wrapped);
  },
  /** 已导入的自定义字体（外观设置用），返回 [{family, url}] */
  listCustomFonts: () => ipcRenderer.invoke("meow:list-custom-fonts"),
  /** 弹系统对话框选字体文件并导入（拷贝到 userData/fonts） */
  importFont: () => ipcRenderer.invoke("meow:import-font"),
  /** 删除已导入的自定义字体（清记录 + 删文件） */
  removeCustomFont: (family) => ipcRenderer.invoke("meow:remove-custom-font", family),
  /** 导出会话：主进程弹保存框、拉 server 内容并写盘，返回最终路径 */
  exportSession: (payload) => ipcRenderer.invoke("meow:export-session", payload),
  /** 托盘菜单「设置…」触发，主进程通知渲染层切到设置页 */
  onOpenSettings: (listener) => {
    const wrapped = () => listener();
    ipcRenderer.on("meow:open-settings", wrapped);
    return () => ipcRenderer.removeListener("meow:open-settings", wrapped);
  },

  // ---- 托盘菜单的最近会话 / 新对话 ----
  /** 会话列表或当前会话变化后推送：主进程据此重建托盘菜单（只用于展示） */
  syncTraySessions: (payload) => ipcRenderer.invoke("meow:tray-sessions", payload),
  /** 托盘里点了某个会话：切过去（主进程已把窗口唤到前台） */
  onTraySwitchSession: (listener) => {
    const wrapped = (_event, filePath) => listener(filePath);
    ipcRenderer.on("meow:tray-switch-session", wrapped);
    return () => ipcRenderer.removeListener("meow:tray-switch-session", wrapped);
  },
  /** 托盘里点了「新对话」 */
  onTrayNewSession: (listener) => {
    const wrapped = () => listener();
    ipcRenderer.on("meow:tray-new-session", wrapped);
    return () => ipcRenderer.removeListener("meow:tray-new-session", wrapped);
  },
  /** 订阅就绪握手：主进程把窗口加载期间排队的托盘动作补发过来 */
  notifyTrayReady: () => ipcRenderer.invoke("meow:tray-ready"),

  // ---- 关闭确认：closeAction=ask 时主进程唤起自绘弹窗，选择经 respondClose 回主进程 ----
  onCloseRequest: (listener) => {
    const wrapped = () => listener();
    ipcRenderer.on("meow:close-request", wrapped);
    return () => ipcRenderer.removeListener("meow:close-request", wrapped);
  },
  respondClose: (choice, remember) => ipcRenderer.invoke("meow:close-decision", choice, remember),

  // ---- 应用信息（关于页）----
  getAppInfo: () => ipcRenderer.invoke("meow:get-app-info"),
  /** 检查更新：主进程拉 GitCode releases（渲染进程直连会被 CORS 拦） */
  checkUpdate: () => ipcRenderer.invoke("meow:check-update"),
  /** 下载更新包：主进程流式下载并广播 meow:update-progress */
  downloadUpdate: (payload) => ipcRenderer.invoke("meow:download-update", payload),
  /** 打开已下载的安装包（Windows 会顺带退出应用） */
  openInstaller: (filePath) => ipcRenderer.invoke("meow:open-installer", filePath),
  /** 下载进度 */
  onUpdateProgress: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("meow:update-progress", wrapped);
    return () => ipcRenderer.removeListener("meow:update-progress", wrapped);
  },

  /** 模型规则：主进程定期从 ZCode 内置配置同步（档位 / 上下文 / 输出 / 图片输入） */
  getModelProfiles: () => ipcRenderer.invoke("meow:model-profiles"),
  onModelProfiles: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("meow:model-profiles", wrapped);
    return () => ipcRenderer.removeListener("meow:model-profiles", wrapped);
  },

  /** 在资源管理器中打开目录（项目行菜单），返回错误信息或 null */
  openPath: (target) => ipcRenderer.invoke("meow:open-path", target),

  /** 用系统默认浏览器打开 http/https 链接，返回错误信息或 null */
  openExternal: (url) => ipcRenderer.invoke("meow:open-external", url),

  // ---- 内嵌浏览器（agent 驱动）----
  /** agent 浏览器页签的 webview 就绪后回报 tabId ↔ webContentsId 绑定 */
  bindBrowserTab: (payload) => ipcRenderer.invoke("meow:browser-bind-tab", payload),
  /** 主进程要求建/复用 agent 浏览器页签（agent 的 browser_navigate 触发） */
  onEnsureBrowserTab: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("meow:browser-ensure-tab", wrapped);
    return () => ipcRenderer.removeListener("meow:browser-ensure-tab", wrapped);
  },
  /** 主进程要求激活 agent 浏览器页签（复用已有页签导航时） */
  onSelectBrowserTab: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("meow:browser-select-tab", wrapped);
    return () => ipcRenderer.removeListener("meow:browser-select-tab", wrapped);
  },

  // ---- 终端（右侧面板终端页签）----
  termCreate: (options) => ipcRenderer.invoke("meow:term-create", options),
  termWrite: (id, data) => ipcRenderer.invoke("meow:term-write", id, data),
  termResize: (id, cols, rows) => ipcRenderer.invoke("meow:term-resize", id, cols, rows),
  termKill: (id) => ipcRenderer.invoke("meow:term-kill", id),
  onTermData: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("meow:term-data", wrapped);
    return () => ipcRenderer.removeListener("meow:term-data", wrapped);
  },
  onTermExit: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("meow:term-exit", wrapped);
    return () => ipcRenderer.removeListener("meow:term-exit", wrapped);
  },
});
