const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  safeStorage,
  screen,
  session,
  shell,
} = require("electron");
const { registerTerminalIpc } = require("./terminals.cjs");
const { createBrowserHostController } = require("./browser-host.cjs");
const { readJsonWithBackup, writeJsonAtomic } = require("./persist.cjs");
const { createEventBatcher } = require("./event-batcher.cjs");
const {
  DEFAULT_CLIENT_ID: GITHUB_OAUTH_CLIENT_ID,
  startDeviceFlow: startGithubDeviceFlow,
  pollDeviceFlow: pollGithubDeviceFlow,
  refreshAccessToken: refreshGithubAccessToken,
} = require("./github-oauth.cjs");
const {
  OAUTH_PLATFORMS,
  resolveClientId: resolveOauthClientId,
  buildAuthorizeUrl: buildOauthAuthorizeUrl,
  exchangeCodeForToken: exchangeOauthPlatformCode,
  refreshPlatformToken: refreshOauthPlatformToken,
  verifyClientCredentials: verifyOauthPlatformCredentials,
} = require("./oauth-platforms.cjs");
const { fork } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

/** 本地 agent server 的进程内鉴权 token：每次应用启动生成一次，server 重启保持不变。 */
const serverToken = crypto.randomBytes(32).toString("base64url");

/** GitHub OAuth access token 注入到这个环境变量；mcp.json 只保留 ${...} 占位模板。 */
const GITHUB_TOKEN_ENV = "MEOWCODE_GITHUB_TOKEN";
/** Gitee/GitCode 手工 PAT：加密存 settings.mcpCredentials，启动/更新时注入进程 env。 */
const MANUAL_MCP_TOKEN_ENVS = ["MEOWCODE_GITEE_TOKEN", "MEOWCODE_GITCODE_TOKEN"];
/** 提前 5 分钟刷新，避开 MCP 请求中途过期。 */
const GITHUB_REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** 未完成的设备流；deviceCode 只留在主进程内存，不落盘、不进渲染层。 */
const githubFlows = new Map();
let githubRefreshTimer = null;
let githubRefreshInFlight = null;
/** Gitee/GitCode OAuth（授权码 + 本地回跳）：Client Secret 加密存 settings，token 注入对应 env。 */
const OAUTH_CALLBACK_PORT = 53682;
const OAUTH_CONNECT_TIMEOUT_MS = 10 * 60 * 1000;
const OAUTH_REFRESH_MARGIN_MS = 60 * 60 * 1000;
let platformOauthServer = null;
const platformOauthFlows = new Map(); // platform -> { state, status, error, timer }
const platformOauthRefreshTimers = new Map(); // platform -> timer
const platformOauthRefreshInFlight = new Map(); // platform -> Promise

/**
 * OAuth 应用凭据解析顺序：设置页密文 → 环境变量 MEOWCODE_<PLATFORM>_CLIENT_SECRET
 * → 本机 %APPDATA%/MeowCode/oauth-apps.json → oauth-platforms.cjs 内置官方应用凭据。
 * 用户自建应用可通过前三种来源完全覆盖内置凭据。
 * 本机文件格式：{ "gitee": { "clientSecret": "..." }, "gitcode": { "clientSecret": "..." } }
 */
let localOauthAppsCache = { mtimeMs: -1, apps: {} };

function localOauthAppsPath() {
  return path.join(app.getPath("userData"), "oauth-apps.json");
}

function readLocalOauthApps() {
  try {
    const file = localOauthAppsPath();
    const stat = fs.statSync(file);
    if (stat.mtimeMs === localOauthAppsCache.mtimeMs) return localOauthAppsCache.apps;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const apps = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    localOauthAppsCache = { mtimeMs: stat.mtimeMs, apps };
    return apps;
  } catch {
    localOauthAppsCache = { mtimeMs: -1, apps: {} };
    return {};
  }
}

/** 本机凭据（环境变量 > oauth-apps.json），secret 为空表示没配。 */
function localOauthCredential(platform) {
  const envName = `MEOWCODE_${platform.toUpperCase()}_CLIENT_SECRET`;
  const fromEnv = typeof process.env[envName] === "string" ? process.env[envName].trim() : "";
  if (fromEnv) return { clientId: "", clientSecret: fromEnv, source: "env" };
  const entry = readLocalOauthApps()[platform];
  if (!entry || typeof entry !== "object") return { clientId: "", clientSecret: "", source: "" };
  const clientSecret = typeof entry.clientSecret === "string" ? entry.clientSecret.trim() : "";
  const clientId = typeof entry.clientId === "string" ? entry.clientId.trim() : "";
  return { clientId, clientSecret, source: clientSecret ? "file" : "" };
}

/**
 * 生效的应用凭据：设置页（加密存）→ 环境变量 → 本机 oauth-apps.json → 内置应用。
 * 内置 Secret 让新装也能一键直连；用户填了自建 Client ID 时不再套用内置 Secret，
 * 避免把「别人的 ID + 内置 Secret」凑成一对必然 401 的凭据。
 */
function resolveOauthApp(settings, platform) {
  const config = OAUTH_PLATFORMS[platform];
  const storedApp = settings.oauthApps?.[platform] ?? {};
  const storedSecret = storedApp.clientSecretEncrypted
    ? decryptApiKey(storedApp.clientSecretEncrypted).trim()
    : "";
  if (storedSecret) {
    return {
      clientId: resolveOauthClientId(config, storedApp),
      clientSecret: storedSecret,
      source: "settings",
    };
  }
  const local = localOauthCredential(platform);
  if (local.clientSecret) {
    return {
      clientId: resolveOauthClientId(config, { clientId: storedApp.clientId || local.clientId }),
      clientSecret: local.clientSecret,
      source: local.source,
    };
  }
  const customClientId = typeof storedApp.clientId === "string" ? storedApp.clientId.trim() : "";
  if (
    config.defaultClientSecret &&
    (!customClientId || customClientId === config.defaultClientId)
  ) {
    return {
      clientId: config.defaultClientId,
      clientSecret: config.defaultClientSecret,
      source: "builtin",
    };
  }
  return {
    clientId: resolveOauthClientId(config, { clientId: storedApp.clientId || local.clientId }),
    clientSecret: "",
    source: "",
  };
}

app.setName("MeowCode");
// 显式锁定数据目录：默认取 package.json 的 name（@meowcode/desktop）会产出 %APPDATA%/@meowcode
app.setPath("userData", path.join(app.getPath("appData"), "MeowCode"));
if (process.platform === "win32") {
  // 与 electron-builder 的 appId 一致，保证任务栏/通知按 MeowCode 归组
  app.setAppUserModelId("app.meowcode.desktop");
}

/** 关闭窗口时的行为：每次询问 / 缩小到托盘 / 直接关闭 */
const CLOSE_ACTIONS = ["ask", "tray", "quit"];
/** 主题偏好：跟随系统 / 浅色 / 深色 */
const THEME_PREFERENCES = ["system", "light", "dark"];
/** 界面语言：跟随系统 / 简体中文（目前仅简体中文有词条） */
const LANGUAGE_PREFERENCES = ["system", "zh-CN"];

/** 主题 → 窗口底色，必须与 theme/tokens.css 的 --bg-root 一致 */
const THEME_BACKGROUND = { dark: "#0a0a0a", light: "#e6e6e6" };

/**
 * Windows 11（build ≥ 22000）启用系统亚克力背板：
 * 窗口边框 / 标题栏 / 面板间隙透出桌面虚化（毛玻璃），面板自身不透明。
 * 页面通过 --meow-backdrop 参数得知要不要把 body/root 画成透明。
 */
const ACRYLIC_BACKDROP =
  process.platform === "win32" && Number(os.release().split(".")[2] ?? 0) >= 22000;

let mainWindow = null;
/** 内嵌浏览器的 agent 控制桥：随窗口起停，agent server 通过 env 拿到地址与 token */
const browserHost = createBrowserHostController({ getMainWindow: () => mainWindow });
let tray = null;
/** 真退出（托盘菜单 / before-quit）时为 true，此时 close 事件直接放行 */
let isQuitting = false;
let serverProcess = null;
let serverUrl = null;
let eventController = null;
let eventLoopActive = false;
/** SSE 已处理到的序号：重连时通过 Last-Event-ID 让服务端补发漏掉的事件 */
let lastEventId = 0;
let settingsDir = null;
let settingsPath = null;
let sessionsDir = null;
let windowStatePath = null;
let uiStatePath = null;
let windowStateTimer = null;
let uiStateCache = null;
let uiStateTimer = null;

function ensureDirs() {
  settingsDir = path.join(app.getPath("userData"), "agent");
  settingsPath = path.join(settingsDir, "settings.json");
  sessionsDir = path.join(settingsDir, "sessions");
  windowStatePath = path.join(settingsDir, "window-state.json");
  uiStatePath = path.join(settingsDir, "ui-state.json");
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
}

/** 默认工作区：用户文档目录下的 MeowCode（可见、可被用户删除）。 */
function defaultWorkspacePath() {
  return path.join(app.getPath("documents"), "MeowCode");
}

/**
 * 首次启动匿名统计（参考 NexBox）：上报一次版本号与操作系统，不含任何个人信息。
 * 查看统计：https://nexbox.cn/api/count；上报走同域的 /api/statistics。
 * 无论请求成败都写标记，每台机器只尝试一次，失败不重试。
 */
function reportStartupStatistics() {
  try {
    const flagPath = path.join(app.getPath("userData"), "statistics-sent.json");
    if (fs.existsSync(flagPath)) return;

    const osName =
      process.platform === "win32"
        ? "windows"
        : process.platform === "darwin"
          ? "macos"
          : process.platform;
    const payload = JSON.stringify({
      version: `meowcode-${app.getVersion()}`,
      os: osName,
    });

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        fs.mkdirSync(path.dirname(flagPath), { recursive: true });
        fs.writeFileSync(flagPath, "1");
      } catch (error) {
        console.warn("[MeowCode] Failed to write statistics flag:", error);
      }
    };

    const request = https.request(
      "https://nexbox.cn/api/statistics",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
        timeout: 10_000,
      },
      (response) => {
        response.resume();
        response.on("end", finish);
      },
    );
    request.on("error", finish);
    request.on("timeout", () => {
      request.destroy();
      finish();
    });
    request.end(payload);
  } catch (error) {
    console.warn("[MeowCode] Failed to send startup statistics:", error);
  }
}

/**
 * 模型规则自动更新：拉取 ZCode 的公开内置配置（与 providerCatalog 同一数据源），
 * 把 modelRules 里按模型名生效的思考档位、上下文窗口、最大输出、图片输入能力
 * 抽成精简表缓存到本机。新模型发布后无需改代码，下次启动（或本次拉取完成）
 * 就能用上新的档位与容量。
 */
const MODEL_PROFILES_URL = "https://cdn-zcode.z.ai/zcode/config/zcode-builtin.json";
/** 拉取间隔：6 小时。失败不重试，等下次启动。 */
const MODEL_PROFILES_TTL = 6 * 60 * 60 * 1000;
let modelProfiles = null;

function modelProfilesPath() {
  return path.join(app.getPath("userData"), "model-profiles.json");
}

/**
 * 只取不带 baseUrlMatch/apiTypeMatch 的通用规则。
 * disabled/enabled 是思考开关，不是强度档位，过滤掉；
 * `.*` 兜底规则也保留，它提供 1M 上下文的默认值（渲染层只在命中具体规则时才采用）。
 */
