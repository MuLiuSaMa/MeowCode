import { LuBlocks, LuGitBranch, LuHouse, LuSettings, LuWorkflow } from "react-icons/lu";
import "./Rail.css";

/**
 * 左侧导航栏：只有图标，没有文字。
 * 没有自己的背景色 —— 直接透出 --bg-chrome，与顶部标题栏连成一体。
 */
export function Rail({
  active = "home",
  onHome,
  onOpenGit,
  onOpenPlugins,
  onOpenSettings,
  onOpenArchitecture,
}: {
  active?: "home" | "git" | "settings" | "plugins" | "architecture";
  onHome: () => void;
  onOpenGit: () => void;
  onOpenPlugins: () => void;
  onOpenSettings: () => void;
  onOpenArchitecture: () => void;
}) {
  return (
    <nav className="mc-rail">
      <button
        type="button"
        className="mc-rail__btn"
        data-active={active === "home"}
        aria-label="主页"
        title="主页"
        onClick={onHome}
      >
        <LuHouse size={18} />
      </button>
      <button
        type="button"
        className="mc-rail__btn"
        data-active={active === "architecture"}
        aria-label="Agent 架构"
        title="Agent 架构"
        onClick={onOpenArchitecture}
      >
        <LuWorkflow size={18} />
      </button>
      <button
        type="button"
        className="mc-rail__btn"
        data-active={active === "git"}
        aria-label="源代码管理"
        title="源代码管理"
        onClick={onOpenGit}
      >
        <LuGitBranch size={18} />
      </button>
      <button
        type="button"
        className="mc-rail__btn"
        data-active={active === "plugins"}
        aria-label="插件市场"
        title="插件市场"
        onClick={onOpenPlugins}
      >
        <LuBlocks size={18} />
      </button>
      <button
        type="button"
        className="mc-rail__btn"
        data-active={active === "settings"}
        aria-label="设置"
        title="设置"
        onClick={onOpenSettings}
      >
        <LuSettings size={18} />
      </button>
    </nav>
  );
}
