const { contextBridge, ipcRenderer, webUtils } = require("electron");

// 会话图片资产基址：加载即取（server 起来前为 null，assetUrl 返回 null 前端降级无图）
let assetBase = null;
ipcRenderer
  .invoke("meow:asset-base")
  .then((base) => {
    assetBase = base;
  })
  .catch(() => undefined);

contextBridge.exposeInMainWorld("meow", {
  request: (path, init) => ipcRenderer.invoke("meow:request", path, init),
  /** 会话落盘图片的绝对 URL（带 query token）；server 未就绪时返回 null */
  assetUrl: (file) => {
    if (!assetBase || !file) return null;
    return `${assetBase.serverUrl}/session/asset?file=${encodeURIComponent(file)}&token=${encodeURIComponent(assetBase.token)}`;
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
  /** GitHub MCP 的 OAuth 设备流：token 只在主进程加密保存，渲染层只拿状态/设备码 */
  githubAuthStatus: () => ipcRenderer.invoke("meow:github-auth-status"),
  githubDeviceStart: () => ipcRenderer.invoke("meow:github-device-start"),
  githubDevicePoll: (flowId) => ipcRenderer.invoke("meow:github-device-poll", flowId),
  githubDisconnect: () => ipcRenderer.invoke("meow:github-disconnect"),
  /** Gitee / GitCode 手工 Token（主进程校验后加密保存并热更新 MCP） */
  setMcpCredentials: (payload) => ipcRenderer.invoke("meow:set-mcp-credentials", payload),
  /** Gitee / GitCode OAuth（浏览器授权，Client Secret 只存本机） */
  oauthStatus: () => ipcRenderer.invoke("meow:oauth-status"),
  oauthSaveApp: (payload) => ipcRenderer.invoke("meow:oauth-save-app", payload),
  oauthConnectStart: (payload) => ipcRenderer.invoke("meow:oauth-connect-start", payload),
  oauthConnectPoll: (payload) => ipcRenderer.invoke("meow:oauth-connect-poll", payload),
  oauthConnectCancel: (payload) => ipcRenderer.invoke("meow:oauth-connect-cancel", payload),
  oauthDisconnect: (payload) => ipcRenderer.invoke("meow:oauth-disconnect", payload),
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
  /** 托盘菜单「设置…」触发，主进程通知渲染层切到设置页 */
  onOpenSettings: (listener) => {
    const wrapped = () => listener();
    ipcRenderer.on("meow:open-settings", wrapped);
    return () => ipcRenderer.removeListener("meow:open-settings", wrapped);
  },

  // ---- 关闭确认：closeAction=ask 时主进程唤起自绘弹窗，选择经 respondClose 回主进程 ----
  onCloseRequest: (listener) => {
    const wrapped = () => listener();
    ipcRenderer.on("meow:close-request", wrapped);
    return () => ipcRenderer.removeListener("meow:close-request", wrapped);
  },
  respondClose: (choice, remember) => ipcRenderer.invoke("meow:close-decision", choice, remember),

  // ---- 应用信息（关于页）----
  getAppInfo: () => ipcRenderer.invoke("meow:get-app-info"),

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
