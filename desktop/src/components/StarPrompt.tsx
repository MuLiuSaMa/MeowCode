import { useTranslation } from "react-i18next";
import { LuGithub } from "react-icons/lu";
import { Button } from "./ui/Button";
import "./StarPrompt.css";

/** 点「补药」后 7 天内不再提示；点「好哒」永久不再提示 */
const STAR_PROMPT_STORAGE_KEY = "meowcode:starPrompt";
const STAR_PROMPT_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

export function shouldShowStarPrompt(): boolean {
  try {
    const raw = window.localStorage.getItem(STAR_PROMPT_STORAGE_KEY);
    if (raw === "accepted") return false;
    const until = Number(raw);
    return !Number.isFinite(until) || until <= Date.now();
  } catch {
    // localStorage 不可用时不再反复打扰
    return false;
  }
}

export function snoozeStarPrompt(): void {
  try {
    window.localStorage.setItem(STAR_PROMPT_STORAGE_KEY, String(Date.now() + STAR_PROMPT_SNOOZE_MS));
  } catch {
    // 记不住就只在本次启动内不再提示
  }
}

export function acceptStarPrompt(): void {
  try {
    window.localStorage.setItem(STAR_PROMPT_STORAGE_KEY, "accepted");
  } catch {
    // 只影响本机记忆
  }
}

export function StarPrompt({
  onAccept,
  onDismiss,
}: {
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation("shell");

  return (
    <aside className="mc-starprompt" role="status" aria-label={t("star.title")}>
      <div className="mc-starprompt__head">
        <span className="mc-starprompt__icon" aria-hidden="true">
          <LuGithub size={14} />
        </span>
        <span className="mc-starprompt__title">{t("star.title")}</span>
      </div>
      <p className="mc-starprompt__body">{t("star.body")}</p>
      <div className="mc-starprompt__actions">
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          {t("star.dismiss")}
        </Button>
        <Button size="sm" variant="primary" onClick={onAccept}>
          {t("star.accept")}
        </Button>
      </div>
    </aside>
  );
}
