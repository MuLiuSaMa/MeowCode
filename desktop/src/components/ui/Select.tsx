import { CustomSelect } from "./CustomSelect";
import "./Select.css";

/**
 * 带标题/说明的表单下拉框。
 * 内部用自绘的 CustomSelect（不用原生 <select>），所以弹出列表与全局主题一致。
 */
export function Select({
  label,
  value,
  options,
  onChange,
  hint,
  disabled = false,
  id,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  onChange: (value: string) => void;
  hint?: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <div className="mc-field" id={id}>
      <span className="mc-field__label">{label}</span>
      <CustomSelect
        value={value}
        options={options}
        onChange={onChange}
        disabled={disabled}
        ariaLabel={label}
        className="mc-field__select"
      />
      {hint ? <span className="mc-field__hint">{hint}</span> : null}
    </div>
  );
}
