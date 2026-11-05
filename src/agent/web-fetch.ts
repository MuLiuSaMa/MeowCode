import TurndownService from "turndown";
import { gfm } from "@joplin/turndown-plugin-gfm";
import { buildAuthHeaders, fetchWithRetry, mergeExtraHeaders } from "./http.js";
import type { ProviderConfig } from "./types.js";
import { EXTERNAL_WEB_CONTENT_NOTICE } from "./web-search.js";

/**
 * 网页正文抓取：
 *  - DeepSeek 走官方 Fetch API（返回 Markdown，与搜索共用同一把 key）；
 *  - 其他服务商走本地匿名 HTTP：只允许 http/https、同源重定向、限时限量，
 *    HTML 用 turndown 转 Markdown。
 *
 * 抓回的内容一律视为不可信外部数据，不当作指令执行。
 */
const MAX_URL_CHARS = 2048;
const MAX_RESPONSE_BYTES = 5_000_000;
const MAX_BODY_CHARS = 100_000;
const MAX_REDIRECTS = 5;
/** 整个抓取（重定向 + 响应头 + 正文）的硬上限：卡住的站点不能拖死整个回合。 */
const WEB_FETCH_TIMEOUT_MS = 10_000;
const USER_AGENT = "MeowCode/0.1.0 (+https://github.com/MuLiuSaMa/MeowCode)";
const DEEPSEEK_FETCH_ENDPOINT = "https://api.deepseek.com/v1/tools/fetch";

export type WebFetchOutcome = {
  output: string;
  url: string;
  status: number;
  truncated: boolean;
};

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
turndown.use(gfm);
turndown.addRule("removeNonVisibleContent", {
  filter(node) {
    const name = node.nodeName.toUpperCase();
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "OBJECT", "EMBED"].includes(name)) {
      return true;
    }
    if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden")?.toLowerCase() === "true") {
      return true;
    }
    if (name === "INPUT" && node.getAttribute("type")?.toLowerCase() === "hidden") return true;
    const declarations = node.getAttribute("style")?.split(";") ?? [];
    return declarations.some((declaration) => {
      const separator = declaration.indexOf(":");
      if (separator === -1) return false;
      const property = declaration.slice(0, separator).trim().toLowerCase();
      const value = declaration
        .slice(separator + 1)
        .trim()
        .toLowerCase()
        .replace(/\s*!important\s*$/u, "");
      return (
        (property === "display" && value === "none") ||
        (property === "visibility" && (value === "hidden" || value === "collapse"))
      );
    });
  },
  replacement() {
    return "";
  },
});

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isDeepSeekHost(host: string): boolean {
  return host === "deepseek.com" || host.endsWith(".deepseek.com");
}

export async function fetchWebPage(
  provider: ProviderConfig | null,
  rawUrl: string,
  signal?: AbortSignal,
): Promise<WebFetchOutcome> {
  const target = parseHttpUrl(rawUrl);
  const timeout = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    timeout.abort();
  }, WEB_FETCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  try {
    if (provider && isDeepSeekHost(hostOf(provider.baseUrl)) && provider.apiKey) {
      return await fetchViaDeepSeek(provider, target, combined);
    }
    return await fetchViaHttp(target, combined);
  } catch (error) {
    if (timedOut) {
      throw new Error(
        `Web fetch timed out after ${WEB_FETCH_TIMEOUT_MS / 1000}s and was cancelled.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseHttpUrl(rawUrl: string): URL {
  const trimmed = rawUrl.trim();
  if (trimmed.length > MAX_URL_CHARS) {
    throw new Error(`URL exceeds the maximum length of ${MAX_URL_CHARS} characters.`);
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid URL: ${trimmed}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme "${url.protocol}" (only http and https are allowed).`);
  }
  if (url.username || url.password) {
    throw new Error("Credentials in URLs are not allowed.");
  }
  return url;
}

async function fetchViaDeepSeek(
  provider: ProviderConfig,
  target: URL,
  signal?: AbortSignal,
): Promise<WebFetchOutcome> {
  const response = await fetchWithRetry(
    DEEPSEEK_FETCH_ENDPOINT,
    {
      method: "POST",
      headers: mergeExtraHeaders(
        {
          "content-type": "application/json",
          ...buildAuthHeaders(provider.apiKey, provider.authStyle, "bearer"),
        },
        provider.extraHeaders,
      ),
      body: JSON.stringify({ url: target.toString() }),
      signal,
    },
  );
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Web fetch failed (HTTP ${response.status}): ${errorDetail(raw)}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("Web fetch returned a non-JSON response.");
  }
  const content =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).content
      : undefined;
  if (typeof content !== "string") {
    throw new Error("Web fetch returned no page content.");
  }
  return wrapOutput(target.toString(), 200, content, false);
}

