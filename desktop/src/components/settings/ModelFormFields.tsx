import { useEffect, useRef } from "react";
import { findTemplate } from "../../data/providerCatalog";
import { detectedCapabilities } from "../../modelProfiles";
import { formatCapacity } from "../../util";
import { Select } from "../ui/Select";
import { TextField } from "../ui/TextField";
import { ProviderIcon } from "../ui/ProviderIcon";
import { ReasoningLevelsField } from "./ReasoningLevelsField";
import { API_FORMATS } from "./modelForm";
import type { ApiFormat, InputModality, ProviderSettings } from "../../api";
import "./ModelsSection.css";

const MODALITIES: Array<{ value: InputModality; label: string }> = [
  { value: "text", label: "文本" },
  { value: "image", label: "图片" },
  { value: "pdf", label: "PDF" },
];

const CAPACITY_PRESETS: Record<"context" | "max", string[]> = {
  context: ["128k", "256k", "512k", "1M"],
  max: ["4k", "16k", "32k", "128k"],
};

/**
 * 模型服务商的完整设置表单。
 * 设置页的「添加/编辑模型」与首次启动引导的「接入」共用同一份字段，避免两处不一致。
 */
export function ModelFormFields({
  form,
  contextInput,
  maxInput,
  onChange,
  onContextInputChange,
  onMaxInputChange,
}: {
  form: ProviderSettings;
  contextInput: string;
  maxInput: string;
  onChange: (patch: Partial<ProviderSettings>) => void;
  onContextInputChange: (value: string) => void;
  onMaxInputChange: (value: string) => void;
}) {
  const template = findTemplate(form.templateId);
  const lastModelRef = useRef(form.model);
  /** 哪些字段是自动填的：换模型时跟着更新；用户手动改过就不再自动覆盖 */
  const autoFilledRef = useRef({ context: false, max: false, image: false });

  /**
   * 模型 ID 变化时，按 ZCode 同步来的规则自动补全上下文 / 最大输出 / 图片能力。
   * 打开已有配置时只补空着的字段，不覆盖用户填好的值。
   */
  useEffect(() => {
    const model = form.model.trim();
    if (!model) return;
    const capabilities = detectedCapabilities(model);
    const changed = lastModelRef.current !== form.model;
    lastModelRef.current = form.model;
    const auto = autoFilledRef.current;

    if (auto.context && !capabilities.contextWindow) {
      auto.context = false;
      onContextInputChange("");
    } else if ((!contextInput.trim() || auto.context) && capabilities.contextWindow) {
      auto.context = true;
      onContextInputChange(formatCapacity(capabilities.contextWindow));
    }

    if (auto.max && !capabilities.maxOutputTokens) {
      auto.max = false;
      onMaxInputChange("");
    } else if ((!maxInput.trim() || auto.max) && capabilities.maxOutputTokens) {
      auto.max = true;
      onMaxInputChange(formatCapacity(capabilities.maxOutputTokens));
    }

    // 换模型时跟新；打开从未配置过容量的旧条目时也补一次，已手动配置过的不动
    const untouched = !form.contextWindow && !form.maxTokens;
    if (!changed && !untouched) return;
    if (capabilities.supportsImage && !(form.inputModalities ?? []).includes("image")) {
      auto.image = true;
      onChange({ inputModalities: ["text", "image"] });
    } else if (capabilities.supportsImage === false && auto.image) {
      auto.image = false;
      onChange({ inputModalities: ["text"] });
    }
    // 只在模型 ID 变化时触发：容量输入框的当前值不作为依赖
  }, [form.model]);

  return (
    <div className="mc-modelform__grid">
      {form.templateId === "custom" ? (
        /* 自定义服务商：名称、端点都由用户填写 */
        <TextField
          className="mc-field--full"
          label="服务商名称"
          value={form.name}
          onChange={(event) => onChange({ name: event.target.value })}
          placeholder="例如 My Provider"
          hint="显示在模型列表的服务商一栏"
        />
      ) : (
        <div className="mc-field mc-field--full">
          <span className="mc-field__label">服务商</span>
          <div className="mc-modelform__provider">
            <ProviderIcon template={template} size={22} />
            <span className="mc-truncate">{form.name}</span>
            <code className="mc-mono mc-modelform__id mc-truncate">{form.templateId}</code>
          </div>
        </div>
      )}

      <Select
        label="API 格式"
        value={form.protocol ?? "openai-chat-completions"}
        options={API_FORMATS}
        onChange={(value) => onChange({ protocol: value as ApiFormat })}
        hint="决定请求打到哪个端点、请求体怎么写"
      />
      <TextField
        label="请求地址"
        value={form.baseUrl}
        onChange={(event) => onChange({ baseUrl: event.target.value })}
        placeholder="https://api.example.com/v1"
        hint="填根地址，路径按上面的格式自动追加"
      />

      <TextField
        label="模型 ID"
        value={form.model}
        onChange={(event) => onChange({ model: event.target.value })}
        placeholder="例如 deepseek-chat"
        hint="服务商文档里的模型标识，必填且不能重复"
      />
      <TextField
        label="模型显示名称"
        value={form.displayName ?? ""}
        onChange={(event) => onChange({ displayName: event.target.value })}
        placeholder="留空则显示模型 ID"
        hint="只影响界面显示"
      />

      <TextField
        label="API 密钥"
        type="password"
        value={form.apiKey ?? ""}
        onChange={(event) => onChange({ apiKey: event.target.value })}
        placeholder={form.hasApiKey ? "已保存，留空则不修改" : "sk-..."}
      />

      <TextField
        label="上下文窗口"
        value={contextInput}
        onChange={(event) => {
          autoFilledRef.current.context = false;
          onContextInputChange(event.target.value);
        }}
        placeholder="128k"
        hint="留空则按模型名自动检测；支持 256K / 1M 写法（K=1000，M=100 万）"
      />
      <TextField
        label="最大输出"
        value={maxInput}
        onChange={(event) => {
          autoFilledRef.current.max = false;
          onMaxInputChange(event.target.value);
        }}
        placeholder="32k"
        hint="留空则按模型名自动检测；单次回复最多产出多少 token"
      />
      <TextField
        label="思考强度"
        value={form.reasoningEffort ?? ""}
        onChange={(event) => onChange({ reasoningEffort: event.target.value })}
        placeholder="留空 = 服务商默认"
        hint="作为 reasoning_effort 下发"
      />
      <TextField
        label="思考预算"
        value={form.thinkingBudget === undefined ? "" : String(form.thinkingBudget)}
        onChange={(event) => {
          const raw = event.target.value.replace(/[^\d]/g, "");
          onChange({ thinkingBudget: raw ? Number(raw) : undefined });
        }}
        placeholder="留空 = 按思考强度档位"
        hint="thinking.budget_tokens；会自动压到 max_tokens 以下"
      />
      <Select
        label="缓存 TTL"
        value={form.cacheTtl ?? "5m"}
        options={[
          { value: "5m", label: "5 分钟（默认）" },
          { value: "1h", label: "1 小时（Anthropic 长 TTL）" },
        ]}
        onChange={(value) => onChange({ cacheTtl: value === "1h" ? "1h" : "5m" })}
        hint="只在支持长 TTL 的服务商上选 1h，否则可能 400"
      />
      <Select
        label="思考摘要"
        value={form.reasoningSummary ?? "none"}
        options={[
          { value: "none", label: "不下发（省 token）" },
          { value: "auto", label: "自动" },
          { value: "concise", label: "简略" },
          { value: "detailed", label: "详细" },
        ]}
        onChange={(value) =>
          onChange({
            reasoningSummary: value as ProviderSettings["reasoningSummary"],
          })
        }
        hint="仅 Responses 协议；摘要按输出 token 计费"
      />
      <Select
        label="服务端压缩"
        value={form.nativeCompaction === undefined ? "auto" : form.nativeCompaction ? "on" : "off"}
        options={[
          { value: "auto", label: "自动（官方端点启用）" },
          { value: "on", label: "强制开启（兼容网关）" },
          { value: "off", label: "关闭（只用本地摘要）" },
        ]}
        onChange={(value) =>
          onChange({ nativeCompaction: value === "auto" ? undefined : value === "on" })
        }
        hint="让服务商压缩历史，省掉一次全量摘要请求"
      />

      <div className="mc-field mc-field--full">
        <span className="mc-field__label">容量预设</span>
        <div className="mc-modelform__presets">
          {CAPACITY_PRESETS.context.map((preset) => (
            <button key={preset} type="button" className="mc-picker__meta mc-modelform__preset" onClick={() => { autoFilledRef.current.context = false; onContextInputChange(preset); }}>
              {preset}
            </button>
          ))}
          <span className="mc-modelform__presetsep" />
          {CAPACITY_PRESETS.max.map((preset) => (
            <button key={`max-${preset}`} type="button" className="mc-picker__meta mc-modelform__preset" onClick={() => { autoFilledRef.current.max = false; onMaxInputChange(preset); }}>
              {preset}
            </button>
          ))}
        </div>
      </div>

      <div className="mc-modalfields__group mc-field--full">
        <span className="mc-modalfields__grouplabel">输入模态</span>
        <div className="mc-modalfields__checks">
          {MODALITIES.map((modality) => {
            const checked = modality.value === "text" || (form.inputModalities ?? ["text"]).includes(modality.value);
            const locked = modality.value === "text";
            return (
              <label key={modality.value} className={`mc-check${locked ? " mc-check--locked" : ""}`}>
                <input
                  type="checkbox"
                  checked={locked ? true : checked}
                  disabled={locked}
                  onChange={(event) => {
                    autoFilledRef.current.image = false;
                    const current = form.inputModalities ?? ["text"];
                    const next = event.target.checked
                      ? [...new Set<InputModality>([...current, modality.value])]
                      : current.filter((item) => item !== modality.value);
                    onChange({ inputModalities: next.length ? next : ["text"] });
                  }}
                />
                {modality.label}
                {locked ? "（必选）" : ""}
              </label>
            );
          })}
        </div>
        <span className="mc-field__hint">图片能力会按模型名自动检测；PDF 仅 Anthropic / Responses 协议可承载。至少保留文本模态。</span>
      </div>

      <div className="mc-field--full">
        <ReasoningLevelsField
          model={form.model}
          values={form.reasoningLevels ?? []}
          onChange={(values) => onChange({ reasoningLevels: values })}
        />
      </div>
    </div>
  );
}
