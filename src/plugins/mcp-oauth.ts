/**
 * MCP OAuth（streamable HTTP 端点的 authorization_code + PKCE，公开客户端）。
 *
 * 职责边界：
 *  - 本模块只管「拿 token / 刷 token / 存 token」；连不上、工具注册等仍归 mcp.ts。
 *  - token 落盘在 `<homeDir>/.meowcode/mcp-oauth/<server>.json`（0600）：agent 服务是
 *    独立进程，桌面 safeStorage 通道覆盖不到它；与 codex/ZCode 的 auth.json 同款做法。
 *  - 授权码经 127.0.0.1 回环回调接收，浏览器由本模块直接拉起 —— 不依赖桌面端 IPC。
 *
 * 流程（SDK auth() 两段式）：
 *  1. transport 收到 401 → auth() 走发现 + 客户端身份（CIMD / 预注册 / DCR）+ 拉浏览器，
 *     返回 "REDIRECT"；
 *  2. ensureAuthorized 等回环回调拿到 code（默认 5 分钟超时）；
 *  3. auth({ authorizationCode }) 换 token 落盘 → 重连。
 *  之后的过期刷新由 transport 在 401 时自动走 refresh（auth() 读 tokens().refresh_token）。
 *
 * 客户端身份优先级：
 *  1. `clientId` 为非 URL → 预注册客户端，跳过 DCR/CIMD；
 *  2. `clientId` 为 HTTPS URL，或显式 `clientMetadataUrl` → SEP-991 CIMD；
 *  3. 都没配 → DCR。CIMD-only 服务器（如 Undermind）必须显式给 `clientMetadataUrl`，
 *     否则会报 "Incompatible auth server: does not support dynamic client registration"。
 *     置空串可关闭 CIMD。文档需发布在
 *     `https://meowcode.cn/.well-known/oauth-client`（当前未发布）。
 *
 * 双开浏览器：StreamableHTTP transport 收到 401 会自己调一次 auth()（拉浏览器后抛
 * UnauthorizedError），MeowCode 再调 ensureAuthorized 又会 auth() 一次。这里用
 * `authFlowActive` 冻结 state/PKCE/浏览器，第二次 auth() 复用第一次的授权 URL。
 *
 * 回环时序：必须在首次 auth() 之前 `prepare()` 起好回环监听。否则 redirectUrl 为
 * undefined，SDK 会把流程当 non-interactive 直接换 token，首次授权必败。
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { readJsonFile, writeJsonAtomic } from "../agent/atomic-json.js";

const OAUTH_DIR = path.join(".meowcode", "mcp-oauth");
/** 等用户在浏览器完成授权的窗口；超时按连接失败走既有 failed 标记。 */
const AUTHORIZATION_TIMEOUT_MS = 5 * 60_000;
const CALLBACK_PATH = "/callback";

/**
 * 默认 CIMD 文档地址（可选发布）：AS 侧拉取的公开客户端元数据（SEP-991）。
 * meowcode.cn 未发布时也能用仓库文件推到 GitHub 后的 jsDelivr / raw。
 */
export const DEFAULT_MCP_CLIENT_METADATA_URL =
  process.env.MEOWCODE_MIMD_URL ||
  process.env.MEOWCODE_MCP_CIMD_URL ||
  "https://meowcode.cn/.well-known/oauth-client";

/**
 * MCP OAuth 回环回调默认端口：CIMD 文档里的 redirect_uris 必须能写死。
 * RFC 8252 允许可变端口，但多数 AS 只做精确匹配；占用时退回随机端口（那就要靠 AS 支持变量端口）。
 */
export const DEFAULT_MCP_CALLBACK_PORT = 53683;

/** CIMD 候选：按序探测，第一个能拉到合法客户端元数据的当选 client_id。 */
export const MCP_CIMD_CANDIDATES = [
  process.env.MEOWCODE_MCP_CIMD_URL || DEFAULT_MCP_CLIENT_METADATA_URL,
  "https://cdn.jsdelivr.net/gh/MuLiuSaMa/MeowCode@main/resources/well-known/oauth-client.json",
  "https://raw.githubusercontent.com/MuLiuSaMa/MeowCode/main/resources/well-known/oauth-client.json",
  // 临时兜底：MeowCode 自己的 CIMD 还没发布时，借 OpenCode 的公开文档跑通 Undermind。
  // OpenCode 文档允许 127.0.0.1/callback 不带端口（RFC 8252 任意本机端口），跟我们 53683 回调兼容。
  // 授权页可能显示 opencode；正式方案仍是发布 meowcode.cn 的文档。
  "https://opencode.ai/oauth/opencode/client.json",
].filter((url) => url.length > 0);

