import { useState } from "react";
import { LuPlus, LuX } from "react-icons/lu";
import { effortLevelsFromValues, effortLevelsForModel } from "../../effort";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";

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
      <span className="mc-modalfields__grouplabel">推理等级</span>
      <div className="mc-levels">
        {list.map((value) => (
          <span key={value} className="mc-levels__chip">
            <span>{value}</span>
            <button
              type="button"
              className="mc-levels__remove"
              aria-label={`移除 ${value}`}
              title="移除这一档"
              onClick={() => onChange(list.filter((item) => item !== value))}
            >
              <LuX size={12} />
            </button>
          </span>
        ))}
        <button type="button" className="mc-levels__add" onClick={add} disabled={list.length >= KNOWN_LEVELS.length}>
          <LuPlus size={12} />
          添加
        </button>
      </div>
      <span className="mc-field__hint">
        {isAuto
          ? `留空则按模型名自动匹配（当前为 ${auto.join(" / ")}）`
          : "已手动指定。清空所有档位可恢复按模型名自动匹配。"}
      </span>
    </div>
  );
}
