import type { ReactNode } from "react";
import { LuCheck } from "react-icons/lu";
import "./Checkbox.css";

/** 与对话列表多选完全同源的方框：14px、4px 圆角、brand 实底 + 白色对勾。 */
function Box({ checked }: { checked: boolean }) {
  return (
    <span className="mc-checkbox__box" data-checked={checked ? "true" : undefined} aria-hidden="true">
      {checked ? <LuCheck size={11} /> : null}
    </span>
  );
}

function classes(...parts: Array<string | undefined | false>): string {
  return parts.filter(Boolean).join(" ");
}

function HiddenInput({
  checked,
  disabled,
  ariaLabel,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  onChange?: (checked: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      className="mc-checkbox__input"
      checked={checked}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => onChange?.(event.target.checked)}
    />
  );
}

export type CheckboxProps = {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  /** 方框右侧的文字；纯图标场景留空 */
  label?: ReactNode;
  className?: string;
  ariaLabel?: string;
  title?: string;
  /** 危险操作（强制覆盖、强推）用红色实底 */
  danger?: boolean;
};

/** 标准勾选框：方框 + 文字，自带 label 语义，点文字也能切换。 */
export function Checkbox({
  checked,
  onChange,
  disabled = false,
  label,
  className,
  ariaLabel,
  title,
  danger = false,
}: CheckboxProps) {
  return (
    <label
      className={classes("mc-checkbox", className)}
      data-disabled={disabled ? "true" : undefined}
      data-danger={danger ? "true" : undefined}
      title={title}
    >
      <HiddenInput checked={checked} disabled={disabled} ariaLabel={ariaLabel} onChange={onChange} />
      <Box checked={checked} />
      {label !== undefined ? <span className="mc-checkbox__label">{label}</span> : null}
    </label>
  );
}

/** 只有方框、没有文字：用于已有 label 容器或列表行的紧凑布局。 */
export function CheckboxMark({
  checked,
  onChange,
  disabled = false,
  className,
  ariaLabel,
  title,
  danger = false,
}: Omit<CheckboxProps, "label">) {
  return (
    <label
      className={classes("mc-checkbox__mark", className)}
      data-disabled={disabled ? "true" : undefined}
      data-danger={danger ? "true" : undefined}
      title={title}
    >
      <HiddenInput checked={checked} disabled={disabled} ariaLabel={ariaLabel} onChange={onChange} />
      <Box checked={checked} />
    </label>
  );
}

/** 纯展示方框：不能嵌 label 的地方（如按钮内部）复用同一套视觉。 */
export function CheckboxBox({ checked, className }: { checked: boolean; className?: string }) {
  return (
    <span
      className={classes("mc-checkbox__box", className)}
      data-checked={checked ? "true" : undefined}
      aria-hidden="true"
    >
      {checked ? <LuCheck size={11} /> : null}
    </span>
  );
}
