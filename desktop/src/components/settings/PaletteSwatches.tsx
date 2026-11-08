import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ThemePalette } from "../../api";
import { PALETTE_VALUES, useTheme } from "../../theme/theme";
import "./PaletteSwatches.css";

/**
 * 配色方案选择器：每个选项是一张「骨架缩略图」。
 *
 * 缩略图不是画一张静态示意图，而是给元素挂上 data-theme + data-palette，
 * 让 palettes.css 在这块小区域里重新定义 CSS 变量 —— 于是缩略图里的画布色、
 * 面板色、强调色都直接取自那套配色的真实 token，跟点下去之后的实际观感一致。
 * 标签一律走 i18n，别在 .tsx 里写中文（scripts/i18n-scan.mjs 会拦）。
 */
export function PaletteSwatches({
  value,
  onChange,
}: {
  value: ThemePalette;
  onChange: (next: ThemePalette) => void;
}) {
  const { t } = useTranslation("settings");
  const { resolved } = useTheme();
  // 表里只存 id：标签在渲染期查表，切语言才会跟着刷新
  const options = useMemo(
    () => PALETTE_VALUES.map((id) => ({ id, label: t(`appearance.palette.${id}`) })),
    [t],
  );

  return (
    <div
      className="mc-palette__grid"
      role="radiogroup"
      aria-label={t("appearance.paletteField")}
    >
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={active}
            className="mc-palette__item"
            data-active={active}
            onClick={() => onChange(option.id)}
          >
            {/* data-theme / data-palette 让这套配色的 token 只作用于这张缩略图 */}
            <span
              className="mc-palette__thumb"
              data-thumb=""
              data-theme={resolved}
              data-palette={option.id}
              aria-hidden="true"
            >
              <span className="mc-palette__thumbchrome" />
              <span className="mc-palette__thumbbody">
                <span className="mc-palette__thumbrail" />
                <span className="mc-palette__thumblines">
                  <span className="mc-palette__line" />
                  <span className="mc-palette__line" />
                  <span className="mc-palette__line" data-accent="" />
                </span>
              </span>
            </span>
            <span className="mc-palette__name">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
