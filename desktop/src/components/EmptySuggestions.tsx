import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import "./EmptySuggestions.css";

/** 新对话建议：每次显示 4 条，自动轮播；点一条把更详细的提示词填进输入框并聚焦。 */
const SUGGESTION_IDS = [
  "idea",
  "readme",
  "bug",
  "tests",
  "api",
  "refactor",
  "script",
  "dashboard",
  "risk",
  "steps",
  "setting",
  "release",
] as const;

const PAGE_SIZE = 4;
const ROTATE_MS = 6_500;

export function EmptySuggestions({ onPick }: { onPick: (text: string) => void }) {
  const { t } = useTranslation("chat");
  const [page, setPage] = useState(0);
  const [paused, setPaused] = useState(false);
  const pageCount = Math.ceil(SUGGESTION_IDS.length / PAGE_SIZE);

  useEffect(() => {
    if (paused || pageCount <= 1) return;
    const timer = window.setInterval(() => {
      setPage((current) => (current + 1) % pageCount);
    }, ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [pageCount, paused]);

  const items = SUGGESTION_IDS.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  return (
    <div
      className="mc-suggest"
      role="group"
      aria-label={t("empty.suggestions.label")}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <div className="mc-suggest__grid" key={page}>
        {items.map((id) => {
          const label = t(`empty.suggestions.${id}`);
          const prompt = t(`empty.suggestions.${id}Prompt`);
          return (
            <button
              type="button"
              className="mc-suggest__item"
              key={id}
              title={prompt}
              onClick={() => onPick(prompt)}
            >
              <span className="mc-suggest__label">{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
