const {
  app,
  BrowserWindow,
  Menu,
  Notification,
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
const { createMailHost } = require("./mail-host.cjs");
const { createJobHost } = require("./job-host.cjs");
const { createBrowserHostController } = require("./browser-host.cjs");
const { createComputerHostController } = require("./computer-host.cjs");
const { createNoticeController } = require("./notice.cjs");
const { mainStrings } = require("./main-i18n.cjs");
// 拖动窗口的位置计算（钉死尺寸，见文件头注释）
const { dragBounds } = require("./window-drag.cjs");
const {
  normalizeTraySessions,
  traySessionLabel,
  splitTraySessions,
} = require("./tray-sessions.cjs");
const {
  TURN_DEDUPE_MS,
  createDedupe,
  describeApproval,
  describeAsk,
  describeTurn,
  notificationTitle,
  shouldNotify,
} = require("./notifications.cjs");
const { readJsonWithBackup, writeJsonAtomic } = require("./persist.cjs");
const { createScheduler } = require("./scheduler.cjs");
const {
  validateManualMcpToken,
  credentialGroupOf,
  credentialCheckName,
} = require("./mcp-token-checks.cjs");
const {
  defaultDataDir,
  locationPointerPath,
  migrateData,
  readDataLocation,
  validateDataTarget,
} = require("./data-location.cjs");
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
const { registerCommunitySubmitIpc } = require("./community-submit.cjs");
const { fork, execFile, execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

// 悬浮岛是透明置顶小窗：Windows 下 Chromium 的遮挡计算会把它误判为被遮挡而挂起渲染
// （NexBox 灵动岛踩过同一坑）。必须在 app ready 前设置，对所有窗口生效。
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

/** 本地 agent server 的进程内鉴权 token：每次应用启动生成一次，server 重启保持不变。 */
const serverToken = crypto.randomBytes(32).toString("base64url");

/** GitHub OAuth access token 注入到这个环境变量；mcp.json 只保留 ${...} 占位模板。 */
const GITHUB_TOKEN_ENV = "MEOWCODE_GITHUB_TOKEN";
/** 手工令牌（Gitee/GitCode PAT、Figma/瑞幸访问令牌、飞书 App ID/Secret）：加密存 settings.mcpCredentials，启动/更新时注入进程 env。 */
const MANUAL_MCP_TOKEN_ENVS = [
  "MEOWCODE_GITEE_TOKEN",
  "MEOWCODE_GITCODE_TOKEN",
  "MEOWCODE_FIGMA_TOKEN",
  "LUCKIN_MCP_TOKEN",
  "MEOWCODE_LARK_APP_ID",
  "MEOWCODE_LARK_APP_SECRET",
];
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
  // 公共客户端（PKCE、无 secret）：Undermind 等 CIMD-only 平台，client_id 用内置/自定义 ID 即可
  if (config.publicClient) {
    const storedApp = settings.oauthApps?.[platform] ?? {};
    const customClientId = typeof storedApp.clientId === "string" ? storedApp.clientId.trim() : "";
    return {
      clientId: customClientId || config.defaultClientId || "",
      clientSecret: "",
      source: customClientId ? "settings" : "builtin",
    };
  }
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
const APP_DATA_DIR = app.getPath("appData");
const DEFAULT_DATA_DIR = defaultDataDir(APP_DATA_DIR);
// 默认 %APPDATA%/MeowCode；用户改过数据位置时读取外部指针，启动前切换 userData。
app.setPath("userData", readDataLocation(APP_DATA_DIR));
if (process.platform === "win32") {
  // 打包后与 electron-builder 的 appId 一致，任务栏/通知按 MeowCode 归组。
  // dev 下 exe 是改名后的 MeowCode.exe，没有对应开始菜单快捷方式，用 appId 会因为没有
  // 归属而静默不弹 toast —— 退回 exe 自身路径，通知才显示得出来。
  app.setAppUserModelId(devRepoRoot() ? process.execPath : "app.meowcode.desktop");
}

/** 关闭窗口时的行为：每次询问 / 缩小到托盘 / 直接关闭 */
const CLOSE_ACTIONS = ["ask", "tray", "quit"];
/** 用户可见回复的语色：普通 / 永雏塔菲 / 大嘴 */
const SPEECH_STYLES = ["normal", "tafei", "dazui"];
/** 输入框上方信息胶囊的收起时机：提交后（跟随工作区未提交状态）/ 对话结束后 */
const PROGRESS_PILL_DISMISS = ["commit", "turn-end"];
const PROXY_MODES = ["direct", "system", "manual"];

/**
 * 读系统代理（Windows「Internet 选项 / 设置 → 网络和 Internet → 代理」那个）。
 * 只解析最常见的 ProxyServer 形态：`host:port` 或 `http=...;https=...`。
 * 读不到就返回空串 —— agent 侧会退到 HTTPS_PROXY/HTTP_PROXY 兜底，
 * 再不行就是直连，不会因为读注册表失败把网络卡死。
 */
function resolveSystemProxy() {
  if (process.platform !== "win32") {
    return process.env.HTTPS_PROXY || process.env.https_proxy || "";
  }
  try {
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    const out = execFileSync("reg", ["query", key], { encoding: "utf8", timeout: 3000 });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(out)) return "";
    const server = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(out)?.[1]?.trim();
    if (!server) return "";
    if (!server.includes("=")) return server;
    const byScheme = {};
    for (const item of server.split(";")) {
      const index = item.indexOf("=");
      if (index <= 0) continue;
      byScheme[item.slice(0, index).trim().toLowerCase()] = item.slice(index + 1).trim();
    }
    return byScheme.https || byScheme.http || "";
  } catch {
    return "";
  }
}
/** 主题偏好：跟随系统 / 浅色 / 深色 */
const THEME_PREFERENCES = ["system", "light", "dark"];
/** 配色方案：必须与 desktop/src/api.ts 的 ThemePalette / theme.tsx 的 PALETTE_VALUES 一致 */
const PALETTES = ["classic", "lava", "bee", "mint", "parchment", "harmony"];
/** 界面语言：跟随系统 + 11 个语种，必须与 desktop/src/i18n/languages.ts 的清单一致 */
const LANGUAGE_PREFERENCES = [
  "system",
  "zh-CN",
  "zh-TW",
  "en",
  "ja",
  "ko",
  "ru",
  "de",
  "fr",
  "es",
  "hi",
  "pt",
];

/** 配色 + 明暗 → 窗口底色，必须与 theme/palettes.css 的 --bg-root 一致（classic 在 tokens.css） */
const PALETTE_BACKGROUND = {
  classic: { dark: "#0a0a0a", light: "#e6e6e6" },
  lava: { dark: "#0f0a08", light: "#f8efe9" },
  bee: { dark: "#0d0c06", light: "#faf5e4" },
  mint: { dark: "#08100d", light: "#ecf6f1" },
  parchment: { dark: "#0e0b07", light: "#f4ecdb" },
  harmony: { dark: "#070b13", light: "#ebf1fa" },
};

/**
 * Windows 11（build ≥ 22000）启用系统亚克力背板：
 * 窗口边框 / 标题栏 / 面板间隙透出桌面虚化（毛玻璃），面板自身不透明。
 * 页面通过 --meow-backdrop 参数得知要不要把 body/root 画成透明。
 */
const ACRYLIC_BACKDROP =
  process.platform === "win32" && Number(os.release().split(".")[2] ?? 0) >= 22000;

let mainWindow = null;
/** AI 悬浮岛窗口：屏幕顶部居中的透明置顶胶囊，显示所有运行中会话的状态 */
let islandWindow = null;
/** 悬浮岛窗口尺寸：需容纳展开态迷你聊天窗 ~460×640 + 边距 */
const ISLAND_WINDOW_WIDTH = 480;
const ISLAND_WINDOW_HEIGHT = 680;
/** 内嵌浏览器的 agent 控制桥：随窗口起停，agent server 通过 env 拿到地址与 token */
const browserHost = createBrowserHostController({ getMainWindow: () => mainWindow });
/** 电脑控制桥（computer_* 工具）：截图走 desktopCapturer，输入走常驻 PowerShell 助手 */
const computerHost = createComputerHostController();
/** 公告控制器：拉取 NexBox 数据仓的 notice_meowcode.json（见 notice.cjs） */
let noticeController = null;
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

/**
 * 命令沙箱设置：只存一组稳定字段；非法值一律回落默认（默认关闭）。
 * 与 server 的 normalizeSandboxSettings 保持同一形状。
 */
function normalizeSandbox(raw) {
  const parsed = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const seen = new Set();
  const writableRoots = [];
  for (const item of Array.isArray(parsed.writableRoots) ? parsed.writableRoots : []) {
    if (typeof item !== "string") continue;
    const value = item.trim();
    if (!value) continue;
    const key = process.platform === "win32" ? value.toLowerCase() : value;
    if (seen.has(key)) continue;
    seen.add(key);
    writableRoots.push(value);
  }
  const grantTimeoutMs =
    typeof parsed.grantTimeoutMs === "number" && Number.isFinite(parsed.grantTimeoutMs)
      ? Math.min(600_000, Math.max(10_000, Math.round(parsed.grantTimeoutMs)))
      : 120_000;
  return {
    enabled: parsed.enabled === true,
    mode: "workspace-write",
    writableRoots,
    allowTemp: parsed.allowTemp !== false,
    grantTimeoutMs,
    confirmDelete: parsed.confirmDelete === true,
  };
}

function defaultSettings() {
  return {
    schemaVersion: 2,
    providers: [],
    theme: "system",
    // 配色方案：classic = 中性观感（默认，与加配色之前一致）
    palette: "classic",
    closeAction: "ask",
    language: "system",
    speechStyle: "normal",
    // 信息胶囊：默认「提交后消失」，与引入这个设置之前的行为一致
    progressPillDismiss: "commit",
    // 记忆总开关：开 = 自动蒸馏 + 注入记忆索引 + 下发记忆工具；关 = 全部停用（记忆文件仍保留）
    memoryEnabled: true,
    // 自我学习（技能 / 项目经验 / 用户模型）：实验性能力，默认关闭，设置页可开
    selfLearning: false,
    // 供应商故障转移：默认关闭，开启后超时/限流/5xx 时本回合自动切备用服务商
    providerFallback: false,
    // 命令沙箱（Windows 受限令牌 + ACL）：默认关闭，设置页显式开启
    sandbox: normalizeSandbox(),
    // 网络代理：direct = 直连（默认，与加代理之前行为一致）
    proxyMode: "direct",
    proxyUrl: "",
    onboardingCompleted: false,
    archivedSessions: [],
    projectNames: {},
    pinnedProjects: [],
    removedProjects: [],
    // 邮件「AI 写」使用的模型 id；空串 = 跟随聊天模型
    mailAiProviderId: "",
    githubAuth: {},
    mcpCredentials: {},
    oauthApps: {},
    oauthAccounts: {},
    hooks: {
      runMode: "auto",
      includeWorkspace: false,
    },
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
    palette: PALETTES.includes(parsed.palette) ? parsed.palette : "classic",
    speechStyle: SPEECH_STYLES.includes(parsed.speechStyle) ? parsed.speechStyle : "normal",
    // 信息胶囊收起时机：缺字段的老用户补「提交后消失」（保持原行为）
    progressPillDismiss: PROGRESS_PILL_DISMISS.includes(parsed.progressPillDismiss)
      ? parsed.progressPillDismiss
      : "commit",
    // 全新安装走 defaultSettings() 回退（显式 false）；已有 settings.json 缺字段的老用户补 true
    onboardingCompleted:
      typeof parsed.onboardingCompleted === "boolean" ? parsed.onboardingCompleted : true,
    // 记忆总开关：缺字段的老用户补 true；早期版本只有 memoryExtraction（只关蒸馏），
    // 沿用它的值——用户当时关掉过，就当作现在关掉整个记忆
    memoryEnabled:
      typeof parsed.memoryEnabled === "boolean"
        ? parsed.memoryEnabled
        : typeof parsed.memoryExtraction === "boolean"
          ? parsed.memoryExtraction
          : true,
    // 自我学习：缺字段的老用户补 false（实验性，默认关闭）
    selfLearning: typeof parsed.selfLearning === "boolean" ? parsed.selfLearning : false,
    // 供应商故障转移：缺字段的老用户补 false（新功能，默认关闭）
    providerFallback: parsed.providerFallback === true,
    // 网络代理：缺字段的老用户补直连（保持原有网络行为）
    proxyMode: PROXY_MODES.includes(parsed.proxyMode) ? parsed.proxyMode : "direct",
    proxyUrl: typeof parsed.proxyUrl === "string" ? parsed.proxyUrl : "",
    archivedSessions: Array.isArray(parsed.archivedSessions) ? parsed.archivedSessions : [],
    projectNames:
      parsed.projectNames && typeof parsed.projectNames === "object" && !Array.isArray(parsed.projectNames)
        ? parsed.projectNames
        : {},
    pinnedProjects: Array.isArray(parsed.pinnedProjects) ? parsed.pinnedProjects : [],
    removedProjects: Array.isArray(parsed.removedProjects) ? parsed.removedProjects : [],
    mailAiProviderId:
      typeof parsed.mailAiProviderId === "string" ? parsed.mailAiProviderId.trim() : "",
    // 界面字体：空串 = 默认 MiSans；customFonts = 导入的自定义字体文件
    fontFamily: typeof parsed.fontFamily === "string" ? parsed.fontFamily : "",
    // 代码字体：空串 = 默认等宽栈
    codeFontFamily: typeof parsed.codeFontFamily === "string" ? parsed.codeFontFamily : "",
    customFonts: Array.isArray(parsed.customFonts)
      ? parsed.customFonts.filter((item) => item && typeof item.fileName === "string")
      : [],
    githubAuth: normalizeGithubAuth(parsed.githubAuth),
    mcpCredentials: normalizeMcpCredentials(parsed.mcpCredentials),
    oauthApps: normalizeOauthApps(parsed.oauthApps),
    oauthAccounts: normalizeOauthAccounts(parsed.oauthAccounts),
    hooks: {
      runMode: parsed.hooks?.runMode === "ask" ? "ask" : "auto",
      includeWorkspace: parsed.hooks?.includeWorkspace === true,
    },
    sandbox: normalizeSandbox(parsed.sandbox),
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
    authStyle: "authStyle" in provider ? provider.authStyle : existing?.authStyle,
    extraHeaders: "extraHeaders" in provider ? provider.extraHeaders : existing?.extraHeaders,
    extraBody: "extraBody" in provider ? provider.extraBody : existing?.extraBody,
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
      configured: config.publicClient
        ? Boolean(resolved.clientId)
        : Boolean(resolved.clientId && resolved.clientSecret),
      connected: Boolean(oauthStoredToken(settings, platform)),
      clientId: resolved.clientId,
      redirectUri: localOauthCallbackUri(platform),
      builtinClientId: Boolean(config.defaultClientId) && !app.clientId,
      needsClientSecret: !config.publicClient && Boolean(resolved.clientId) && !resolved.clientSecret,
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
    palette: PALETTES.includes(settings.palette) ? settings.palette : "classic",
    closeAction: settings.closeAction ?? "ask",
    language: LANGUAGE_PREFERENCES.includes(settings.language) ? settings.language : "system",
    speechStyle: SPEECH_STYLES.includes(settings.speechStyle) ? settings.speechStyle : "normal",
    /** 输入框上方信息胶囊的收起时机 */
    progressPillDismiss: PROGRESS_PILL_DISMISS.includes(settings.progressPillDismiss)
      ? settings.progressPillDismiss
      : "commit",
    onboardingCompleted: typeof settings.onboardingCompleted === "boolean" ? settings.onboardingCompleted : true,
    /** 记忆总开关：默认开（关掉后不蒸馏、不注入、不下发记忆工具） */
    memoryEnabled:
      typeof settings.memoryEnabled === "boolean"
        ? settings.memoryEnabled
        : typeof settings.memoryExtraction === "boolean"
          ? settings.memoryExtraction
          : true,
    /** 自我学习：实验性，默认关 */
    selfLearning: typeof settings.selfLearning === "boolean" ? settings.selfLearning : false,
    /** 供应商故障转移：默认关（开 = 临时故障时本回合切备用服务商） */
    providerFallback: settings.providerFallback === true,
    /** 网络代理：direct / system / manual */
    proxyMode: PROXY_MODES.includes(settings.proxyMode) ? settings.proxyMode : "direct",
    proxyUrl: typeof settings.proxyUrl === "string" ? settings.proxyUrl : "",
    archivedSessions: Array.isArray(settings.archivedSessions) ? settings.archivedSessions : [],
    /** 项目（工作区）自定义显示名：cwd → name */
    projectNames: settings.projectNames && typeof settings.projectNames === "object" ? settings.projectNames : {},
    /** 置顶的项目 cwd 列表（顺序即置顶顺序） */
    pinnedProjects: Array.isArray(settings.pinnedProjects) ? settings.pinnedProjects : [],
    /** 已移除（侧栏隐藏）的项目 cwd 列表 */
    removedProjects: Array.isArray(settings.removedProjects) ? settings.removedProjects : [],
    silentUpdate: typeof settings.silentUpdate === "boolean" ? settings.silentUpdate : true,
    notifications: typeof settings.notifications === "boolean" ? settings.notifications : true,
    announcements: typeof settings.announcements === "boolean" ? settings.announcements : true,
    floatingIsland: typeof settings.floatingIsland === "boolean" ? settings.floatingIsland : false,
    nextPromptSuggestions:
      typeof settings.nextPromptSuggestions === "boolean" ? settings.nextPromptSuggestions : false,
    mailAiProviderId:
      typeof settings.mailAiProviderId === "string" ? settings.mailAiProviderId : "",
    worktreeFetchUpstream:
      typeof settings.worktreeFetchUpstream === "boolean" ? settings.worktreeFetchUpstream : false,
    worktreeAutoCleanup:
      typeof settings.worktreeAutoCleanup === "boolean" ? settings.worktreeAutoCleanup : true,
    worktreeMaxKeep:
      typeof settings.worktreeMaxKeep === "number" ? settings.worktreeMaxKeep : 15,
    includeAgentsMd: typeof settings.includeAgentsMd === "boolean" ? settings.includeAgentsMd : true,
    includeClaudeMd: typeof settings.includeClaudeMd === "boolean" ? settings.includeClaudeMd : true,
    hooks: {
      runMode: settings.hooks?.runMode === "ask" ? "ask" : "auto",
      includeWorkspace: settings.hooks?.includeWorkspace === true,
    },
    sandbox: normalizeSandbox(settings.sandbox),
    fontFamily: typeof settings.fontFamily === "string" ? settings.fontFamily : "",
    codeFontFamily: typeof settings.codeFontFamily === "string" ? settings.codeFontFamily : "",
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
      authStyle: provider.authStyle,
      extraHeaders: provider.extraHeaders,
      extraBody: provider.extraBody,
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
  return path.join(process.resourcesPath, "agent-server", "dist", "server", "server.js");
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

function windowBackground(preference, palette) {
  const table = PALETTE_BACKGROUND[palette] ?? PALETTE_BACKGROUND.classic;
  return table[resolveTheme(preference)];
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
  "plugin",
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
          // 标题交给渲染层按当前语言现算，避免把某一语的默认标题持久化
          title: title || "",
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
          title: title || "",
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
      if (item.kind === "plugin") {
        const pluginId = typeof item.pluginId === "string" ? item.pluginId.trim() : "";
        if (!pluginId) continue;
        tabs.push({
          id,
          kind: "plugin",
          title: title || pluginId,
          pluginId: pluginId.slice(0, 64),
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

/**
 * settings.providers（密钥是加密串）→ server 侧的 ProviderConfig（解密后的 apiKey）。
 * 启动时进 env，运行中增删改模型走 PUT /config/providers（不重启进程）。
 */
function providersForServer(settings) {
  return (settings.providers ?? []).map((provider) => ({
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
    authStyle: provider.authStyle,
    extraHeaders: provider.extraHeaders,
    extraBody: provider.extraBody,
    nativeCompaction: provider.nativeCompaction,
  }));
}

function buildServerEnv(settings) {
  const providers = providersForServer(settings);
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
  // 插件禁用清单（设置页启停）：server 只认 env，不读 settings 文件。
  // computer-control（电脑控制）默认关闭：用户从未持久化过插件开关（settings.plugins
  // 缺失）时注入禁用项；设置页写过的 disabled 数组存在后，以用户持久化的清单为准
  //（设置页开关以 server 回报的 enabled 状态为基础整表重写，因此双向自洽）。
  const storedPluginDisabled = Array.isArray(settings.plugins?.disabled)
    ? settings.plugins.disabled
    : null;
  const pluginDisabled = storedPluginDisabled ?? ["computer-control"];
  return {
    ...process.env,
    ...manualMcpEnv,
    ...(githubToken ? { [GITHUB_TOKEN_ENV]: githubToken } : {}),
    MEOWCODE_SERVER_PORT: "0",
    MEOWCODE_SESSIONS_DIR: sessionsDir,
    MEOWCODE_WORKTREES_DIR: path.join(settingsDir, "worktrees"),
    MEOWCODE_WORKSPACE: settings.workspace ?? "",
    MEOWCODE_PROVIDER_ID: settings.providerId ?? "",
    MEOWCODE_PROVIDERS: JSON.stringify(providers),
    // 记忆总开关：server 只认 env，不读 settings 文件
    MEOWCODE_MEMORY: settings.memoryEnabled === false ? "0" : "1",
    // 自我学习开关：同上，运行中切换走 /config/learning（默认关）
    MEOWCODE_SELF_LEARNING: settings.selfLearning === true ? "1" : "0",
    // 供应商故障转移：server 只认 env，运行中切换走 /config/provider-fallback（默认关）
    MEOWCODE_PROVIDER_FALLBACK: settings.providerFallback === true ? "1" : "0",
    // 网络代理：system 模式在启动时把系统代理解析成具体地址传给 server
    // （agent 侧再退到 HTTPS_PROXY/HTTP_PROXY 兜底）；运行中切换走 /config/proxy
    MEOWCODE_PROXY_MODE: PROXY_MODES.includes(settings.proxyMode) ? settings.proxyMode : "direct",
    MEOWCODE_PROXY_URL:
      settings.proxyMode === "manual"
        ? settings.proxyUrl || ""
        : settings.proxyMode === "system"
          ? resolveSystemProxy()
          : "",
    // AGENTS.md / CLAUDE.md 导入开关：server 启动时读 env，设置页切换走 /config/instructions
    MEOWCODE_INCLUDE_AGENTS_MD: settings.includeAgentsMd === false ? "0" : "1",
    MEOWCODE_INCLUDE_CLAUDE_MD: settings.includeClaudeMd === false ? "0" : "1",
    // 会话回滚（文件快照）：server 启动时读 env，写盘后重启 agent server 生效
    MEOWCODE_REWIND: settings.rewindSnapshots === false ? "0" : "1",
    ...(typeof settings.rewindMaxTotalMb === "number" && settings.rewindMaxTotalMb > 0
      ? { MEOWCODE_REWIND_MAX_MB: String(Math.round(settings.rewindMaxTotalMb)) }
      : {}),
    ...(typeof settings.rewindKeepCheckpoints === "number" && settings.rewindKeepCheckpoints > 0
      ? { MEOWCODE_REWIND_KEEP: String(Math.round(settings.rewindKeepCheckpoints)) }
      : {}),
    // 语色：server 只认 env，不读 settings 文件；运行中切换走 /config/speech-style
    MEOWCODE_SPEECH_STYLE: SPEECH_STYLES.includes(settings.speechStyle)
      ? settings.speechStyle
      : "normal",
    MEOWCODE_PLUGINS: JSON.stringify({ disabled: pluginDisabled }),
    // 命令沙箱：server 只认 env；运行中切换走 PUT /config/sandbox
    MEOWCODE_SANDBOX: JSON.stringify(normalizeSandbox(settings.sandbox)),
    // Claude Code hooks：user 级始终参与；工作区 .claude 默认不执行（设置页子开关）
    MEOWCODE_HOOKS_RUN_MODE: settings.hooks?.runMode === "ask" ? "ask" : "auto",
    MEOWCODE_CC_HOOKS_SCOPE: JSON.stringify({
      user: true,
      workspace: settings.hooks?.includeWorkspace === true,
    }),
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
    ...(computerHost.baseUrl
      ? {
          MEOWCODE_COMPUTER_HOST: computerHost.baseUrl,
          MEOWCODE_COMPUTER_HOST_TOKEN: computerHost.token,
        }
      : {}),
    ...(jobHost.baseUrl
      ? {
          MEOWCODE_JOB_HOST: jobHost.baseUrl,
          MEOWCODE_JOB_HOST_TOKEN: jobHost.token,
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

/** 手工令牌在线校验：Gitee/GitCode 走 query 参数，Figma 走 X-Figma-Token 请求头，瑞幸走 MCP initialize 握手。 */
// 校验器与成组规则见 desktop/mcp-token-checks.cjs（values 化 + evaluate 业务码判定），
// 这里只做 IPC 层的成组收集/合并/加密落盘。

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
      ...(flow?.codeVerifier ? { codeVerifier: flow.codeVerifier } : {}),
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
  // 后台任务控制面必须在 fork 前就绪：agent 通过 env 拿到 baseUrl/token
  await jobHost.start().catch(() => undefined);
  const spawn = () =>
    new Promise((resolve, reject) => {
      const child = fork(script, [], {
        // 打包后 app.getAppPath() 是 app.asar 文件路径，不能当 cwd（spawn 会 ENOENT）
        cwd: devRepoRoot() ?? process.resourcesPath,
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
          // 托盘菜单里的最近会话：server 就绪后补一次（窗口还没推送过时靠它填）
          void refreshTraySessions();
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
              // 通知侧先消化：标题/摘要缓存 + 到点弹窗，再照旧转发给渲染层
              handleServerEventForNotifications(payload);
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

// ---- 系统通知 ----
//
// Windows 的 toast 卡片上「应用名 + 图标」由 AUMID 决定（见文件顶部的 setAppUserModelId），
// 内容由这里拼：标题取会话名，正文取本轮最后一条回复；审批则是工具名 + 命令/路径。
// 只在主窗口不在前台时打扰用户；前台但看的是别的会话时照常提示。

/** 会话标题缓存：session_title 事件 + /sessions 兜底，通知标题用。 */
const sessionTitles = new Map();
/** 每个会话本轮最后一条 AI 回复：通知正文的摘要来源。 */
const sessionPreviews = new Map();
/** 回合结束通知去重：SSE 重连可能重放同一事件。 */
const turnDedupe = createDedupe({ windowMs: TURN_DEDUPE_MS });
/** 审批通知去重：同一个 callId 只提示一次（子 Agent 也复用同一事件类型）。 */
const approvalDedupe = createDedupe();

/** 通知文案跟随界面语言（与托盘菜单同一套词条表）。 */
function notificationLabels() {
  const ui = uiStrings();
  return {
    turnDone: ui.notifTurnDone,
    turnAborted: ui.notifTurnAborted,
    turnError: ui.notifTurnError,
    approval: ui.notifApproval,
    ask: ui.notifAsk,
    untitled: ui.untitledSession,
  };
}

/** 通知卡片图标：dev 读仓库 resources/icon.png，打包读 resources/icons/icon.png。 */
function notificationIconPath() {
  const root = devRepoRoot();
  return root
    ? path.join(root, "resources", "icon.png")
    : path.join(process.resourcesPath, "icons", "icon.png");
}

let notificationIconImage;
function notificationIcon() {
  if (notificationIconImage !== undefined) return notificationIconImage || undefined;
  try {
    const image = nativeImage.createFromPath(notificationIconPath());
    // toast 卡片上的图标是 48~64px，整张 1254px 的原图没必要
    notificationIconImage = image.isEmpty() ? null : image.resize({ width: 64, height: 64 });
  } catch {
    notificationIconImage = null;
  }
  return notificationIconImage || undefined;
}

/** 主窗口是否正被用户看着：隐藏到托盘 / 最小化 / 被别的应用挡住都算后台。 */
function isMainWindowInForeground() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (!mainWindow.isVisible() || mainWindow.isMinimized()) return false;
  return mainWindow.isFocused();
}

/**
 * 要不要打扰用户：总开关 + 系统支持 + 窗口在后台。
 * 窗口在前台但用户看的是别的会话时也要提示，否则多会话并行永远收不到通知。
 */
function shouldNotifyNow(sessionId) {
  // 正在退出：别在关应用的最后几秒弹一堆通知
  if (isQuitting) return false;
  const enabled = readSettings().notifications !== false;
  if (!shouldNotify({ enabled, supported: Notification.isSupported() })) return false;
  if (!isMainWindowInForeground()) return true;
  return Boolean(sessionId && trayActiveSessionId && sessionId !== trayActiveSessionId);
}

function showNotification({ title, body, sessionId }) {
  if (!body) return;
  try {
    const notification = new Notification({
      title,
      body,
      icon: notificationIcon(),
      // Windows 的 Tag 语义：同一会话的新通知替换旧的，通知中心不会堆一列
      ...(sessionId ? { id: sessionId } : {}),
    });
    notification.on("failed", (_event, error) => {
      // dev 下没有开始菜单快捷方式时 AUMID 归属可能失败，这里至少留下线索
      console.warn("[MeowCode] Notification failed:", error);
    });
    notification.on("click", () => {
      showMainWindow();
      void focusSessionFromNotification(sessionId);
    });
    notification.show();
  } catch (error) {
    console.warn("[MeowCode] Notification error:", error);
  }
}

/** 点通知回到对应会话：事件只带 sessionId，现拉一次列表换成 filePath 再走托盘切换通道。 */
async function focusSessionFromNotification(sessionId) {
  if (!sessionId || !serverUrl) return;
  try {
    const response = await fetch(`${serverUrl}/sessions`, {
      headers: { authorization: `Bearer ${serverToken}` },
    });
    if (!response.ok) return;
    const body = await response.json();
    const hit = Array.isArray(body?.sessions)
      ? body.sessions.find((item) => item?.id === sessionId)
      : null;
    if (hit?.filePath) sendTrayAction("meow:tray-switch-session", hit.filePath);
  } catch {
    // 拿不到列表就只把窗口唤到前台，不打断用户
  }
}

// ---- 自动化（定时任务）调度器 ----
// 到点后新建会话投递 prompt（loopback HTTP）；transport 先等 server 就绪再发，
// 启动竞态下重试才不会白跑。执行/事件/通知全部复用现有链路，agent server 零改动。
const automationScheduler = createScheduler({
  filePath: () =>
    path.join(settingsDir ?? path.join(app.getPath("userData"), "agent"), "automations.json"),
  transport: async ({ cwd, message }) => {
    await waitForServerReady();
    if (!serverUrl) throw new Error("agent server is not running");
    const created = await fetch(`${serverUrl}/session/new`, {
      method: "POST",
      headers: { authorization: `Bearer ${serverToken}`, "content-type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    if (!created.ok) throw new Error(`create session failed (${created.status})`);
    const createdBody = await created.json();
    const sessionId = String(createdBody?.id ?? "");
    if (!sessionId) throw new Error("create session returned no id");
    const sent = await fetch(`${serverUrl}/session/prompt`, {
      method: "POST",
      headers: { authorization: `Bearer ${serverToken}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId, message }),
    });
    if (!sent.ok) {
      const detail = await sent.text().catch(() => "");
      throw new Error(`prompt failed (${sent.status}) ${detail.slice(0, 200)}`);
    }
    return { sessionId };
  },
  getPrefix: (automation) =>
    String(uiStrings().automationPromptPrefix ?? "").replaceAll("{title}", automation?.title ?? ""),
  onEvent: handleAutomationEvent,
});

/** 调度器事件：列表变化广播给所有窗口；触发失败弹系统通知。 */
function handleAutomationEvent(event) {
  if (!event || typeof event.type !== "string") return;
  if (event.type === "changed") {
    broadcast("meow:automations-changed", automationScheduler.list());
    return;
  }
  if (event.type === "fire-failed") {
    const labels = uiStrings();
    const title = String(event.automation?.title ?? "");
    const error = String(event.error ?? "").slice(0, 200);
    showNotification({
      title: String(labels.notifAutomationFailed ?? "自动化触发失败"),
      body: `${title} — ${error}`,
    });
  }
}

function notifyTurnComplete(payload) {
  const sessionId = String(payload?.sessionId ?? "");
  if (!sessionId) return;
  if (!shouldNotifyNow(sessionId)) return;
  if (!turnDedupe.accept(sessionId)) return;
  const labels = notificationLabels();
  showNotification({
    title: notificationTitle(sessionTitles.get(sessionId), labels.untitled),
    body: describeTurn({
      status: payload.status,
      preview: sessionPreviews.get(sessionId),
      labels,
    }),
    sessionId,
  });
}

function notifyApprovalRequired(payload) {
  const callId = String(payload?.callId ?? "");
  // 子 Agent 的审批复用同一事件类型：标题取父会话的
  const sessionId = String(payload?.parentSessionId ?? payload?.sessionId ?? "");
  if (!callId || !sessionId) return;
  if (!shouldNotifyNow(sessionId)) return;
  if (!approvalDedupe.accept(callId)) return;
  const labels = notificationLabels();
  showNotification({
    title: notificationTitle(sessionTitles.get(sessionId), labels.untitled),
    body: describeApproval({
      tool: payload.tool,
      command: payload.command,
      input: payload.input,
      labels,
    }),
    sessionId,
  });
}

/** ask_user：模型挂起等你点选/回答，和审批一样需要打扰。 */
function notifyAskUser(payload) {
  const callId = String(payload?.callId ?? "");
  const sessionId = String(payload?.sessionId ?? "");
  if (!callId || !sessionId) return;
  if (!shouldNotifyNow(sessionId)) return;
  // 与审批共用一张表：同一个 callId 只提示一次
  if (!approvalDedupe.accept(callId)) return;
  const labels = notificationLabels();
  showNotification({
    title: notificationTitle(sessionTitles.get(sessionId), labels.untitled),
    body: describeAsk({ questions: payload.questions, labels }),
    sessionId,
  });
}

/** agent server 的 SSE 事件分流：维护标题/摘要缓存，再决定弹不弹。 */function handleServerEventForNotifications(payload) {
  if (!payload || typeof payload.type !== "string") return;
  switch (payload.type) {
    case "session_title":
      if (payload.sessionId && payload.title) sessionTitles.set(payload.sessionId, payload.title);
      return;
    case "message_start":
      if (!payload.agentId && payload.sessionId) sessionPreviews.delete(payload.sessionId);
      return;
    case "message_complete":
      if (!payload.agentId && payload.sessionId) {
        sessionPreviews.set(payload.sessionId, payload.text ?? "");
      }
      return;
    case "turn_complete":
      // 子 Agent 收尾不代表主回合结束，不提示
      if (!payload.agentId) {
        notifyTurnComplete(payload);
        // 自动化任务的会话在此结算历史（started → ok/error）
        automationScheduler.handleTurnComplete(payload.sessionId, payload.status);
      }
      return;
    case "approval_required":
      notifyApprovalRequired(payload);
      return;
    case "approval_resolved":
      approvalDedupe.release(payload.callId);
      return;
    case "ask_user":
      notifyAskUser(payload);
      return;
    default:
      return;
  }
}

// ---- 托盘 ----

/** 最近会话（渲染层会话列表变化时推送；server 就绪后再兜底拉一次）。 */
let traySessions = [];
/** 当前打开的会话文件：菜单里打勾用 */
let trayActiveSessionPath = null;
/** 当前打开的会话 id：通知判定「前台但看的是别的会话」用 */
let trayActiveSessionId = null;
/** 渲染层是否已经加载完（决定托盘动作直接发还是先排队）。 */
let rendererReady = false;
/** 托盘动作 → 渲染层：窗口还没加载完时先存一条，did-finish-load 后补发。 */
let pendingTrayAction = null;

function showMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** 托盘点击后要渲染层做的事（切会话 / 新对话 / 开设置）：没加载完就排队等一次。 */
function sendTrayAction(channel, payload) {
  const win = mainWindow;
  if (!win || win.isDestroyed() || !rendererReady) {
    pendingTrayAction = { channel, payload, at: Date.now() };
    return;
  }
  win.webContents.send(channel, payload);
}

function flushTrayAction() {
  const action = pendingTrayAction;
  pendingTrayAction = null;
  if (!action || !mainWindow || mainWindow.isDestroyed()) return;
  // 窗口加载失败后隔很久才恢复时，别再拿十几分钟前的那次点击动用户的会话
  if (Date.now() - (action.at ?? 0) > 30_000) return;
  mainWindow.webContents.send(action.channel, action.payload);
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
  // 窗口首帧还没渲染时菜单里也要有内容：直接问一次 agent server
  void refreshTraySessions();
}

/** 原生 UI（托盘 / 文件选择框）的当前语言文案：跟随设置里的界面语言，system 用系统语言解析。 */
function uiStrings() {
  let preference = "system";
  try {
    preference = readSettings().language || "system";
  } catch {
    // 设置还没写入时按 system 处理
  }
  const languages = app.getPreferredSystemLanguages?.() ?? [app.getLocale()];
  return mainStrings(preference, languages);
}

/** 兜底数据源：渲染层还没推送时（窗口未加载）直接从 server 拉会话列表。 */
async function refreshTraySessions() {
  if (!serverUrl) return;
  try {
    const response = await fetch(`${serverUrl}/sessions`, {
      headers: { authorization: `Bearer ${serverToken}` },
    });
    if (!response.ok) return;
    const body = await response.json();
    if (!Array.isArray(body?.sessions)) return;
    traySessions = normalizeTraySessions(body.sessions);
    // 顺手补一遍标题缓存：窗口还没推送过标题时，通知也不会只剩「未命名会话」
    for (const item of body.sessions) {
      if (item?.id && typeof item.title === "string" && item.title) {
        sessionTitles.set(item.id, item.title);
      }
    }
    updateTrayMenu();
  } catch {
    // server 还没就绪：等渲染层推送
  }
}

/** 菜单项标题：无标题会话用「未命名会话」，& 要转义成 && 否则被当成助记符。 */
function traySessionItem(session, ui) {
  return {
    label: traySessionLabel(session, ui.untitledSession),
    type: "checkbox",
    checked: Boolean(trayActiveSessionPath && session.filePath === trayActiveSessionPath),
    click: () => {
      // 先把状态挪过去再重建菜单：勾选立刻跟随，不用等渲染层推送。
      // 延到下一拍重建：点击回调里直接换掉正在弹出的菜单，Windows 下会闪一下。
      trayActiveSessionPath = session.filePath;
      showMainWindow();
      sendTrayAction("meow:tray-switch-session", session.filePath);
      setTimeout(updateTrayMenu, 0);
    },
  };
}

function updateTrayMenu() {
  if (!tray) return;
  const ui = uiStrings();
  const { recent, more } = splitTraySessions(traySessions);
  const template = [{ label: ui.newChat, click: openTrayNewChat }, { type: "separator" }];
  if (recent.length) {
    template.push({ label: ui.recentChats, enabled: false });
    for (const session of recent) template.push(traySessionItem(session, ui));
    if (more.length) {
      template.push({
        label: ui.moreChats,
        submenu: more.map((session) => traySessionItem(session, ui)),
      });
    }
    template.push({ type: "separator" });
  }
  template.push(
    { label: ui.showWindow, click: showMainWindow },
    {
      label: ui.settings,
      click: () => {
        showMainWindow();
        sendTrayAction("meow:open-settings");
      },
    },
    { type: "separator" },
    {
      label: ui.quit,
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

/** 托盘「新对话」：走和侧栏按钮同一条渲染层逻辑（沿用上次工作区）。 */
function openTrayNewChat() {
  showMainWindow();
  sendTrayAction("meow:tray-new-session");
}

/** 渲染层每次会话列表/当前会话变化后推一次：主进程只负责展示与分发点击。 */
ipcMain.handle("meow:tray-sessions", (_event, payload) => {
  traySessions = normalizeTraySessions(payload?.sessions);
  trayActiveSessionPath =
    typeof payload?.activeFilePath === "string" && payload.activeFilePath
      ? payload.activeFilePath
      : null;
  trayActiveSessionId =
    typeof payload?.activeSessionId === "string" && payload.activeSessionId
      ? payload.activeSessionId
      : null;
  updateTrayMenu();
  return { ok: true };
});

/**
 * 渲染层已订阅好托盘事件：这时补发排队的那一条动作。
 * 不能只靠 did-finish-load —— React 的 effect 在首帧之后才跑，早发会直接丢掉。
 */
ipcMain.handle("meow:tray-ready", () => {
  rendererReady = true;
  flushTrayAction();
  return { ok: true };
});

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

// ---- AI 悬浮岛：屏幕顶部居中的透明置顶胶囊（设置 → AI 悬浮岛开关）----

let islandScreenHooksInstalled = false;

/** 渲染层上报的岛体交互矩形（屏幕坐标）：展开=面板，折叠=胶囊 */
let islandHoverRect = null;
/** 主进程轮询判定的光标是否在岛上 */
let islandCursorInside = false;
let islandPollTimer = null;

/**
 * 60ms 轮询光标位置直接切换穿透（NexBox 灵动岛同款）。
 * 不用渲染层 mousemove + IPC：快速点击时穿透还没切回来，点击会穿到下层窗口——这就是「有时展不开」的根源。
 */
function startIslandPoll() {
  if (islandPollTimer) return;
  islandPollTimer = setInterval(() => {
    const win = islandWindow;
    if (!win || win.isDestroyed() || !islandHoverRect) return;
    const pt = screen.getCursorScreenPoint();
    const rect = islandHoverRect;
    // 进入只留 4px（给 60ms 轮询一点提前量），离开 8px 回差避免边缘抖动。
    // 旧值 14/26 会在胶囊周围形成一圈可拦截点击的透明区域。
    const margin = islandCursorInside ? 8 : 4;
    const inside =
      pt.x >= rect.x - margin &&
      pt.x <= rect.x + rect.width + margin &&
      pt.y >= rect.y - margin &&
      pt.y <= rect.y + rect.height + margin;
    if (inside === islandCursorInside) return;
    islandCursorInside = inside;
    win.setIgnoreMouseEvents(!inside, { forward: true });
    // 同步给渲染层：离开岛体时收起展开面板
    win.webContents.send("meow:island-cursor", inside);
  }, 60);
}

function stopIslandPoll() {
  if (islandPollTimer) {
    clearInterval(islandPollTimer);
    islandPollTimer = null;
  }
  islandCursorInside = false;
  islandHoverRect = null;
}

/** 贴住主显示器工作区顶部居中；分辨率变化 / 插拔显示器时由 screen 事件回调自动校正 */
function positionIslandWindow() {
  if (!islandWindow || islandWindow.isDestroyed()) return;
  const { workArea } = screen.getPrimaryDisplay();
  const width = ISLAND_WINDOW_WIDTH;
  const x = Math.max(workArea.x, Math.round(workArea.x + (workArea.width - width) / 2));
  islandWindow.setPosition(x, workArea.y);
}

function ensureIslandScreenHooks() {
  if (islandScreenHooksInstalled) return;
  islandScreenHooksInstalled = true;
  screen.on("display-metrics-changed", () => positionIslandWindow());
  screen.on("displays-changed", () => positionIslandWindow());
}

function createIslandWindow() {
  if (islandWindow && !islandWindow.isDestroyed()) return;
  ensureIslandScreenHooks();
  startIslandPoll();
  islandWindow = new BrowserWindow({
    width: ISLAND_WINDOW_WIDTH,
    height: ISLAND_WINDOW_HEIGHT,
    show: false,
    // 无边框透明：岛体形状完全由渲染层绘制
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    // 输入框需要键盘焦点：hover 展开不抢焦点（showInactive），点进输入框才聚焦。
    // focusable:false 在 Windows 上收不到键盘事件，直接输入要求必须可聚焦。
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: false,
      // 常驻后台的流式动画与状态推进不能被节流
      backgroundThrottling: false,
    },
  });
  islandWindow.setMenu(null);
  // 兜底：任何未被渲染层 preventDefault 的拖放都不允许导航岛页面（Chromium 默认会打开文件）
  islandWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  // 空闲时整窗穿透；forward:true 让渲染层仍能收到 mousemove，据此判定光标进出岛体再切换
  islandWindow.setIgnoreMouseEvents(true, { forward: true });
  islandWindow.once("ready-to-show", () => {
    if (!islandWindow || islandWindow.isDestroyed()) return;
    positionIslandWindow();
    islandWindow.showInactive();
  });
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    islandWindow.loadURL(`${devServerUrl.replace(/\/+$/, "")}/island.html`);
  } else {
    islandWindow.loadFile(path.join(__dirname, "renderer", "island.html"));
  }
  islandWindow.on("closed", () => {
    islandWindow = null;
  });
}

function destroyIslandWindow() {
  if (!islandWindow) return;
  const win = islandWindow;
  islandWindow = null;
  stopIslandPoll();
  try {
    win.destroy();
  } catch {
    // 已销毁则忽略
  }
}

function createWindow() {
  const settings = readSettings();
  // 新窗口的渲染层还没跑起来：托盘动作先排队，did-finish-load 后再补发
  rendererReady = false;
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
    backgroundColor: ACRYLIC_BACKDROP ? "#00000000" : windowBackground(settings.theme, settings.palette),
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
  // 首帧渲染完成：托盘动作等渲染层订阅好（meow:tray-ready）再补发，这里只标记可发
  mainWindow.webContents.on("did-finish-load", () => {
    rendererReady = true;
  });
  mainWindow.webContents.on("did-start-loading", () => {
    rendererReady = false;
  });

  // 系统主题切换时，跟随系统的窗口底色也跟着变
  nativeTheme.on("updated", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const current = readSettings();
    if ((current.theme ?? "system") !== "system") return;
    // 亚克力模式下窗口底色是透明的，不能覆盖
    if (ACRYLIC_BACKDROP) return;
    mainWindow.setBackgroundColor(windowBackground("system", current.palette));
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
    rendererReady = false;
    // 悬浮岛跟着销毁：否则它常驻会让 window-all-closed 不触发，应用退不干净
    destroyIslandWindow();
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
    // 同一服务商下新增的模型条目是全新 id：密钥从同组来源条目继承，否则会丢 key
    const existing =
      (previous.providers ?? []).find((item) => item.id === provider.id) ??
      (typeof provider.apiKeySourceId === "string"
        ? (previous.providers ?? []).find((item) => item.id === provider.apiKeySourceId)
        : undefined);
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
    // 重路径也接受配色：否则「保存设置」会把它回退成旧值
    palette: PALETTES.includes(incoming.palette) ? incoming.palette : previous.palette,
    closeAction: CLOSE_ACTIONS.includes(incoming.closeAction)
      ? incoming.closeAction
      : previous.closeAction,
    providers,
  });
  writeSettings(settings);
  await startServer();
  return publicSettings(settings);
});

// ---- 服务商列表增删改：轻量落盘 + 热更新运行中的 server（不重启进程） ----
/**
 * 服务商热更新：桌面端已落盘，这里只把解密后的配置推给运行中的 server。
 * server 没起来时无需推送（下次启动 env 里已是新列表）。
 */
async function pushProviders(providers, providerId) {
  if (!serverUrl) return;
  const response = await fetch(`${serverUrl}/config/providers`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${serverToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ providers, providerId }),
  });
  if (!response.ok) throw new Error(`provider update failed: HTTP ${response.status}`);
}

/**
 * 保存模型列表（增删改 / 启用开关）：只写盘 + 热更新 server。
 * 走 meow:save-settings 会 startServer() 重启进程，把运行中的回合直接杀掉。
 */
ipcMain.handle("meow:save-providers", async (_event, payload) => {
  ensureDirs();
  const incoming = payload && typeof payload === "object" ? payload : {};
  const previous = readSettings();
  const providers = (Array.isArray(incoming.providers) ? incoming.providers : []).map((provider) => {
    // 同一服务商下新增的模型条目是全新 id：密钥从同组来源条目继承，否则会丢 key
    const existing =
      (previous.providers ?? []).find((item) => item.id === provider.id) ??
      (typeof provider.apiKeySourceId === "string"
        ? (previous.providers ?? []).find((item) => item.id === provider.apiKeySourceId)
        : undefined);
    return providerFields(provider, existing);
  });
  const settings = migrateSettings({
    ...previous,
    providers,
    providerId:
      (typeof incoming.providerId === "string" && incoming.providerId) ||
      providers.find((item) => item.id)?.id ||
      providers[0]?.id ||
      previous.providerId,
  });
  writeSettings(settings);
  await pushProviders(providersForServer(settings), settings.providerId);
  return publicSettings(settings);
});

// ---- 插件启停：写 settings.plugins 后热更新运行中的 server（不重启进程） ----
/**
 * 插件启停热更新：只让运行中的 server 更新禁用列表并重载插件，不重启进程。
 * server 没起来时才启动一次；启动后 env 里已经是新列表。
 */
async function pushPluginDisabled(disabled) {
  if (!serverUrl) await startServer();
  if (!serverUrl) throw new Error("Agent server is not ready.");
  const response = await fetch(`${serverUrl}/plugins/disabled`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${serverToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ disabled }),
  });
  if (!response.ok) throw new Error(`plugin state update failed: HTTP ${response.status}`);
}

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
  await pushPluginDisabled(disabled);
  return publicSettings(settings);
});

// ---- Claude Code hooks：启停 + 运行方式 + 工作区配置范围；插件启停走热更新 ----
/**
 * hooks 运行方式/工作区范围热更新：server 侧只改 env，插件每次执行时读 env，不重启进程。
 * server 没起来时无需推送（下次启动 env 里已是新值）。
 */
async function pushHooksConfig({ runMode, includeWorkspace }) {
  if (!serverUrl) return;
  const response = await fetch(`${serverUrl}/config/hooks`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${serverToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ runMode, includeWorkspace }),
  });
  if (!response.ok) throw new Error(`hooks config update failed: HTTP ${response.status}`);
}

ipcMain.handle("meow:save-hooks-settings", async (_event, payload) => {
  ensureDirs();
  const incoming = payload && typeof payload === "object" ? payload : {};
  const previous = readSettings();
  const enabled = incoming.enabled !== false;
  const runMode = incoming.runMode === "ask" ? "ask" : "auto";
  const includeWorkspace = incoming.includeWorkspace === true;
  const previousDisabled = Array.isArray(previous.plugins?.disabled)
    ? previous.plugins.disabled
    : ["computer-control"];
  const wasEnabled = !previousDisabled.includes("claude-code-hooks");
  const disabled = new Set(previousDisabled);
  if (enabled) disabled.delete("claude-code-hooks");
  else disabled.add("claude-code-hooks");
  const settings = migrateSettings({
    ...previous,
    plugins: { ...(previous.plugins ?? {}), disabled: [...disabled] },
    hooks: { runMode, includeWorkspace },
  });
  writeSettings(settings);
  // 运行方式/范围只改 env；只有启停状态变了才重载插件（避免无谓的目录改写）
  await pushHooksConfig({ runMode, includeWorkspace });
  if (enabled !== wasEnabled) await pushPluginDisabled([...disabled]);
  return publicSettings(settings);
});

/** 打开 Claude Code hooks 配置文件：只接受已知 layer，路径由主进程解析，避免任意文件打开。 */
ipcMain.handle("meow:open-hooks-file", async (_event, layer) => {
  const settings = readSettings();
  const home = process.env.MEOWCODE_CC_HOOKS_HOME || os.homedir();
  const workspace = settings.workspace;
  let file = null;
  if (layer === "user") file = path.join(home, ".claude", "settings.json");
  else if (layer === "project" && workspace) {
    file = path.join(workspace, ".claude", "settings.json");
  } else if (layer === "local" && workspace) {
    file = path.join(workspace, ".claude", "settings.local.json");
  }
  if (!file) return { ok: false, error: "invalid_layer" };
  if (!fs.existsSync(file)) return { ok: false, missing: true, path: file };
  const error = await shell.openPath(file);
  if (error) return { ok: false, error, path: file };
  return { ok: true, path: file };
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
  const incoming = {};
  for (const name of MANUAL_MCP_TOKEN_ENVS) {
    const value = env[name];
    if (typeof value !== "string" || !value.trim()) continue;
    incoming[name] = value.trim();
  }
  if (!Object.keys(incoming).length) return { ok: false, message: "请填写 Token。" };
  const previous = readSettings();
  // 成组校验的 values 用「旧存储解密 + 本次新值」合并：只填一半时另一半沿用旧值
  const merged = {};
  for (const name of MANUAL_MCP_TOKEN_ENVS) {
    const stored = previous.mcpCredentials?.[name];
    if (typeof stored === "string") {
      try {
        merged[name] = decryptApiKey(stored) ?? "";
      } catch {
        merged[name] = "";
      }
    }
  }
  Object.assign(merged, incoming);
  // 成组完整性：组内任一 env 本次有新值（或已有旧值）时，组内全部 env 都必须有值
  const touchedGroups = new Set(Object.keys(incoming).map(credentialGroupOf));
  for (const group of touchedGroups) {
    if (group.length < 2) continue;
    const missing = group.filter((name) => !merged[name]);
    if (missing.length) {
      return {
        ok: false,
        message: `请同时填写完整凭据：缺少 ${missing.join("、")}。`,
      };
    }
  }
  // 校验每个被触碰组的组代表（values 里带整组值）
  const checkNames = new Set([...touchedGroups].map((group) => credentialCheckName(group[0])));
  for (const name of checkNames) {
    const check = await validateManualMcpToken(name, merged);
    if (!check.ok) return check;
  }
  const nextCredentials = { ...(previous.mcpCredentials ?? {}) };
  for (const [name, value] of Object.entries(incoming)) {
    nextCredentials[name] = encryptApiKey(value);
  }
  const settings = migrateSettings({ ...previous, mcpCredentials: nextCredentials });
  writeSettings(settings);
  const applied = await updateServerMcpCredentials(incoming);
  return {
    ok: true,
    ...(applied ? {} : { warning: "已保存，但 MCP 热更新失败，重启应用后生效。" }),
  };
});

// 清除手工令牌（如 Figma「解除授权」、飞书双凭据）：从 settings.mcpCredentials 删除，
// 并把 server 进程 env 置 null（=删除）触发热重载；对应的 MCP 会因缺令牌而断开。
// payload.names 是数组（双凭据条目一次清整组）；兼容旧的 { name } 单值。
ipcMain.handle("meow:clear-mcp-token", async (_event, payload) => {
  ensureDirs();
  const names = Array.isArray(payload?.names) && payload.names.length
    ? payload.names.map((value) => String(value))
    : [String(payload?.name ?? "")].filter(Boolean);
  if (!names.length || names.some((name) => !MANUAL_MCP_TOKEN_ENVS.includes(name))) {
    return { ok: false, message: "不支持的 MCP Token。" };
  }
  const previous = readSettings();
  const credentials = { ...(previous.mcpCredentials ?? {}) };
  const clearable = names.filter((name) => name in credentials);
  if (!clearable.length) return { ok: false, message: "没有已保存的令牌。" };
  for (const name of clearable) delete credentials[name];
  writeSettings(migrateSettings({ ...previous, mcpCredentials: credentials }));
  const applied = await updateServerMcpCredentials(
    Object.fromEntries(clearable.map((name) => [name, null])),
  );
  return {
    ok: true,
    ...(applied ? {} : { warning: "已清除本机令牌，但 MCP 热更新失败，重启应用后生效。" }),
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
  if (config.publicClient) {
    const stored = resolveOauthApp(settings, platform);
    return { clientId: stored.clientId, clientSecret: "", source: stored.source };
  }
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
  if (!config.publicClient && !clientSecret) {
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
  let codeVerifier = "";
  let codeChallenge = "";
  if (config.pkce) {
    codeVerifier = crypto.randomBytes(48).toString("base64url");
    codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  }
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
  platformOauthFlows.set(platform, {
    state,
    status: "pending",
    timer,
    clientId,
    clientSecret,
    ...(config.pkce ? { codeVerifier } : {}),
  });
  return {
    ok: true,
    authorizeUrl: buildOauthAuthorizeUrl(config, {
      clientId,
      redirectUri: localOauthCallbackUri(platform),
      state,
      ...(codeChallenge ? { codeChallenge } : {}),
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

// 社区市场提交/删除：复用 gitcode-community 槽位 token（提交窗口引导授权）
registerCommunitySubmitIpc({
  ipcMain,
  broadcast,
  readCommunityToken: () => oauthStoredToken(readSettings(), "gitcode-community"),
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
    title: uiStrings().pickWorkspace,
  });
  return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
});

ipcMain.handle("meow:get-data-location", () => ({
  path: app.getPath("userData"),
  defaultPath: DEFAULT_DATA_DIR,
}));

ipcMain.handle("meow:pick-data-directory", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
});

ipcMain.handle("meow:change-data-location", async (_event, target) => {
  const current = app.getPath("userData");
  const invalid = validateDataTarget({ current, target, defaultDir: DEFAULT_DATA_DIR });
  if (invalid) return { ok: false, code: invalid };
  try {
    // 先 flush 再关 server：保证 ui-state / 窗口尺寸和会话收尾都写进被复制的目录
    flushWindowState();
    flushUiState();
    await stopServer();
    const result = migrateData({
      current,
      target,
      defaultDir: DEFAULT_DATA_DIR,
      pointerPath: locationPointerPath(APP_DATA_DIR),
    });
    if (!result.ok) {
      // 迁移失败不把应用留在「server 已停」状态
      void startServer().catch(() => undefined);
      return result;
    }
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 350);
    return { ok: true, restarting: true };
  } catch (error) {
    void startServer().catch(() => undefined);
    return {
      ok: false,
      code: "copy_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
});

// ---- 自绘标题栏的窗口操作（frame: false 后由渲染层调用）----
ipcMain.handle("meow:window-minimize", () => {
  mainWindow?.minimize();
});

// 标题栏公告：拖动文字等于拖动窗口（渲染层判断位移后调用）。
// no-drag 区域内 ReleaseCapture+WM_NCLBUTTONDOWN 进不了系统移动循环（鼠标捕获在渲染进程），
// 这里改用主进程轮询光标 + 逐帧移动的方案：稳定、与是否 no-drag 无关。
//
// 两个坑，都表现为「拖一下窗口变大」：
//  1. 只调 setPosition：Electron 每帧读当前尺寸再写回，缩放显示器上 DIP↔像素往返取整，
//     每帧可能多 1px，拖一会儿窗口就胖一圈。→ 逐帧 setBounds，宽高钉死起拖快照。
//  2. 最大化状态下起拖：快照拿到的是全屏矩形，挪走的就是一个「全屏大小的普通窗口」。
//     → 先 unmaximize 还原，等系统落定后再按还原后的尺寸起拖（与系统拖标题栏一致）。
let windowDragTimer = null;
let windowDragState = null;
/** 起拖序号：unmaximize 后延迟起拖期间若又结束/重开，旧的那次必须作废 */
let windowDragSeq = 0;

function stopWindowDrag() {
  windowDragSeq += 1;
  if (windowDragTimer) clearInterval(windowDragTimer);
  windowDragTimer = null;
  windowDragState = null;
}

/** 每帧：光标位移 → 新矩形（尺寸永远取起拖时那份）。 */
function stepWindowDrag() {
  const state = windowDragState;
  // 兜底：渲染层没发结束（崩溃/丢抬起）时最长 60s 自动停
  if (!state || state.win.isDestroyed() || Date.now() - state.startedAt > 60_000) {
    stopWindowDrag();
    return;
  }
  const next = dragBounds(state.bounds, state.startCursor, screen.getCursorScreenPoint());
  // 光标没动就别写窗口：省掉每秒 60 次无意义的 move 事件（还会触发状态落盘）
  if (next.x === state.lastX && next.y === state.lastY) return;
  state.lastX = next.x;
  state.lastY = next.y;
  state.win.setBounds(next);
}

ipcMain.handle("meow:window-start-drag", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed() || win.isFullScreen()) return false;
  stopWindowDrag();
  const seq = windowDragSeq;
  const begin = () => {
    // 等待期间被 endWindowDrag / 新一次 start 顶掉就作废
    if (seq !== windowDragSeq || win.isDestroyed()) return;
    windowDragState = {
      win,
      startCursor: screen.getCursorScreenPoint(),
      bounds: win.getBounds(),
      startedAt: Date.now(),
      lastX: Number.NaN,
      lastY: Number.NaN,
    };
    win.once("closed", stopWindowDrag);
    windowDragTimer = setInterval(stepWindowDrag, 16);
  };
  if (win.isMaximized()) {
    win.unmaximize();
    // unmaximize 是异步的：立刻 getBounds() 还可能拿到最大化矩形，等系统摆回还原尺寸
    setTimeout(begin, 60);
  } else {
    begin();
  }
  return true;
});
ipcMain.handle("meow:window-end-drag", () => {
  stopWindowDrag();
  return true;
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

/** 文件关联检测结果缓存：同一扩展名只查一次注册表 + 取一次图标。 */
const openWithCache = new Map();

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/**
 * 扫描系统里能打开该扩展名的应用（参考 OpenMD 的 detect_editors）：
 * Windows 注册表取 UserChoice / 扩展名默认 ProgID / OpenWithProgids /
 * OpenWithList，解析出 exe 与友好名称，再取 exe 图标。
 */
async function scanOpenWithApps(ext) {
  const safeExt = ext.replace(/'/g, "''");
  const script = String.raw`
$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
$ext='${safeExt}'
$items=New-Object System.Collections.ArrayList
$seen=@{}
function Get-Default([string]$key){
  try { return (Get-ItemProperty -LiteralPath $key -ErrorAction Stop).'(default)' } catch { return $null }
}
function Get-Exe([string]$progId){
  $cmd=Get-Default "Registry::HKEY_CLASSES_ROOT\$progId\shell\open\command"
  if(-not $cmd){ return $null }
  if($cmd -match '^\s*"([^"]+)"'){ return $matches[1] }
  return ($cmd -split '\s+')[0]
}
function Get-AppName([string]$exe){
  $base=[System.IO.Path]::GetFileName($exe)
  $props=Get-ItemProperty -LiteralPath "Registry::HKEY_CLASSES_ROOT\Applications\$base" -ErrorAction SilentlyContinue
  if($props -and $props.FriendlyAppName){ return $props.FriendlyAppName }
  try {
    $vi=(Get-Item -LiteralPath $exe -ErrorAction Stop).VersionInfo
    if($vi.ProductName){ return $vi.ProductName }
    if($vi.FileDescription){ return $vi.FileDescription }
  } catch {}
  return [System.IO.Path]::GetFileNameWithoutExtension($exe)
}
function Get-IconData([string]$path){
  try {
    $icon=[System.Drawing.Icon]::ExtractAssociatedIcon($path)
    if(-not $icon){ return $null }
    $bmp=$icon.ToBitmap()
    $ms=New-Object System.IO.MemoryStream
    $bmp.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png)
    $data='data:image/png;base64,'+[Convert]::ToBase64String($ms.ToArray())
    $bmp.Dispose(); $ms.Dispose(); $icon.Dispose()
    return $data
  } catch { return $null }
}
function Add-App([string]$exe,[bool]$isDefault){
  if(-not $exe){ return }
  $exe=[Environment]::ExpandEnvironmentVariables($exe.Trim('"'))
  if(-not (Test-Path -LiteralPath $exe -PathType Leaf)){ return }
  $key=$exe.ToLowerInvariant()
  if($seen.ContainsKey($key)){
    if($isDefault){ $seen[$key].default=$true }
    return
  }
  $name=Get-AppName $exe
  $entry=[pscustomobject]@{name=$name;exe=$exe;default=$isDefault;recommended=$isDefault;icon=(Get-IconData $exe)}
  $seen[$key]=$entry
  [void]$items.Add($entry)
}
$uc=Get-ItemProperty -LiteralPath "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$ext\UserChoice" -ErrorAction SilentlyContinue
if($uc -and $uc.ProgId){ $p=$uc.ProgId; $e=Get-Exe $p; Add-App $e $true }
$p=Get-Default "Registry::HKEY_CLASSES_ROOT\$ext"
if($p){ $e=Get-Exe $p; Add-App $e $true }
foreach($root in @("Registry::HKEY_CLASSES_ROOT\$ext\OpenWithProgids","Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$ext\OpenWithProgids")){
  $props=Get-ItemProperty -LiteralPath $root -ErrorAction SilentlyContinue
  if($props){
    foreach($prop in $props.PSObject.Properties){
      if($prop.Name -like 'PS*'){ continue }
      $e=Get-Exe $prop.Name
      Add-App $e $false
    }
  }
}
$keys=Get-ChildItem -LiteralPath "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$ext\OpenWithList" -ErrorAction SilentlyContinue
if($keys){
  foreach($k in $keys){
    $exeName=$k.PSChildName
    if($exeName -eq 'MRUList'){ continue }
    $e=Get-Exe "Applications\$exeName"
    if(-not $e){ $e=Get-Default "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exeName" }
    Add-App $e $false
  }
}
$explorerIcon=Get-IconData ([Environment]::ExpandEnvironmentVariables('%SystemRoot%\explorer.exe'))
$result=[pscustomobject]@{apps=$items;explorerIcon=$explorerIcon}
$result | ConvertTo-Json -Compress -Depth 4
`;

  try {
    const raw = (await runPowerShell(script)).trim();
    const parsed = raw ? JSON.parse(raw) : {};
    const list = (
      Array.isArray(parsed) ? parsed : Array.isArray(parsed.apps) ? parsed.apps : []
    ).filter((item) => item && typeof item.exe === "string" && typeof item.name === "string");
    list.sort(
      (a, b) =>
        Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)) ||
        String(a.name).localeCompare(String(b.name), "zh-CN"),
    );
    return {
      default: list.find((item) => item.default) ?? null,
      apps: list.slice(0, 12),
      explorerIcon: typeof parsed.explorerIcon === "string" ? parsed.explorerIcon : null,
    };
  } catch {
    // 不缓存失败结果：注册表查询可能因临时权限/进程问题失败，下次打开再试
    return { default: null, apps: [], explorerIcon: null };
  }
}

// ---- 打开方式缓存：注册表扫描结果 + 图标，落盘跨进程复用 ----

const OPEN_WITH_CACHE_VERSION = 2;
const OPEN_WITH_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let openWithDisk = null;

function openWithCacheFile() {
  return path.join(app.getPath("userData"), "open-with-cache.json");
}

function loadOpenWithDisk() {
  if (openWithDisk) return openWithDisk;
  try {
    const parsed = JSON.parse(fs.readFileSync(openWithCacheFile(), "utf8"));
    openWithDisk =
      parsed && parsed.version === OPEN_WITH_CACHE_VERSION
        ? parsed
        : { version: OPEN_WITH_CACHE_VERSION, extensions: {}, icons: {} };
  } catch {
    openWithDisk = { version: OPEN_WITH_CACHE_VERSION, extensions: {}, icons: {} };
  }
  return openWithDisk;
}

function saveOpenWithDisk() {
  try {
    const file = openWithCacheFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(loadOpenWithDisk()), "utf8");
    fs.renameSync(temp, file);
  } catch {
    // 缓存写失败不影响本次使用
  }
}

/**
 * 从 exe 直接提取图标（与 OpenMD 的 SHGetFileInfo 同源结果）。
 * Electron 的 app.getFileIcon 对部分应用会回退成通用蓝色图标，不能用于这里。
 */
async function extractIconsViaPowerShell(exes) {
  if (!exes.length) return {};
  const encoded = Buffer.from(JSON.stringify(exes), "utf8").toString("base64");
  const script = String.raw`
Add-Type -AssemblyName System.Drawing
$json=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
$paths=$json | ConvertFrom-Json
if($paths -isnot [array]){ $paths=@($paths) }
$out=@{}
foreach($p in $paths){
  try {
    $icon=[System.Drawing.Icon]::ExtractAssociatedIcon($p)
    if($icon){
      $bmp=$icon.ToBitmap()
      $ms=New-Object System.IO.MemoryStream
      $bmp.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png)
      $out[$p]='data:image/png;base64,'+[Convert]::ToBase64String($ms.ToArray())
      $bmp.Dispose(); $ms.Dispose(); $icon.Dispose()
    }
  } catch {}
}
$out | ConvertTo-Json -Compress
`;
  try {
    const raw = (await runPowerShell(script)).trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function cachedResult(ext) {
  const disk = loadOpenWithDisk();
  const entry = disk.extensions[ext];
  if (!entry || !Array.isArray(entry.apps)) return null;
  const apps = entry.apps.map((app) => ({
    ...app,
    icon: disk.icons[String(app.exe).toLowerCase()] ?? null,
  }));
  return {
    default: apps.find((app) => app.default) ?? null,
    apps,
    explorerIcon: entry.explorerIcon ?? null,
    stale: Date.now() - Number(entry.at || 0) > OPEN_WITH_CACHE_TTL_MS,
  };
}

async function scanAndCache(ext) {
  const scanned = await scanOpenWithApps(ext);
  const disk = loadOpenWithDisk();
  const explorerKey = path
    .join(process.env.SystemRoot || "C:\\Windows", "explorer.exe")
    .toLowerCase();
  for (const app of scanned.apps) {
    if (typeof app.icon === "string") disk.icons[app.exe.toLowerCase()] = app.icon;
  }
  if (typeof scanned.explorerIcon === "string") {
    disk.icons[explorerKey] = scanned.explorerIcon;
  }
  const explorerIcon = scanned.explorerIcon ?? disk.icons[explorerKey] ?? null;
  disk.extensions[ext] = {
    apps: scanned.apps.map(({ name, exe, default: isDefault, recommended }) => ({
      name,
      exe,
      ...(isDefault ? { default: true } : {}),
      ...(recommended ? { recommended: true } : {}),
    })),
    explorerIcon,
    at: Date.now(),
  };
  saveOpenWithDisk();
  return {
    default: scanned.default,
    apps: scanned.apps.map((app) => ({
      ...app,
      icon: app.icon ?? disk.icons[String(app.exe).toLowerCase()] ?? null,
    })),
    explorerIcon,
  };
}

async function detectOpenWithApps(target) {
  if (process.platform !== "win32") return { default: null, apps: [], explorerIcon: null };
  const ext = path.extname(target).toLowerCase();
  if (!ext) return { default: null, apps: [], explorerIcon: null };
  const cached = openWithCache.get(ext);
  if (cached) return cached;

  const stored = cachedResult(ext);
  if (stored) {
    const { stale, ...result } = stored;
    openWithCache.set(ext, result);
    // 过期时先用旧缓存秒开，后台刷新，下次打开自然更新
    if (stale) {
      void scanAndCache(ext)
        .then((refreshed) => openWithCache.set(ext, refreshed))
        .catch(() => undefined);
    }
    return result;
  }

  const result = await scanAndCache(ext);
  openWithCache.set(ext, result);
  return result;
}

ipcMain.handle("meow:detect-open-with", async (_event, target) => {
  if (typeof target !== "string" || !target.trim() || !fs.existsSync(target)) {
    return { default: null, apps: [], explorerIcon: null };
  }
  return await detectOpenWithApps(target);
});

/** 图标异步补全：菜单先用名称秒开，图标批量提取后回填。 */
ipcMain.handle("meow:open-with-icons", async (_event, exes) => {
  if (!Array.isArray(exes)) return {};
  const unique = [...new Set(exes.filter((exe) => typeof exe === "string" && exe))].slice(0, 24);
  const disk = loadOpenWithDisk();
  const missing = unique.filter((exe) => typeof disk.icons[exe.toLowerCase()] !== "string");
  if (missing.length) {
    const extracted = await extractIconsViaPowerShell(missing);
    for (const [exe, icon] of Object.entries(extracted)) {
      if (typeof icon === "string") disk.icons[exe.toLowerCase()] = icon;
    }
    saveOpenWithDisk();
  }
  return Object.fromEntries(
    unique.map((exe) => [exe, disk.icons[exe.toLowerCase()] ?? null]),
  );
});

/** 用检测到的具体应用打开文件（Windows）。 */
ipcMain.handle("meow:open-with-app", (_event, exe, target) => {
  if (typeof exe !== "string" || !fs.existsSync(exe)) return "app not found";
  if (process.platform === "win32" && path.extname(exe).toLowerCase() !== ".exe") {
    return "not an executable";
  }
  if (typeof target !== "string" || !fs.existsSync(target)) return "file not found";
  const { spawn } = require("node:child_process");
  try {
    const child = spawn(exe, [target], { detached: true, stdio: "ignore" });
    child.unref();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
});

/**
 * 「打开方式」：调用系统原生的应用选择器。
 * - Windows：rundll32 OpenAs_RunDLL，对应右键「打开方式」的完整应用列表；
 * - macOS：osascript 弹出选择应用对话框，失败回退默认应用；
 * - Linux：优先 mimeopen -a，未安装时回退 xdg-open。
 */
ipcMain.handle("meow:open-with", async (_event, target) => {
  if (typeof target !== "string" || !target.trim()) return "invalid path";
  if (!fs.existsSync(target)) return "file not found";
  const { spawn } = require("node:child_process");
  try {
    if (process.platform === "win32") {
      const child = spawn("rundll32.exe", ["shell32.dll,OpenAs_RunDLL", target], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return null;
    }
    if (process.platform === "darwin") {
      const script = [
        "on run argv",
        "set targetPath to item 1 of argv",
        "set chosenApp to choose application",
        "set appPath to POSIX path of chosenApp",
        'do shell script "open -a " & quoted form of appPath & " " & quoted form of targetPath',
        "end run",
      ];
      const child = spawn("osascript", script.flatMap((line) => ["-e", line]).concat(target), {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return null;
    }
    const child = spawn("mimeopen", ["-a", target], { detached: true, stdio: "ignore" });
    child.on("error", () => {
      const fallback = spawn("xdg-open", [target], { detached: true, stdio: "ignore" });
      fallback.unref();
    });
    child.unref();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
});

/** 在系统文件管理器中定位文件。 */
ipcMain.handle("meow:show-in-folder", (_event, target) => {
  if (typeof target !== "string" || !target.trim()) return "invalid path";
  if (!fs.existsSync(target)) return "file not found";
  shell.showItemInFolder(target);
  return null;
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
/** 邮箱聚合：IMAP/SMTP、轮询同步与发送队列都在主进程；数据落在 userData/mail */
const mailHost = createMailHost({
  ipcMain,
  getWindow: () => mainWindow,
  dataDir: app.getPath("userData"),
  encrypt: encryptApiKey,
  decrypt: decryptApiKey,
});
mailHost.start();
/**
 * agent 后台任务控制面：与浏览器桥同款 loopback HTTP + token。
 * 任务在同一个终端 PTY 里跑，渲染层收到 ensure-tab 后按 id 打开终端页签即可接管输入。
 */
const jobHost = createJobHost({
  terminals: terminalManager,
  notify: (event) => {
    if (event.type !== "start" || !event.id) return;
    const win = mainWindow;
    if (win && !win.isDestroyed()) {
      win.webContents.send("meow:job-ensure-tab", {
        id: event.id,
        command: event.command ?? "",
      });
    }
  },
});
void jobHost.start().catch((error) => {
  console.error(`[meowcode] job host failed: ${error?.message ?? error}`);
});
app.on("before-quit", () => {
  terminalManager.disposeAll();
  void mailHost.dispose();
  jobHost.close();
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
    const nextProvider = { ...provider };
    if ("reasoningEffort" in patch) {
      nextProvider.reasoningEffort = patch.reasoningEffort || undefined;
    }
    if (typeof patch.enabled === "boolean") {
      nextProvider.enabled = patch.enabled;
    }
    return nextProvider;
  });
  const next = { ...settings, providers };
  if (typeof prefs?.providerId === "string" && prefs.providerId) {
    next.providerId = prefs.providerId;
  }
  // 记忆总开关：只写盘（启动时经 MEOWCODE_MEMORY 传给 server），
  // 实时生效走 /config/memory，由渲染层另行调用——绝不走 saveSettings
  if (typeof prefs?.memoryEnabled === "boolean") {
    next.memoryEnabled = prefs.memoryEnabled;
  }
  // 自我学习开关：同款双通道 —— 落盘供下次启动，实时生效走 /config/learning
  if (typeof prefs?.selfLearning === "boolean") {
    next.selfLearning = prefs.selfLearning;
  }
  // 网络代理：落盘供下次启动，实时生效走 /config/proxy
  if (PROXY_MODES.includes(prefs?.proxyMode)) {
    next.proxyMode = prefs.proxyMode;
  }
  if (typeof prefs?.proxyUrl === "string") {
    next.proxyUrl = prefs.proxyUrl;
  }
  // 命令沙箱：落盘供下次启动，实时生效走 PUT /config/sandbox
  if (prefs?.sandbox && typeof prefs.sandbox === "object") {
    next.sandbox = normalizeSandbox({ ...next.sandbox, ...prefs.sandbox });
  }
  writeSettings(next);
  return publicSettings(next);
});

// ---- 轻量偏好：主题 / 关闭方式（只写盘，绝不重启 agent server）----

ipcMain.handle("meow:get-preferences", () => {
  const settings = readSettings();
  return {
    theme: THEME_PREFERENCES.includes(settings.theme) ? settings.theme : "system",
    palette: PALETTES.includes(settings.palette) ? settings.palette : "classic",
    closeAction: CLOSE_ACTIONS.includes(settings.closeAction) ? settings.closeAction : "ask",
    language: LANGUAGE_PREFERENCES.includes(settings.language) ? settings.language : "system",
    speechStyle: SPEECH_STYLES.includes(settings.speechStyle) ? settings.speechStyle : "normal",
    progressPillDismiss: PROGRESS_PILL_DISMISS.includes(settings.progressPillDismiss)
      ? settings.progressPillDismiss
      : "commit",
    onboardingCompleted:
      typeof settings.onboardingCompleted === "boolean" ? settings.onboardingCompleted : true,
    archivedSessions: Array.isArray(settings.archivedSessions) ? settings.archivedSessions : [],
    projectNames: settings.projectNames && typeof settings.projectNames === "object" ? settings.projectNames : {},
    pinnedProjects: Array.isArray(settings.pinnedProjects) ? settings.pinnedProjects : [],
    removedProjects: Array.isArray(settings.removedProjects) ? settings.removedProjects : [],
    // 缺省视为开启静默下载（boolean 存量用户没有这个字段）
    silentUpdate: typeof settings.silentUpdate === "boolean" ? settings.silentUpdate : true,
    // 系统通知：默认开启
    notifications: typeof settings.notifications === "boolean" ? settings.notifications : true,
    // 标题栏公告：默认开启
    announcements: typeof settings.announcements === "boolean" ? settings.announcements : true,
    // AI 悬浮岛：默认关闭
    floatingIsland: typeof settings.floatingIsland === "boolean" ? settings.floatingIsland : false,
    // 输入建议：每轮回合后预测下一句（默认关闭，开启前会提示额外 token）
    nextPromptSuggestions:
      typeof settings.nextPromptSuggestions === "boolean" ? settings.nextPromptSuggestions : false,
    mailAiProviderId:
      typeof settings.mailAiProviderId === "string" ? settings.mailAiProviderId : "",
    worktreeFetchUpstream:
      typeof settings.worktreeFetchUpstream === "boolean" ? settings.worktreeFetchUpstream : false,
    worktreeAutoCleanup:
      typeof settings.worktreeAutoCleanup === "boolean" ? settings.worktreeAutoCleanup : true,
    worktreeMaxKeep:
      typeof settings.worktreeMaxKeep === "number" ? settings.worktreeMaxKeep : 15,
    includeAgentsMd: typeof settings.includeAgentsMd === "boolean" ? settings.includeAgentsMd : true,
    includeClaudeMd: typeof settings.includeClaudeMd === "boolean" ? settings.includeClaudeMd : true,
    // 会话回滚（文件快照）：默认开启
    rewindSnapshots:
      typeof settings.rewindSnapshots === "boolean" ? settings.rewindSnapshots : true,
    rewindKeepCheckpoints:
      typeof settings.rewindKeepCheckpoints === "number" ? settings.rewindKeepCheckpoints : 120,
    rewindMaxTotalMb:
      typeof settings.rewindMaxTotalMb === "number" ? settings.rewindMaxTotalMb : 512,
    fontFamily: typeof settings.fontFamily === "string" ? settings.fontFamily : "",
    codeFontFamily: typeof settings.codeFontFamily === "string" ? settings.codeFontFamily : "",
  };
});

ipcMain.handle("meow:save-preferences", (_event, prefs) => {
  ensureDirs();
  const settings = readSettings();
  const next = { ...settings };
  if (prefs?.theme !== undefined && THEME_PREFERENCES.includes(prefs.theme)) {
    next.theme = prefs.theme;
  }
  // 配色方案：轻量通道，只写盘 + 换窗口底色，绝不重启 agent server
  if (prefs?.palette !== undefined && PALETTES.includes(prefs.palette)) {
    next.palette = prefs.palette;
  }
  if (prefs?.closeAction !== undefined && CLOSE_ACTIONS.includes(prefs.closeAction)) {
    next.closeAction = prefs.closeAction;
  }
  if (prefs?.language !== undefined && LANGUAGE_PREFERENCES.includes(prefs.language)) {
    next.language = prefs.language;
  }
  // 语色：实时生效由渲染层先调 /config/speech-style，这里只负责落盘
  if (prefs?.speechStyle !== undefined && SPEECH_STYLES.includes(prefs.speechStyle)) {
    next.speechStyle = prefs.speechStyle;
  }
  // 信息胶囊收起时机：纯渲染层偏好，只写盘，不重启 agent server
  if (
    prefs?.progressPillDismiss !== undefined &&
    PROGRESS_PILL_DISMISS.includes(prefs.progressPillDismiss)
  ) {
    next.progressPillDismiss = prefs.progressPillDismiss;
  }
  // 工作区只决定「新建会话的默认目录」（/session/new 每次都会带 cwd）。
  // 绝不能走 meow:save-settings：那条路会 startServer() 重启 agent server，
  // 把运行中的回合和后台会话一起杀掉——这正是「换工作区后对话就结束」的根因。
  if (typeof prefs?.workspace === "string" && prefs.workspace.trim()) {
    next.workspace = prefs.workspace.trim();
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
  if (typeof prefs?.silentUpdate === "boolean") {
    next.silentUpdate = prefs.silentUpdate;
  }
  if (typeof prefs?.notifications === "boolean") {
    next.notifications = prefs.notifications;
  }
  // 标题栏公告开关：纯渲染层偏好，只写盘，不重启 agent server
  if (typeof prefs?.announcements === "boolean") {
    next.announcements = prefs.announcements;
  }
  // 界面字体：空串 = 默认 MiSans
  if (typeof prefs?.fontFamily === "string") {
    next.fontFamily = prefs.fontFamily.slice(0, 120);
  }
  // 代码字体：空串 = 默认等宽栈
  if (typeof prefs?.codeFontFamily === "string") {
    next.codeFontFamily = prefs.codeFontFamily.slice(0, 120);
  }
  // AI 悬浮岛开关：默认关闭
  if (typeof prefs?.floatingIsland === "boolean") {
    next.floatingIsland = prefs.floatingIsland;
  }
  // 输入建议：默认关闭；只影响渲染层是否在回合后请求预测
  if (typeof prefs?.nextPromptSuggestions === "boolean") {
    next.nextPromptSuggestions = prefs.nextPromptSuggestions;
  }
  // 邮件 AI 写作模型：空串 = 跟随聊天模型；只写盘，不重启 agent server
  if (typeof prefs?.mailAiProviderId === "string") {
    next.mailAiProviderId = prefs.mailAiProviderId.trim();
  }
  // 供应商故障转移：默认关闭；实时生效走 /config/provider-fallback
  if (typeof prefs?.providerFallback === "boolean") {
    next.providerFallback = prefs.providerFallback;
  }
  // Worktrees：创建前 fetch / 自动清理 / 保留上限
  if (typeof prefs?.worktreeFetchUpstream === "boolean") {
    next.worktreeFetchUpstream = prefs.worktreeFetchUpstream;
  }
  if (typeof prefs?.worktreeAutoCleanup === "boolean") {
    next.worktreeAutoCleanup = prefs.worktreeAutoCleanup;
  }
  if (typeof prefs?.worktreeMaxKeep === "number" && Number.isFinite(prefs.worktreeMaxKeep)) {
    next.worktreeMaxKeep = Math.max(1, Math.min(100, Math.round(prefs.worktreeMaxKeep)));
  }
  // AGENTS.md / CLAUDE.md 导入开关
  if (typeof prefs?.includeAgentsMd === "boolean") {
    next.includeAgentsMd = prefs.includeAgentsMd;
  }
  if (typeof prefs?.includeClaudeMd === "boolean") {
    next.includeClaudeMd = prefs.includeClaudeMd;
  }
  // 插件 UI 授权记忆：按插件 id 合并进 settings.plugins.approvals。
  // 只写盘、不重启 agent server：启用插件弹授权时批准，不该杀掉运行中的回合。
  if (
    prefs?.pluginApprovals &&
    typeof prefs.pluginApprovals === "object" &&
    !Array.isArray(prefs.pluginApprovals)
  ) {
    const approvals = { ...(settings.plugins?.approvals ?? {}) };
    for (const [pluginId, record] of Object.entries(prefs.pluginApprovals)) {
      if (!pluginId.trim() || !record || typeof record !== "object" || Array.isArray(record)) continue;
      const version = typeof record.version === "string" ? record.version.trim() : "";
      if (!version) continue;
      approvals[pluginId] = {
        version,
        permissions: Array.isArray(record.permissions)
          ? record.permissions.filter((item) => typeof item === "string" && item.trim())
          : [],
        approvedAt:
          typeof record.approvedAt === "string" && record.approvedAt.trim()
            ? record.approvedAt
            : new Date().toISOString(),
        ...(record.declined === true ? { declined: true } : {}),
      };
    }
    next.plugins = { ...(next.plugins ?? {}), approvals };
  }
  // 读-改-写：保留 providers 里的 apiKeyEncrypted
  writeSettings(next);
  if (prefs?.language !== undefined) {
    // 托盘菜单是原生 UI，切语言后必须重建才会跟着变
    updateTrayMenu();
  }
  if (prefs?.theme !== undefined) {
    applyWindowTheme(next.theme);
    if (mainWindow && !mainWindow.isDestroyed() && !ACRYLIC_BACKDROP) {
      mainWindow.setBackgroundColor(windowBackground(next.theme, next.palette));
    }
  }
  // 只换配色：明暗不变，但窗口底色要跟着换成新配色的 --bg-root，否则面板间隙会露出旧色
  if (prefs?.theme === undefined && prefs?.palette !== undefined) {
    if (mainWindow && !mainWindow.isDestroyed() && !ACRYLIC_BACKDROP) {
      mainWindow.setBackgroundColor(windowBackground(next.theme, next.palette));
    }
  }
  // 悬浮岛开关变化：按需创建/销毁窗口（比较旧值，避免无谓重建闪一下）
  if (
    typeof prefs?.floatingIsland === "boolean" &&
    prefs.floatingIsland !== (typeof settings.floatingIsland === "boolean" ? settings.floatingIsland : false)
  ) {
    if (prefs.floatingIsland) {
      createIslandWindow();
    } else {
      destroyIslandWindow();
    }
  }
  // 广播给所有窗口（含悬浮岛）：岛据此跟随主题/语言变化
  broadcast("meow:preferences-changed", publicSettings(next));
  return {
    theme: next.theme,
    // 这里是一份手写白名单，不是 publicSettings()：漏一个字段渲染层就收不到回执，
    // 表现为「界面换色了但选中态不动」（乐观更新生效、落盘回执被丢弃）
    palette: PALETTES.includes(next.palette) ? next.palette : "classic",
    closeAction: next.closeAction,
    language: LANGUAGE_PREFERENCES.includes(next.language) ? next.language : "system",
    progressPillDismiss: PROGRESS_PILL_DISMISS.includes(next.progressPillDismiss)
      ? next.progressPillDismiss
      : "commit",
    onboardingCompleted:
      typeof next.onboardingCompleted === "boolean" ? next.onboardingCompleted : true,
    archivedSessions: Array.isArray(next.archivedSessions) ? next.archivedSessions : [],
    projectNames: next.projectNames ?? {},
    pinnedProjects: Array.isArray(next.pinnedProjects) ? next.pinnedProjects : [],
    removedProjects: Array.isArray(next.removedProjects) ? next.removedProjects : [],
    silentUpdate: typeof next.silentUpdate === "boolean" ? next.silentUpdate : true,
    notifications: typeof next.notifications === "boolean" ? next.notifications : true,
    announcements: typeof next.announcements === "boolean" ? next.announcements : true,
    floatingIsland: typeof next.floatingIsland === "boolean" ? next.floatingIsland : false,
    nextPromptSuggestions:
      typeof next.nextPromptSuggestions === "boolean" ? next.nextPromptSuggestions : false,
    worktreeFetchUpstream:
      typeof next.worktreeFetchUpstream === "boolean" ? next.worktreeFetchUpstream : false,
    worktreeAutoCleanup:
      typeof next.worktreeAutoCleanup === "boolean" ? next.worktreeAutoCleanup : true,
    worktreeMaxKeep: typeof next.worktreeMaxKeep === "number" ? next.worktreeMaxKeep : 15,
    includeAgentsMd: typeof next.includeAgentsMd === "boolean" ? next.includeAgentsMd : true,
    includeClaudeMd: typeof next.includeClaudeMd === "boolean" ? next.includeClaudeMd : true,
    fontFamily: typeof next.fontFamily === "string" ? next.fontFamily : "",
    codeFontFamily: typeof next.codeFontFamily === "string" ? next.codeFontFamily : "",
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

// ---- 界面字体：导入自定义字体文件（拷贝到 userData/fonts 并记入 settings）----

function customFontsDir() {
  return path.join(app.getPath("userData"), "fonts");
}

/** 文件名清洗成可安全落盘的名字 */
function safeFontFileName(name) {
  const base = String(name || "")
    .split(/[\\/]/)
    .pop()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .trim();
  return base || "font.ttf";
}

const FONT_MIME = {
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttc": "font/collection",
};

/**
 * 已导入的自定义字体：[{family, url}]。
 * url 是 data URL —— file:// 直链指向应用目录之外，会被 Chromium 的文件同源策略拦掉。
 */
ipcMain.handle("meow:list-custom-fonts", async () => {
  const settings = readSettings();
  const dir = customFontsDir();
  const list = Array.isArray(settings.customFonts) ? settings.customFonts : [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item.fileName !== "string") continue;
    const target = path.join(dir, item.fileName);
    if (!fs.existsSync(target)) continue;
    const ext = path.extname(target).toLowerCase();
    const data = await fs.promises.readFile(target);
    out.push({
      family: String(item.family || item.fileName),
      url: `data:${FONT_MIME[ext] || "font/ttf"};base64,${data.toString("base64")}`,
    });
  }
  return out;
});

// ---- 会话导出：选路径 → 主进程拉内容 → 写盘 ----
// 渲染层没有 fs，也不该把几 MB 的 Markdown 走 IPC；内容由 server 产出，这里直接落盘。
ipcMain.handle("meow:export-session", async (_event, payload) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: "No window." };
  const request = payload && typeof payload === "object" ? payload : {};
  const format = request.format === "json" ? "json" : request.format === "html" ? "html" : "markdown";
  const extension = format === "json" ? "json" : format === "html" ? "html" : "md";
  const ui = uiStrings();
  const rawTitle = typeof request.title === "string" && request.title.trim() ? request.title.trim() : "session";
  const safeName =
    rawTitle
      .replace(/[\\/:*?"<>|\s]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "session";
  const picked = await dialog.showSaveDialog(mainWindow, {
    title: ui.exportSession,
    defaultPath: path.join(app.getPath("documents"), `${safeName}.${extension}`),
    filters: [
      {
        name:
          format === "json" ? ui.jsonFiles : format === "html" ? ui.htmlFiles : ui.markdownFiles,
        extensions: [extension],
      },
    ],
  });
  if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
  try {
    const base = await waitForServerReady();
    const response = await fetch(`${base}/session/export`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${serverToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        filePath: request.filePath,
        format,
        includeThinking: request.includeThinking !== false,
        includeTools: request.includeTools !== false,
        inlineImages: request.inlineImages !== false,
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return { ok: false, error: text || `Export failed (${response.status})` };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(picked.filePath, buffer);
    return { ok: true, filePath: picked.filePath, bytes: buffer.byteLength };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle("meow:import-font", async () => {
  const ui = uiStrings();
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: ui.importFont,
    properties: ["openFile"],
    filters: [{ name: ui.fontFiles, extensions: ["ttf", "otf", "woff", "woff2", "ttc"] }],
  });
  if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };
  const source = picked.filePaths[0];
  const fileName = safeFontFileName(path.basename(source));
  const dir = customFontsDir();
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.copyFile(source, path.join(dir, fileName));
  // 展示名与 @font-face 族名都用文件名（去扩展名）
  const family = fileName.replace(/\.(ttf|otf|woff2?|ttc)$/i, "") || fileName;
  const settings = readSettings();
  const list = (Array.isArray(settings.customFonts) ? settings.customFonts : []).filter(
    (item) => item && item.fileName !== fileName,
  );
  writeSettings({ ...settings, customFonts: [...list, { family, fileName }] });
  return { ok: true, family };
});

/** 删除已导入的自定义字体：清 settings 记录并删掉字体文件 */
ipcMain.handle("meow:remove-custom-font", async (_event, family) => {
  const name = String(family || "");
  const settings = readSettings();
  const list = Array.isArray(settings.customFonts) ? settings.customFonts : [];
  const hit = list.find((item) => item && (item.family === name || item.fileName === name));
  if (!hit) return { ok: false };
  writeSettings({ ...settings, customFonts: list.filter((item) => item !== hit) });
  await fs.promises.rm(path.join(customFontsDir(), hit.fileName), { force: true }).catch(() => undefined);
  return { ok: true };
});

// ---- 更新检查 / 下载 / 安装（逻辑见 update-check.cjs、update-download.cjs，可单测）----
const { checkForUpdate } = require("./update-check.cjs");
const { downloadToFile, safeAssetFileName } = require("./update-download.cjs");

// 商店版（MSIX）标记：更新由 Microsoft Store 接管，渲染层据此隐藏检查更新入口
ipcMain.on("meow:store-managed", (event) => {
  event.returnValue = process.windowsStore === true;
});

ipcMain.handle("meow:check-update", async () => {
  // 商店版（MSIX）由 Microsoft Store 负责更新：不再引导用户下载 NSIS 安装包，
  // 否则会装出一个并行的副本，也不符合商店对自更新的要求。
  if (process.windowsStore) {
    return { ok: true, current: app.getVersion(), latest: null, hasUpdate: false };
  }
  return checkForUpdate(app.getVersion());
});

/** 更新包存放目录：系统「下载」文件夹（用户自己也能找到安装包） */
function updateDownloadsDir() {
  return app.getPath("downloads");
}

// 任意时刻只允许一个更新下载在跑：静默下载与更新弹窗共用一个任务
let activeUpdateDownload = null;

ipcMain.handle("meow:download-update", async (_event, payload) => {
  const url = String(payload?.url || "");
  if (!/^https?:\/\//i.test(url)) throw new Error("下载地址不合法");
  const fileName = safeAssetFileName(String(payload?.fileName || "MeowCode-Setup.exe"));

  const current = activeUpdateDownload;
  if (current) {
    // 同一个安装包：搭当前下载的车，返回同一份结果（静默 + 弹窗手动就是这种）
    if (current.url === url && current.fileName === fileName) return current.promise;
    // 别的包：等它下完再开新的，保证同时只有一个下载在跑
    await current.promise.catch(() => undefined);
  }

  const promise = (async () => {
    const dir = updateDownloadsDir();
    await fs.promises.mkdir(dir, { recursive: true });
    const target = path.join(dir, fileName);
    const result = await downloadToFile({
      url,
      target,
      onProgress: (progress) => broadcast("meow:update-progress", progress),
    });
    return { path: result.path, size: result.received };
  })();

  activeUpdateDownload = { url, fileName, promise };
  try {
    return await promise;
  } finally {
    if (activeUpdateDownload && activeUpdateDownload.promise === promise) {
      activeUpdateDownload = null;
    }
  }
});

ipcMain.handle("meow:open-installer", async (_event, filePath) => {
  const target = path.resolve(String(filePath || ""));
  const dir = path.resolve(updateDownloadsDir());
  // 只允许打开下载目录里的文件：渲染层传来的路径不可全信
  if (!target.startsWith(dir + path.sep)) throw new Error("安装包路径不合法");
  if (!fs.existsSync(target)) throw new Error("安装包不存在");
  if (process.platform === "darwin") {
    // macOS：挂载 dmg，让用户在访达里拖拽安装
    await shell.openPath(target);
    return { launched: true, quit: false };
  }
  if (process.platform === "win32") {
    // NSIS 安装包 manifest 是 requireAdministrator，直接 spawn 会 EACCES；
    // 走 ShellExecute 才会弹 UAC
    const failure = await shell.openPath(target);
    if (failure) throw new Error(`无法启动安装包：${failure}`);
    // 安装包要覆盖正在运行的文件，得先把应用退掉；窗口立刻收起，
    // 会话落盘等优雅关停留在后台完成
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
    destroyIslandWindow();
    setTimeout(() => app.quit(), 300);
    return { launched: true, quit: true };
  }
  if (process.platform === "linux") {
    await fs.promises.chmod(target, 0o755).catch(() => undefined);
  }
  const { spawn } = require("node:child_process");
  const child = spawn(target, [], { detached: true, stdio: "ignore" });
  // spawn 的失败通过 error 事件异步返回；不监听会变成主进程未捕获异常
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(new Error(`无法启动安装包：${error.message}`));
    child.once("error", onError);
    child.once("spawn", () => {
      child.removeListener("error", onError);
      // 启动后仍可能收到 error；吞掉，避免子进程退出拖垮主进程
      child.on("error", () => undefined);
      resolve();
    });
  });
  child.unref();
  return { launched: true, quit: false };
});

ipcMain.handle("meow:model-profiles", () => modelProfiles);

// ---- AI 悬浮岛 IPC ----

/** 渲染层上报岛体交互矩形（视口 CSS 坐标）：换算成屏幕坐标供轮询判定 */
ipcMain.handle("meow:island-rect", (_event, rect) => {
  const win = islandWindow;
  if (!win || win.isDestroyed() || !rect || typeof rect !== "object") return;
  const x = Number(rect.x);
  const y = Number(rect.y);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (![x, y, width, height].every(Number.isFinite)) return;
  const bounds = win.getContentBounds();
  islandHoverRect = { x: bounds.x + x, y: bounds.y + y, width, height };
});

/** 悬浮岛发出的 prompt 广播给主窗口：当前会话命中时由渲染层补用户气泡（服务端事件不带用户消息文本） */
ipcMain.handle("meow:island-notify-prompt", (_event, payload) => {
  if (!payload || typeof payload.sessionId !== "string" || !payload.sessionId) return;
  broadcast("meow:island-prompt-sent", {
    sessionId: payload.sessionId,
    text: typeof payload.text === "string" ? payload.text : "",
  });
});

// ---- 自动化（定时任务）：列表/保存/删除/启停/立即运行/打开历史会话 ----
ipcMain.handle("meow:automations-list", () => automationScheduler.list());
ipcMain.handle("meow:automations-save", (_event, input) => automationScheduler.save(input));
ipcMain.handle("meow:automations-delete", (_event, id) => automationScheduler.remove(String(id ?? "")));
ipcMain.handle("meow:automations-toggle", (_event, id, enabled) =>
  automationScheduler.setEnabled(String(id ?? ""), Boolean(enabled)),
);
ipcMain.handle("meow:automations-run-now", (_event, id) => automationScheduler.runNow(String(id ?? "")));
/** 历史里「打开会话」：与通知点击同一条跳转链路（唤窗 + 托盘切换通道） */
ipcMain.handle("meow:automations-open-session", (_event, sessionId) => {
  showMainWindow();
  void focusSessionFromNotification(String(sessionId ?? ""));
});

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
    automationScheduler.start();
    ensureDefaultWorkspace();
    reportStartupStatistics();
    // 界面字体设置要枚举系统字体（Local Font Access）：应用窗口自身放行该权限，
    // 其余权限维持 Electron 默认行为（这里的处理器只保证 local-fonts 不被拦）
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(true));
    session.defaultSession.setPermissionCheckHandler(() => true);
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
    // AI 悬浮岛：设置里开着就随应用启动（island 渲染层自行拉快照、带重试）
    if (readSettings().floatingIsland) {
      createIslandWindow();
    }
    // 先读本机缓存，过期再后台拉取；拉取完成后会把新规则推给渲染层
    fetchModelProfiles();
    setInterval(fetchModelProfiles, MODEL_PROFILES_TTL).unref();
    // 公告：先展示磁盘缓存，再后台拉取（失败静默），每 3 小时刷新
    noticeController = createNoticeController({
      cachePath: path.join(settingsDir, "announcement.json"),
      onUpdate: (notice) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          try {
            mainWindow.webContents.send("meow:announcement", notice);
          } catch {
            // 窗口正在销毁
          }
        }
      },
    });
    ipcMain.handle("meow:announcement", () => noticeController?.get() ?? null);
    ipcMain.handle("meow:announcement-dismiss", (_event, id) => {
      noticeController?.dismiss(typeof id === "string" ? id : "");
      return null;
    });
    noticeController.start();
    try {
      await browserHost.start();
    } catch (error) {
      // 桥起不来不阻塞应用启动：agent 侧浏览器工具会自动降级为不可用
      console.error("[MeowCode] Failed to start browser host:", error);
    }
    try {
      await computerHost.start();
    } catch (error) {
      // 桥起不来不阻塞应用启动：agent 侧电脑控制工具会自动降级为不可用
      console.error("[MeowCode] Failed to start computer host:", error);
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
  // 悬浮岛先于窗口关闭流程销毁，避免 WebView 销毁时闪现原生边框
  destroyIslandWindow();
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
    automationScheduler.stop();
    browserHost.stop();
    computerHost.stop();
    noticeController?.stop();
    void stopServer().finally(() => {
      quitAfterShutdown = true;
      app.quit();
    });
    return;
  }
  isQuitting = true;
  automationScheduler.stop();
  browserHost.stop();
  computerHost.stop();
  noticeController?.stop();
});
