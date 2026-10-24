import { parseCapacity } from "../../util";
import type { ApiFormat, InputModality, ProviderSettings } from "../../api";

/** API 协议选项：设置页与首次启动引导共用。 */
export const API_FORMATS: Array<{ value: ApiFormat; label: string }> = [
  { value: "anthropic-messages", label: "Anthropic Messages (/v1/messages)" },
  { value: "openai-chat-completions", label: "OpenAI Chat Completions (/chat/completions)" },
  { value: "openai-responses", label: "OpenAI Responses (/v1/responses)" },
];

export type BuildProviderResult =
  | { ok: true; provider: ProviderSettings }
  | { ok: false; error: string };

/**
 * 校验模型表单并生成要落盘的 ProviderSettings。
 * 设置页的 ModelFormDialog 与首次启动引导共用，保证两处字段和校验完全一致。
 */
export function buildProvider(
  form: ProviderSettings,
  contextInput: string,
  maxInput: string,
  existingIds: string[],
): BuildProviderResult {
  const model = form.model.trim();
  const name = form.name.trim() || "自定义服务商";
  if (form.templateId === "custom" && !form.name.trim()) {
    return { ok: false, error: "服务商名称不能为空" };
  }
  if (!model) {
    return { ok: false, error: "模型 ID 不能为空" };
  }
  if (existingIds.includes(model)) {
    return { ok: false, error: `模型 ID「${model}」已经配置过了` };
  }
  if (!form.baseUrl.trim()) {
    return { ok: false, error: "请求地址不能为空" };
  }
  const contextWindow = contextInput.trim() ? parseCapacity(contextInput) : undefined;
  if (contextInput.trim() && contextWindow === undefined) {
    return { ok: false, error: "上下文窗口格式不正确，例如 128k 或 1M" };
  }
  const maxTokens = maxInput.trim() ? parseCapacity(maxInput) : undefined;
  if (maxInput.trim() && maxTokens === undefined) {
    return { ok: false, error: "最大输出格式不正确，例如 32k" };
  }
  const modalities = form.inputModalities?.length ? form.inputModalities : (["text"] as InputModality[]);
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
      displayName: form.displayName?.trim() || undefined,
      baseUrl: form.baseUrl.trim(),
      contextWindow,
      maxTokens,
      inputModalities: modalities,
      reasoningLevels: form.reasoningLevels?.length ? form.reasoningLevels : undefined,
      thinkingBudget,
      cacheTtl: form.cacheTtl === "1h" ? "1h" : undefined,
      reasoningSummary:
        form.reasoningSummary && form.reasoningSummary !== "none" ? form.reasoningSummary : undefined,
      enabled: form.enabled !== false,
    },
  };
}
