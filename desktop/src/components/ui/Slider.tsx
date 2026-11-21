import "./Slider.css";

/**
 * 带当前值回显的滑杆。
 * 设置页里只有外观的几项调节用得到，所以做成极简版本：原生 range + 定宽读数。
 */
export function Slider({
  value,
  min,
  max,
  step,
  onChange,
  ariaLabel,
  format,
  disabled = false,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  ariaLabel: string;
  /** 右侧读数格式化（如百分比） */
  format: (value: number) => string;
  disabled?: boolean;
}) {
  return (
    <div className="mc-sliderfield" data-disabled={disabled}>
      <input
        className="mc-sliderfield__input"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="mc-sliderfield__value">{format(value)}</span>
    </div>
  );
}
