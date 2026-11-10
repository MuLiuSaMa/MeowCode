import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuChevronDown } from "react-icons/lu";
import { detectedCapabilities } from "../../modelProfiles";
import { formatCapacity } from "../../util";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Checkbox";
import { Dialog } from "../ui/Dialog";
import { Select } from "../ui/Select";
import { TextField } from "../ui/TextField";
import { ReasoningLevelsField } from "./ReasoningLevelsField";
import type { InputModality, ProviderSettings } from "../../api";
import "./ModelsSection.css";

const MODALITY_VALUES: InputModality[] = ["text", "image", "pdf"];

const CACHE_TTL_OPTIONS = [
  { value: "5m", labelKey: "models.ttlOptions.fiveMinutes" },
  { value: "auto", labelKey: "models.ttlOptions.auto" },
  { value: "1h", labelKey: "models.ttlOptions.oneHour" },
];

const SUMMARY_OPTIONS = [
  { value: "none", labelKey: "models.summaryOptions.none" },
  { value: "auto", labelKey: "models.summaryOptions.auto" },
  { value: "concise", labelKey: "models.summaryOptions.concise" },
  { value: "detailed", labelKey: "models.summaryOptions.detailed" },
];

const COMPACTION_OPTIONS = [
  { value: "auto", labelKey: "models.compactionOptions.auto" },
  { value: "on", labelKey: "models.compactionOptions.on" },
  { value: "off", labelKey: "models.compactionOptions.off" },
];

/**
 * 单个模型的设置：端点 / 密钥 / 协议属于服务商层，不在这里；
 * 这里只放会随模型变化的参数（容量、模态、思考、缓存）。
 */
