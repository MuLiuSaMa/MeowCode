import { useTranslation } from "react-i18next";
import { LuX } from "react-icons/lu";
import "./PromptSuggestion.css";

export function PromptSuggestion({
  text,
  onUse,
  onDismiss,
}: {
  text: string;
  onUse: (text: string) => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation("chat");
  return (
    <div className="mc-suggestion">
      <button
        type="button"
        className="mc-suggestion__main"
        onClick={() => onUse(text)}
        title={text}
      >
        <span className="mc-suggestion__label">{t("suggestion.label")}</span>
        <span className="mc-suggestion__text">{text}</span>
      </button>
      <kbd className="mc-suggestion__kbd">Tab</kbd>
      <button
        type="button"
        className="mc-suggestion__dismiss"
        aria-label={t("suggestion.dismiss")}
        onClick={onDismiss}
      >
        <LuX size={12} />
      </button>
    </div>
  );
}