/** 模块级缓存：探测成功才记，失败下次连接重试（发布后不用重启） */
let cachedCimdUrl: string | undefined;

async function isLiveCimdDocument(url: string, timeoutMs = 4_000): Promise<boolean> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    if (!response.ok) return false;
    const text = await response.text();
    const json = JSON.parse(text) as { redirect_uris?: unknown; client_name?: unknown };
    return typeof json.client_name === "string" && Array.isArray(json.redirect_uris);
  } catch {
    return false;
  }
}

type StoredOAuthState = {
  /** 防止把 A 服务器的注册信息喂给 B：保存 issuer，读取时校验 */
  issuer?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
};

function sanitizeServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "server";
}

/**
 * 各平台拉起浏览器的命令（导出仅供测试）。
 *
 * Windows 两个坑都踩过了，别再改回去：
 * - `cmd /c start "" <url>`：cmd 把 URL 里的 `&` 当命令分隔符，浏览器只收到 `?response_type=code`，
 *   授权页报 "client_id is required"。
 * - `explorer.exe <url>`：explorer 把参数当文件路径，弹出来是资源管理器窗口。
 * rundll32 url.dll,FileProtocolHandler 走 ShellExecute，参数不经任何 shell 解析。
 */
export function browserOpenCommand(
  platform: NodeJS.Platform,
  url: string,
): { command: string; args: string[] } {
  if (platform === "win32") {
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  }
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

/** 拉起系统浏览器；失败仅告警——日志里有完整授权 URL，用户可手动打开。 */
function openInBrowser(url: string): void {
  try {
    const { command, args } = browserOpenCommand(process.platform, url);
    spawn(command, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // 打不开浏览器不致命：日志里有完整授权 URL
  }
}

export type McpOAuthOptions = {
  serverName: string;
  serverUrl: string;
  homeDir: string;
  scopes?: string[];
  /** 预注册 client_id（非 URL）：设置后跳过 DCR/CIMD。HTTPS URL 则作为 CIMD 地址。 */
  clientId?: string;
  /** CIMD 文档 URL；空串关闭 CIMD 回退；缺省用 DEFAULT_MCP_CLIENT_METADATA_URL */
  clientMetadataUrl?: string;
  /** 浏览器拉起器（测试注入捕获 URL）；缺省 openInBrowser */
  openBrowser?: (url: string) => void;
  /** 授权等待窗口（测试用）；缺省 5 分钟 */
  authorizationTimeoutMs?: number;
  /** 自动探测官方 CIMD 候选（meowcode.cn / jsDelivr / raw）。测试默认关，免打外网。 */
  probeCimd?: boolean;
  log?: (level: "info" | "warn" | "error", message: string) => void;
};

export class McpOAuthProvider implements OAuthClientProvider {
  /** DCR 元数据：redirect_uris 必须含真实回环地址，惰性起监听后取。 */
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "MeowCode",
      client_uri: "https://meowcode.cn",
      redirect_uris: [this.redirectUrl ?? "http://127.0.0.1/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.options.scopes?.length ? { scope: this.options.scopes.join(" ") } : {}),
    };
  }

  private readonly options: McpOAuthOptions;
  private readonly file: string;
  private loaded = false;
  private stored: StoredOAuthState = {};
  private callbackServer: http.Server | null = null;
  private callbackPort = 0;
  private pending: { promise: Promise<string>; resolve: (code: string) => void; reject: (error: Error) => void } | null =
    null;
  /**
   * 回调先于等待者到达的缓冲：浏览器可能在我们进入 waitForAuthorizationCode 之前
   * 就完成跳转（自动化 / 极快的人手）。只缓冲最近一次。
   */
  private buffered: { code?: string; error?: Error } | null = null;
  private authorizationState = randomBytes(16).toString("hex");
  /** 交互式授权进行中：冻结 state / PKCE，避免 transport 401 + ensureAuthorized 重置凭据 */
  private authFlowActive = false;
  /** 本次交互流程已拉起浏览器；重入 auth() 不再开新标签页 */
  private browserLaunched = false;
  /** 本次交互流程的 PKCE verifier；重入 auth() 时不许覆盖，否则第一个标签页换 token 必败 */
  private pendingVerifier: string | undefined;
  /** probeCimd 解析结果；getter 是同步的，必须在首次 auth() 前就绪 */
  private resolvedCimdUrl: string | undefined;

  constructor(options: McpOAuthOptions) {
    this.options = options;
    this.file = path.join(options.homeDir, OAUTH_DIR, `${sanitizeServerName(options.serverName)}.json`);
  }

  /** 预注册的非 URL client_id；HTTPS URL 走 CIMD，不在这里当 opaque id */
  private staticClientId(): string | undefined {
    const id = this.options.clientId;
    if (!id || /^https:\/\//i.test(id)) return undefined;
    return id;
  }

  /** CIMD 文档地址：显式配置 > HTTPS 形式的 clientId > probeCimd 探测。空串关闭。 */
  get clientMetadataUrl(): string | undefined {
    const explicit = this.options.clientMetadataUrl;
    if (explicit !== undefined) return explicit === "" ? undefined : explicit;
    if (this.options.clientId && /^https:\/\//i.test(this.options.clientId)) {
      return this.options.clientId;
    }
    return this.resolvedCimdUrl;
  }

  /** 已确认 AS 支持 DCR：CIMD 不再探测（两者互斥） */
  private cimdSkippedForDcr = false;

  /**
   * AS 是否支持动态客户端注册（DCR）。
   * CIMD 只是「AS 不支持 DCR」时的兜底：AS 能自己发 client_id 时，拿外部 CIMD 文档当 client_id
   * 会被判 invalid_client——Cloudflare 这类 DCR-only 的服务器就是这样，表现为授权页压根不出现。
   */
  private async supportsDynamicRegistration(): Promise<boolean> {
    try {
      const origin = new URL(this.options.serverUrl).origin;
      const response = await fetch(`${origin}/.well-known/oauth-authorization-server`, {
        redirect: "follow",
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return false;
      const meta = (await response.json()) as { registration_endpoint?: unknown };
      return typeof meta.registration_endpoint === "string" && meta.registration_endpoint.length > 0;
    } catch {
      return false;
    }
  }

  /** 连接前调用：起回环监听 + 解析 CIMD 候选。getter 是同步的，必须先 await 这一步。幂等。 */
  async prepare(): Promise<void> {
    if (this.options.probeCimd && this.resolvedCimdUrl === undefined && !this.cimdSkippedForDcr) {
      const explicitOff = this.options.clientMetadataUrl === "" || this.staticClientId();
      if (!explicitOff && (await this.supportsDynamicRegistration())) {
        this.cimdSkippedForDcr = true;
      } else if (!explicitOff) {
        if (cachedCimdUrl) {
          this.resolvedCimdUrl = cachedCimdUrl;
        } else {
          let picked: string | undefined;
          // 并发探测：国内拉 jsDelivr / raw 可能超时，串行 4s×n 会把浏览器授权拖后好几秒
          const probes = await Promise.all(
            MCP_CIMD_CANDIDATES.map(async (url) => ({ url, ok: await isLiveCimdDocument(url) })),
          );
          picked = probes.find((item) => item.ok)?.url;
          if (picked) {
            cachedCimdUrl = picked;
            this.resolvedCimdUrl = picked;
            if (picked.includes("opencode.ai")) {
              this.log(
                "warn",
                "MeowCode CIMD not published yet; falling back to OpenCode's public client metadata (consent page may say opencode). Publish resources/well-known/oauth-client.json to meowcode.cn to brand this as MeowCode.",
              );
            } else {
              this.log("info", `using CIMD document ${picked}`);
            }
          } else {
            // 不缓存失败：发布后下次连接即可生效。仍用首选当 client_id，AS 拉不到会 invalid_client。
            this.resolvedCimdUrl = MCP_CIMD_CANDIDATES[0];
            this.log(
              "warn",
              `no live CIMD document (tried ${MCP_CIMD_CANDIDATES.join(", ")}); publish resources/well-known/oauth-client.json to meowcode.cn, otherwise authorization will fail with invalid_client`,
            );
          }
        }
      }
    }
    await this.ensureCallbackServer();
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    this.options.log?.(level, `mcp oauth "${this.options.serverName}": ${message}`);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const stored = await readJsonFile<StoredOAuthState>(this.file).catch(() => undefined);
    // 注册信息与 token 都绑定 issuer：服务器 URL 换了就作废重来，不能跨站复用
    if (stored && stored.issuer === this.options.serverUrl) this.stored = stored;
    else this.stored = {};
    await this.dropStaleCimdClient();
  }

  /**
   * 显式关掉 CIMD（clientMetadataUrl: ""）后，本地缓存的 client_id 可能还是 CIMD 时期的
   * HTTPS 文档地址。AS 不认这种 client_id（Cloudflare 直接回 "client_id is required"），
   * 而 SDK 只要看到 clientInformation 存在就不会重新注册——所以必须主动作废，让它走 DCR。
   */
  private async dropStaleCimdClient(): Promise<void> {
    if (this.options.clientMetadataUrl !== "") return;
    const info = this.stored.clientInformation as { client_id?: unknown } | undefined;
    if (typeof info?.client_id !== "string" || !/^https:\/\//i.test(info.client_id)) return;
    delete this.stored.clientInformation;
    await this.persist().catch(() => undefined);
    this.log("warn", "dropped stale CIMD client_id from local state; re-registering via DCR");
  }

  /**
   * 回环端口变了（默认 53683 被占用会退回随机端口）时，注册时的 redirect_uris 不再匹配，
   * AS 会拒绝授权。作废重注册——DCR 不要钱，比让用户对着错误页发呆好。
   */
  private async dropRedirectMismatchClient(): Promise<void> {
    const info = this.stored.clientInformation as { redirect_uris?: unknown } | undefined;
    const current = this.redirectUrl;
    if (!current || !Array.isArray(info?.redirect_uris)) return;
    if (info.redirect_uris.some((uri) => uri === current)) return;
    delete this.stored.clientInformation;
    await this.persist().catch(() => undefined);
    this.log("warn", `redirect_uri changed (${current}); re-registering client`);
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await writeJsonAtomic(this.file, this.stored);
    if (process.platform !== "win32") await fs.chmod(this.file, 0o600).catch(() => undefined);
  }

  get redirectUrl(): string | undefined {
    return this.callbackPort > 0 ? `http://127.0.0.1:${this.callbackPort}${CALLBACK_PATH}` : undefined;
  }

  /** 启动回环回调服务并等待 listen 完成（getter 是同步的，必须先 await 这一步）。 */
  private async ensureCallbackServer(): Promise<string> {
    if (this.callbackPort > 0) return `http://127.0.0.1:${this.callbackPort}${CALLBACK_PATH}`;
    // 先试固定端口（CIMD redirect_uris 能精确匹配）；占用则换新 server 退随机端口
    const tryListen = (port: number): Promise<http.Server> => {
      const candidate = http.createServer(handler);
      return new Promise((resolve, reject) => {
        const onError = (error: Error): void => {
          candidate.removeListener("listening", onListen);
          candidate.close(() => reject(error));
        };
        const onListen = (): void => {
          candidate.removeListener("error", onError);
          resolve(candidate);
        };
        candidate.once("error", onError);
        candidate.once("listening", onListen);
        candidate.listen(port, "127.0.0.1");
      });
    };
    const handler = (request: http.IncomingMessage, response: http.ServerResponse): void => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${this.callbackPort}`);
      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><meta charset=utf-8><title>MeowCode</title><p>授权完成，回到 MeowCode 即可。</p>",
      );
      this.resolveAuthorizationCode(url);
    };
    try {
      const listening = await tryListen(DEFAULT_MCP_CALLBACK_PORT);
      this.callbackServer = listening;
      this.callbackPort = DEFAULT_MCP_CALLBACK_PORT;
    } catch {
      const listening = await tryListen(0);
      this.callbackServer = listening;
      const address = listening.address();
      this.callbackPort = address && typeof address === "object" ? address.port : 0;
    }
    // listen 之后的偶发 error 不能变 unhandled exception；等待方靠超时兑底
    this.callbackServer?.on("error", (error) => {
      this.log("warn", `callback server error: ${error.message}`);
    });
    return `http://127.0.0.1:${this.callbackPort}${CALLBACK_PATH}`;
  }

  state(): string {
    // 交互流程已开始（transport 401 先跑了 auth()）：复用同一 state，否则第一个标签页的
    // 回调会被 CSRF 检查拒掉。只在全新流程时换 state。
    if (!this.authFlowActive) {
      this.authorizationState = randomBytes(16).toString("hex");
      this.authFlowActive = true;
    }
    return this.authorizationState;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    await this.load();
    const staticId = this.staticClientId();
    if (staticId) return { client_id: staticId };
    return this.stored.clientInformation;
  }

  async saveClientInformation(information: OAuthClientInformationMixed): Promise<void> {
    await this.load();
    this.stored.issuer = this.options.serverUrl;
    this.stored.clientInformation = information;
    await this.persist();
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    await this.load();
    return this.stored.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.load();
    this.stored.issuer = this.options.serverUrl;
    this.stored.tokens = tokens;
    await this.persist();
  }

  /**
   * 清掉本机保存的 token（重新授权 / token 过期时用）。
   * 只清 tokens 与 codeVerifier，保留 clientInformation：重注册没必要，DCR 不是免费额度。
   */
  async clearTokens(): Promise<void> {
    await this.load();
    delete this.stored.tokens;
    delete this.stored.codeVerifier;
    await this.persist();
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.load();
    // 重入 auth() 不覆盖：第一个标签页是用第一个 challenge 发起的
    if (this.pendingVerifier) return;
    this.pendingVerifier = verifier;
    this.stored.issuer = this.options.serverUrl;
    this.stored.codeVerifier = verifier;
    await this.persist();
  }

  async codeVerifier(): Promise<string> {
    await this.load();
    const verifier = this.pendingVerifier ?? this.stored.codeVerifier;
    if (!verifier) throw new Error("No code verifier saved.");
    return verifier;
  }

  /** SDK 在拿到授权 URL 后调这里跳浏览器。交互流程内只开一次。 */
  redirectToAuthorization(authorizationUrl: URL): void {
    if (this.browserLaunched) {
      this.log("info", "authorization already in browser; skip duplicate launch");
      return;
    }
    this.browserLaunched = true;
    const open = this.options.openBrowser ?? openInBrowser;
    this.log("info", `opening browser for authorization: ${authorizationUrl.toString()}`);
    open(authorizationUrl.toString());
  }

  /** 等回环回调送来授权码（浏览器流程第二步）。回调先到时直接取缓冲。 */
  waitForAuthorizationCode(
    timeoutMs = this.options.authorizationTimeoutMs ?? AUTHORIZATION_TIMEOUT_MS,
  ): Promise<string> {
    if (this.buffered?.code) return Promise.resolve(this.buffered.code);
    if (this.buffered?.error) return Promise.reject(this.buffered.error);
    if (this.pending) return this.pending.promise;
    let resolveCode: (code: string) => void = () => undefined;
    let rejectCode: (error: Error) => void = () => undefined;
    const promise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
      setTimeout(() => {
        this.pending = null;
        reject(new Error(`authorization timed out after ${Math.round(timeoutMs / 1000)}s (no browser callback)`));
      }, timeoutMs);
    });
    this.pending = { promise, resolve: resolveCode, reject: rejectCode };
    return promise;
  }

  /** 回环服务收到回调：校验 state 后把 code 交给等待方（没人等就缓冲）。 */
  resolveAuthorizationCode(url: URL): void {
    const deliver = (outcome: { code?: string; error?: Error }): void => {
      if (this.pending) {
        if (outcome.error) this.pending.reject(outcome.error);
        else this.pending.resolve(outcome.code!);
        this.pending = null;
      } else {
        this.buffered = outcome;
      }
    };
    const error = url.searchParams.get("error");
    if (error) {
      const description = url.searchParams.get("error_description") ?? error;
      deliver({ error: new Error(`authorization server returned ${error}: ${description}`) });
      return;
    }
    if (url.searchParams.get("state") !== this.authorizationState) {
      deliver({ error: new Error("authorization callback state mismatch (possible CSRF)") });
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      deliver({ error: new Error("authorization callback missing code") });
      return;
    }
    deliver({ code });
  }


  /** 关回环监听（teardown 时调用；token 已落盘，重连无需再监听）。 */
  async close(): Promise<void> {
    this.resetFlow();
    const server = this.callbackServer;
    this.callbackServer = null;
    this.callbackPort = 0;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** 结束本次交互流程：下次重试允许换 state、重开浏览器、重存 PKCE。 */
  private resetFlow(): void {
    this.authFlowActive = false;
    this.browserLaunched = false;
    this.pendingVerifier = undefined;
    this.buffered = null;
  }

  /**
   * 完整授权：REDIRECT → 等回环 code → 换 token。token 已在盘上时直接返回。
   *
   * StreamableHTTP transport 收到 401 会先自己 auth() 一次（已拉浏览器、已选好客户端身份）。
   * 这里重入 auth() 复用同一 state/verifier/浏览器，只负责等 code 并换 token。
   */
  async ensureAuthorized(): Promise<void> {
    await this.load();
    if (this.stored.tokens) return;
    // 先把回环监听起好：redirectUrl / clientMetadata 都是同步 getter，必须就绪后 SDK 才读得到
    await this.ensureCallbackServer();
    await this.dropRedirectMismatchClient();
    const serverUrl = this.options.serverUrl;
    try {
      const first = await auth(this, { serverUrl });
      if (first === "AUTHORIZED") {
        await this.close();
        return;
      }
      if (first !== "REDIRECT") throw new Error(`unexpected auth result: ${String(first)}`);
      const code = await this.waitForAuthorizationCode();
      const second = await auth(this, { serverUrl, authorizationCode: code });
      if (second !== "AUTHORIZED") throw new Error(`token exchange failed: ${String(second)}`);
    } finally {
      this.resetFlow();
    }
    await this.close();
  }
}