function extractModelProfiles(payload) {
  const config = payload && payload.config ? payload.config : payload;
  const rules = config?.modelConfigRules?.modelRules;
  if (!Array.isArray(rules)) return [];
  const profiles = [];
  for (const rule of rules) {
    if (!rule || typeof rule.modelMatch !== "string") continue;
    if (rule.baseUrlMatch || rule.apiTypeMatch) continue;
    const properties = rule.config?.properties;
    const optionSpecs = rule.config?.optionSpecs;
    const rawValues = optionSpecs?.reasoningLevel?.values;
    const values = Array.isArray(rawValues)
      ? rawValues.filter(
          (value) => typeof value === "string" && value !== "disabled" && value !== "enabled",
        )
      : [];
    const contextWindow = properties?.contextWindow;
    const maxOutputTokens = optionSpecs?.maxOutputTokens?.max;
    const supportsImage = properties?.inputFormat?.supportsImage;

    const profile = { match: rule.modelMatch };
    if (values.length) profile.values = values;
    if (Number.isSafeInteger(contextWindow) && contextWindow > 0) {
      profile.contextWindow = contextWindow;
    }
    if (Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0) {
      profile.maxOutputTokens = maxOutputTokens;
    }
    if (typeof supportsImage === "boolean") profile.supportsImage = supportsImage;
    if (
      profile.values ||
      profile.contextWindow !== undefined ||
      profile.maxOutputTokens !== undefined ||
      profile.supportsImage !== undefined
    ) {
      profiles.push(profile);
    }
  }
  return profiles;
}

function readCachedModelProfiles() {
  try {
    const parsed = JSON.parse(fs.readFileSync(modelProfilesPath(), "utf8"));
    return parsed && Array.isArray(parsed.profiles) ? parsed : null;
  } catch {
    return null;
  }
}

function fetchModelProfiles() {
  modelProfiles = readCachedModelProfiles();
  const age = modelProfiles ? Date.now() - Number(modelProfiles.fetchedAt ?? 0) : Infinity;
  if (age >= 0 && age < MODEL_PROFILES_TTL) return;

  const request = https.get(MODEL_PROFILES_URL, { timeout: 15_000 }, (response) => {
    if (response.statusCode !== 200) {
      response.resume();
      return;
    }
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      body += chunk;
    });
    response.on("end", () => {
      try {
        const payload = JSON.parse(body);
        const profiles = extractModelProfiles(payload);
        if (!profiles.length) return;
        const next = {
          revision: payload.revision ?? null,
          fetchedAt: Date.now(),
          profiles,
        };
        fs.mkdirSync(path.dirname(modelProfilesPath()), { recursive: true });
        fs.writeFileSync(modelProfilesPath(), JSON.stringify(next));
        modelProfiles = next;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("meow:model-profiles", next);
        }
      } catch (error) {
        console.warn("[MeowCode] Failed to parse model profiles:", error);
      }
    });
  });
  request.on("error", (error) => {
    console.warn("[MeowCode] Failed to fetch model profiles:", error.message ?? error);
  });
  request.on("timeout", () => request.destroy());
}

/**
 * 从未选择过工作区时，自动创建并选中默认工作区。
 * 已选择过的工作区即使目录被删除也不重建 —— 渲染层据此展示「选择工作区」。
 */
function ensureDefaultWorkspace() {
  ensureDirs();
  const settings = readSettings();
  if (settings.workspace) return settings;
  const target = defaultWorkspacePath();
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (error) {
    // 文档目录不可写等情况下保持未选择，由渲染层引导用户手动选择
    console.warn(
      "[MeowCode] Failed to create default workspace:",
      error instanceof Error ? error.message : String(error),
    );
    return settings;
  }
  const next = migrateSettings({ ...settings, workspace: target });
  writeSettings(next);
  return next;
}

function defaultSettings() {
  return {
    schemaVersion: 2,
    providers: [],
    theme: "system",
    closeAction: "ask",
    language: "system",
    onboardingCompleted: false,
    archivedSessions: [],
    projectNames: {},
    pinnedProjects: [],
    removedProjects: [],
    githubAuth: {},
    mcpCredentials: {},
    oauthApps: {},
    oauthAccounts: {},
  };
}

function normalizeMcpCredentials(raw) {
  const parsed = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const name of MANUAL_MCP_TOKEN_ENVS) {
    if (typeof parsed[name] === "string" && parsed[name]) out[name] = parsed[name];
  }
  return out;
}

function normalizeOauthApps(raw) {
  const parsed = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const platform of Object.keys(OAUTH_PLATFORMS)) {
    const app = parsed?.[platform];
    if (!app || typeof app !== "object") continue;
    out[platform] = {
      clientId: typeof app.clientId === "string" ? app.clientId : "",
      clientSecretEncrypted:
        typeof app.clientSecretEncrypted === "string" ? app.clientSecretEncrypted : "",
    };
  }
  return out;
}

function normalizeOauthAccounts(raw) {
  const parsed = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const platform of Object.keys(OAUTH_PLATFORMS)) {
    const account = parsed?.[platform];
    if (!account || typeof account !== "object") continue;
    out[platform] = {
      accessTokenEncrypted:
        typeof account.accessTokenEncrypted === "string" ? account.accessTokenEncrypted : "",
      refreshTokenEncrypted:
        typeof account.refreshTokenEncrypted === "string" ? account.refreshTokenEncrypted : "",
      expiresAt: typeof account.expiresAt === "string" ? account.expiresAt : "",
      scope: typeof account.scope === "string" ? account.scope : "",
    };
  }
  return out;
}

/** GitHub OAuth 凭据只保存密文；client ID 是公开的，直接内置在 github-oauth.cjs。 */
function normalizeGithubAuth(raw) {
  const parsed = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    accessTokenEncrypted:
      typeof parsed.accessTokenEncrypted === "string" ? parsed.accessTokenEncrypted : "",
    refreshTokenEncrypted:
      typeof parsed.refreshTokenEncrypted === "string" ? parsed.refreshTokenEncrypted : "",
    expiresAt: typeof parsed.expiresAt === "string" ? parsed.expiresAt : "",
    scope: typeof parsed.scope === "string" ? parsed.scope : "",
    tokenType: typeof parsed.tokenType === "string" ? parsed.tokenType : "bearer",
  };
}

function migrateSettings(raw) {
  const base = defaultSettings();
  const parsed = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    ...base,
    ...parsed,
    schemaVersion: 2,
    providers: Array.isArray(parsed.providers) ? parsed.providers : [],
    language: LANGUAGE_PREFERENCES.includes(parsed.language) ? parsed.language : "system",
    // 全新安装走 defaultSettings() 回退（显式 false）；已有 settings.json 缺字段的老用户补 true
    onboardingCompleted:
      typeof parsed.onboardingCompleted === "boolean" ? parsed.onboardingCompleted : true,
    archivedSessions: Array.isArray(parsed.archivedSessions) ? parsed.archivedSessions : [],
    projectNames:
      parsed.projectNames && typeof parsed.projectNames === "object" && !Array.isArray(parsed.projectNames)
        ? parsed.projectNames
        : {},
    pinnedProjects: Array.isArray(parsed.pinnedProjects) ? parsed.pinnedProjects : [],
    removedProjects: Array.isArray(parsed.removedProjects) ? parsed.removedProjects : [],
    githubAuth: normalizeGithubAuth(parsed.githubAuth),
    mcpCredentials: normalizeMcpCredentials(parsed.mcpCredentials),
    oauthApps: normalizeOauthApps(parsed.oauthApps),
    oauthAccounts: normalizeOauthAccounts(parsed.oauthAccounts),
  };
}

function readSettings() {
  return migrateSettings(readJsonWithBackup(settingsPath, () => defaultSettings()));
}

function writeSettings(settings) {
  writeJsonAtomic(settingsPath, migrateSettings(settings));
}

function encryptApiKey(value) {
  if (!value) return "";
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn("[MeowCode] safeStorage unavailable; storing API key without OS encryption.");
    return Buffer.from(value, "utf8").toString("base64");
  }
  return safeStorage.encryptString(value).toString("base64");
}

function decryptApiKey(value) {
  if (!value) return "";
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return Buffer.from(value, "base64").toString("utf8");
    }
    return safeStorage.decryptString(Buffer.from(value, "base64"));
  } catch {
    return "";
  }
}

/** 服务商字段白名单。新增字段必须同时加在这里、publicSettings 与 buildServerEnv。 */
function providerFields(provider, existing) {
  return {
    id: provider.id || `provider-${Date.now()}`,
    name: provider.name,
    baseUrl: provider.baseUrl,
    model: provider.model,
    displayName: provider.displayName,
    protocol: provider.protocol,
    templateId: provider.templateId,
    contextWindow: provider.contextWindow,
    maxTokens: provider.maxTokens,
    inputModalities: provider.inputModalities,
    reasoningLevels: provider.reasoningLevels,
    nativeCompaction:
      "nativeCompaction" in provider ? provider.nativeCompaction : existing?.nativeCompaction,
    reasoningEffort:
      "reasoningEffort" in provider
        ? provider.reasoningEffort || undefined
        : existing?.reasoningEffort,
    thinkingBudget:
      "thinkingBudget" in provider ? provider.thinkingBudget : existing?.thinkingBudget,
    cacheTtl: "cacheTtl" in provider ? provider.cacheTtl : existing?.cacheTtl,
    reasoningSummary:
      "reasoningSummary" in provider ? provider.reasoningSummary : existing?.reasoningSummary,
    fallbackIds: "fallbackIds" in provider ? provider.fallbackIds : existing?.fallbackIds,
    // 显式带 enabled 字段就采用它（false 会被保留），否则沿用原值
    enabled: "enabled" in provider ? Boolean(provider.enabled) : existing?.enabled,
    apiKeyEncrypted: provider.apiKey
      ? encryptApiKey(provider.apiKey)
      : existing?.apiKeyEncrypted ?? "",
  };
}

function githubStoredToken(settings) {
  const auth = settings.githubAuth ?? {};
  if (!auth.accessTokenEncrypted) return "";
  const expiresAt = auth.expiresAt ? Date.parse(auth.expiresAt) : 0;
  if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Date.now()) return "";
  return decryptApiKey(auth.accessTokenEncrypted).trim();
}

function publicGithubAuth(settings) {
  const auth = settings.githubAuth ?? {};
  return {
    connected: Boolean(githubStoredToken(settings)),
    expiresAt: auth.expiresAt || undefined,
    scope: auth.scope || undefined,
  };
}

function oauthStoredToken(settings, platform) {
  const account = settings.oauthAccounts?.[platform] ?? {};
  if (!account.accessTokenEncrypted) return "";
  const expiresAt = account.expiresAt ? Date.parse(account.expiresAt) : 0;
  if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Date.now()) return "";
  return decryptApiKey(account.accessTokenEncrypted).trim();
}

