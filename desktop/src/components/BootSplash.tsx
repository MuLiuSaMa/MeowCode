import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import iconUrl from "../assets/logo-cat.webp";
import { preloadProviderIcons } from "../data/providerIcons";
import "./BootSplash.css";

/**
 * 启动画面：纯黑底 + Logo 淡入。
 * 数据加载完成（且不少于约 1 秒）后由 App 切走；主题在浅色下也保持黑底。
 */
export function BootSplash() {
  const { t } = useTranslation("shell");
  // 启动动画期间预热模型弹层的品牌图标：首次打开模型列表时图标不再慢半拍
  useEffect(() => {
    void preloadProviderIcons();
  }, []);
  return (
    <div className="mc-splash" role="status" aria-label={t("bootSplash.aria")}>
      <span className="mc-splash__glow" aria-hidden />
      <img className="mc-splash__logo" src={iconUrl} alt="MeowCode" draggable={false} />
    </div>
  );
}
