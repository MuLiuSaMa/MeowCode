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
 *  1. transport 收到 401 → auth() 走发现 + 动态注册 + 拉浏览器（redirectToAuthorization），
 *     返回 "REDIRECT"；
 *  2. 本模块等回环回调拿到 code（默认 5 分钟超时）；
 *  3. auth({ authorizationCode }) 换 token 落盘 → 重连。
 *  之后的过期刷新由 transport 在 401 时自动走 refresh（auth() 读 tokens().refresh_token）。
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

/** 拉起系统浏览器；失败仅告警——日志里有完整授权 URL，用户可手动打开。 */
function openInBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // 打不开浏览器不致命：日志里有完整授权 URL
  }
}

export type McpOAuthOptions = {
  serverName: string;
  serverUrl: string;
  homeDir: string;
  scopes?: string[];
  /** 浏览器拉起器（测试注入捕获 URL）；缺省 openInBrowser */
  openBrowser?: (url: string) => void;
  /** 授权等待窗口（测试用）；缺省 5 分钟 */
  authorizationTimeoutMs?: number;
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

  constructor(options: McpOAuthOptions) {
    this.options = options;
    this.file = path.join(options.homeDir, OAUTH_DIR, `${sanitizeServerName(options.serverName)}.json`);
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
    const server = http.createServer((request, response) => {
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
    });
    server.on("error", (error) => {
      this.log("error", `callback server failed: ${error.message}`);
      this.pending?.reject(error);
      this.pending = null;
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    this.callbackPort = address && typeof address === "object" ? address.port : 0;
    this.callbackServer = server;
    return `http://127.0.0.1:${this.callbackPort}${CALLBACK_PATH}`;
  }

  state(): string {
    this.authorizationState = randomBytes(16).toString("hex");
    return this.authorizationState;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    await this.load();
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

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.load();
    this.stored.issuer = this.options.serverUrl;
    this.stored.codeVerifier = verifier;
    await this.persist();
  }

  async codeVerifier(): Promise<string> {
    await this.load();
    if (!this.stored.codeVerifier) throw new Error("No code verifier saved.");
    return this.stored.codeVerifier;
  }

  /** SDK 在拿到授权 URL 后调这里跳浏览器。 */
  redirectToAuthorization(authorizationUrl: URL): void {
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
    const server = this.callbackServer;
    this.callbackServer = null;
    this.callbackPort = 0;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** 完整授权：REDIRECT → 等回环 code → 换 token。token 已在盘上时直接返回。 */
  async ensureAuthorized(): Promise<void> {
    await this.load();
    if (this.stored.tokens) return;
    // 先把回环监听起好：redirectUrl / clientMetadata 都是同步 getter，必须就绪后 SDK 才读得到
    await this.ensureCallbackServer();
    const serverUrl = this.options.serverUrl;
    const first = await auth(this, { serverUrl });
    if (first === "AUTHORIZED") return;
    if (first !== "REDIRECT") throw new Error(`unexpected auth result: ${String(first)}`);
    const code = await this.waitForAuthorizationCode();
    const second = await auth(this, { serverUrl, authorizationCode: code });
    if (second !== "AUTHORIZED") throw new Error(`token exchange failed: ${String(second)}`);
    await this.close();
  }
}
