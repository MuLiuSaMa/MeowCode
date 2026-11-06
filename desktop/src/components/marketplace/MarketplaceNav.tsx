import { useTranslation } from "react-i18next";
import { LuPuzzle, LuSparkles, LuPlug } from "react-icons/lu";
import "./marketplace.css";

export type MarketTab = "plugins" | "skills" | "mcp";

/** 表里只存 key 与图标：标签在组件里查表，切语言才会跟着刷新 */
const TABS: Array<{ id: MarketTab; labelKey: string; icon: typeof LuPuzzle }> = [
  { id: "plugins", labelKey: "entryType.plugins", icon: LuPuzzle },
  { id: "skills", labelKey: "entryType.skills", icon: LuSparkles },
  { id: "mcp", labelKey: "entryType.mcp", icon: LuPlug },
];

/**
 * 市场左侧导航（占对话列表槽位）：标题 + 三页签。
 * 标题复用 mc-settings__heading 的既有样式。
 */
export function MarketplaceNav({
  tab,
  onTab,
}: {
  tab: MarketTab;
  onTab: (tab: MarketTab) => void;
}) {
  const { t } = useTranslation("marketplace");

  return (
    <nav className="mc-panel mc-panel--conversations mc-mkt__nav" aria-label={t("nav.ariaLabel")}>
      <h1 className="mc-settings__heading">{t("nav.heading")}</h1>
      <p className="mc-mkt__subtitle">{t("nav.subtitle")}</p>
      <ul className="mc-mkt__tabs">
        {TABS.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="mc-mkt__tab"
              data-active={tab === item.id}
              aria-current={tab === item.id ? "page" : undefined}
              onClick={() => onTab(item.id)}
            >
              <item.icon size={15} />
              {t(item.labelKey)}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
