import { LuPanelRight } from "react-icons/lu";
import { IconButton } from "./ui/IconButton";
import "./ChatHeader.css";

export function ChatHeader({
  title,
  workspace,
  inspectorOpen,
  onToggleInspector,
}: {
  /** AI 生成或手动设置的会话标题；还没生成时用回退文案 */
  title?: string | null;
  workspace?: string;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
}) {
  return (
    <header className="mc-header">
      <div className="mc-header__bar">
        <div className="mc-header__title">
          {/* 标题由 AI 根据首条消息生成（参考 ZCode）；无图标 */}
          <div className="mc-header__titles">
            <span className="mc-header__name mc-truncate" title={title ?? undefined}>
              {title || "新对话"}
            </span>
            {workspace ? <span className="mc-header__cwd mc-truncate">{workspace}</span> : null}
          </div>
        </div>

        <div className="mc-header__right">
          <IconButton
            label={inspectorOpen ? "收起右侧栏" : "展开右侧栏"}
            size="md"
            active={inspectorOpen}
            onClick={onToggleInspector}
          >
            <LuPanelRight size={15} />
          </IconButton>
        </div>
      </div>
    </header>
  );
}