function publicOauthStatus(settings) {
  const status = {};
  for (const platform of Object.keys(OAUTH_PLATFORMS)) {
    const config = OAUTH_PLATFORMS[platform];
    const app = settings.oauthApps?.[platform] ?? {};
    const expiresAt = settings.oauthAccounts?.[platform]?.expiresAt;
    // Client ID 走内置应用（公开信息），Secret 可能来自设置页 / 环境变量 / 本机凭据文件
    const resolved = resolveOauthApp(settings, platform);
    status[platform] = {
      configured: Boolean(resolved.clientId && resolved.clientSecret),
      connected: Boolean(oauthStoredToken(settings, platform)),
      clientId: resolved.clientId,
      redirectUri: localOauthCallbackUri(platform),
      builtinClientId: Boolean(config.defaultClientId) && !app.clientId,
      needsClientSecret: Boolean(resolved.clientId) && !resolved.clientSecret,
      /** secret 来源：settings（设置页保存）/ env（环境变量）/ file（oauth-apps.json）/ builtin（内置应用） */
      secretSource: resolved.source,
      ...(expiresAt ? { expiresAt } : {}),
    };
  }
  return status;
}

function publicSettings(settings) {
  return {
    workspace: settings.workspace,
    providerId: settings.providerId,
    theme: settings.theme ?? "system",
    closeAction: settings.closeAction ?? "ask",
    language: LANGUAGE_PREFERENCES.includes(settings.language) ? settings.language : "system",
    onboardingCompleted: typeof settings.onboardingCompleted === "boolean" ? settings.onboardingCompleted : true,
    archivedSessions: Array.isArray(settings.archivedSessions) ? settings.archivedSessions : [],
    /** 项目（工作区）自定义显示名：cwd → name */
    projectNames: settings.projectNames && typeof settings.projectNames === "object" ? settings.projectNames : {},
    /** 置顶的项目 cwd 列表（顺序即置顶顺序） */
    pinnedProjects: Array.isArray(settings.pinnedProjects) ? settings.pinnedProjects : [],
    /** 已移除（侧栏隐藏）的项目 cwd 列表 */
    removedProjects: Array.isArray(settings.removedProjects) ? settings.removedProjects : [],
    providers: (settings.providers ?? []).map((provider) => ({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
      displayName: provider.displayName,
      protocol: provider.protocol,
      templateId: provider.templateId,
      contextWindow: provider.contextWindow,
      maxTokens: provider.maxTokens,
      inputModalities: provider.inputModalities,
      reasoningEffort: provider.reasoningEffort,
      reasoningLevels: provider.reasoningLevels,
      thinkingBudget: provider.thinkingBudget,
      cacheTtl: provider.cacheTtl,
      reasoningSummary: provider.reasoningSummary,
      fallbackIds: provider.fallbackIds,
      nativeCompaction: provider.nativeCompaction,
      enabled: provider.enabled,
      hasApiKey: Boolean(provider.apiKeyEncrypted),
    })),
    githubAuth: publicGithubAuth(settings),
    mcpCredentialKeys: Object.keys(settings.mcpCredentials ?? {}),
    oauthStatus: publicOauthStatus(settings),
  };
}

/**
 * 仓库根目录（仅 dev 布局下非空）。dev 时 main.cjs 在仓库 desktop/ 里；
 * 打包后它在 app.asar 内，不存在同级 desktop/main.cjs —— 以此区分两种布局。
 * 不能用 app.isPackaged：electron.exe 被改名 MeowCode.exe 后会被 Electron
 * 当作 packaged 启动，isPackaged 在 dev 下也变成 true。
 */
function devRepoRoot() {
  const root = path.resolve(__dirname, "..");
  return fs.existsSync(path.join(root, "desktop", "main.cjs")) ? root : null;
}

function serverScriptPath() {
  const root = devRepoRoot();
  if (root) return path.join(root, "dist", "server", "server.js");
  return path.join(process.resourcesPath, "agent-server", "server.js");
}

/** 插件市场 bundles：dev=仓库 resources/marketplace；打包=extraResources/marketplace */
function marketplaceDir() {
  const root = devRepoRoot();
  if (root) return path.join(root, "resources", "marketplace");
  return path.join(process.resourcesPath, "marketplace");
}

/** 应用图标：多尺寸 ICO（≤36px 为对称标记，≥48px 为完整 Logo），打包后落在 icons/icon.ico。 */
function iconPath() {
  const root = devRepoRoot();
  return root
    ? path.join(root, "resources", "icon.ico")
    : path.join(process.resourcesPath, "icons", "icon.ico");
}