async function fetchViaHttp(target: URL, signal: AbortSignal): Promise<WebFetchOutcome> {
  let current = target;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    assertNotPrivateHost(current);
    const response = await fetchWithRetry(
      current.toString(),
      {
        method: "GET",
        redirect: "manual",
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8",
        },
        signal,
      },
    );

    if (isRedirectStatus(response.status)) {
      if (hop === MAX_REDIRECTS) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Exceeded the maximum of ${MAX_REDIRECTS} redirects.`);
      }
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) {
        throw new Error(`Redirect response (HTTP ${response.status}) without a Location header.`);
      }
      const next = parseHttpUrl(new URL(location, current).toString());
      if (!isSameOrigin(next, current)) {
        throw new Error(
          `Cross-origin redirect to ${next.origin} is not followed automatically; call web_fetch on that URL directly.`,
        );
      }
      current = next;
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Web fetch failed (HTTP ${response.status}).`);
    }
    return await readResponse(response, current, signal);
  }
  throw new Error(`Exceeded the maximum of ${MAX_REDIRECTS} redirects.`);
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isSameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port;
}

function assertNotPrivateHost(url: URL): void {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("Private/loopback hosts are blocked. Use the browser tools for local pages.");
  }
  if (host.includes(":")) {
    if (host === "::1" || host === "0:0:0:0:0:0:0:1" || /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host)) {
      throw new Error("Private/loopback hosts are blocked. Use the browser tools for local pages.");
    }
    return;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return;
  const first = Number(ipv4[1]);
  const second = Number(ipv4[2]);
  if (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  ) {
    throw new Error("Private/loopback hosts are blocked. Use the browser tools for local pages.");
  }
}

async function readResponse(
  response: Response,
  finalUrl: URL,
  signal: AbortSignal,
): Promise<WebFetchOutcome> {
  const contentType = response.headers.get("content-type");
  const kind = classifyContentType(contentType);
  if (!kind) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Unsupported content type "${contentType ?? "unknown"}".`);
  }

  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Response exceeds the maximum of ${MAX_RESPONSE_BYTES} bytes.`);
  }

  const { bytes, truncatedByBytes } = await readCapped(response, signal);
  const decoded = decodeBody(bytes, contentType, truncatedByBytes);
  const truncatedByChars = decoded.length > MAX_BODY_CHARS;
  const body = truncatedByChars ? decoded.slice(0, MAX_BODY_CHARS) : decoded;
  const markdown = kind === "html" ? htmlToMarkdown(body) : body;
  return wrapOutput(finalUrl.toString(), response.status, markdown, truncatedByBytes || truncatedByChars);
}

function classifyContentType(contentType: string | null): "html" | "text" | null {
  const mime = (contentType ?? "").replace(/;.*$/s, "").trim().toLowerCase();
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime.startsWith("text/")) return "text";
  if (mime === "application/json" || mime === "application/xml" || mime.endsWith("+json") || mime.endsWith("+xml")) {
    return "text";
  }
  return null;
}

function decodeBody(bytes: Uint8Array, contentType: string | null, allowIncompleteUtf8: boolean): string {
  const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? "");
  const label = match?.[1]?.trim() || "utf-8";
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes, { stream: allowIncompleteUtf8 });
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes, { stream: allowIncompleteUtf8 });
  }
}

/**
 * 把 reader.read() 和 abort 信号赛跑：站点先发响应头再拖住正文时，
 * fetch 的 abort 不保证立刻打断已挂起的 read，必须自己兜住。
 */
function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(new Error("Web fetch aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("Web fetch aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function readCapped(
  response: Response,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; truncatedByBytes: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(0), truncatedByBytes: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncatedByBytes = false;
  try {
    for (;;) {
      const { done, value } = await readWithAbort(reader, signal);
      if (done) break;
      const remaining = MAX_RESPONSE_BYTES - total;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        truncatedByBytes = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncatedByBytes };
}

function htmlToMarkdown(html: string): string {
  try {
    return turndown.turndown(html).trim();
  } catch {
    // 极端畸形 HTML 让 turndown 抛错时，退回纯文本，至少不丢正文
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\s+/g, " ")
      .trim();
  }
}

function wrapOutput(url: string, status: number, markdown: string, truncated: boolean): WebFetchOutcome {
  const parts = [EXTERNAL_WEB_CONTENT_NOTICE, `Fetched: ${url} (HTTP ${status})`, markdown];
  if (truncated) {
    parts.push(`(Content truncated at ${MAX_BODY_CHARS} characters or ${MAX_RESPONSE_BYTES} bytes.)`);
  }
  return {
    output: parts.join("\n\n"),
    url,
    status,
    truncated,
  };
}

function errorDetail(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const error = record.error;
      if (error && typeof error === "object" && !Array.isArray(error)) {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === "string" && message.trim()) return message.slice(0, 300);
      }
      if (typeof record.message === "string" && record.message.trim()) return record.message.slice(0, 300);
    }
  } catch {
    // fall through
  }
  return (raw.trim() || "no detail").slice(0, 300);
}
