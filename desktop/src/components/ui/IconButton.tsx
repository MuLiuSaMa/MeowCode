import type { ButtonHTMLAttributes, ReactNode } from "react";
import "./IconButton.css";

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
  size?: "sm" | "md";
  active?: boolean;
};

export function IconButton({
  label,
  children,
  size = "md",
  active = false,
  className,
  type = "button",
  ...rest
}: IconButtonProps) {
  const classes = ["mc-iconbtn", `mc-iconbtn--${size}`, className ?? ""].filter(Boolean).join(" ");
  return (
    <button
      type={type}
      className={classes}
      data-active={active}
      aria-label={label}
      aria-pressed={active}
      title={label}
      {...rest}
    >
      {children}
    </button>
  );
}
