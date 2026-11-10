import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuCopy, LuMinus, LuSquare, LuX } from "react-icons/lu";
import wordmarkBlackUrl from "../assets/wordmark-black.png";
import wordmarkUrl from "../assets/wordmark.png";
import { useTheme } from "../theme/theme";
import { PluginSlot } from "../plugins/PluginSlot";
import { AnnouncementBar } from "./AnnouncementBar";
import "./TitleBar.css";

/** forceDark：启动画面固定黑底，即使系统是浅色也要用白色字标。 */
export function TitleBar({ forceDark = false, announcements = false }: { forceDark?: boolean; announcements?: boolean }) {
  const [maximized, setMaximized] = useState(false);
  const { resolved } = useTheme();
  const { t } = useTranslation("shell");
  // 浅色主题下白字标会看不见，换黑色字标（两份资源尺寸一致，2217×377）
  const wordmark = forceDark || resolved === "dark" ? wordmarkUrl : wordmarkBlackUrl;

  useEffect(() => {
    let disposed = false;
    let receivedEvent = false;

    const unsubscribe = window.meow?.onWindowStateChange?.((state) => {
      receivedEvent = true;
      if (!disposed) setMaximized(state.isMaximized);
    });

    void window.meow
      ?.getWindowState?.()
      .then((state) => {
        // 订阅后读取初态；较晚返回的初态不能覆盖用户刚触发的最大化事件。
        if (!disposed && !receivedEvent) setMaximized(state.isMaximized);
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  return (
    <header className="mc-titlebar">
      <div className="mc-titlebar__brand">
        <img className="mc-titlebar__wordmark" src={wordmark} alt="MeowCode" draggable={false} />
      </div>

      {/* 公告：紧跟 Logo 右侧，小字号、一行截断；点击弹窗看全文，× 关闭（设置 → 通用可关） */}
      {announcements ? <AnnouncementBar /> : null}

      <div className="mc-titlebar__plugins">
        <PluginSlot name="titlebar.actions" props={{}} />
      </div>

      <div className="mc-titlebar__controls">
        <button
          type="button"
          className="mc-winbtn"
          aria-label={t("window.minimize")}
          title={t("window.minimize")}
          onClick={() => void window.meow?.minimizeWindow?.()}
        >
          <LuMinus size={16} />
        </button>
        <button
          type="button"
          className="mc-winbtn"
          data-maximized={maximized}
          aria-label={maximized ? t("window.restore") : t("window.maximize")}
          title={maximized ? t("window.restore") : t("window.maximize")}
          onClick={() => void window.meow?.toggleMaximizeWindow?.()}
        >
          {maximized ? <LuCopy size={14} /> : <LuSquare size={13} />}
        </button>
        <button
          type="button"
          className="mc-winbtn mc-winbtn--close"
          aria-label={t("window.close")}
          title={t("window.close")}
          onClick={() => void window.meow?.closeWindow?.()}
        >
          <LuX size={16} />
        </button>
      </div>
    </header>
  );
}
