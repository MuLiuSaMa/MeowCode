import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import appIcon from "../assets/icon.png";
import "./AssistantStatusLine.css";

export type AssistantStatus = {
  text: string;
  /** 机器正在干活才转三点；「等你回答」这类不转 */
  busy?: boolean;
};

const RANDOM_STATUS_KEYS = [
  "status.idle",
  "status.adjusting",
  "status.fixingBugs",
  "status.checking",
  "status.burningTokens",
  "status.eating",
] as const;

/** 消息流末尾的品牌落款：有真实状态显示真实状态，否则 5 秒轮换一条趣味文案。 */
export function AssistantStatusLine({ status }: { status?: AssistantStatus | null }) {
  const { t } = useTranslation("chat");
  const [index, setIndex] = useState(() => Math.floor(Math.random() * RANDOM_STATUS_KEYS.length));
  const live = Boolean(status);

  useEffect(() => {
    if (live) return;
    const timer = window.setInterval(() => {
      setIndex((current) => {
        const next = Math.floor(Math.random() * (RANDOM_STATUS_KEYS.length - 1));
        return next >= current ? next + 1 : next;
      });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [live]);

  const text = status?.text ?? t(RANDOM_STATUS_KEYS[index]);

  return (
    <div className="mc-statusline">
      <img src={appIcon} alt="" draggable={false} className="mc-statusline__logo" aria-hidden="true" />
      <span className="mc-statusline__text" aria-hidden="true">
        {text}
      </span>
      {status?.busy === false ? null : (
        <span className="mc-statusline__dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )}
      <span className="mc-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {status?.text ?? ""}
      </span>
    </div>
  );
}