function resolveTheme(preference) {
  if (preference === "light" || preference === "dark") return preference;
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

/**
 * 系统毛玻璃背板跟随应用主题：深色模式深、浅色模式浅。
 * （Acrylic 的明暗由 DWM 按窗口主题绘制，themeSource 就是那个开关）
 */
function applyWindowTheme(preference) {
  const next = preference === "light" || preference === "dark" ? preference : "system";
  if (nativeTheme.themeSource !== next) nativeTheme.themeSource = next;
}

function windowBackground(preference) {
  return THEME_BACKGROUND[resolveTheme(preference)];
}

// ---- Window bounds ----

function readWindowState() {
  const parsed = readJsonWithBackup(windowStatePath, () => ({ version: 1 }));
  if (!parsed || typeof parsed !== "object") return { version: 1 };
  return {
    version: 1,
    ...(parsed.bounds && typeof parsed.bounds === "object" ? { bounds: parsed.bounds } : {}),
    maximized: Boolean(parsed.maximized),
  };
}

function boundsAreVisible(bounds) {
  if (!bounds) return false;
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  const x = Number(bounds.x);
  const y = Number(bounds.y);
  if (![width, height, x, y].every(Number.isFinite) || width < 640 || height < 480) return false;
  try {
    return screen.getAllDisplays().some((display) => {
      const area = display.workArea;
      const overlapX = Math.min(x + width, area.x + area.width) - Math.max(x, area.x);
      const overlapY = Math.min(y + height, area.y + area.height) - Math.max(y, area.y);
      return overlapX >= 100 && overlapY >= 100;
    });
  } catch {
    return false;
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const maximized = mainWindow.isMaximized();
  const bounds = maximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
  try {
    writeJsonAtomic(
      windowStatePath,
      { version: 1, bounds, maximized },
      { pretty: false },
    );
  } catch {
    // 窗口尺寸只是体验优化，绝不阻塞关闭
  }
}

function scheduleWindowStateSave(delay = 500) {
  if (windowStateTimer) clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(() => {
    windowStateTimer = null;
    saveWindowState();
  }, delay);
}

function flushWindowState() {
  if (windowStateTimer) {
    clearTimeout(windowStateTimer);
    windowStateTimer = null;
  }
  saveWindowState();
}

// ---- Renderer UI state (drafts / tabs / panel) ----

const UI_TAB_KINDS = new Set([
  "browser",
  "workspace",
  "review",
  "sidechat",
  "terminal",
  "plan",
  "subagent",
  "subagents",
]);
const MAX_UI_TABS = 32;
const MAX_DRAFTS = 200;
const MAX_DRAFT_CHARS = 64_000;
const MAX_UI_STATE_CHARS = 4_000_000;

function defaultUiState() {
  return {
    version: 1,
    inspector: { visible: true, width: 360 },
    tabs: [],
    activeTabId: "home",
    drafts: {},
  };
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function sanitizeUiState(raw) {
  const base = defaultUiState();
  const parsed = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const inspectorInput =
    parsed.inspector && typeof parsed.inspector === "object" ? parsed.inspector : {};
  const inspector = {
    visible:
      typeof inspectorInput.visible === "boolean" ? inspectorInput.visible : base.inspector.visible,
    width: clampNumber(inspectorInput.width, 240, 1600, base.inspector.width),
  };

  const tabs = [];
  if (Array.isArray(parsed.tabs)) {
    for (const item of parsed.tabs.slice(0, MAX_UI_TABS)) {
      if (!item || typeof item !== "object" || !UI_TAB_KINDS.has(item.kind)) continue;
      const id =
        typeof item.id === "string" && item.id.trim()
          ? item.id.trim().slice(0, 64)
          : `restored-${tabs.length}`;
      const title = typeof item.title === "string" ? item.title.slice(0, 200) : undefined;
      if (item.kind === "browser") {
        const url = typeof item.url === "string" ? item.url.trim() : "";
        if (!/^https?:\/\//i.test(url) || url.length > 2048 || item.agent) continue;
        tabs.push({ id, kind: "browser", title: title || url, url });
        continue;
      }
      if (item.kind === "workspace") {
        tabs.push({
          id,
          kind: "workspace",
          title: title || "文件",
          ...(typeof item.path === "string" && item.path.trim()
            ? { path: item.path.trim().slice(0, 2048) }
            : {}),
        });
        continue;
      }
      if (item.kind === "subagent") {
        const agentId = typeof item.agentId === "string" ? item.agentId.trim() : "";
        const parentSessionId =
          typeof item.parentSessionId === "string" ? item.parentSessionId.trim() : "";
        if (!agentId || !parentSessionId) continue;
        tabs.push({
          id,
          kind: "subagent",
          title: title || "子 Agent",
          agentId: agentId.slice(0, 64),
          parentSessionId: parentSessionId.slice(0, 64),
          ...(typeof item.callId === "string" && item.callId.trim()
            ? { callId: item.callId.trim().slice(0, 64) }
            : {}),
          ...(typeof item.description === "string" && item.description.trim()
            ? { description: item.description.trim().slice(0, 200) }
            : {}),
        });
        continue;
      }
      tabs.push({ id, kind: item.kind, title: title || item.kind });
    }
  }

  const drafts = {};
  const entries = [];
  if (parsed.drafts && typeof parsed.drafts === "object" && !Array.isArray(parsed.drafts)) {
    for (const [key, value] of Object.entries(parsed.drafts)) {
      if (!key.trim() || key.length > 100) continue;
      if (!value || typeof value !== "object" || typeof value.text !== "string") continue;
      if (!value.text.trim()) continue;
      entries.push({
        key,
        text: value.text.slice(0, MAX_DRAFT_CHARS),
        updatedAt:
          typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
      });
    }
  }
  entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const entry of entries.slice(0, MAX_DRAFTS)) {
    drafts[entry.key] = { text: entry.text, updatedAt: entry.updatedAt };
  }

  let activeTabId =
    typeof parsed.activeTabId === "string" ? parsed.activeTabId.slice(0, 64) : "home";
  if (activeTabId !== "home" && !tabs.some((tab) => tab.id === activeTabId)) {
    activeTabId = tabs[0]?.id ?? "home";
  }

  const result = { version: 1, inspector, tabs, activeTabId, drafts };
  // 极端情况下仍超限：先丢最旧草稿，再减少非活动浏览器页签
  while (JSON.stringify(result).length > MAX_UI_STATE_CHARS && Object.keys(result.drafts).length) {
    const oldest = Object.entries(result.drafts).sort((a, b) =>
      a[1].updatedAt.localeCompare(b[1].updatedAt),
    )[0];
    if (!oldest) break;
    delete result.drafts[oldest[0]];
  }
  while (JSON.stringify(result).length > MAX_UI_STATE_CHARS && result.tabs.length > 1) {
    const index = result.tabs.findIndex((tab) => tab.id !== result.activeTabId);
    if (index < 0) break;
    result.tabs.splice(index, 1);
  }
  return result;
}

function ensureUiState() {
  if (!uiStateCache) {
    uiStateCache = sanitizeUiState(readJsonWithBackup(uiStatePath, () => defaultUiState()));
  }
  return uiStateCache;
}

function mergeUiState(patch) {
  const current = ensureUiState();
  const next = {
    ...current,
    inspector: { ...current.inspector },
    tabs: current.tabs,
    drafts: { ...current.drafts },
  };
  if (patch?.inspector && typeof patch.inspector === "object") {
    if (typeof patch.inspector.visible === "boolean") {
      next.inspector.visible = patch.inspector.visible;
    }
    if (Number.isFinite(Number(patch.inspector.width))) {
      next.inspector.width = Number(patch.inspector.width);
    }
  }
  if (Array.isArray(patch?.tabs)) next.tabs = patch.tabs;
  if (typeof patch?.activeTabId === "string") next.activeTabId = patch.activeTabId;
  if (patch?.drafts && typeof patch.drafts === "object" && !Array.isArray(patch.drafts)) {
    for (const [key, value] of Object.entries(patch.drafts)) {
      if (value === null) {
        delete next.drafts[key];
        continue;
      }
      if (!value || typeof value !== "object" || typeof value.text !== "string") continue;
      next.drafts[key] = {
        text: value.text,
        updatedAt:
          typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
      };
    }
  }
  uiStateCache = sanitizeUiState(next);
  return uiStateCache;
}

function scheduleUiStateSave() {
  if (uiStateTimer) clearTimeout(uiStateTimer);
  uiStateTimer = setTimeout(() => {
    uiStateTimer = null;
    flushUiState();
  }, 300);
}

function flushUiState() {
  if (uiStateTimer) {
    clearTimeout(uiStateTimer);
    uiStateTimer = null;
  }
  if (!uiStateCache) return;
  try {
    writeJsonAtomic(uiStatePath, uiStateCache, { pretty: false });
  } catch {
    // UI 状态写失败不能影响交互
  }
}

function buildServerEnv(settings) {
  const providers = (settings.providers ?? []).map((provider) => ({
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    model: provider.model,
    displayName: provider.displayName,
    protocol: provider.protocol,
    templateId: provider.templateId,
    contextWindow: provider.contextWindow,
    maxTokens: provider.maxTokens,
    inputModalities: provider.inputModalities,
    reasoningLevels: provider.reasoningLevels,
    apiKey: decryptApiKey(provider.apiKeyEncrypted),
    reasoningEffort: provider.reasoningEffort,
    thinkingBudget: provider.thinkingBudget,
    cacheTtl: provider.cacheTtl,
    reasoningSummary: provider.reasoningSummary,
    fallbackIds: provider.fallbackIds,
    nativeCompaction: provider.nativeCompaction,
  }));
  const ripgrepPath = devRepoRoot()
    ? ""
    : path.join(process.resourcesPath, "agent-server", "ripgrep", process.platform === "win32" ? "rg.exe" : "rg");
  const manualMcpEnv = {};
  for (const name of MANUAL_MCP_TOKEN_ENVS) {
    const encrypted = settings.mcpCredentials?.[name];
    if (!encrypted) continue;
    const value = decryptApiKey(encrypted).trim();
    if (value) manualMcpEnv[name] = value;
  }
  // 平台 OAuth token 优先于手工 PAT
  for (const [platform, config] of Object.entries(OAUTH_PLATFORMS)) {
    const token = oauthStoredToken(settings, platform);
    if (token) manualMcpEnv[config.tokenEnv] = token;
  }
  const githubToken = githubStoredToken(settings);
  return {
    ...process.env,
    ...manualMcpEnv,
    ...(githubToken ? { [GITHUB_TOKEN_ENV]: githubToken } : {}),
    MEOWCODE_SERVER_PORT: "0",
    MEOWCODE_SESSIONS_DIR: sessionsDir,
    MEOWCODE_WORKSPACE: settings.workspace ?? "",
    MEOWCODE_PROVIDER_ID: settings.providerId ?? "",
    MEOWCODE_PROVIDERS: JSON.stringify(providers),
    // 插件禁用清单（设置页启停）：server 只认 env，不读 settings 文件
    MEOWCODE_PLUGINS: JSON.stringify({ disabled: settings.plugins?.disabled ?? [] }),
    MEOWCODE_SERVER_TOKEN: serverToken,
    // 插件市场 bundles 根（未设置=市场功能为空）
    MEOWCODE_MARKETPLACE_DIR: marketplaceDir(),
    MEOWCODE_RIPGREP_PATH: ripgrepPath,
    ...(browserHost.baseUrl
      ? {
          MEOWCODE_BROWSER_HOST: browserHost.baseUrl,
          MEOWCODE_BROWSER_HOST_TOKEN: browserHost.token,
        }
      : {}),
    ELECTRON_RUN_AS_NODE: "1",
  };
}

function clearGithubRefresh() {
  if (githubRefreshTimer) {
    clearTimeout(githubRefreshTimer);
    githubRefreshTimer = null;
  }
}

function scheduleGithubRefresh(settings) {
  clearGithubRefresh();
  const auth = settings.githubAuth ?? {};
  if (!auth.refreshTokenEncrypted || !auth.expiresAt) return;
  const expiresAt = Date.parse(auth.expiresAt);
  if (!Number.isFinite(expiresAt)) return;
  const delay = Math.max(60_000, expiresAt - Date.now() - GITHUB_REFRESH_MARGIN_MS);
  githubRefreshTimer = setTimeout(() => {
    githubRefreshTimer = null;
    void refreshGithubToken().catch((error) => {
      console.warn(
        "[MeowCode] GitHub token refresh failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
  }, delay);
  githubRefreshTimer.unref?.();
}

function saveGithubToken(token) {
  const previous = readSettings();
  const auth = {
    accessTokenEncrypted: encryptApiKey(token.accessToken),
    refreshTokenEncrypted: token.refreshToken ? encryptApiKey(token.refreshToken) : "",
    expiresAt:
      token.expiresIn > 0 ? new Date(Date.now() + token.expiresIn * 1000).toISOString() : "",
    scope: token.scope,
    tokenType: token.tokenType,
  };
  const settings = migrateSettings({ ...previous, githubAuth: auth });
  writeSettings(settings);
  scheduleGithubRefresh(settings);
  return settings;
}

/** 把 MCP 凭据热更新到运行中的 agent server（设置 env + reload MCP）；server 未就绪时下次启动生效。 */
async function updateServerMcpCredentials(env) {
  if (!serverUrl) return false;
  try {
    const response = await fetch(`${serverUrl}/plugins/mcp-credentials`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${serverToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ env }),
    });
    if (!response.ok) {
      console.error(`[MeowCode] Failed to update MCP credentials (${response.status}).`);
      return false;
    }
    return true;
  } catch (error) {
    console.error(
      "[MeowCode] Failed to update MCP credentials:",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

function updateServerGithubToken(token) {
  return updateServerMcpCredentials({ [GITHUB_TOKEN_ENV]: token || null });
}

const MANUAL_MCP_USER_URLS = {
  MEOWCODE_GITEE_TOKEN: "https://gitee.com/api/v5/user",
  MEOWCODE_GITCODE_TOKEN: "https://api.gitcode.com/api/v5/user",
};

async function validateManualMcpToken(name, token) {
  const userUrl = MANUAL_MCP_USER_URLS[name];
  if (!userUrl) return { ok: false, message: "不支持的 MCP Token。" };
  try {
    const response = await fetch(`${userUrl}?access_token=${encodeURIComponent(token)}`, {
      headers: { accept: "application/json", "user-agent": "MeowCode" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) return { ok: true };
    return {
      ok: false,
      message: `Token 校验失败（HTTP ${response.status}），请确认是否是有效的私人令牌/访问令牌。`,
    };
  } catch (error) {
    return {
      ok: false,
      message: `无法连接平台校验 Token：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ---- Gitee / GitCode OAuth（授权码 + 本地回跳）----

function localOauthCallbackUri(platform) {
  return `http://127.0.0.1:${OAUTH_CALLBACK_PORT}${OAUTH_PLATFORMS[platform].localCallbackPath}`;
}

function closeOauthCallbackServerIfIdle() {
  if (platformOauthServer && platformOauthFlows.size === 0) {
    const server = platformOauthServer;
    platformOauthServer = null;
    server.close(() => undefined);
  }
}

function handleOauthCallback(platform, url, response) {
  const flow = platformOauthFlows.get(platform);
  const config = OAUTH_PLATFORMS[platform];
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(
    "<!doctype html><meta charset='utf-8'><title>MeowCode 授权</title>" +
      '<body style="font-family:system-ui,sans-serif;background:#0d0d0d;color:#f5f5f5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">' +
      "<p>已收到授权，正在返回 MeowCode… 可以关闭此窗口。</p>",
  );
  if (!flow || flow.status !== "pending") return;
  if (url.searchParams.get("state") !== flow.state) {
    flow.status = "error";
    flow.error = "回调 state 不匹配，请重新开始授权。";
    closeOauthCallbackServerIfIdle();
    return;
  }
  const errorParam = url.searchParams.get("error");
  if (errorParam) {
    flow.status = "error";
    flow.error = url.searchParams.get("error_description") ?? errorParam;
    closeOauthCallbackServerIfIdle();
    return;
  }
  const code = url.searchParams.get("code") ?? "";
  if (!code) {
    flow.status = "error";
    flow.error = "平台未返回授权码。";
    closeOauthCallbackServerIfIdle();
    return;
  }
  void (async () => {
    const settings = readSettings();
    const resolved = resolveOauthApp(settings, platform);
    // 用发起授权时那一对（外层 flow 已持有）；拿不到才回落到当前解析结果。
    // 不用 platformOauthFlows.get：轮询可能在授权码到达与此处之间把 flow 取走。
    const clientId = flow?.clientId || resolved.clientId;
    const clientSecret = flow?.clientSecret || resolved.clientSecret;
    const result = await exchangeOauthPlatformCode(config, {
      clientId,
      clientSecret,
      code,
      redirectUri: localOauthCallbackUri(platform),
    });
    if (!result.ok) {
      flow.status = "error";
      flow.error = result.message;
      closeOauthCallbackServerIfIdle();
      return;
    }
    const next = savePlatformOauthToken(platform, result.token);
    await updateServerMcpCredentials({ [config.tokenEnv]: result.token.accessToken });
    scheduleOauthRefresh(next, platform);
    flow.status = "success";
    closeOauthCallbackServerIfIdle();
  })().catch((error) => {
    flow.status = "error";
    flow.error = error instanceof Error ? error.message : String(error);
    closeOauthCallbackServerIfIdle();
  });
}

function ensureOauthCallbackServer() {
  if (platformOauthServer) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      try {
        const url = new URL(request.url ?? "/", `http://127.0.0.1:${OAUTH_CALLBACK_PORT}`);
        const platform = Object.keys(OAUTH_PLATFORMS).find(
          (name) => url.pathname === OAUTH_PLATFORMS[name].localCallbackPath,
        );
        if (platform) {
          handleOauthCallback(platform, url, response);
          return;
        }
      } catch {
        /* 解析失败按 404 处理 */
      }
      response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><meta charset='utf-8'><title>404</title><p>未找到对应的授权会话。</p>");
    });
    server.on("error", (error) => {
      platformOauthServer = null;
      reject(error);
    });
    server.listen(OAUTH_CALLBACK_PORT, "127.0.0.1", () => {
      platformOauthServer = server;
      resolve();
    });
  });
}

function savePlatformOauthToken(platform, token) {
  const previous = readSettings();
  const accounts = { ...(previous.oauthAccounts ?? {}) };
  accounts[platform] = {
    accessTokenEncrypted: encryptApiKey(token.accessToken),
    refreshTokenEncrypted: token.refreshToken ? encryptApiKey(token.refreshToken) : "",
    expiresAt:
      token.expiresIn > 0 ? new Date(Date.now() + token.expiresIn * 1000).toISOString() : "",
    scope: token.scope,
  };
  const settings = migrateSettings({ ...previous, oauthAccounts: accounts });
  writeSettings(settings);
  scheduleOauthRefresh(settings, platform);
  return settings;
}

function clearOauthRefreshTimer(platform) {
  const timer = platformOauthRefreshTimers.get(platform);
  if (timer) {
    clearTimeout(timer);
    platformOauthRefreshTimers.delete(platform);
  }
}

function scheduleOauthRefresh(settings, platform) {
  clearOauthRefreshTimer(platform);
  const account = settings.oauthAccounts?.[platform] ?? {};
  if (!account.refreshTokenEncrypted || !account.expiresAt) return;
  const expiresAt = Date.parse(account.expiresAt);
  if (!Number.isFinite(expiresAt)) return;
  const delay = Math.max(60_000, expiresAt - Date.now() - OAUTH_REFRESH_MARGIN_MS);
  const timer = setTimeout(() => {
    platformOauthRefreshTimers.delete(platform);
    void refreshOauthToken(platform).catch((error) => {
      console.warn(
        `[MeowCode] ${platform} OAuth token refresh failed:`,
        error instanceof Error ? error.message : String(error),
      );
    });
  }, delay);
  timer.unref?.();
  platformOauthRefreshTimers.set(platform, timer);
}

async function refreshOauthToken(platform) {
  const inFlight = platformOauthRefreshInFlight.get(platform);
  if (inFlight) return inFlight;
  const task = (async () => {
    const settings = readSettings();
    const account = settings.oauthAccounts?.[platform] ?? {};
    const refreshToken = account.refreshTokenEncrypted
      ? decryptApiKey(account.refreshTokenEncrypted).trim()
      : "";
    if (!refreshToken) return;
    const config = OAUTH_PLATFORMS[platform];
    const { clientId, clientSecret } = resolveOauthApp(settings, platform);
    const result = await refreshOauthPlatformToken(config, {
      clientId,
      clientSecret,
      refreshToken,
    });
    if (!result.ok) {
      console.warn(`[MeowCode] ${platform} OAuth token refresh failed:`, result.message);
      const expiresAt = account.expiresAt ? Date.parse(account.expiresAt) : 0;
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        const accounts = { ...(settings.oauthAccounts ?? {}) };
        delete accounts[platform];
        const next = migrateSettings({ ...settings, oauthAccounts: accounts });
        writeSettings(next);
        const fallbackEncrypted = next.mcpCredentials?.[config.tokenEnv];
        const fallback = fallbackEncrypted ? decryptApiKey(fallbackEncrypted).trim() : "";
        await updateServerMcpCredentials({ [config.tokenEnv]: fallback || null });
        clearOauthRefreshTimer(platform);
        return;
      }
      const retryTimer = setTimeout(() => {
        platformOauthRefreshTimers.delete(platform);
        void refreshOauthToken(platform).catch(() => undefined);
      }, 5 * 60 * 1000);
      retryTimer.unref?.();
      platformOauthRefreshTimers.set(platform, retryTimer);
      return;
    }
    const accounts = { ...(settings.oauthAccounts ?? {}) };
    accounts[platform] = {
      accessTokenEncrypted: encryptApiKey(result.token.accessToken),
      refreshTokenEncrypted: result.token.refreshToken
        ? encryptApiKey(result.token.refreshToken)
        : account.refreshTokenEncrypted,
      expiresAt:
        result.token.expiresIn > 0
          ? new Date(Date.now() + result.token.expiresIn * 1000).toISOString()
          : "",
      scope: result.token.scope || account.scope,
    };
    const next = migrateSettings({ ...settings, oauthAccounts: accounts });
    writeSettings(next);
    await updateServerMcpCredentials({ [config.tokenEnv]: result.token.accessToken });
    scheduleOauthRefresh(next, platform);
  })().finally(() => {
    platformOauthRefreshInFlight.delete(platform);
  });
  platformOauthRefreshInFlight.set(platform, task);
  return task;
}

async function refreshOauthTokensIfNeeded() {
  const settings = readSettings();
  for (const platform of Object.keys(OAUTH_PLATFORMS)) {
    const account = settings.oauthAccounts?.[platform] ?? {};
    if (!account.accessTokenEncrypted) {
      clearOauthRefreshTimer(platform);
      continue;
    }
    if (!account.refreshTokenEncrypted || !account.expiresAt) {
      clearOauthRefreshTimer(platform);
      continue;
    }
    const expiresAt = Date.parse(account.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      clearOauthRefreshTimer(platform);
      continue;
    }
    if (expiresAt - Date.now() > OAUTH_REFRESH_MARGIN_MS) {
      scheduleOauthRefresh(settings, platform);
      continue;
    }
    await refreshOauthToken(platform);
  }
}

async function refreshGithubToken() {
  if (githubRefreshInFlight) return githubRefreshInFlight;
  githubRefreshInFlight = (async () => {
    const settings = readSettings();
    const auth = settings.githubAuth ?? {};
    const refreshToken = auth.refreshTokenEncrypted
      ? decryptApiKey(auth.refreshTokenEncrypted).trim()
      : "";
    if (!refreshToken) return settings;
    const result = await refreshGithubAccessToken(GITHUB_OAUTH_CLIENT_ID, refreshToken);
    if (!result.ok) {
      console.warn("[MeowCode] GitHub token refresh failed:", result.message);
      const expiresAt = auth.expiresAt ? Date.parse(auth.expiresAt) : 0;
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        const next = migrateSettings({ ...settings, githubAuth: {} });
        writeSettings(next);
        await updateServerGithubToken(null);
        clearGithubRefresh();
        return next;
      }
      githubRefreshTimer = setTimeout(() => {
        githubRefreshTimer = null;
        void refreshGithubToken().catch(() => undefined);
      }, 5 * 60 * 1000);
      githubRefreshTimer.unref?.();
      return settings;
    }
    const nextAuth = {
      ...auth,
      accessTokenEncrypted: encryptApiKey(result.token.accessToken),
      refreshTokenEncrypted: result.token.refreshToken
        ? encryptApiKey(result.token.refreshToken)
        : auth.refreshTokenEncrypted,
      expiresAt:
        result.token.expiresIn > 0
          ? new Date(Date.now() + result.token.expiresIn * 1000).toISOString()
          : "",
      scope: result.token.scope || auth.scope,
      tokenType: result.token.tokenType || auth.tokenType,
    };
    const next = migrateSettings({ ...settings, githubAuth: nextAuth });
    writeSettings(next);
    await updateServerGithubToken(result.token.accessToken);
    scheduleGithubRefresh(next);
    return next;
  })().finally(() => {
    githubRefreshInFlight = null;
  });
  return githubRefreshInFlight;
}

async function refreshGithubTokenIfNeeded() {
  const settings = readSettings();
  const auth = settings.githubAuth ?? {};
  if (!auth.refreshTokenEncrypted || !auth.expiresAt) {
    clearGithubRefresh();
    return;
  }
  const expiresAt = Date.parse(auth.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    clearGithubRefresh();
    return;
  }
  if (expiresAt - Date.now() > GITHUB_REFRESH_MARGIN_MS) {
    scheduleGithubRefresh(settings);
    return;
  }
  await refreshGithubToken();
}

function cleanupGithubFlows() {
  const now = Date.now();
  for (const [flowId, flow] of githubFlows) {
    if (flow.expiresAt <= now) githubFlows.delete(flowId);
  }
}

/**
 * 串行化启动/重启：保存设置、插件开关与启动流程都可能同时触发 startServer()。
 * 并发 fork 时后一次会在开头 stopServer() 把「正在启动」的子进程 shutdown 掉，
 * 表现为 "Agent server exited before becoming ready (0)" —— 一次无害的竞态，
 * 却会让用户看到整个启动失败。这里把所有启动排成队列，前一次结束再动下一次。
 */
let serverStartChain = Promise.resolve();

/**
 * 等待 agent server 就绪的请求：启动需要几秒（插件 + MCP），渲染层首屏会立刻发请求。
 * 以前这里直接抛 "Agent server is not ready."，用户看到一串红色错误；
 * 现在改成最多等 15s，就绪后自动放行，超时才报错。
 */
const serverReadyWaiters = new Set();
const SERVER_READY_TIMEOUT_MS = 15_000;

function waitForServerReady() {
  if (serverUrl) return Promise.resolve(serverUrl);
  return new Promise((resolve, reject) => {
    let timer = null;
    const waiter = (url) => {
      if (timer) clearTimeout(timer);
      resolve(url);
    };
    timer = setTimeout(() => {
      serverReadyWaiters.delete(waiter);
      reject(new Error("Agent server is not ready."));
    }, SERVER_READY_TIMEOUT_MS);
    serverReadyWaiters.add(waiter);
  });
}

function startServer() {
  const run = serverStartChain.then(
    () => bootServerOnce(),
    () => bootServerOnce(),
  );
  // 队列本身吞掉失败：一次失败不能让后续启动永远被拒绝
  serverStartChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function bootServerOnce() {
  ensureDirs();
  try {
    await refreshGithubTokenIfNeeded();
  } catch (error) {
    console.warn(
      "[MeowCode] GitHub token refresh check failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
  try {
    await refreshOauthTokensIfNeeded();
  } catch (error) {
    console.warn(
      "[MeowCode] OAuth token refresh check failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
  const settings = ensureDefaultWorkspace();
  await stopServer();
  const script = serverScriptPath();
  if (!fs.existsSync(script)) {
    throw new Error(`Agent server is not built. Missing: ${script}`);
  }
  const spawn = () =>
    new Promise((resolve, reject) => {
      const child = fork(script, [], {
        cwd: devRepoRoot() ?? app.getAppPath(),
        env: buildServerEnv(settings),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        serialization: "advanced",
      });
      let settled = false;
      serverProcess = child;
      child.stdout?.on("data", (chunk) => process.stdout.write(`[agent-server] ${chunk}`));
      child.stderr?.on("data", (chunk) => process.stderr.write(`[agent-server] ${chunk}`));
      child.on("message", (message) => {
        if (message?.type === "ready" && message.url) {
          serverUrl = message.url;
          for (const waiter of serverReadyWaiters) waiter(serverUrl);
          serverReadyWaiters.clear();
          if (!settled) {
            settled = true;
            resolve(serverUrl);
          }
          startEventStream();
        }
      });
      child.on("exit", (code, signal) => {
        if (serverProcess === child) {
          serverProcess = null;
          serverUrl = null;
        }
        if (!settled) {
          settled = true;
          reject(new Error(`Agent server exited before becoming ready (${code ?? signal}).`));
        }
      });
    });

  try {
    return await spawn();
  } catch (error) {
    // 子进程「干净退出（0）且从未 ready」几乎只可能是被 shutdown 打断（重启/退出竞态），
    // 而不是崩溃。自动重试一次；真正的崩溃会带非 0 退出码，照常抛出。
    if (error instanceof Error && /exited before becoming ready \(0\)/.test(error.message)) {
      console.warn("[MeowCode] Agent server exited cleanly before ready; retrying once.");
      await stopServer();
      return await spawn();
    }
    throw error;
  }
}

async function stopServer() {
  if (eventController) {
    eventController.abort();
    eventController = null;
  }
  eventLoopActive = false;
  // 新 server 的序号从 0 重新开始，旧游标不能带过去
  lastEventId = 0;
  const child = serverProcess;
  serverProcess = null;
  serverUrl = null;
  if (!child) return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("exit", finish);
    // Windows 的 child.kill() 是 TerminateProcess，server 来不及 flush；
    // 先走 IPC 让 server abort 回合、写 turn_end 并关闭会话文件。
    try {
      child.send({ type: "shutdown" }, () => undefined);
    } catch {
      child.kill();
    }
    setTimeout(() => {
      if (!settled) child.kill();
      setTimeout(finish, 500);
    }, 3000);
  });
}

function broadcast(event, payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(event, payload);
  }
}

async function startEventStream() {
  if (eventLoopActive || !serverUrl) return;
  eventLoopActive = true;
  while (eventLoopActive && serverUrl) {
    eventController = new AbortController();
    try {
      const response = await fetch(`${serverUrl}/event`, {
        signal: eventController.signal,
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${serverToken}`,
          ...(lastEventId > 0 ? { "last-event-id": String(lastEventId) } : {}),
        },
      });
      if (response.status === 401) {
        eventLoopActive = false;
        console.error("[MeowCode] Agent server rejected the auth token; event stream stopped.");
        return;
      }
      if (!response.ok || !response.body) throw new Error(`Event stream failed: ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let pendingId = null;
      // 高频 delta 微批合帧后走同一条 meow:event 通道；终态事件 flush 后直发保序
      const batcher = createEventBatcher((payload) => broadcast("meow:event", payload));
      try {
        while (eventLoopActive) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("id:")) {
              const id = Number(line.slice(3).trim());
              if (Number.isInteger(id) && id >= 0) pendingId = id;
              continue;
            }
            if (!line.startsWith("data:")) continue;
            try {
              const payload = JSON.parse(line.slice(5).trim());
              if (payload?.type === "server.resync") {
                // 断档/服务端重启：服务端已让前端全量对账，游标直接对齐当前序号
                lastEventId = Number.isInteger(payload.seq) ? payload.seq : 0;
              } else if (Number.isInteger(payload?.seq)) {
                lastEventId = Math.max(lastEventId, payload.seq);
              } else if (pendingId !== null) {
                lastEventId = Math.max(lastEventId, pendingId);
              }
              pendingId = null;
              batcher.push(payload);
            } catch {
              // Ignore malformed frames.
            }
          }
        }
      } finally {
        // 断流/退出前冲掉尾巴；重连补发由 lastEventId 保证不丢事件
        batcher.flush();
      }
    } catch (error) {
      if (error.name !== "AbortError") {
        console.error("[MeowCode] Event stream error:", error);
      }
    }
    if (eventLoopActive) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// ---- 托盘 ----

function showMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** 独立托盘 ICO：内含 16–64 各 DPI 帧，由 scripts/make-tray-icons.mjs 从 resources/icon.png 生成。 */
function trayIconPath() {
  const root = devRepoRoot();
  return root
    ? path.join(root, "resources", "tray", "tray.ico")
    : path.join(process.resourcesPath, "icons", "tray", "tray.ico");
}

function trayImage() {
  return nativeImage.createFromPath(trayIconPath());
}

function createTray() {
  if (tray) return;
  tray = new Tray(trayImage());
  tray.setToolTip("MeowCode");
  tray.on("click", showMainWindow);
  tray.on("double-click", showMainWindow);
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示 MeowCode", click: showMainWindow },
      {
        label: "设置…",
        click: () => {
          showMainWindow();
          mainWindow?.webContents.send("meow:open-settings");
        },
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
}

// ---- 关闭方式 ----

/** 关闭确认走渲染层自绘弹窗（meow:close-request），用户选择经 meow:close-decision 回来。 */
function askCloseChoice() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("meow:close-request");
}

ipcMain.handle("meow:close-decision", (_event, choice, remember) => {
  // 用户可能在弹窗期间按了托盘菜单退出
  if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return;
  if (choice !== "tray" && choice !== "quit") return; // 取消：保持打开
  if (remember) {
    const settings = readSettings();
    settings.closeAction = choice;
    writeSettings(settings);
  }
  if (choice === "tray") {
    mainWindow.hide();
  } else {
    isQuitting = true;
    mainWindow.close();
  }
});

function createWindow() {
  const settings = readSettings();
  // 毛玻璃背板的明暗跟随应用主题（深色更深、浅色更浅）
  applyWindowTheme(settings.theme);
  const savedWindow = readWindowState();
  const restoreBounds = boundsAreVisible(savedWindow.bounds) ? savedWindow.bounds : null;
  mainWindow = new BrowserWindow({
    width: restoreBounds?.width ?? 1320,
    height: restoreBounds?.height ?? 880,
    ...(restoreBounds ? { x: restoreBounds.x, y: restoreBounds.y } : {}),
    minWidth: 960,
    minHeight: 640,
    title: "MeowCode",
    show: false,
    // ZCode 同款：禁用原生标题栏，窗口操作由渲染层自绘（见 preload 的 window* API）。
    frame: false,
    // Win11 用系统亚克力背板做毛玻璃边框；其他系统回退到跟随主题的实色底
    ...(ACRYLIC_BACKDROP ? { backgroundMaterial: "acrylic" } : {}),
    // 跟随主题，避免浅色主题下启动时先闪一下黑（亚克力模式下必须透明，否则挡住背板）
    backgroundColor: ACRYLIC_BACKDROP ? "#00000000" : windowBackground(settings.theme),
    icon: iconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 关闭开发者工具（F12 / Ctrl+Shift+I / 右键「检查」全部失效）。
      // 注意：只关 devtools，不动文字选择与图片拖拽。
      devTools: false,
      // 右侧面板的内嵌浏览器用 <webview>（每个浏览器页签一个）
      webviewTag: true,
      // 渲染层据此把 body/root 画成透明，露出系统毛玻璃
      additionalArguments: ACRYLIC_BACKDROP ? ["--meow-backdrop=acrylic"] : [],
    },
  });

  // 再兜一层：即便有代码路径尝试打开，也直接拒绝
  mainWindow.webContents.on("before-input-event", (event, input) => {
    const key = input.key?.toLowerCase();
    if (
      key === "f12" ||
      (input.control && input.shift && (key === "i" || key === "j" || key === "c")) ||
      (input.meta && input.alt && key === "i")
    ) {
      event.preventDefault();
    }
  });

  // 最大化状态变化时同步给渲染层，用于切换「最大化 / 还原」图标。
  const pushWindowState = () => {
    if (!mainWindow) return;
    mainWindow.webContents.send("meow:window-state", {
      isMaximized: mainWindow.isMaximized(),
    });
  };
  // 内嵌 webview 不允许自带 preload / Node 能力
  mainWindow.webContents.on("will-attach-webview", (_event, webPreferences) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
  });

  mainWindow.on("maximize", () => {
    pushWindowState();
    scheduleWindowStateSave(0);
  });
  mainWindow.on("unmaximize", () => {
    pushWindowState();
    scheduleWindowStateSave(0);
  });
  mainWindow.on("enter-full-screen", pushWindowState);
  mainWindow.on("leave-full-screen", pushWindowState);
  mainWindow.on("resize", () => scheduleWindowStateSave());
  mainWindow.on("move", () => scheduleWindowStateSave());
  mainWindow.once("ready-to-show", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (savedWindow.maximized) mainWindow.maximize();
    mainWindow.show();
  });

  // 系统主题切换时，跟随系统的窗口底色也跟着变
  nativeTheme.on("updated", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if ((readSettings().theme ?? "system") !== "system") return;
    // 亚克力模式下窗口底色是透明的，不能覆盖
    if (ACRYLIC_BACKDROP) return;
    mainWindow.setBackgroundColor(windowBackground("system"));
  });

  // 关闭方式：直接放行（真退出）/ 询问 / 托盘
  mainWindow.on("close", (event) => {
    flushWindowState();
    flushUiState();
    if (isQuitting) return;
    const action = readSettings().closeAction ?? "ask";
    if (!CLOSE_ACTIONS.includes(action) || action === "quit") {
      isQuitting = true;
      return;
    }
    event.preventDefault();
    if (action === "tray") {
      mainWindow.hide();
      return;
    }
    void askCloseChoice();
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
    // 关窗即释放所有终端 pty，避免 conpty 残留阻塞退出
    terminalManager?.disposeAll();
  });
}

ipcMain.handle("meow:request", async (_event, requestPath, init) => {
  const base = await waitForServerReady();
  if (typeof requestPath !== "string" || !requestPath.startsWith("/")) {
    throw new Error("Invalid agent request path.");
  }
  const requestUrl = new URL(requestPath, base);
  if (requestUrl.origin !== new URL(base).origin) {
    throw new Error("Invalid agent request origin.");
  }
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${serverToken}`);
  const response = await fetch(requestUrl, { ...init, headers, redirect: "error" });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: response.ok, status: response.status, body };
});

ipcMain.handle("meow:get-settings", () => publicSettings(ensureDefaultWorkspace()));

/** 工作区目录是否仍然存在（被用户在系统里删掉后，输入框上方要回退成「选择工作区」）。 */
ipcMain.handle("meow:workspace-exists", (_event, target) => {
  if (typeof target !== "string" || !target.trim()) return false;
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
});

// 会话图片资产的基址与 token：<img> 标签带不了 Authorization，渲染层用 query token 取图
ipcMain.handle("meow:asset-base", () =>
  serverUrl ? { serverUrl, token: serverToken } : null,
);

// ---- 渲染层布局/草稿：主进程校验后防抖原子落盘 ----
ipcMain.handle("meow:get-ui-state", () => {
  ensureDirs();
  return ensureUiState();
});

ipcMain.handle("meow:save-ui-state", (_event, patch) => {
  ensureDirs();
  mergeUiState(patch);
  scheduleUiStateSave();
  return { ok: true };
});

ipcMain.handle("meow:save-settings", async (_event, nextSettings) => {
  ensureDirs();
  const incoming = nextSettings && typeof nextSettings === "object" ? nextSettings : {};
  const previous = readSettings();
  const providers = (incoming.providers ?? []).map((provider) => {
    const existing = (previous.providers ?? []).find((item) => item.id === provider.id);
    return providerFields(provider, existing);
  });
  // 以 previous 为底：archivedSessions、项目偏好和未来新增字段都不会被这次保存丢掉
  const settings = migrateSettings({
    ...previous,
    workspace: incoming.workspace ?? previous.workspace,
    providerId:
      incoming.providerId ||
      providers.find((item) => item.id)?.id ||
      providers[0]?.id ||
      previous.providerId,
    theme: THEME_PREFERENCES.includes(incoming.theme) ? incoming.theme : previous.theme,
    closeAction: CLOSE_ACTIONS.includes(incoming.closeAction)
      ? incoming.closeAction
      : previous.closeAction,
    providers,
  });
  writeSettings(settings);
  await startServer();
  return publicSettings(settings);
});

// ---- 插件启停：只动 settings.plugins，写盘后重启 agent server 生效 ----
ipcMain.handle("meow:set-plugins-state", async (_event, payload) => {
  ensureDirs();
  const disabled = Array.isArray(payload?.disabled)
    ? payload.disabled.filter((item) => typeof item === "string" && item.trim())
    : [];
  const previous = readSettings();
  const settings = migrateSettings({
    ...previous,
    plugins: { ...(previous.plugins ?? {}), disabled },
  });
  writeSettings(settings);
  await startServer();
  return publicSettings(settings);
});

// ---- GitHub OAuth（设备流）：token 加密存 settings，注入 MCP 凭据 env ----

ipcMain.handle("meow:github-auth-status", () => {
  ensureDirs();
  return publicGithubAuth(readSettings());
});

ipcMain.handle("meow:github-device-start", async () => {
  ensureDirs();
  cleanupGithubFlows();
  let result;
  try {
    result = await startGithubDeviceFlow(GITHUB_OAUTH_CLIENT_ID);
  } catch (error) {
    return {
      ok: false,
      message: `无法连接 GitHub：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!result.ok) return { ok: false, message: result.error.message };
  const flowId = crypto.randomUUID();
  githubFlows.set(flowId, {
    deviceCode: result.flow.deviceCode,
    interval: result.flow.interval,
    expiresAt: Date.now() + result.flow.expiresIn * 1000,
  });
  return {
    ok: true,
    flow: {
      flowId,
      userCode: result.flow.userCode,
      verificationUri: result.flow.verificationUri,
      expiresIn: result.flow.expiresIn,
      interval: result.flow.interval,
    },
  };
});

ipcMain.handle("meow:github-device-poll", async (_event, flowId) => {
  ensureDirs();
  cleanupGithubFlows();
  const flow = typeof flowId === "string" ? githubFlows.get(flowId) : null;
  if (!flow) return { status: "error", message: "授权会话已过期，请重新开始。" };
  if (Date.now() > flow.expiresAt) {
    githubFlows.delete(flowId);
    return { status: "error", message: "设备码已过期，请重新开始。" };
  }
  let result;
  try {
    result = await pollGithubDeviceFlow(GITHUB_OAUTH_CLIENT_ID, flow.deviceCode);
  } catch (error) {
    return {
      status: "error",
      message: `无法连接 GitHub：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (result.status === "pending") return { status: "pending" };
  if (result.status === "slow_down") {
    flow.interval = result.interval;
    return { status: "slow_down", interval: result.interval };
  }
  githubFlows.delete(flowId);
  if (result.status === "error") {
    return { status: "error", message: result.message };
  }
  const settings = saveGithubToken(result.token);
  const applied = await updateServerGithubToken(result.token.accessToken);
  return {
    status: "success",
    auth: publicGithubAuth(settings),
    ...(applied ? {} : { warning: "已保存 GitHub 授权，但 MCP 热更新失败，重启应用后生效。" }),
  };
});

ipcMain.handle("meow:github-disconnect", async () => {
  ensureDirs();
  clearGithubRefresh();
  const previous = readSettings();
  const settings = migrateSettings({ ...previous, githubAuth: {} });
  writeSettings(settings);
  const applied = await updateServerGithubToken(null);
  return {
    auth: publicGithubAuth(settings),
    ...(applied ? {} : { warning: "已清除本机授权，但 MCP 热更新失败，重启应用后彻底断开。" }),
  };
});

// ---- Gitee / GitCode 手工 Token：校验后加密存 settings，并热更新 MCP ----

ipcMain.handle("meow:set-mcp-credentials", async (_event, payload) => {
  ensureDirs();
  const env = payload?.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return { ok: false, message: "参数错误。" };
  }
  const updates = [];
  for (const name of MANUAL_MCP_TOKEN_ENVS) {
    const value = env[name];
    if (typeof value !== "string" || !value.trim()) continue;
    updates.push([name, value.trim()]);
  }
  if (!updates.length) return { ok: false, message: "请填写 Token。" };
  for (const [name, value] of updates) {
    const check = await validateManualMcpToken(name, value);
    if (!check.ok) return check;
  }
  const previous = readSettings();
  const nextCredentials = { ...(previous.mcpCredentials ?? {}) };
  for (const [name, value] of updates) nextCredentials[name] = encryptApiKey(value);
  const settings = migrateSettings({ ...previous, mcpCredentials: nextCredentials });
  writeSettings(settings);
  const applied = await updateServerMcpCredentials(Object.fromEntries(updates));
  return {
    ok: true,
    ...(applied ? {} : { warning: "已保存，但 MCP 热更新失败，重启应用后生效。" }),
  };
});

// ---- Gitee / GitCode OAuth 连接状态与浏览器授权 ----

ipcMain.handle("meow:oauth-status", () => {
  ensureDirs();
  return publicOauthStatus(readSettings());
});

ipcMain.handle("meow:oauth-save-app", async (_event, payload) => {
  ensureDirs();
  const platform = String(payload?.platform ?? "");
  const config = OAUTH_PLATFORMS[platform];
  if (!config) return { ok: false, message: "未知平台。" };
  const clientId = typeof payload.clientId === "string" ? payload.clientId.trim() : "";
  const clientSecret = typeof payload.clientSecret === "string" ? payload.clientSecret.trim() : "";
  // Client ID 可留空：回落到内置官方应用；Secret 两个平台都强制校验，必须填
  const effectiveClientId = clientId || config.defaultClientId || "";
  if (!effectiveClientId) return { ok: false, message: "缺少 Client ID。" };
  if (!clientSecret) return { ok: false, message: `请填写 ${config.label} 的 Client Secret。` };
  // 落盘前先自检：平台不认这对其 ID/Secret 时就别存，
  // 否则错误会推迟到换 token 时才爆成一句无信息的 401。
  try {
    const probe = await verifyOauthPlatformCredentials(config, {
      clientId: effectiveClientId,
      clientSecret,
      redirectUri: localOauthCallbackUri(platform),
    });
    if (probe.verdict === "mismatch") {
      return { ok: false, message: probe.message };
    }
  } catch (error) {
    // 网络不通等自检失败不阻塞保存：真正的交换阶段会再报一次
    console.warn(
      `[MeowCode] OAuth credential probe failed for ${platform}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
  const previous = readSettings();
  const apps = { ...(previous.oauthApps ?? {}) };
  apps[platform] = { clientId, clientSecretEncrypted: encryptApiKey(clientSecret) };
  const settings = migrateSettings({ ...previous, oauthApps: apps });
  writeSettings(settings);
  return { ok: true, status: publicOauthStatus(settings) };
});

ipcMain.handle("meow:oauth-verify-app", async (_event, payload) => {
  ensureDirs();
  const platform = String(payload?.platform ?? "");
  const config = OAUTH_PLATFORMS[platform];
  if (!config) return { ok: false, verdict: "unknown", message: "未知平台。" };
  const settings = readSettings();
  // 允许带未保存的临时凭据来试（用户可能正在对话框里改 Client ID）
  const overrideId = typeof payload?.clientId === "string" ? payload.clientId.trim() : "";
  const overrideSecret = typeof payload?.clientSecret === "string" ? payload.clientSecret.trim() : "";
  const stored = resolveOauthApp(settings, platform);
  const clientId = overrideId || stored.clientId;
  const clientSecret = overrideSecret || stored.clientSecret;
  if (!clientId || !clientSecret) {
    return { ok: false, verdict: "incomplete", message: "Client ID 或 Client Secret 为空。" };
  }
  try {
    return await verifyOauthPlatformCredentials(config, {
      clientId,
      clientSecret,
      redirectUri: localOauthCallbackUri(platform),
    });
  } catch (error) {
    return {
      ok: false,
      verdict: "unknown",
      message: error instanceof Error ? error.message : String(error),
    };
  }
});

/**
 * 挑一对平台真的认的凭据：设置页 → 本机 oauth-apps.json → 环境变量，逐个探针验证。
 * 设置里存的那对可能已经失效（手输错、换了应用），而本机文件里往往还有可用的一对；
 * 不做这一步，用户只能看到一句无信息的 401。
 */
async function pickWorkingCredentials(settings, platform) {
  const config = OAUTH_PLATFORMS[platform];
  const candidates = [];
  const stored = resolveOauthApp(settings, platform);
  if (stored.clientId && stored.clientSecret) {
    candidates.push({ clientId: stored.clientId, clientSecret: stored.clientSecret, source: stored.source });
  }
  const local = localOauthCredential(platform);
  if (local.clientSecret) {
    const localId = resolveOauthClientId(config, { clientId: local.clientId });
    if (!candidates.some((item) => item.clientSecret === local.clientSecret && item.clientId === localId)) {
      candidates.push({ clientId: localId, clientSecret: local.clientSecret, source: local.source || "file" });
    }
  }
  if (!candidates.length) return { clientId: "", clientSecret: "" };
  for (const candidate of candidates) {
    try {
      const probe = await verifyOauthPlatformCredentials(config, {
        clientId: candidate.clientId,
        clientSecret: candidate.clientSecret,
        redirectUri: localOauthCallbackUri(platform),
      });
      if (probe.ok) return candidate;
    } catch {
      // 探针失败（网络等）：继续试下一对
    }
  }
  // 全部没验过：仍用第一对，让真正的交换阶段给出平台原始报错
  return candidates[0];
}

ipcMain.handle("meow:oauth-connect-start", async (_event, payload) => {
  ensureDirs();
  const platform = String(payload?.platform ?? "");
  const config = OAUTH_PLATFORMS[platform];
  if (!config) return { ok: false, message: "未知平台。" };
  const settings = readSettings();
  const { clientId, clientSecret } = await pickWorkingCredentials(settings, platform);
  if (!clientId) return { ok: false, message: "缺少 Client ID，无法发起授权。" };
  if (!clientSecret) {
    return {
      ok: false,
      message: `${config.label} 换 token 需要 Client Secret，请先填写一次。`,
      needsClientSecret: true,
    };
  }
  const old = platformOauthFlows.get(platform);
  if (old?.timer) clearTimeout(old.timer);
  platformOauthFlows.delete(platform);
  try {
    await ensureOauthCallbackServer();
  } catch (error) {
    return {
      ok: false,
      message: `本地回调端口 ${OAUTH_CALLBACK_PORT} 被占用，请关闭占用它的应用后重试。`,
    };
  }
  const state = crypto.randomBytes(24).toString("base64url");
  const timer = setTimeout(() => {
    const flow = platformOauthFlows.get(platform);
    if (flow?.status === "pending") {
      flow.status = "error";
      flow.error = "授权超时，请重新开始。";
      closeOauthCallbackServerIfIdle();
    }
  }, OAUTH_CONNECT_TIMEOUT_MS);
  timer.unref?.();
  // 凭据对随 flow 记下：换 token 必须用「发起授权时那一对」，
  // 中途重新解析可能换成另一对（设置 vs 本机文件），平台会判 invalid_client。
  platformOauthFlows.set(platform, { state, status: "pending", timer, clientId, clientSecret });
  return {
    ok: true,
    authorizeUrl: buildOauthAuthorizeUrl(config, {
      clientId,
      redirectUri: localOauthCallbackUri(platform),
      state,
    }),
  };
});

ipcMain.handle("meow:oauth-connect-poll", async (_event, payload) => {
  const platform = String(payload?.platform ?? "");
  const flow = platformOauthFlows.get(platform);
  if (!flow) return { status: "error", message: "授权会话已结束，请重新开始。" };
  if (flow.status === "pending") return { status: "pending" };
  platformOauthFlows.delete(platform);
  closeOauthCallbackServerIfIdle();
  if (flow.status === "error") return { status: "error", message: flow.error ?? "授权失败。" };
  return { status: "success" };
});

ipcMain.handle("meow:oauth-connect-cancel", (_event, payload) => {
  const platform = String(payload?.platform ?? "");
  const flow = platformOauthFlows.get(platform);
  if (flow?.timer) clearTimeout(flow.timer);
  platformOauthFlows.delete(platform);
  closeOauthCallbackServerIfIdle();
  return { ok: true };
});

ipcMain.handle("meow:oauth-disconnect", async (_event, payload) => {
  ensureDirs();
  const platform = String(payload?.platform ?? "");
  const config = OAUTH_PLATFORMS[platform];
  if (!config) return { ok: false, message: "未知平台。" };
  const flow = platformOauthFlows.get(platform);
  if (flow?.timer) clearTimeout(flow.timer);
  platformOauthFlows.delete(platform);
  closeOauthCallbackServerIfIdle();
  clearOauthRefreshTimer(platform);
  const previous = readSettings();
  const accounts = { ...(previous.oauthAccounts ?? {}) };
  delete accounts[platform];
  const settings = migrateSettings({ ...previous, oauthAccounts: accounts });
  writeSettings(settings);
  const fallbackEncrypted = settings.mcpCredentials?.[config.tokenEnv];
  const fallback = fallbackEncrypted ? decryptApiKey(fallbackEncrypted).trim() : "";
  const applied = await updateServerMcpCredentials({ [config.tokenEnv]: fallback || null });
  return {
    warning: applied ? undefined : "已清除本机授权，但 MCP 热更新失败，重启应用后彻底断开。",
  };
});

ipcMain.handle("meow:pick-workspace", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
    title: "选择 MeowCode 工作区",
  });
  return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
});

// ---- 自绘标题栏的窗口操作（frame: false 后由渲染层调用）----
ipcMain.handle("meow:window-minimize", () => {
  mainWindow?.minimize();
});

ipcMain.handle("meow:window-toggle-maximize", () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});

ipcMain.handle("meow:window-close", () => {
  mainWindow?.close();
});

ipcMain.handle("meow:window-state", () => ({
  isMaximized: mainWindow?.isMaximized() ?? false,
}));

/** 在资源管理器中打开项目目录（项目行菜单）。返回错误信息或 null。 */
ipcMain.handle("meow:open-path", async (_event, target) => {
  if (typeof target !== "string" || !target.trim()) return "invalid path";
  const message = await shell.openPath(target);
  return message || null;
});

/** 用系统默认浏览器打开链接（聊天里的外链、内嵌浏览器的新窗口请求） */
ipcMain.handle("meow:open-external", async (_event, url) => {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return "invalid url";
  await shell.openExternal(url);
  return null;
});

/** agent 浏览器页签的 webview 就绪后，渲染器回报 tabId ↔ webContentsId 绑定 */
ipcMain.handle("meow:browser-bind-tab", (_event, payload) => browserHost.bindTab(payload || {}));

// 内嵌浏览器（webview guest）的导航约束：http/https 放行，其余拦截；
// 页面里 window.open / target=_blank 交系统浏览器，不开新的 Electron 窗口。
app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "webview") return;
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (!/^https?:\/\//i.test(url)) event.preventDefault();
  });
});

