import type { InputHTMLAttributes } from "react";
import "./TextField.css";

export type TextFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
};

export function TextField({ label, hint, id, className, ...rest }: TextFieldProps) {
  const fieldId = id ?? `mc-field-${label.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <label className={["mc-field", className ?? ""].filter(Boolean).join(" ")} htmlFor={fieldId}>
      <span className="mc-field__label">{label}</span>
      <input id={fieldId} className="mc-field__input" {...rest} />
      {hint ? <span className="mc-field__hint">{hint}</span> : null}
    </label>
  );
}
