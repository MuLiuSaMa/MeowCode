import i18n from "i18next";
import { detectedCapabilities } from "../../modelProfiles";
import { formatCapacity, parseCapacity } from "../../util";
import type { ApiFormat, InputModality, ProviderSettings } from "../../api";

/**
 * 校验文案在调用时取，绝不在模块顶层取 —— import 期求值会把语言锁死在首帧。
 * 返回值仍是字符串，所以设置页与首次启动引导两个调用点都不用改类型。
 */
const translate = (key: string, values?: Record<string, unknown>): string =>
  i18n.t(`settings:${key}`, values);

/** API 协议选项：设置页与首次启动引导共用。 */
export const API_FORMATS: Array<{ value: ApiFormat; label: string }> = [
  { value: "anthropic-messages", label: "Anthropic Messages (/v1/messages)" },
  { value: "openai-chat-completions", label: "OpenAI Chat Completions (/chat/completions)" },
  { value: "openai-responses", label: "OpenAI Responses (/v1/responses)" },
];

/** 按请求地址识别出的协议（外加个别主机附带的鉴权方式）。 */
export type ApiFormatGuess = {
  protocol: ApiFormat;
  /** 仅 Azure / Bedrock 这类鉴权头特殊的主机才给出 */
  authStyle?: "api-key" | "bedrock-api-key";
};

/**
 * 按 API 地址猜测协议格式；没有把握时返回 undefined（调用方保持当前选择不动）。
 *
 * 识别优先级（先命中先返回）：
 *  1. 端点动作名 —— 用户把完整端点粘进来了：/chat/completions、/messages、/responses；
 *  2. 协议专用路径段 —— /anthropic（z.ai、DeepSeek、百炼、MiniMax、小米、Kimi 的
 *     Anthropic 兼容网关都是这种写法）；compatible-mode（百炼国际 OpenAI 兼容）；
 *  3. 知名主机 —— api.anthropic.com / api.openai.com / api.x.ai / *.openai.azure.com /
 *     *.amazonaws.com / *.googleapis.com；Azure 与 Bedrock 同时给出鉴权头风格；
 *  4. 其余一律 undefined —— 不确定就别动，默认兜底交给表单现状（大多数是 chat completions）。
 */
export function detectApiFormat(url: string): ApiFormatGuess | undefined {
  const raw = url.trim();
  if (!raw) return undefined;
  let host = "";
  let path = "";
  try {
    // 允许用户偷懒不写协议头（api.example.com/v1）
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname.toLowerCase().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
  if (path.endsWith("/chat/completions")) return { protocol: "openai-chat-completions" };
  if (path.endsWith("/messages")) return { protocol: "anthropic-messages" };
  if (path.endsWith("/responses")) return { protocol: "openai-responses" };
  if (path.split("/").includes("anthropic")) return { protocol: "anthropic-messages" };
  if (path.includes("compatible-mode")) return { protocol: "openai-chat-completions" };
  if (host === "api.anthropic.com") return { protocol: "anthropic-messages" };
  if (host === "api.openai.com" || host === "api.x.ai") return { protocol: "openai-responses" };
  if (host === "openai.azure.com" || host.endsWith(".openai.azure.com")) {
    return { protocol: "openai-chat-completions", authStyle: "api-key" };
  }
  if (host.endsWith(".amazonaws.com")) {
    return { protocol: "openai-chat-completions", authStyle: "bedrock-api-key" };
  }
  if (host.endsWith(".googleapis.com")) return { protocol: "openai-chat-completions" };
  return undefined;
}

/**
 * 解析「额外请求头」多行文本（每行 `Name: value`，# 开头为注释，空行忽略）。
 * 无法解析的行抛错，由调用方展示。
 */
export function parseExtraHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error(translate("models.error.headerLine", { line }));
    headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return headers;
}