/** 终端 PTY 管理器（右侧面板终端页签）；退出前全量释放，防止 conpty 残留阻塞退出 */
const terminalManager = registerTerminalIpc(ipcMain, () => mainWindow);
app.on("before-quit", () => {
  terminalManager.disposeAll();
  clearGithubRefresh();
  githubFlows.clear();
  for (const timer of platformOauthRefreshTimers.values()) clearTimeout(timer);
  platformOauthRefreshTimers.clear();
  for (const flow of platformOauthFlows.values()) if (flow.timer) clearTimeout(flow.timer);
  platformOauthFlows.clear();
  if (platformOauthServer) {
    const server = platformOauthServer;
    platformOauthServer = null;
    server.close(() => undefined);
  }
});

/**
 * 只更新 provider 的偏好（思考强度 / 激活模型）并落盘，**不重启 agent server**。
 * 激活模型已通过 PUT /session/model 作用到运行中的 runtime，这里只是让下次启动能记住。
 * 走 meow:save-settings 会触发 startServer()，切换一次模型就重启一次服务，
 * 会丢掉运行中的会话状态、还可能和前端竞态新建空会话 —— 换模型绝不走那条路。
 */
ipcMain.handle("meow:save-provider-prefs", (_event, prefs) => {
  ensureDirs();
  const settings = readSettings();
  const patches = prefs?.providers ?? [];
  const providers = (settings.providers ?? []).map((provider) => {
    const patch = patches.find((item) => item.id === provider.id);
    if (!patch) return provider;
    return { ...provider, reasoningEffort: patch.reasoningEffort || undefined };
  });
  const next = { ...settings, providers };
  if (typeof prefs?.providerId === "string" && prefs.providerId) {
    next.providerId = prefs.providerId;
  }
  writeSettings(next);
  return publicSettings(next);
});

