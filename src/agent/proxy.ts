/**
 * 网络代理。
 *
 * 三种模式：
 *  - direct：直连（默认，与加代理之前的行为完全一致）
 *  - system：跟随系统 —— 优先用桌面端解析好的 MEOWCODE_PROXY_URL，
 *            其次 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY（Node 生态的通行约定），
 *            并按 NO_PROXY 跳过本地地址
 *  - manual：用户手填代理地址
 *
 * 实现用 undici 的 ProxyAgent 作为 fetch 的 dispatcher（Node 的全局 fetch 就是
 * undici，认这个扩展字段）。配置是进程级的，所以放在模块状态里，由 runtime 在
 * 启动和设置页切换时调用 setProxyConfig() 热更新。
 */
import { ProxyAgent, type Dispatcher } from "undici";

export type ProxyMode = "direct" | "system" | "manual";

export type ProxyConfig = {
  mode: ProxyMode;
  /** manual 模式下必填；其他模式忽略。 */
  url: string;
};

export const DEFAULT_PROXY_CONFIG: ProxyConfig = { mode: "direct", url: "" };

/** 当前生效的代理配置。 */
let activeConfig: ProxyConfig = { ...DEFAULT_PROXY_CONFIG };

/** 按代理地址缓存 dispatcher：ProxyAgent 会持有连接池，每次新建等于每次都重连。 */
const dispatchers = new Map<string, Dispatcher>();

export function isProxyMode(value: unknown): value is ProxyMode {
  return value === "direct" || value === "system" || value === "manual";
}

/**
 * 规范化代理地址：补 http:// 前缀、去尾部斜杠、校验协议。
 * 非法地址返回 undefined（调用方按直连处理，而不是让整个请求炸掉）。
 */
export function normalizeProxyUrl(raw: string): string | undefined {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    if (!parsed.hostname) return undefined;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/$/, "")}`;
  } catch {
    return undefined;
  }
}

/** 打日志/给 UI 看时抹掉代理里的账号密码。 */
export function maskProxyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = "***";
    parsed.password = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

/** NO_PROXY 匹配：支持 `*`、裸域名、前导点、`host:port`。 */
export function shouldBypassProxy(target: string, noProxy: string): boolean {
  const entries = (noProxy ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (!entries.length) return false;
  let host: string;
  try {
    host = new URL(target).hostname.toLowerCase();
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry === "*") return true;
    const bare = entry.replace(/^\./, "").replace(/:\d+$/, "");
    if (!bare) continue;
    if (host === bare || host.endsWith(`.${bare}`)) return true;
  }
  return false;
}

/** 从环境变量读初始配置（server 启动时用）。 */
export function readProxyFromEnv(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const mode = env.MEOWCODE_PROXY_MODE;
  if (isProxyMode(mode)) {
    return { mode, url: (env.MEOWCODE_PROXY_URL ?? "").trim() };
  }
  // 只给了地址没给模式：按手动配置处理（env 用户的直觉）
  const url = (env.MEOWCODE_PROXY_URL ?? "").trim();
  return url ? { mode: "manual", url } : { ...DEFAULT_PROXY_CONFIG };
}

export function getProxyConfig(): ProxyConfig {
  return { ...activeConfig };
}

/** 热更新：清空 dispatcher 缓存，下一次请求用新代理。 */
export function setProxyConfig(config: ProxyConfig): void {
  const next: ProxyConfig = isProxyMode(config.mode)
    ? { mode: config.mode, url: (config.url ?? "").trim() }
    : { ...DEFAULT_PROXY_CONFIG };
  if (next.mode === activeConfig.mode && next.url === activeConfig.url) return;
  activeConfig = next;
  for (const dispatcher of dispatchers.values()) {
    void dispatcher.close?.().catch(() => undefined);
  }
  dispatchers.clear();
}

/**
 * 当前配置下应该使用的代理地址；不需要代理时返回 undefined。
 * system 模式额外读一次 NO_PROXY，让本地服务（Ollama / vLLM）绕过代理。
 */
export function resolveProxyUrl(
  config: ProxyConfig = activeConfig,
  env: NodeJS.ProcessEnv = process.env,
  target?: string,
): string | undefined {
  if (config.mode === "direct") return undefined;
  if (config.mode === "manual") return normalizeProxyUrl(config.url);
  const systemUrl =
    normalizeProxyUrl(env.MEOWCODE_PROXY_URL ?? "") ??
    normalizeProxyUrl(env.HTTPS_PROXY ?? "") ??
    normalizeProxyUrl(env.https_proxy ?? "") ??
    normalizeProxyUrl(env.HTTP_PROXY ?? "") ??
    normalizeProxyUrl(env.http_proxy ?? "") ??
    normalizeProxyUrl(env.ALL_PROXY ?? "") ??
    normalizeProxyUrl(env.all_proxy ?? "");
  if (!systemUrl) return undefined;
  if (target && shouldBypassProxy(target, env.NO_PROXY ?? env.no_proxy ?? "")) return undefined;
  return systemUrl;
}

function dispatcherFor(proxyUrl: string): Dispatcher {
  const cached = dispatchers.get(proxyUrl);
  if (cached) return cached;
  const agent = new ProxyAgent(proxyUrl);
  dispatchers.set(proxyUrl, agent);
  return agent;
}

/**
 * 给 fetch 的 init 补上 dispatcher。
 * 不是代理目标时原样返回，调用方不需要判断。
 */
export function applyProxy(init: RequestInit, target: string): RequestInit {
  const proxyUrl = resolveProxyUrl(activeConfig, process.env, target);
  if (!proxyUrl) return init;
  try {
    return { ...init, dispatcher: dispatcherFor(proxyUrl) } as RequestInit;
  } catch {
    // 代理地址构造失败就退回直连：连不上比整段请求抛错更容易排查
    return init;
  }
}

/** 供设置页展示的一句话描述。 */
export function describeProxy(config: ProxyConfig = activeConfig): string {
  if (config.mode === "direct") return "direct";
  if (config.mode === "manual") {
    const normalized = normalizeProxyUrl(config.url);
    return normalized ? maskProxyUrl(normalized) : "manual (invalid url)";
  }
  const resolved = resolveProxyUrl(config);
  return resolved ? `system (${maskProxyUrl(resolved)})` : "system (no proxy detected)";
}
