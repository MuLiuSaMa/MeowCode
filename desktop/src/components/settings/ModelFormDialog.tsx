import { useState } from "react";
import { findTemplate } from "../../data/providerCatalog";
import { formatCapacity } from "../../util";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { ModelFormFields } from "./ModelFormFields";
import { buildProvider } from "./modelForm";
import type { ProviderSettings } from "../../api";

export function ModelFormDialog({
  draft,
  existingIds,
  onClose,
  onSave,
}: {
  draft: ProviderSettings;
  /** 其它已配置项的模型 ID，用于唯一性校验 */
  existingIds: string[];
  onClose: () => void;
  onSave: (provider: ProviderSettings) => void;
}) {
  const [form, setForm] = useState<ProviderSettings>(draft);
  const [contextInput, setContextInput] = useState(formatCapacity(draft.contextWindow));
  const [maxInput, setMaxInput] = useState(formatCapacity(draft.maxTokens));
  const [error, setError] = useState<string | null>(null);

  const template = findTemplate(form.templateId);
  const patch = (part: Partial<ProviderSettings>) => setForm((prev) => ({ ...prev, ...part }));

  const submit = () => {
    const result = buildProvider(form, contextInput, maxInput, existingIds);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSave(result.provider);
  };

  return (
    <Dialog open onClose={onClose} labelledBy="mc-modelform-title" className="mc-dialog--wide">
      <span className="mc-dialog__title" id="mc-modelform-title">
        {template ? `添加模型 · ${template.name}` : "编辑模型"}
      </span>
      <p className="mc-dialog__desc">
        服务商已选好，下面填写模型本身的配置。API 密钥保存在本地（Windows 凭据加密），不会离开这台机器。
      </p>

      <ModelFormFields
        form={form}
        contextInput={contextInput}
        maxInput={maxInput}
        onChange={patch}
        onContextInputChange={setContextInput}
        onMaxInputChange={setMaxInput}
      />

      {error ? <p className="mc-modelform__error">{error}</p> : null}

      <div className="mc-dialog__footer">
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button variant="primary" onClick={submit}>
          保存
        </Button>
      </div>
    </Dialog>
  );
}