// ---- 轻量偏好：主题 / 关闭方式（只写盘，绝不重启 agent server）----

ipcMain.handle("meow:get-preferences", () => {
  const settings = readSettings();
  return {
    theme: THEME_PREFERENCES.includes(settings.theme) ? settings.theme : "system",
    closeAction: CLOSE_ACTIONS.includes(settings.closeAction) ? settings.closeAction : "ask",
    language: LANGUAGE_PREFERENCES.includes(settings.language) ? settings.language : "system",
    onboardingCompleted:
      typeof settings.onboardingCompleted === "boolean" ? settings.onboardingCompleted : true,
    archivedSessions: Array.isArray(settings.archivedSessions) ? settings.archivedSessions : [],
    projectNames: settings.projectNames && typeof settings.projectNames === "object" ? settings.projectNames : {},
    pinnedProjects: Array.isArray(settings.pinnedProjects) ? settings.pinnedProjects : [],
    removedProjects: Array.isArray(settings.removedProjects) ? settings.removedProjects : [],
  };
});

ipcMain.handle("meow:save-preferences", (_event, prefs) => {
  ensureDirs();
  const settings = readSettings();
  const next = { ...settings };
  if (prefs?.theme !== undefined && THEME_PREFERENCES.includes(prefs.theme)) {
    next.theme = prefs.theme;
  }
  if (prefs?.closeAction !== undefined && CLOSE_ACTIONS.includes(prefs.closeAction)) {
    next.closeAction = prefs.closeAction;
  }
  if (prefs?.language !== undefined && LANGUAGE_PREFERENCES.includes(prefs.language)) {
    next.language = prefs.language;
  }
  if (typeof prefs?.onboardingCompleted === "boolean") {
    next.onboardingCompleted = prefs.onboardingCompleted;
  }
  if (Array.isArray(prefs?.archivedSessions)) {
    next.archivedSessions = prefs.archivedSessions.filter((item) => typeof item === "string");
  }
  // 侧栏项目偏好：显示名映射 / 置顶顺序 / 移除列表
  if (prefs?.projectNames && typeof prefs.projectNames === "object" && !Array.isArray(prefs.projectNames)) {
    next.projectNames = Object.fromEntries(
      Object.entries(prefs.projectNames).filter(
        ([key, value]) => key.trim() && typeof value === "string" && value.trim(),
      ),
    );
  }
  if (Array.isArray(prefs?.pinnedProjects)) {
    next.pinnedProjects = prefs.pinnedProjects.filter((item) => typeof item === "string");
  }
  if (Array.isArray(prefs?.removedProjects)) {
    next.removedProjects = prefs.removedProjects.filter((item) => typeof item === "string");
  }
  // 读-改-写：保留 providers 里的 apiKeyEncrypted
  writeSettings(next);
  if (prefs?.theme !== undefined) {
    applyWindowTheme(next.theme);
    if (mainWindow && !mainWindow.isDestroyed() && !ACRYLIC_BACKDROP) {
      mainWindow.setBackgroundColor(windowBackground(next.theme));
    }
  }
  return {
    theme: next.theme,
    closeAction: next.closeAction,
    language: LANGUAGE_PREFERENCES.includes(next.language) ? next.language : "system",
    onboardingCompleted:
      typeof next.onboardingCompleted === "boolean" ? next.onboardingCompleted : true,
    archivedSessions: Array.isArray(next.archivedSessions) ? next.archivedSessions : [],
    projectNames: next.projectNames ?? {},
    pinnedProjects: Array.isArray(next.pinnedProjects) ? next.pinnedProjects : [],
    removedProjects: Array.isArray(next.removedProjects) ? next.removedProjects : [],
  };
});

