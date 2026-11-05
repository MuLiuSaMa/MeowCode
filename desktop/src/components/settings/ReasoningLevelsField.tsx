import { useTranslation } from "react-i18next";
import { LuPlus, LuX } from "react-icons/lu";
import { effortLevelsForModel } from "../../effort";

/** 已知的推理档位取值（用于下拉添加）。 */
const KNOWN_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export function ReasoningLevelsField({
  model,
  values,
  onChange,
}: {
  model: string;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const { t } = useTranslation("settings");
  const auto = effortLevelsForModel(model).slice(1).map((level) => level.value);
  const list = values.length > 0 ? values : auto;
  const isAuto = values.length === 0;

  const add = () => {
    const next = KNOWN_LEVELS.find((value) => !list.includes(value));
    if (!next) return;
    onChange([...list, next]);
  };

  return (
    <div className="mc-modalfields__group">
      <span className="mc-modalfields__grouplabel">{t("models.levels")}</span>
      <div className="mc-levels">
        {list.map((value) => (
          <span key={value} className="mc-levels__chip">
            <span>{value}</span>
            <button
              type="button"
              className="mc-levels__remove"
              aria-label={t("models.levelRemoveAria", { level: value })}
              title={t("models.levelRemoveTitle")}
              onClick={() => onChange(list.filter((item) => item !== value))}
            >
              <LuX size={12} />
            </button>
          </span>
        ))}
        <button type="button" className="mc-levels__add" onClick={add} disabled={list.length >= KNOWN_LEVELS.length}>
          <LuPlus size={12} />
          {t("actions.add")}
        </button>
      </div>
      <span className="mc-field__hint">
        {isAuto ? t("models.levelsAuto", { levels: auto.join(" / ") }) : t("models.levelsManual")}
      </span>
    </div>
  );
}
