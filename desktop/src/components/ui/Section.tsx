import type { ReactNode } from "react";
import "./Section.css";

export function Section({
  title,
  description,
  badge,
  action,
  children,
}: {
  title: string;
  description?: string;
  /** 标题右侧的小标记（BETA / 实验性等），不参与无障碍标题文本 */
  badge?: ReactNode;
  /** 标题行最右侧的操作（如「全部删除」） */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mc-section">
      <header className="mc-section__head">
        <div className="mc-section__titlerow">
          <h2 className="mc-section__title">{title}</h2>
          {badge}
          {action ? <div className="mc-section__action">{action}</div> : null}
        </div>
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