ipcMain.handle("meow:get-app-info", () => ({
  name: "MeowCode",
  version: app.getVersion(),
  electron: process.versions.electron ?? "",
  chrome: process.versions.chrome ?? "",
  node: process.versions.node ?? "",
  platform: `${process.platform} ${process.arch}`,
}));

ipcMain.handle("meow:model-profiles", () => modelProfiles);

// 单实例：两个进程共享 settings.json 和会话 JSONL 会互相覆盖
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    ensureDirs();
    ensureDefaultWorkspace();
    reportStartupStatistics();
    // 内嵌浏览器默认拒绝摄像头/麦克风/定位/剪贴板/通知等权限请求
    for (const partition of ["persist:meow-browser", "persist:meow-browser-agent"]) {
      const browserSession = session.fromPartition(partition);
      browserSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      browserSession.setPermissionCheckHandler(() => false);
    }
    createWindow();
    createTray();
    // 先读本机缓存，过期再后台拉取；拉取完成后会把新规则推给渲染层
    fetchModelProfiles();
    setInterval(fetchModelProfiles, MODEL_PROFILES_TTL).unref();
    try {
      await browserHost.start();
    } catch (error) {
      // 桥起不来不阻塞应用启动：agent 侧浏览器工具会自动降级为不可用
      console.error("[MeowCode] Failed to start browser host:", error);
    }
    try {
      await startServer();
    } catch (error) {
      console.error("[MeowCode] Failed to start agent server:", error);
      if (mainWindow) {
        mainWindow.webContents.send("meow:event", {
          type: "error",
          sessionId: "",
          message: error.message,
        });
      }
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  // 「缩小到托盘」时窗口是 hide() 不是 close()，不会走到这里；
  // 只有全部窗口真的关闭（直接关闭 / 真退出）才会 quit。
  if (process.platform !== "darwin") app.quit();
});

let quitAfterShutdown = false;
let appShutdownInFlight = false;
app.on("before-quit", (event) => {
  flushWindowState();
  flushUiState();
  if (quitAfterShutdown) return;
  if (appShutdownInFlight) {
    event.preventDefault();
    return;
  }
  if (serverProcess) {
    // 先让 agent server 走 IPC 优雅关停（写 turn_end / flush 会话文件），再真正退出
    event.preventDefault();
    appShutdownInFlight = true;
    isQuitting = true;
    browserHost.stop();
    void stopServer().finally(() => {
      quitAfterShutdown = true;
      app.quit();
    });
    return;
  }
  isQuitting = true;
  browserHost.stop();
});
