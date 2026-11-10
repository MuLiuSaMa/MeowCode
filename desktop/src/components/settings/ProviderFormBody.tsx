import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuPlus, LuSettings2, LuTrash2 } from "react-icons/lu";
import { api } from "../../api";
import { findTemplate } from "../../data/providerCatalog";
import { formatCapacity } from "../../util";
import { Button } from "../ui/Button";
import { CheckboxMark } from "../ui/Checkbox";
import { IconButton } from "../ui/IconButton";
import { ProviderIcon } from "../ui/ProviderIcon";
import { Select } from "../ui/Select";
import { TextField } from "../ui/TextField";
import { ModelSettingsDialog } from "./ModelSettingsDialog";
import {
  API_FORMATS,
  applyDetectedCapabilities,
  buildProvider,
  detectApiFormat,
  formatExtraHeaders,
  mergeProviderRow,
  parseExtraBody,
  parseExtraHeaders,
  providerLabel,
  type ModelCapabilityAuto,
} from "./modelForm";
import type { ApiFormat, ProviderSettings } from "../../api";
import "./ModelsSection.css";

export type ProviderRow = {
  key: string;
  form: ProviderSettings;
  contextInput: string;
  maxInput: string;
};

let rowSeq = 0;
function rowKey(): string {
  rowSeq += 1;
  return `row-${Date.now()}-${rowSeq}`;
}

function baseFrom(draft: ProviderSettings, entries: ProviderSettings[]): ProviderSettings {
  const initial = entries[0] ?? draft;
  return {
    ...draft,
    name: initial.name,
    baseUrl: initial.baseUrl,
    protocol: initial.protocol,
    apiKey: initial.apiKey,
    hasApiKey: initial.hasApiKey,
    authStyle: initial.authStyle,
    extraHeaders: initial.extraHeaders,
    extraBody: initial.extraBody,
  };
}

function rowsFrom(draft: ProviderSettings, entries: ProviderSettings[]): ProviderRow[] {
  if (entries.length) {
    return entries.map((entry) => ({
      key: rowKey(),
      form: entry,
      contextInput: formatCapacity(entry.contextWindow),
      maxInput: formatCapacity(entry.maxTokens),
    }));
  }
  return [
    {
      key: rowKey(),
      form: { ...draft, model: draft.model ?? "" },
      contextInput: formatCapacity(draft.contextWindow),
      maxInput: formatCapacity(draft.maxTokens),
    },
  ];
}

/**
 * 服务商表单状态：端点 / 密钥 / 协议在上层配置一次，下方一个模型一行。
 * 存储仍是「一条 = 一个模型」，保存时统一展开成多条 ProviderSettings。
 * 设置页弹层与首次启动引导共用，保证两处字段、校验、获取模型列表完全一致。
 */
