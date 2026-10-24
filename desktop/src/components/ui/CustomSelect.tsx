import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { LuCheck, LuChevronDown } from "react-icons/lu";
import "./CustomSelect.css";

export type CustomSelectOption<T extends string> = {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
};

/**
 * 自绘下拉选择器（不使用原生 <select>）。
 * 按钮 + listbox 浮层，支持键盘上下选择、Enter 确认、Esc 关闭。
 */
export function CustomSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  placement = "bottom",
  className,
  disabled = false,
}: {
  value: T;
  options: Array<CustomSelectOption<T>>;
  onChange: (value: T) => void;
  ariaLabel?: string;
  /** 靠近内容底部时用 top，让菜单向上展开 */
  placement?: "bottom" | "top";
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const selected = options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutside);
    return () => document.removeEventListener("pointerdown", closeOnOutside);
  }, [open]);

  const openMenu = () => {
    if (disabled) return;
    setActiveIndex(selectedIndex);
    setOpen(true);
  };

  const selectAt = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    buttonRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (disabled) return;
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        openMenu();
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % options.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + options.length) % options.length);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectAt(activeIndex);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div
      ref={rootRef}
      className={["mc-customselect", className ?? ""].filter(Boolean).join(" ")}
      data-open={open}
      data-disabled={disabled}
    >
      <button
        ref={buttonRef}
        type="button"
        className="mc-customselect__button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={handleKeyDown}
      >
        <span className="mc-customselect__value">{selected?.label ?? ""}</span>
        <LuChevronDown size={15} className="mc-customselect__chevron" aria-hidden />
      </button>

      {open ? (
        <div
          id={menuId}
          role="listbox"
          className="mc-customselect__menu"
          data-placement={placement}
          onKeyDown={handleKeyDown}
        >
          {options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className="mc-customselect__option"
              data-active={index === activeIndex}
              data-disabled={option.disabled}
              disabled={option.disabled}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => selectAt(index)}
            >
              <span className="mc-customselect__optiontext">
                <span className="mc-customselect__optionlabel">{option.label}</span>
                {option.description ? (
                  <span className="mc-customselect__optiondesc">{option.description}</span>
                ) : null}
              </span>
              {option.value === value ? <LuCheck size={14} aria-hidden /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