/** 反向：把额外请求头对象格式化成可编辑的多行文本。 */
export function formatExtraHeaders(headers: Record<string, string> | undefined): string {
  if (!headers) return "";
  return Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

/** 解析「额外请求体」JSON 文本；空串 → undefined。非对象 JSON 抛错。 */
export function parseExtraBody(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      translate("models.error.extraBodyJson", {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(translate("models.error.extraBodyObject"));
  }
  return parsed as Record<string, unknown>;
}

/** 每个字段是不是「上次自动填的」：只有自动填的值才允许被下一次识别覆盖。 */
export type ModelCapabilityAuto = { context: boolean; max: boolean; image: boolean };

export type DetectedCapabilityResult = {
  form: ProviderSettings;
  contextInput: string;
  maxInput: string;
  auto: ModelCapabilityAuto;
};

/**
 * 模型 ID → 容量 / 模态的自动补全（纯函数）。
 * 行内输入与「获取模型列表」新增行共用；手填值不会被覆盖。
 */
export function applyDetectedCapabilities(
  form: ProviderSettings,
  contextInput: string,
  maxInput: string,
  auto: ModelCapabilityAuto,
): DetectedCapabilityResult {
  const capabilities = detectedCapabilities(form.model.trim());
  let nextContext = contextInput;
  let nextMax = maxInput;

  if (auto.context && !capabilities.contextWindow) {
    auto.context = false;
    nextContext = "";
  } else if ((!nextContext.trim() || auto.context) && capabilities.contextWindow) {
    auto.context = true;
    nextContext = formatCapacity(capabilities.contextWindow);
  }

  if (auto.max && !capabilities.maxOutputTokens) {
    auto.max = false;
    nextMax = "";
  } else if ((!nextMax.trim() || auto.max) && capabilities.maxOutputTokens) {
    auto.max = true;
    nextMax = formatCapacity(capabilities.maxOutputTokens);
  }

  let nextForm = form;
  const modalities = form.inputModalities?.length ? form.inputModalities : (["text"] as InputModality[]);
  if (capabilities.supportsImage === true && !modalities.includes("image")) {
    auto.image = true;
    nextForm = {
      ...form,
      inputModalities: [...new Set<InputModality>([...modalities, "image"])],
    };
  } else if (capabilities.supportsImage === false && auto.image) {
    auto.image = false;
    nextForm = { ...form, inputModalities: ["text"] };
  }

  return { form: nextForm, contextInput: nextContext, maxInput: nextMax, auto };
}

export type BuildProviderResult =
  | { ok: true; provider: ProviderSettings }
  | { ok: false; error: string };

/**
 * 列表与弹层里显示的名字：没填显示名时回退到模型 ID。
 * 唯一性校验也以它为准 —— 同一个模型 ID 可以配多条（不同端点/密钥），
 * 但两条在界面上一模一样就分不清用哪个了。
 */
export function providerLabel(provider: { displayName?: string; model: string }): string {
  return provider.displayName?.trim() || provider.model.trim();
}

/**
 * 校验模型表单并生成要落盘的 ProviderSettings。
 * 设置页的 ModelFormDialog 与首次启动引导共用，保证两处字段和校验完全一致。
 */
export function buildProvider(
  form: ProviderSettings,
  contextInput: string,
  maxInput: string,
  existingLabels: string[],
): BuildProviderResult {
  const model = form.model.trim();
  const displayName = form.displayName?.trim() || "";
  const name = form.name.trim() || translate("models.form.customProviderName");
  if (form.templateId === "custom" && !form.name.trim()) {
    return { ok: false, error: translate("models.error.providerNameRequired") };
  }
  if (!model) {
    return { ok: false, error: translate("models.error.modelRequired") };
  }
  if (existingLabels.includes(displayName || model)) {
    return { ok: false, error: translate("models.error.duplicateName", { name: displayName || model }) };
  }
  if (!form.baseUrl.trim()) {
    return { ok: false, error: translate("models.error.baseUrlRequired") };
  }
  const contextWindow = contextInput.trim() ? parseCapacity(contextInput) : undefined;
  if (contextInput.trim() && contextWindow === undefined) {
    return { ok: false, error: translate("models.error.contextFormat") };
  }
  const maxTokens = maxInput.trim() ? parseCapacity(maxInput) : undefined;
  if (maxInput.trim() && maxTokens === undefined) {
    return { ok: false, error: translate("models.error.maxOutputFormat") };
  }
  const modalities = form.inputModalities?.length ? form.inputModalities : (["text"] as InputModality[]);
  // 额外请求体只接受 JSON 对象（数组/标量会在服务端 JSON.stringify 时产生意外形态）
  if (form.extraBody !== undefined && (!form.extraBody || typeof form.extraBody !== "object" || Array.isArray(form.extraBody))) {
    return { ok: false, error: translate("models.error.extraBodyObject") };
  }
  // 思考预算：非法/非正数一律清掉（服务端会按档位推导），避免把 0 当成"要 0 预算"
  const thinkingBudget =
    typeof form.thinkingBudget === "number" && Number.isFinite(form.thinkingBudget) && form.thinkingBudget > 0
      ? Math.floor(form.thinkingBudget)
      : undefined;

  return {
    ok: true,
    provider: {
      ...form,
      name,
      model,
      displayName: displayName || undefined,
      baseUrl: form.baseUrl.trim(),
      contextWindow,
      maxTokens,
      inputModalities: modalities,
      reasoningLevels: form.reasoningLevels?.length ? form.reasoningLevels : undefined,
      thinkingBudget,
      cacheTtl: form.cacheTtl && form.cacheTtl !== "5m" ? form.cacheTtl : undefined,
      reasoningSummary:
        form.reasoningSummary && form.reasoningSummary !== "none" ? form.reasoningSummary : undefined,
      enabled: form.enabled !== false,
    },
  };
}