export function ModelSettingsDialog({
  form,
  contextInput,
  maxInput,
  onChange,
  onContextInputChange,
  onMaxInputChange,
  onClose,
  onSave,
}: {
  form: ProviderSettings;
  contextInput: string;
  maxInput: string;
  onChange: (patch: Partial<ProviderSettings>) => void;
  onContextInputChange: (value: string) => void;
  onMaxInputChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation("settings");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const autoFilledRef = useRef({ context: false, max: false, image: false });
  const lastModelRef = useRef(form.model);

  // 与旧表单一致：模型 ID 变化时按 ZCode 规则自动补容量与图片能力，已手填的不覆盖
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

  const ttlOptions = useMemo(
    () => CACHE_TTL_OPTIONS.map((item) => ({ value: item.value, label: t(item.labelKey) })),
    [t],
  );
  const summaryOptions = useMemo(
    () => SUMMARY_OPTIONS.map((item) => ({ value: item.value, label: t(item.labelKey) })),
    [t],
  );
  const compactionOptions = useMemo(
    () => COMPACTION_OPTIONS.map((item) => ({ value: item.value, label: t(item.labelKey) })),
    [t],
  );

  return (
    <Dialog open onClose={onClose} className="mc-dialog--wide">
      <h2 className="mc-dialog__title">{t("models.form.modelSettings")}</h2>
      <p className="mc-dialog__desc">{t("models.form.modelSettingsDesc")}</p>

      <div className="mc-modelform__grid">
        <TextField
          label={t("models.form.modelId")}
          value={form.model}
          onChange={(event) => onChange({ model: event.target.value })}
          placeholder={t("models.form.modelIdPlaceholder")}
          hint={t("models.form.modelIdHint")}
        />
        <TextField
          label={t("models.form.displayName")}
          value={form.displayName ?? ""}
          onChange={(event) => onChange({ displayName: event.target.value })}
          placeholder={t("models.form.displayNamePlaceholder")}
          hint={t("models.form.displayNameHint")}
        />
        <TextField
          label={t("models.form.contextWindow")}
          value={contextInput}
          onChange={(event) => {
            autoFilledRef.current.context = false;
            onContextInputChange(event.target.value);
          }}
          placeholder="128k"
          hint={t("models.form.contextWindowHint")}
        />
        <TextField
          label={t("models.form.maxOutput")}
          value={maxInput}
          onChange={(event) => {
            autoFilledRef.current.max = false;
            onMaxInputChange(event.target.value);
          }}
          placeholder="32k"
          hint={t("models.form.maxOutputHint")}
        />

        <div className="mc-modalfields__group mc-field--full">
          <span className="mc-modalfields__grouplabel">{t("models.form.modalities")}</span>
          <div className="mc-modalfields__checks">
            {MODALITY_VALUES.map((value) => {
              const checked = value === "text" || (form.inputModalities ?? ["text"]).includes(value);
              const locked = value === "text";
              return (
                <Checkbox
                  key={value}
                  className={`mc-check${locked ? " mc-check--locked" : ""}`}
                  checked={locked ? true : checked}
                  disabled={locked}
                  onChange={(nextChecked) => {
                    autoFilledRef.current.image = false;
                    const current = form.inputModalities ?? ["text"];
                    const next = nextChecked
                      ? [...new Set<InputModality>([...current, value])]
                      : current.filter((item) => item !== value);
                    onChange({ inputModalities: next.length ? next : ["text"] });
                  }}
                  label={
                    <span>
                      {t(`models.modalityOptions.${value}`)}
                      {locked ? t("models.form.requiredTag") : null}
                    </span>
                  }
                />
              );
            })}
          </div>
          <span className="mc-field__hint">{t("models.form.modalityHint")}</span>
        </div>

        <div className="mc-field mc-field--full mc-modelform__advanced">
          <button
            type="button"
            className="mc-modelform__advancedtoggle"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((value) => !value)}
          >
            <LuChevronDown
              size={14}
              className="mc-modelform__advancedchevron"
              data-open={advancedOpen}
              aria-hidden
            />
            {t("models.form.advanced")}
            <span className="mc-modelform__advancedhint">{t("models.form.advancedHint")}</span>
          </button>
          {advancedOpen ? (
            <div className="mc-modelform__grid mc-modelform__advancedbody">
              <TextField
                label={t("models.form.reasoningEffort")}
                value={form.reasoningEffort ?? ""}
                onChange={(event) => onChange({ reasoningEffort: event.target.value })}
                placeholder={t("models.form.reasoningEffortPlaceholder")}
                hint={t("models.form.reasoningEffortHint")}
              />
              <TextField
                label={t("models.form.thinkingBudget")}
                value={form.thinkingBudget === undefined ? "" : String(form.thinkingBudget)}
                onChange={(event) => {
                  const raw = event.target.value.replace(/[^\d]/g, "");
                  onChange({ thinkingBudget: raw ? Number(raw) : undefined });
                }}
                placeholder={t("models.form.thinkingBudgetPlaceholder")}
                hint={t("models.form.thinkingBudgetHint")}
              />
              <Select
                label={t("models.form.cacheTtl")}
                value={form.cacheTtl ?? "5m"}
                options={ttlOptions}
                onChange={(value) =>
                  onChange({ cacheTtl: value === "1h" || value === "auto" ? value : "5m" })
                }
                hint={t("models.form.cacheTtlHint")}
              />
              <Select
                label={t("models.form.reasoningSummary")}
                value={form.reasoningSummary ?? "none"}
                options={summaryOptions}
                onChange={(value) =>
                  onChange({ reasoningSummary: value as ProviderSettings["reasoningSummary"] })
                }
                hint={t("models.form.reasoningSummaryHint")}
              />
              <Select
                label={t("models.form.nativeCompaction")}
                value={
                  form.nativeCompaction === undefined ? "auto" : form.nativeCompaction ? "on" : "off"
                }
                options={compactionOptions}
                onChange={(value) =>
                  onChange({ nativeCompaction: value === "auto" ? undefined : value === "on" })
                }
                hint={t("models.form.nativeCompactionHint")}
              />
              <div className="mc-field--full">
                <ReasoningLevelsField
                  model={form.model}
                  values={form.reasoningLevels ?? []}
                  onChange={(values) => onChange({ reasoningLevels: values })}
                />
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mc-dialog__footer">
        <Button variant="ghost" onClick={onClose}>
          {t("actions.cancel")}
        </Button>
        <Button variant="primary" onClick={onSave}>
          {t("actions.save")}
        </Button>
      </div>
    </Dialog>
  );
}
