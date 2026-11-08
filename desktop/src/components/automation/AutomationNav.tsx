import { useTranslation } from "react-i18next";
import "./automation.css";

/**
 * 自动化左侧导航（占对话列表槽位）：标题 + 副标题。
 * 结构与 MarketplaceNav 一致，标题复用 mc-settings__heading 的既有样式。
 */
export function AutomationNav() {
  const { t } = useTranslation("automation");
  return (
    <nav className="mc-panel mc-panel--conversations mc-auto__nav" aria-label={t("nav.ariaLabel")}>
      <h1 className="mc-settings__heading">{t("nav.heading")}</h1>
      <p className="mc-auto__subtitle">{t("nav.subtitle")}</p>
    </nav>
  );
}
