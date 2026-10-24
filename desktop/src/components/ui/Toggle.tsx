import "./Toggle.css";

export function Toggle({
  checked,
  onChange,
  disabled = false,
  id,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  id?: string;
  /** 无可视 label 时作为 aria-label 兜底 */
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      className="mc-toggle"
      data-checked={checked}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="mc-toggle__knob" />
    </button>
  );
}
