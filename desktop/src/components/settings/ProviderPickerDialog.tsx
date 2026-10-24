import { useMemo, useState } from "react";
import { LuSearch } from "react-icons/lu";
import { CUSTOM_TEMPLATE, PROVIDER_CATALOG, type ProviderTemplate } from "../../data/providerCatalog";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { TextField } from "../ui/TextField";
import { ProviderIcon } from "../ui/ProviderIcon";

export function ProviderPickerDialog({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (template: ProviderTemplate) => void;
}) {
  const [query, setQuery] = useState("");

  const list = useMemo(() => {
    const key = query.trim().toLowerCase();
    if (!key) return PROVIDER_CATALOG;
    return PROVIDER_CATALOG.filter(
      (item) => item.id.toLowerCase().includes(key) || item.name.toLowerCase().includes(key),
    );
  }, [query]);

  // 搜索时只在没有命中任何内置服务商（或搜索词本身就是 custom / 自定义）时展示自定义入口
  const showCustom = useMemo(() => {
    const key = query.trim().toLowerCase();
    return !key || "custom".includes(key) || "自定义".includes(query.trim());
  }, [query]);

  // meta 行显示端点域名（没有预设端点的提示需填写）
  const metaOf = (template: ProviderTemplate) => {
    if (!template.baseUrl) return "需填写端点";
    try {
      return new URL(template.baseUrl).host;
    } catch {
      return template.baseUrl;
    }
  };

  return (
    <Dialog open onClose={onClose} labelledBy="mc-picker-title" className="mc-dialog--wide">
      <span className="mc-dialog__title" id="mc-picker-title">
        添加模型服务商
      </span>
      <p className="mc-dialog__desc">
        目录来自 ZCode 与 DSH 的内置服务商清单（已去重）。选择服务商后，再填写你要使用的模型名称；API
        格式之后也能随时切换。没有找到？用「自定义服务商」手动填写端点。
      </p>
      <TextField
        label="搜索"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="按名称或 id 搜索，例如 deepseek"
      />
      <div className="mc-picker__grid">
        {showCustom ? (
          <button
            key={CUSTOM_TEMPLATE.id}
            type="button"
            className="mc-picker__item mc-picker__item--custom"
            onClick={() => onPick(CUSTOM_TEMPLATE)}
          >
            <ProviderIcon template={CUSTOM_TEMPLATE} size={24} />
            <span className="mc-picker__text">
              <span className="mc-picker__name">自定义服务商</span>
              <span className="mc-picker__meta">手动填写端点与密钥</span>
            </span>
          </button>
        ) : null}
        {list.map((template) => (
          <button
            key={template.id}
            type="button"
            className="mc-picker__item"
            onClick={() => onPick(template)}
          >
            <ProviderIcon template={template} size={24} />
            <span className="mc-picker__text">
              <span className="mc-picker__name">{template.name}</span>
              <span className="mc-picker__meta">
                {metaOf(template)}
              </span>
            </span>
          </button>
        ))}
        {list.length === 0 && !showCustom ? (
          <p className="mc-models__empty" style={{ gridColumn: "1 / -1" }}>
            <LuSearch size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            没有匹配的服务商 —— 可以试试「自定义服务商」
          </p>
        ) : null}
      </div>
      <div className="mc-dialog__footer">
        <span className="mc-picker__meta">共 {list.length} 个服务商</span>
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
      </div>
    </Dialog>
  );
}
