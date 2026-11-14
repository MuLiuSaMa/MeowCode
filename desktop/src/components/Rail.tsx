import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LuAlarmClock,
  LuBlocks,
  LuCircleAlert,
  LuDownload,
  LuGitBranch,
  LuHouse,
  LuMail,
  LuRotateCw,
  LuSettings,
  LuWorkflow,
  LuX,
} from "react-icons/lu";
import { PluginPageIcon } from "../plugins/PluginPage";
import { PluginSlot } from "../plugins/PluginSlot";
import { usePluginSlot } from "../plugins/runtime";
import "./Rail.css";

/** 左下角更新图标的呈现状态：downloading=圆环进度 done=可重启安装 error=失败 */
export type RailUpdateStatus = "downloading" | "done" | "error";

/** 圆环进度条的周长（viewBox 24、半径 9） */
const RING_CIRCUMFERENCE = 2 * Math.PI * 9;

/**
 * 左侧导航栏：只有图标，没有文字。
 * 没有自己的背景色 —— 直接透出 --bg-chrome，与顶部标题栏连成一体。
 */
export function Rail({
  view = "chat",
  onHome,
  onOpenGit,
  onOpenMail,
  onOpenPlugins,
  onOpenSettings,
  onOpenArchitecture,
  onOpenAutomation,
  onOpenView,
  update = null,
  onUpdateClick,
}: {
  /** 当前主视图：chat / settings / plugin:<pluginId>:<pageId> … */
  view?: string;
  onHome: () => void;
  onOpenGit: () => void;
  onOpenMail: () => void;
  onOpenPlugins: () => void;
  onOpenSettings: () => void;
  onOpenArchitecture: () => void;
  onOpenAutomation: () => void;
  /** 打开插件页面 */
  onOpenView: (view: string) => void;
  /** 静默下载更新的状态：null 时左下角不渲染任何东西 */
  update?: { status: RailUpdateStatus; percent: number } | null;
  /** 点击图标：done=重启安装 error=打开更新弹窗重试；downloading 时无需响应 */
  onUpdateClick?: () => void;
}) {
  // 引导气泡只在下载期间出现一次：用户关掉后就不再打扰（圆环还在，进度不丢）
  const [popDismissed, setPopDismissed] = useState(false);
  const { t } = useTranslation("shell");
  const pluginPages = usePluginSlot("pages");

  return (
    <nav className="mc-rail">
      <button
        type="button"
        className="mc-rail__btn"
        data-active={view === "chat"}
        aria-label={t("rail.home")}
        title={t("rail.home")}
        onClick={onHome}
      >
        <LuHouse size={18} />
      </button>
      <button
        type="button"
        className="mc-rail__btn"
        data-active={view === "architecture"}
        aria-label={t("rail.architecture")}
        title={t("rail.architecture")}
        onClick={onOpenArchitecture}
      >
        <LuWorkflow size={18} />
      </button>
      <button
        type="button"
        className="mc-rail__btn"
        data-active={view === "git"}
        aria-label={t("rail.git")}
        title={t("rail.git")}
        onClick={onOpenGit}
      >
        <LuGitBranch size={18} />
      </button>
      <button
        type="button"
        className="mc-rail__btn"
        data-active={view === "plugins"}
        aria-label={t("rail.plugins")}
        title={t("rail.plugins")}
        onClick={onOpenPlugins}
      >
        <LuBlocks size={18} />
      </button>
      <button
        type="button"
        className="mc-rail__btn"
        data-active={view === "automation"}
        aria-label={t("rail.automation")}
        title={t("rail.automation")}
        onClick={onOpenAutomation}
      >
        <LuAlarmClock size={18} />
      </button>
      <button
        type="button"
        className="mc-rail__btn"
        data-active={view === "mail"}
        aria-label={t("rail.mail")}
        title={t("rail.mail")}
        onClick={onOpenMail}
      >
        <LuMail size={18} />
      </button>
      <button
        type="button"
        className="mc-rail__btn"
        data-active={view === "settings"}
        aria-label={t("rail.settings")}
        title={t("rail.settings")}
        onClick={onOpenSettings}
      >
        <LuSettings size={18} />
      </button>

      {/* 插件注册的主视图页面：自动进左栏，点击切换整页 */}
      {pluginPages.map((page) => {
        const pageView = `plugin:${page.pluginId}:${page.entry.id}`;
        const title = page.entry.title ?? page.entry.id;
        return (
          <button
            key={pageView}
            type="button"
            className="mc-rail__btn"
            data-active={view === pageView}
            aria-label={title}
            title={title}
            onClick={() => onOpenView(pageView)}
          >
            <PluginPageIcon icon={page.entry.icon} title={title} size={18} />
          </button>
        );
      })}

      {/* 插件贡献的侧栏动作：组件自己渲染 mc-rail__btn 样式的按钮 */}
      <PluginSlot name="rail.actions" props={{ view }} />

      <div className="mc-rail__foot">
      <PluginSlot name="rail.footer.actions" props={{}} />

      {update ? (
        <div className="mc-rail__update">
          {update.status === "downloading" ? (
            <>
              <span
                className="mc-rail__btn mc-rail__updatebtn"
                data-kind="downloading"
                role="status"
                title={t("update.downloadingPercent", { percent: update.percent })}
              >
                <svg className="mc-rail__ring" viewBox="0 0 24 24" aria-hidden="true">
                  <circle className="mc-rail__ringtrack" cx="12" cy="12" r="9" />
                  <circle
                    className="mc-rail__ringfill"
                    cx="12"
                    cy="12"
                    r="9"
                    strokeDasharray={RING_CIRCUMFERENCE}
                    strokeDashoffset={RING_CIRCUMFERENCE * (1 - Math.min(100, update.percent) / 100)}
                  />
                </svg>
                <LuDownload className="mc-rail__ringicon" size={18} />
              </span>
              {!popDismissed ? (
                <div className="mc-rail__updatepop" role="status">
                  {t("update.downloading")}
                  <button
                    type="button"
                    className="mc-rail__updatepopclose"
                    aria-label={t("update.dismiss")}
                    onClick={() => setPopDismissed(true)}
                  >
                    <LuX size={11} />
                  </button>
                </div>
              ) : null}
            </>
          ) : update.status === "done" ? (
            <button
              type="button"
              className="mc-rail__btn mc-rail__updatebtn"
              data-kind="done"
              aria-label={t("update.restart")}
              title={t("update.restart")}
              onClick={onUpdateClick}
            >
              <LuRotateCw size={18} />
            </button>
          ) : (
            <button
              type="button"
              className="mc-rail__btn mc-rail__updatebtn"
              data-kind="error"
              aria-label={t("update.failedAria")}
              title={t("update.failedTitle")}
              onClick={onUpdateClick}
            >
              <LuCircleAlert size={18} />
            </button>
          )}
        </div>
      ) : null}
      </div>
    </nav>
  );
}
