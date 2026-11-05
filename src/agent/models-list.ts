import { buildAuthHeaders, mergeExtraHeaders } from "./http.js";
import { applyProxy } from "./proxy.js";
import type { ProviderConfig } from "./types.js";

/** `/models` 与对话端点同源：把动作后缀换掉即可。 */
function modelsCandidates(baseUrl: string): string[] {
  const base = baseUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(chat\/completions|messages|responses)$/i, "");
  const candidates: string[] = [];
  const push = (url: string) => {
    if (!candidates.includes(url)) candidates.push(url);
  };
  if (/\/models$/i.test(base)) {
    push(base);
    return candidates;
  }
  const versioned = /\/v\d+[a-z]*$/i.test(base) || /\/openai$/i.test(base);
  push(versioned ? `${base}/models` : `${base}/v1/models`);
  // 各家不统一：DeepSeek 等在根路径挂 /models，版本前缀反而 404
  if (!versioned) push(`${base}/models`);
  // 带兼容层路径的网关（/anthropic、/compatible、/api/xxx）常常只在站点根暴露
  try {
    const origin = new URL(base).origin;
    push(`${origin}/v1/models`);
    push(`${origin}/models`);
  } catch {
    // base 不合法时交给上层报错
  }
  return candidates;
}

/** 各家 /models 的返回形状不统一：data[].id（OpenAI/Anthropic）、models[]、裸数组。 */
function extractModelIds(payload: unknown): string[] {
  const collect = (items: unknown[]): string[] =>
    items
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          const id = record.id ?? record.name ?? record.model;
          return typeof id === "string" ? id : "";
        }
        return "";
      })
      .filter((id) => id.trim().length > 0);
  if (Array.isArray(payload)) return [...new Set(collect(payload))];
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.data)) return [...new Set(collect(record.data))];
    if (Array.isArray(record.models)) return [...new Set(collect(record.models))];
  }
  return [];
}

type StoredProvider = Pick<
  ProviderConfig,
  "baseUrl" | "protocol" | "apiKey" | "authStyle" | "extraHeaders"
>;

/**
 * 「获取模型列表」的参数归一：请求体显式值优先，缺省回退到已保存的同 id 服务商。
 * 编辑已存服务商时表单拿不到密钥（只在主进程），没有这层回退会必然 401。
 */
export function resolveProviderModelsOptions(
  request: {
    baseUrl?: string;
    protocol?: string;
    apiKey?: string;
    authStyle?: "bearer" | "api-key" | "bedrock-api-key" | "none";
    extraHeaders?: Record<string, string>;
  },
  stored: StoredProvider | undefined,
):
  | {
      ok: true;
      options: {
        baseUrl: string;
        protocol?: string;
        apiKey?: string;
        authStyle?: "bearer" | "api-key" | "bedrock-api-key" | "none";
        extraHeaders?: Record<string, string>;
      };
    }
  | { ok: false; error: string } {
  const baseUrl = request.baseUrl?.trim() || stored?.baseUrl?.trim() || "";
  if (!baseUrl) return { ok: false, error: "baseUrl is required." };
  const protocol = request.protocol ?? stored?.protocol;
  const apiKey = request.apiKey?.trim() ? request.apiKey : stored?.apiKey;
  const authStyle = request.authStyle ?? stored?.authStyle;
  const extraHeaders = request.extraHeaders ?? stored?.extraHeaders;
  return {
    ok: true,
    options: {
      baseUrl,
      ...(protocol ? { protocol } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(authStyle ? { authStyle } : {}),
      ...(extraHeaders ? { extraHeaders } : {}),
    },
  };
}

/** 读取服务商可用模型列表（只读）。密钥只在这里使用，不落日志。 */
export async function listProviderModels(options: {
  baseUrl: string;
  protocol?: string;
  apiKey?: string;
  authStyle?: "bearer" | "api-key" | "bedrock-api-key" | "none";
  extraHeaders?: Record<string, string>;
}): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  const protocol = options.protocol ?? "openai-chat-completions";
  const anthropic = protocol === "anthropic-messages";
  const headers = mergeExtraHeaders(
    {
      ...(anthropic ? { "anthropic-version": "2023-06-01" } : {}),
      ...buildAuthHeaders(options.apiKey, options.authStyle, anthropic ? "x-api-key" : "bearer"),
    },
    options.extraHeaders,
  );
  try {
    let lastError = "";
    for (const url of modelsCandidates(options.baseUrl)) {
      const response = await fetch(
        url,
        applyProxy({ headers, signal: AbortSignal.timeout(15_000) }, url),
      );
      // 404 = 这个候选路径不存在，换下一个；其它错误直接报（鉴权/超时/5xx）
      if (response.status === 404) {
        lastError = `HTTP 404 at ${url}`;
        continue;
      }
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 200).trim();
        return {
          ok: false,
          error: `HTTP ${response.status}${detail ? `: ${detail}` : ""} at ${url}`,
        };
      }
      const models = extractModelIds(await response.json());
      if (!models.length) {
        lastError = `empty model list at ${url}`;
        continue;
      }
      return { ok: true, models };
    }
    return { ok: false, error: lastError || "No model list endpoint responded." };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
