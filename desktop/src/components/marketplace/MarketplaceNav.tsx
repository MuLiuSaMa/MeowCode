import { LuPuzzle, LuSparkles, LuPlug } from "react-icons/lu";
import "./marketplace.css";

export type MarketTab = "plugins" | "skills" | "mcp";

const TABS: Array<{ id: MarketTab; label: string; icon: typeof LuPuzzle }> = [
  { id: "plugins", label: "插件", icon: LuPuzzle },
  { id: "skills", label: "技能", icon: LuSparkles },
  { id: "mcp", label: "MCP", icon: LuPlug },
];

/**
 * 市场左侧导航（占对话列表槽位）：标题 + 三页签 + 返回对话。
 * 标题/返回按钮复用 mc-settings__heading / mc-settings__back 的既有样式。
 */
export function MarketplaceNav({
  tab,
  onTab,
  onClose,
}: {
  tab: MarketTab;
  onTab: (tab: MarketTab) => void;
  onClose: () => void;
}) {
  return (
    <nav className="mc-panel mc-panel--conversations mc-mkt__nav" aria-label="插件市场导航">
      <h1 className="mc-settings__heading">插件市场</h1>
      <p className="mc-mkt__subtitle">发现并安装插件、技能和 MCP，拓展 MeowCode 的能力。</p>
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
              {item.label}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="mc-settings__back" onClick={onClose}>
        返回对话
      </button>
    </nav>
  );
}
