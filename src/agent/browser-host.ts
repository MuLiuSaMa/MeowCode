/**
 * Client for the MeowCode Desktop embedded-browser host (loopback HTTP control plane).
 * Browser tools call this; Electron main implements the server while Desktop is running.
 * 无 Desktop 环境（测试 / CLI）时 env 缺失，createBrowserHostFromEnv 返回 undefined。
 */

export type BrowserHostCommand =
  | { op: "navigate"; url: string }
  | { op: "snapshot" }
  | { op: "click"; ref: string }
  | { op: "type"; text: string; ref?: string; submit?: boolean }
  | { op: "screenshot" }
  | { op: "back" }
  | { op: "reload" }
  /** 图片过大时在桌面主进程里缩图（nativeImage 支持任意格式）；path 必须存在且可读 */
  | { op: "shrink_image"; path: string; maxBytes?: number; maxEdge?: number };

export type ShrinkImageResult = {
  ok: boolean;
  error?: string;
  /** 缩图后的 base64（不带 data: 前缀）与实际 MIME */
  data?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  bytes?: number;
  /** 缩放前的原始尺寸，成功时回带便于提示 */
  originalWidth?: number;
  originalHeight?: number;
};

export type ShrinkImageRequest = {
  path: string;
  /** 编码后允许的最大字节数，默认 4MB */
  maxBytes?: number;
  /** 允许的最大边长，默认 1568（各家的视觉 token 计费在 ~1.5K 边长后收益骤减） */
  maxEdge?: number;
};

export type BrowserHostResult = {
  ok: boolean;
  error?: string;
  tabId?: string;
  url?: string;
  title?: string;
  snapshot?: string;
  screenshotBase64?: string;
  mimeType?: string;
  viewportWidth?: number;
  viewportHeight?: number;
  clicked?: string;
  trusted?: boolean;
  typed?: string;
  submitted?: boolean;
};

export interface BrowserHostClient {
  execute(command: BrowserHostCommand, signal?: AbortSignal): Promise<BrowserHostResult>;
  /**
   * 缩图片（桌面端用 Electron nativeImage 实现，支持 PNG/JPEG/WebP 等）。
   * 实现不可用（CLI / 测试）或格式不支持时返回 ok:false，调用方走「卸载」降级。
   */
  shrinkImage?(request: ShrinkImageRequest, signal?: AbortSignal): Promise<ShrinkImageResult>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function createHttpBrowserHostClient(options: {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
}): BrowserHostClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const execute = async (
    command: BrowserHostCommand,
    signal?: AbortSignal,
  ): Promise<BrowserHostResult> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const headers: Record<string, string> = {
          "content-type": "application/json",
          accept: "application/json",
        };
        if (options.token) {
          headers["x-meow-browser-token"] = options.token;
        }
        const response = await fetch(new URL("/browser/command", options.baseUrl).toString(), {
          method: "POST",
          headers,
          body: JSON.stringify(command),
          signal: controller.signal,
        });
        const text = await response.text();
        let parsed: BrowserHostResult | undefined;
        try {
          parsed = text ? (JSON.parse(text) as BrowserHostResult) : undefined;
        } catch {
          parsed = undefined;
        }
        if (!response.ok) {
          return {
            ok: false,
            error: parsed?.error || `Browser host HTTP ${response.status}: ${text.slice(0, 200)}`,
          };
        }
        if (!parsed) {
          return { ok: false, error: "Browser host returned invalid JSON" };
        }
        return parsed;
      } catch (error) {
        if (signal?.aborted) {
          return { ok: false, error: "aborted" };
        }
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: `Browser host request failed: ${message}` };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
  };
  return {
    execute,
    async shrinkImage(request, signal) {
      const result = await execute(
        {
          op: "shrink_image",
          path: request.path,
          ...(request.maxBytes !== undefined ? { maxBytes: request.maxBytes } : {}),
          ...(request.maxEdge !== undefined ? { maxEdge: request.maxEdge } : {}),
        },
        signal,
      );
      return result as ShrinkImageResult;
    },
  };
}

/** Resolve the Desktop-injected browser host from environment (127.0.0.1 / localhost only). */
export function createBrowserHostFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BrowserHostClient | undefined {
  const baseUrl = env.MEOWCODE_BROWSER_HOST?.trim();
  if (!baseUrl) {
    return undefined;
  }
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return createHttpBrowserHostClient({
    baseUrl: baseUrl.replace(/\/$/, ""),
    token: env.MEOWCODE_BROWSER_HOST_TOKEN?.trim() || undefined,
  });
}
