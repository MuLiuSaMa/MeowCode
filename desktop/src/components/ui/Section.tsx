import type { ReactNode } from "react";
import "./Section.css";

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="mc-section">
      <header className="mc-section__head">
        <h2 className="mc-section__title">{title}</h2>
        {description ? <p className="mc-section__desc">{description}</p> : null}
      </header>
      <div className="mc-section__body">{children}</div>
    </section>
  );
}

/** 左标签 / 右控件的一行。 */
export function FieldRow({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="mc-fieldrow">
      <div className="mc-fieldrow__text">
        <label className="mc-fieldrow__label" htmlFor={htmlFor}>
          {label}
        </label>
        {hint ? <span className="mc-fieldrow__hint">{hint}</span> : null}
      </div>
      <div className="mc-fieldrow__control">{children}</div>
    </div>
  );
}
