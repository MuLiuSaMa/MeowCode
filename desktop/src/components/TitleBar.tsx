import { useEffect, useState } from "react";
import { LuCopy, LuMinus, LuSquare, LuX } from "react-icons/lu";
import wordmarkBlackUrl from "../assets/wordmark-black.png";
import wordmarkUrl from "../assets/wordmark.png";
import { useTheme } from "../theme/theme";
import "./TitleBar.css";

/** forceDark：启动画面固定黑底，即使系统是浅色也要用白色字标。 */
export function TitleBar({ forceDark = false }: { forceDark?: boolean }) {
  const [maximized, setMaximized] = useState(false);
  const { resolved } = useTheme();
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

      <div className="mc-titlebar__controls">
        <button
          type="button"
          className="mc-winbtn"
          aria-label="最小化"
          title="最小化"
          onClick={() => void window.meow?.minimizeWindow?.()}
        >
          <LuMinus size={16} />
        </button>
        <button
          type="button"
          className="mc-winbtn"
          data-maximized={maximized}
          aria-label={maximized ? "还原" : "最大化"}
          title={maximized ? "还原" : "最大化"}
          onClick={() => void window.meow?.toggleMaximizeWindow?.()}
        >
          {maximized ? <LuCopy size={14} /> : <LuSquare size={13} />}
        </button>
        <button
          type="button"
          className="mc-winbtn mc-winbtn--close"
          aria-label="关闭"
          title="关闭"
          onClick={() => void window.meow?.closeWindow?.()}
        >
          <LuX size={16} />
        </button>
      </div>
    </header>
  );
}
