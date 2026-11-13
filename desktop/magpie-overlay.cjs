const fs = require("node:fs");

/**
 * magpie 的 Agent 插件写得进 MeowCode 的只有一个它自己的文件
 * （`agent/magpie.json`）：MeowCode 在启动时把它当作覆盖层并进服务商列表，
 * 写盘时再剔除，用户自己的 providers 与加密密钥都不受影响。
 */

const MAGPIE_ID_PREFIX = "magpie/";
const LOOPBACK_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;
const PROTOCOLS = new Set(["openai-chat-completions", "openai-responses", "anthropic-messages"]);

function isMagpieProviderId(id) {
  return typeof id === "string" && id.startsWith(MAGPIE_ID_PREFIX);
}

function cleanHeaders(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key || typeof value !== "string") continue;
    // 头部值不能带换行，否则等于把请求头拆开
    out[key] = value.replace(/[\r\n]+/g, " ").trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function cleanProvider(raw, seen) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!isMagpieProviderId(id) || seen.has(id)) return null;
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "";
  // 只认本机网关：这个文件本地可写，不能让伪造的条目把请求带到外网
  if (!model || !LOOPBACK_URL.test(baseUrl)) return null;
  const provider = {
    id,
    name: typeof raw.name === "string" && raw.name ? raw.name : "Magpie",
    baseUrl,
    model,
    protocol: PROTOCOLS.has(raw.protocol) ? raw.protocol : "openai-chat-completions",
    authStyle: "none",
    enabled: raw.enabled !== false,
  };
  if (typeof raw.displayName === "string" && raw.displayName) provider.displayName = raw.displayName;
  const headers = cleanHeaders(raw.extraHeaders);
  if (headers) provider.extraHeaders = headers;
  if (Number.isFinite(raw.contextWindow) && raw.contextWindow > 0) provider.contextWindow = raw.contextWindow;
  if (Number.isFinite(raw.maxTokens) && raw.maxTokens > 0) provider.maxTokens = raw.maxTokens;
  if (Array.isArray(raw.inputModalities)) {
    const modalities = raw.inputModalities.filter((m) => m === "text" || m === "image" || m === "pdf");
    if (modalities.length) provider.inputModalities = modalities;
  }
  seen.add(id);
  return provider;
}

/** 解析覆盖层文件内容；不是对象、没有可用条目一律 null。 */
function parseMagpieFile(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const list = Array.isArray(raw.providers) ? raw.providers : [];
  const seen = new Set();
  const providers = [];
  for (const item of list) {
    const provider = cleanProvider(item, seen);
    if (provider) providers.push(provider);
  }
  if (!providers.length) return null;
  const ids = new Set(providers.map((p) => p.id));
  const providerId =
    typeof raw.providerId === "string" && ids.has(raw.providerId) ? raw.providerId : providers[0].id;
  return { providerId, providers };
}

const MAGPIE_FILE_NAME = "magpie.json";
let snapshot;

/** 启动时读一次（magpie 连上/断开都要重启 MeowCode 才生效，和 server 侧一致）。 */
function loadMagpieOverlay(candidates) {
  if (snapshot !== undefined) return snapshot;
  let best = null;
  for (const file of candidates ?? []) {
    if (!file) continue;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      if (!best || stat.mtimeMs > best.mtimeMs) best = { path: file, mtimeMs: stat.mtimeMs };
    } catch {
      // 不存在或不可读：当作没有覆盖层
    }
  }
  if (!best) {
    snapshot = null;
    return snapshot;
  }
  let overlay = null;
  try {
    // 不用 readJsonWithBackup：它会把坏文件改名移走，而这份文件由 magpie 独占
    overlay = parseMagpieFile(fs.readFileSync(best.path, "utf8"));
  } catch {
    overlay = null;
  }
  snapshot = overlay ? { path: best.path, overlay } : null;
  return snapshot;
}

function resetMagpieOverlayCache() {
  snapshot = undefined;
}

function stripMagpieProviders(providers) {
  if (!Array.isArray(providers)) return [];
  return providers.filter((provider) => !isMagpieProviderId(provider?.id));
}

function applyProviderPrefs(provider, prefs) {
  if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) return provider;
  const next = { ...provider };
  if (typeof prefs.reasoningEffort === "string" && prefs.reasoningEffort) {
    next.reasoningEffort = prefs.reasoningEffort;
  }
  if (typeof prefs.enabled === "boolean") next.enabled = prefs.enabled;
  return next;
}

/**
 * 合并规则（providerId）：
 *  - 没有覆盖层：清掉 magpieAppliedId，失效的 providerId 回退到第一个可用服务商；
 *  - magpie 选了新模型（与上次生效的不同）：切过去并记下，下次不会再抢；
 *  - 其余情况保留用户自己在 MeowCode 里选的。
 */
function mergeMagpieSettings(settings, overlay) {
  const base = settings && typeof settings === "object" ? settings : {};
  const own = stripMagpieProviders(base.providers);
  if (!overlay) {
    return resolveActive({ ...base, providers: own, magpieAppliedId: undefined });
  }
  const prefs = base.providerPrefs && typeof base.providerPrefs === "object" ? base.providerPrefs : {};
  const providers = [
    ...own,
    ...overlay.providers.map((provider) => applyProviderPrefs(provider, prefs[provider.id])),
  ];
  let providerId = base.providerId;
  let magpieAppliedId = base.magpieAppliedId;
  if (overlay.providerId && overlay.providerId !== magpieAppliedId) {
    providerId = overlay.providerId;
    magpieAppliedId = overlay.providerId;
  }
  return resolveActive({ ...base, providers, providerId, magpieAppliedId });
}

/** providerId 必须指向一条可用记录；否则第一个启用项，再否则第一个。 */
function resolveActive(settings) {
  const providers = settings.providers;
  const active = providers.find((p) => p.id === settings.providerId && p.enabled !== false);
  if (active) return settings;
  const fallback = providers.find((p) => p.enabled !== false) ?? providers[0];
  const providerId = fallback ? fallback.id : undefined;
  if (providerId === settings.providerId) return settings;
  return { ...settings, providerId };
}

module.exports = {
  MAGPIE_FILE_NAME,
  applyProviderPrefs,
  isMagpieProviderId,
  loadMagpieOverlay,
  mergeMagpieSettings,
  parseMagpieFile,
  resetMagpieOverlayCache,
  stripMagpieProviders,
};
