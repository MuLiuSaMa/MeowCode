import { CustomSelect } from "../ui/CustomSelect";

const pad2 = (n: number) => String(n).padStart(2, "0");
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => ({ value: pad2(i), label: pad2(i) }));
const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, i) => ({ value: pad2(i), label: pad2(i) }));

/**
 * 应用风格的时间选择（HH:MM）：两个 CustomSelect 替代原生 <input type="time">。
 * 原生 spinner 弹层与深色 UI 完全脱节，且右侧时钟图标不可点击；这里右侧
 * chevron 就是选择按钮。value/onChange 直接走 "HH:MM"（与主进程 normalize 一致）。
 */
export function TimeSelect({
  value,
  onChange,
  ariaLabel,
}: {
  /** "HH:MM"（"9:00" 这类缺前导零的值也能容住） */
  value: string;
  onChange: (next: string) => void;
  ariaLabel?: string;
}) {
  const [hours = "09", minutes = "00"] = value.split(":");
  return (
    <div className="mc-auto__timeselect">
      <CustomSelect
        value={hours}
        options={HOUR_OPTIONS}
        onChange={(h) => onChange(`${h}:${minutes}`)}
        ariaLabel={ariaLabel ? `${ariaLabel} · HH` : undefined}
      />
      <span className="mc-auto__timesep">:</span>
      <CustomSelect
        value={minutes}
        options={MINUTE_OPTIONS}
        onChange={(m) => onChange(`${hours}:${m}`)}
        ariaLabel={ariaLabel ? `${ariaLabel} · mm` : undefined}
      />
    </div>
  );
}
