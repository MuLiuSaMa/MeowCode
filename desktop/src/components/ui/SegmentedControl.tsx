import type { ReactNode } from "react";
import "./SegmentedControl.css";

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
}: {
  value: T;
  /** 标签允许是节点（带图标的分段项），纯文本直接传字符串 */
  options: Array<{ value: T; label: ReactNode; disabled?: boolean }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <div className="mc-segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className="mc-segmented__item"
          data-active={option.value === value}
          disabled={disabled || option.disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
