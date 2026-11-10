import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LuPanelRight, LuSearch } from "react-icons/lu";
import { PluginSlot } from "../plugins/PluginSlot";
import { IconButton } from "./ui/IconButton";
import "./ChatHeader.css";

export function ChatHeader({
  title,
  workspace,
  workspaceTitle,
  inspectorOpen,
  onToggleInspector,
  onOpenSearch,
  overview,
  sessionId,
  running,
  mode,
}: {
  /** AI 生成或手动设置的会话标题；还没生成时用回退文案 */
  title?: string | null;
  workspace?: string;
  /** 悬停提示：worktree 会话给完整路径 */
  workspaceTitle?: string;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  /** 打开会话全文检索弹窗（Ctrl+K 的可见入口） */
  onOpenSearch: () => void;
  /** 右上角工作区概览（胶囊 + 展开卡片） */
  overview?: ReactNode;
  /** 插件槽位 session.header.actions 的宿主上下文 */
  sessionId?: string;
  running?: boolean;
  mode?: string;
}) {
  const { t } = useTranslation("chat");
  return (
    <header className="mc-header">
      <div className="mc-header__bar">
        <div className="mc-header__title">
          {/* 标题由 AI 根据首条消息生成（参考 ZCode）；无图标 */}
          <div className="mc-header__titles">
            <span className="mc-header__name mc-truncate" title={title ?? undefined}>
              {title || t("conversation.untitled")}
            </span>
            {workspace ? (
              <span className="mc-header__cwd mc-truncate" title={workspaceTitle ?? workspace}>
                {workspace}
              </span>
            ) : null}
          </div>
        </div>

        <div className="mc-header__right">
          <div className="mc-header__actions">
            <PluginSlot
              name="session.header.actions"
              props={{ sessionId, running: running ?? false, mode: mode ?? "default" }}
            />
            {/* 工作区概览（文件变更/N 个子 Agent）：放在搜索按钮左侧，固定进标题栏这一行 */}
            {overview ? <div className="mc-header__overview">{overview}</div> : null}
            <IconButton label={t("header.searchSessions")} size="md" onClick={onOpenSearch}>
              <LuSearch size={15} />
            </IconButton>
            <IconButton
              label={inspectorOpen ? t("header.collapseInspector") : t("header.expandInspector")}
              size="md"
              active={inspectorOpen}
              onClick={onToggleInspector}
            >
              <LuPanelRight size={15} />
            </IconButton>
          </div>
        </div>
      </div>
    </header>
  );
}
