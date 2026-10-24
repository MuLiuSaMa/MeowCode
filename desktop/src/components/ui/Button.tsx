import type { ButtonHTMLAttributes, ReactNode } from "react";
import "./Button.css";

type Variant = "primary" | "ghost" | "outline" | "danger";
type Size = "sm" | "md" | "lg";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  block?: boolean;
  icon?: ReactNode;
  children?: ReactNode;
};

export function Button({
  variant = "ghost",
  size = "md",
  block = false,
  icon,
  children,
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  const classes = [
    "mc-btn",
    `mc-btn--${variant}`,
    `mc-btn--${size}`,
    block ? "mc-btn--block" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button type={type} className={classes} {...rest}>
      {icon ? <span className="mc-btn__icon">{icon}</span> : null}
      {children ? <span className="mc-btn__label">{children}</span> : null}
    </button>
  );
}