export function useProviderForm({
  draft,
  entries = [],
  onSave,
}: {
  draft: ProviderSettings;
  /** 同一服务商下已有的模型条目（编辑时传入；新建为空） */
  entries?: ProviderSettings[];
  onSave: (entries: ProviderSettings[]) => void;
}) {
  const { t } = useTranslation("settings");
  const initial = entries[0] ?? draft;
  const [base, setBase] = useState<ProviderSettings>(() => baseFrom(draft, entries));
  const [rows, setRows] = useState<ProviderRow[]>(() => rowsFrom(draft, entries));
  const [headersText, setHeadersText] = useState(formatExtraHeaders(initial.extraHeaders));
  const [bodyText, setBodyText] = useState(
    initial.extraBody ? JSON.stringify(initial.extraBody, null, 2) : "",
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  /** 每行容量/模态是否由自动补全填入：只覆盖自动填的值，不动用户手填的 */
  const autoRef = useRef(new Map<string, ModelCapabilityAuto>());
  /** 协议与鉴权是否仍由请求地址自动识别：用户手选过就不再被 URL 覆盖 */
  const protocolAutoRef = useRef(true);
  const authAutoRef = useRef(true);
  /** 每行「该不该按来源条目继承密钥」在提交时判定，这里只记创建时的 id 集合 */
  const initialIds = useMemo(() => new Set(entries.map((entry) => entry.id)), [entries]);
  const keySourceId = entries[0]?.id;

  // 引导页会在同一处（保持挂载）反复挑服务商模板：换模板即整表重置。
  // 弹层每次打开都是新实例，不会走到这里。
  const draftIdRef = useRef(draft.id);
  if (draftIdRef.current !== draft.id) {
    draftIdRef.current = draft.id;
    const nextInitial = entries[0] ?? draft;
    setBase(baseFrom(draft, entries));
    setRows(rowsFrom(draft, entries));
    setHeadersText(formatExtraHeaders(nextInitial.extraHeaders));
    setBodyText(nextInitial.extraBody ? JSON.stringify(nextInitial.extraBody, null, 2) : "");
    setAdvancedOpen(false);
    setEditingKey(null);
    setError(null);
    setFetching(false);
    autoRef.current = new Map();
    protocolAutoRef.current = true;
    authAutoRef.current = true;
  }

  const template = findTemplate(base.templateId);
  const patchBase = (part: Partial<ProviderSettings>) => setBase((prev) => ({ ...prev, ...part }));

  /** URL 变化：自动态下同步协议与鉴权方式（Azure/Bedrock 的鉴权头由此识别） */
  const updateBaseUrl = (next: string) => {
    const guess = detectApiFormat(next);
    setBase((prev) => ({
      ...prev,
      baseUrl: next,
      ...(guess && protocolAutoRef.current ? { protocol: guess.protocol } : {}),
      ...(guess?.authStyle && authAutoRef.current ? { authStyle: guess.authStyle } : {}),
    }));
  };
  const setProtocolManual = (protocol: ApiFormat) => {
    protocolAutoRef.current = false;
    patchBase({ protocol });
  };
  const setAuthStyleManual = (authStyle: ProviderSettings["authStyle"]) => {
    authAutoRef.current = false;
    patchBase({ authStyle });
  };
  const patchRow = (key: string, part: Partial<ProviderRow>) =>
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...part } : row)));
  const editingRow = rows.find((row) => row.key === editingKey) ?? null;

  /** 新行插到列表最上面：刚加的模型 ID 立刻可见，不用滚到底部 */
  const addRow = () => {
    setRows((prev) => [
      { key: rowKey(), form: { ...base, model: "", enabled: true }, contextInput: "", maxInput: "" },
      ...prev,
    ]);
  };

  const removeRow = (key: string) =>
    setRows((prev) => prev.filter((row) => row.key !== key));

  /** 用户手填上下文后不再被模型 ID 自动补全覆盖 */
  const markContextManual = (key: string) => {
    const auto = autoRef.current.get(key) ?? { context: false, max: false, image: false };
    auto.context = false;
    autoRef.current.set(key, auto);
  };

  /** 行内改模型 ID：立刻按规则补上下文 / 最大输出 / 图片模态，不用进设置弹层 */
  const updateRowModel = (key: string, model: string, row: ProviderRow) => {
    const auto = autoRef.current.get(key) ?? { context: false, max: false, image: false };
    autoRef.current.set(key, auto);
    const detected = applyDetectedCapabilities(
      { ...row.form, model },
      row.contextInput,
      row.maxInput,
      auto,
    );
    patchRow(key, {
      form: detected.form,
      contextInput: detected.contextInput,
      maxInput: detected.maxInput,
    });
  };

  const fetchModels = async () => {
    if (!base.baseUrl.trim()) {
      setError(t("models.error.baseUrlRequired"));
      return;
    }
    setFetching(true);
    setError(null);
    try {
      const result = await api<{ models: string[] }>("/provider/models", {
        method: "POST",
        body: JSON.stringify({
          // 编辑已存服务商时密钥不在渲染层：带上同组 id，服务端回退到存档 key
          ...(keySourceId ? { providerId: keySourceId } : {}),
          baseUrl: base.baseUrl,
          protocol: base.protocol ?? "openai-chat-completions",
          ...(base.apiKey ? { apiKey: base.apiKey } : {}),
          ...(base.authStyle ? { authStyle: base.authStyle } : {}),
          ...(base.extraHeaders ? { extraHeaders: base.extraHeaders } : {}),
        }),
      });
      const models = result?.models ?? [];
      if (!models.length) {
        setError(t("models.form.fetchEmpty"));
        return;
      }
      // 拉到的模型全部进列表，但默认不勾选（= 不显示在输入框的模型列表里）。
      // 还没填内容的空行直接丢掉：不要拉取后还留一个空 Model ID。
      setRows((prev) => {
        const kept = prev.filter((row) => row.form.model.trim().length > 0);
        const known = new Set(kept.map((row) => row.form.model.trim()));
        const additions = models
          .filter((id) => !known.has(id))
          .map((id) => {
            // 拉到的模型也按模型规则补容量/模态：与手输模型 ID 保持一致
            const detected = applyDetectedCapabilities(
              { ...base, model: id, enabled: false },
              "",
              "",
              { context: false, max: false, image: false },
            );
            return {
              key: rowKey(),
              form: detected.form,
              contextInput: detected.contextInput,
              maxInput: detected.maxInput,
            };
          });
        return [...kept, ...additions];
      });
    } catch (err) {
      setError(
        t("models.form.fetchFailed", {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setFetching(false);
    }
  };

  const submit = () => {
    if (base.templateId === "custom" && !base.name.trim()) {
      setError(t("models.error.providerNameRequired"));
      return;
    }
    if (!base.baseUrl.trim()) {
      setError(t("models.error.baseUrlRequired"));
      return;
    }
    if (!rows.length) {
      setError(t("models.form.modelsRequired"));
      return;
    }
    let extraHeaders: Record<string, string> | undefined;
    let extraBody: Record<string, unknown> | undefined;
    try {
      const headers = parseExtraHeaders(headersText);
      extraHeaders = Object.keys(headers).length ? headers : undefined;
      extraBody = parseExtraBody(bodyText);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    // 显示名只要求同一服务商内不重复；不同服务商可以有同名模型。
    const labels: string[] = [];
    const built: ProviderSettings[] = [];
    const usedIds = new Set<string>();
    for (const row of rows) {
      const result = buildProvider(
        { ...mergeProviderRow(row.form, base), extraHeaders, extraBody },
        row.contextInput,
        row.maxInput,
        labels,
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // 新行会继承服务商草稿的 id：同一次保存里必须去重，否则多条记录撞 id
      const provider = result.provider;
      if (!provider.id || usedIds.has(provider.id)) {
        provider.id = `provider-${Date.now()}-${built.length}`;
      }
      // 新条目没有历史密钥：主进程按来源 id 继承同组已存的 key
      if (keySourceId && !initialIds.has(provider.id)) {
        provider.apiKeySourceId = keySourceId;
      }
      usedIds.add(provider.id);
      labels.push(providerLabel(provider));
      built.push(provider);
    }
    setError(null);
    onSave(built);
  };

  return {
    base,
    rows,
    headersText,
    bodyText,
    advancedOpen,
    editingRow,
    error,
    fetching,
    template,
    setHeadersText,
    setBodyText,
    setAdvancedOpen,
    setEditingKey,
    patchBase,
    patchRow,
    updateBaseUrl,
    setProtocolManual,
    setAuthStyleManual,
    addRow,
    removeRow,
    markContextManual,
    updateRowModel,
    fetchModels,
    submit,
  };
}

export type ProviderFormController = ReturnType<typeof useProviderForm>;

/** 表单体：服务商字段 + 模型行；保存按钮由外层（弹层页脚 / 引导页页脚）提供。 */
export function ProviderFormBody({ controller }: { controller: ProviderFormController }) {
  const { t } = useTranslation("settings");
  const {
    base,
    rows,
    headersText,
    bodyText,
    advancedOpen,
    editingRow,
    error,
    fetching,
    template,
    setHeadersText,
    setBodyText,
    setAdvancedOpen,
    setEditingKey,
    patchBase,
    patchRow,
    updateBaseUrl,
    setProtocolManual,
    setAuthStyleManual,
    addRow,
    removeRow,
    markContextManual,
    updateRowModel,
    fetchModels,
  } = controller;

  const authOptions = useMemo(
    () => [
      { value: "default", label: t("models.authOptions.protocolDefault") },
      { value: "bearer", label: t("models.authOptions.bearer") },
      { value: "api-key", label: t("models.authOptions.azureKey") },
      { value: "bedrock-api-key", label: t("models.authOptions.bedrockKey") },
      { value: "none", label: t("models.authOptions.none") },
    ],
    [t],
  );

  return (
    <>
      <div className="mc-modelform__grid">
        {base.templateId === "custom" ? (
          <TextField
            className="mc-field--full"
            label={t("models.form.providerName")}
            value={base.name}
            onChange={(event) => patchBase({ name: event.target.value })}
            placeholder={t("models.form.providerNamePlaceholder")}
            hint={t("models.form.providerNameHint")}
          />
        ) : (
          <div className="mc-field mc-field--full">
            <span className="mc-field__label">{t("models.form.provider")}</span>
            <div className="mc-modelform__provider">
              <ProviderIcon template={template} size={22} />
              <span className="mc-truncate">{base.name}</span>
              <code className="mc-mono mc-modelform__id mc-truncate">{base.templateId}</code>
            </div>
          </div>
        )}

        <Select
          label={t("models.form.apiFormat")}
          value={base.protocol ?? "openai-chat-completions"}
          options={API_FORMATS}
          onChange={(value) => setProtocolManual(value as ApiFormat)}
          hint={t("models.form.apiFormatDesc")}
        />
        <TextField
          label={t("models.form.baseUrl")}
          value={base.baseUrl}
          onChange={(event) => updateBaseUrl(event.target.value)}
          placeholder="https://api.example.com/v1"
          hint={t("models.form.baseUrlHint")}
        />
        <TextField
          className="mc-field--full"
          label={t("models.form.apiKey")}
          type="password"
          value={base.apiKey ?? ""}
          onChange={(event) => patchBase({ apiKey: event.target.value })}
          placeholder={base.hasApiKey ? t("models.form.apiKeySaved") : "sk-..."}
        />

        <div className="mc-field mc-field--full mc-modelform__advanced">
          <button
            type="button"
            className="mc-modelform__advancedtoggle"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen(!advancedOpen)}
          >
            {t("models.form.advanced")}
            <span className="mc-modelform__advancedhint">{t("models.form.advancedHint")}</span>
          </button>
          {advancedOpen ? (
            <div className="mc-modelform__grid mc-modelform__advancedbody">
              <Select
                label={t("models.form.authStyle")}
                value={base.authStyle ?? "default"}
                options={authOptions}
                onChange={(value) =>
                  setAuthStyleManual(
                    value === "default" ? undefined : (value as ProviderSettings["authStyle"]),
                  )
                }
                hint={t("models.form.authStyleHint")}
              />
              <TextField
                className="mc-field--full"
                label={t("models.form.extraHeaders")}
                value={headersText}
                onChange={(event) => setHeadersText(event.target.value)}
                placeholder={"HTTP-Referer: https://example.com\nX-Title: MeowCode"}
                hint={t("models.form.extraHeadersHint")}
              />
              <TextField
                className="mc-field--full"
                label={t("models.form.extraBody")}
                value={bodyText}
                onChange={(event) => setBodyText(event.target.value)}
                placeholder={'{\n  "enable_thinking": false\n}'}
                hint={t("models.form.extraBodyHint")}
              />
            </div>
          ) : null}
        </div>
      </div>

      <div className="mc-modelrows">
        <div className="mc-modelrows__head">
          <span className="mc-modalfields__grouplabel">{t("models.form.models")}</span>
          <div className="mc-modelrows__toolbar">
            <Button size="sm" onClick={addRow} icon={<LuPlus size={13} />}>
              {t("models.form.addModel")}
            </Button>
            <Button size="sm" onClick={() => void fetchModels()} disabled={fetching}>
              {fetching ? t("models.form.fetching") : t("models.form.fetchModels")}
            </Button>
          </div>
        </div>
        <span className="mc-field__label">{t("models.form.modelId")}</span>
        {rows.map((row) => (
          <div className="mc-modelrow" key={row.key}>
            <CheckboxMark
              className="mc-modelrow__check"
              checked={row.form.enabled !== false}
              onChange={(enabled) => patchRow(row.key, { form: { ...row.form, enabled } })}
              ariaLabel={t("models.enableAria", { name: row.form.model || "—" })}
            />
            <TextField
              className="mc-modelrow__id"
              label=""
              value={row.form.model}
              onChange={(event) => updateRowModel(row.key, event.target.value, row)}
              placeholder={t("models.form.modelIdPlaceholder")}
            />
            <TextField
              className="mc-modelrow__context"
              label=""
              value={row.contextInput}
              onChange={(event) => {
                markContextManual(row.key);
                patchRow(row.key, { contextInput: event.target.value });
              }}
              placeholder={t("models.form.contextDefault")}
            />
            <IconButton
              label={t("models.form.modelSettings")}
              size="sm"
              onClick={() => setEditingKey(row.key)}
            >
              <LuSettings2 size={14} />
            </IconButton>
            <IconButton
              label={t("actions.delete")}
              size="sm"
              onClick={() => removeRow(row.key)}
            >
              <LuTrash2 size={14} />
            </IconButton>
          </div>
        ))}
      </div>

      {error ? <p className="mc-modelform__error">{error}</p> : null}

      {editingRow ? (
        <ModelSettingsDialog
          form={editingRow.form}
          contextInput={editingRow.contextInput}
          maxInput={editingRow.maxInput}
          onChange={(part) => patchRow(editingRow.key, { form: { ...editingRow.form, ...part } })}
          onContextInputChange={(value) => patchRow(editingRow.key, { contextInput: value })}
          onMaxInputChange={(value) => patchRow(editingRow.key, { maxInput: value })}
          onClose={() => setEditingKey(null)}
          onSave={() => setEditingKey(null)}
        />
      ) : null}
    </>
  );
}
