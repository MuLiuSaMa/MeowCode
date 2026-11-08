import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuArrowUpRight, LuRotateCw } from "react-icons/lu";
import alipayQrUrl from "../../assets/sponsor/alipay.webp";
import wechatQrUrl from "../../assets/sponsor/wechat.png";
import logoUrl from "../../assets/icon.png";
import wordmarkBlackUrl from "../../assets/wordmark-black.png";
import wordmarkUrl from "../../assets/wordmark.png";
import { useTheme } from "../../theme/theme";
import { SPONSOR_NAMES } from "../../data/sponsors";
import { checkForUpdates, type AppInfo, type UpdateInfo } from "../../api";
import { FieldRow } from "../ui/Section";
import { Spinner } from "../ui/Spinner";
import "./AboutSection.css";

/** 开源仓库（GitHub）：只做跳转，不参与更新检查 */
const REPO_URL = "https://github.com/MuLiuSaMa/MeowCode";
/** 官网 */
const SITE_URL = "https://meowcode.cn";
const AUTHOR = "木流"; // i18n-allow：作者署名是专有名词，不随界面语言改写
/** 赞助：收款二维码（图片放在 assets/sponsor，扫码即可打赏）；名称是词条 key */
const SPONSORS: Array<{ id: "wechat" | "alipay"; src: string }> = [
  { id: "wechat", src: wechatQrUrl },
  { id: "alipay", src: alipayQrUrl },
];

export function AboutSection({
  appInfo,
  updateRelease,
  onUpdateDiscovered,
  onOpenUpdate,
  onToast,
}: {
  appInfo: AppInfo | null;
  /** 已发现的新版本（App 启动时静默查一次，结果放上层） */
  updateRelease: UpdateInfo | null;
  /** 手动检查发现新版本：记录让按钮变样并直接弹更新窗口 */
  onUpdateDiscovered: (release: UpdateInfo) => void;
  /** 打开更新弹窗（下载 + 打开安装包） */
  onOpenUpdate: () => void;
  /** 右上角轻提示（检查结果反馈） */
  onToast: (text: string) => void;
}) {
  const { t } = useTranslation("settings");
  const { resolved } = useTheme();
  /** 商店版（MSIX）：更新交给 Microsoft Store，页面不出现检查更新按钮 */
  const storeManaged = window.meow.storeManaged;
  // 文字 Logo 与左上角标题栏同一份资源：浅色主题用黑色字标，否则白字看不见
  const wordmark = resolved === "dark" ? wordmarkUrl : wordmarkBlackUrl;
  const [checking, setChecking] = useState(false);
  /** 防止连点触发多次请求 */
  const busyRef = useRef(false);

  const runCheck = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setChecking(true);
    try {
      const result = await checkForUpdates();
      if (!result.ok) {
        onToast(t("about.checkFailed", { error: result.error }));
        return;
      }
      if (result.hasUpdate) {
        onUpdateDiscovered(result.latest);
        onOpenUpdate();
        return;
      }
      onToast(t("about.upToDate"));
    } catch (error) {
      onToast(t("about.checkFailed", { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setChecking(false);
      busyRef.current = false;
    }
  }, [onUpdateDiscovered, onOpenUpdate, onToast, t]);

  if (!appInfo) {
    return (
      <div className="mc-settings__inner">
        <div className="mc-about__loading">
          <Spinner size={20} />
          <span>{t("about.loading")}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="mc-settings__inner">
      <div className="mc-about">
        <div className="mc-about__head">
          <img className="mc-about__logo" src={logoUrl} alt="MeowCode" draggable={false} />
          <img
            className="mc-about__wordmark"
            src={wordmark}
            alt="MeowCode"
            draggable={false}
          />
        </div>

        <div className="mc-about__rows">
          <FieldRow label={t("about.version")}>
            <div className="mc-about__version">
              <span className="mc-about__value">v{appInfo.version}</span>
              {storeManaged ? null : updateRelease ? (
                <button type="button" className="mc-about__check" data-found onClick={onOpenUpdate}>
                  <LuArrowUpRight size={12} />
                  {t("about.newVersion")}
                </button>
              ) : (
                <button
                  type="button"
                  className="mc-about__check"
                  disabled={checking}
                  onClick={() => void runCheck()}
                >
                  <LuRotateCw size={12} />
                  {checking ? t("about.checking") : t("about.check")}
                </button>
              )}
            </div>
          </FieldRow>

          <FieldRow label={t("about.author")}>
            <span className="mc-about__value">{AUTHOR}</span>
          </FieldRow>

          <FieldRow label={t("about.qqGroup")}>
            <span className="mc-about__value">1128483595</span>
          </FieldRow>

          <FieldRow label={t("about.website")}>
            <button
              type="button"
              className="mc-about__link"
              title={t("about.openInBrowser")}
              onClick={() => void window.meow.openExternal(SITE_URL)}
            >
              meowcode.cn
              <LuArrowUpRight size={12} />
            </button>
          </FieldRow>

          <FieldRow label={t("about.repo")}>
            <button
              type="button"
              className="mc-about__link"
              title={t("about.openInBrowser")}
              onClick={() => void window.meow.openExternal(REPO_URL)}
            >
              {REPO_URL}
              <LuArrowUpRight size={12} />
            </button>
          </FieldRow>
        </div>

        <div className="mc-about__rows mc-about__sponsor">
          <h2 className="mc-about__thankstitle">{t("about.sponsor")}</h2>
          <p className="mc-about__sponsorhint">{t("about.sponsorHint")}</p>
          <div className="mc-about__qrcodes">
            {SPONSORS.map((sponsor) => (
              <figure key={sponsor.id} className="mc-about__qr">
                <img
                  className="mc-about__qrimg"
                  src={sponsor.src}
                  alt={t("about.qrAlt", { name: t(`about.sponsors.${sponsor.id}`) })}
                  draggable={false}
                />
                <figcaption className="mc-about__qrname">{t(`about.sponsors.${sponsor.id}`)}</figcaption>
              </figure>
            ))}
          </div>
          <div className="mc-about__sponsorlist">
            <h3 className="mc-about__sponsornamestitle">{t("about.sponsorList")}</h3>
            <div
              className="mc-about__sponsornames"
              role="list"
              aria-label={t("about.sponsorList")}
            >
              {SPONSOR_NAMES.map((name, index) => (
                <span className="mc-about__sponsorname" role="listitem" key={`${name}-${index}`}>
                  {name}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
