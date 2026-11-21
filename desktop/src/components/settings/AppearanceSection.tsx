import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuFolderUp, LuPlus, LuX } from "react-icons/lu";
import { Button } from "../ui/Button";
import { CustomSelect, type CustomSelectOption } from "../ui/CustomSelect";
import { FieldRow, Section } from "../ui/Section";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Slider } from "../ui/Slider";
import { Toggle } from "../ui/Toggle";
import { PaletteSwatches } from "./PaletteSwatches";
import {
  wallpaperUrl,
  type ThemePalette,
  type ThemePreference,
  type WallpaperKind,
  type WallpaperSettings,
} from "../../api";
import "./AppearanceSection.css";

/** 表里只存值：标签在组件里查表，切语言才会跟着刷新。 */
const THEME_VALUES: ThemePreference[] = ["system", "light", "dark"];

// i18n-allow-block-start：字体展示名属于系统事实，不随界面语言翻译
/** Windows 常见中文字体的英文名 → 中文名（queryLocalFonts 在部分系统只回英文族名） */
const FONT_NAME_OVERRIDES: Record<string, string> = {
  KaiTi: "楷体",
  SimKai: "楷体",
  "Microsoft YaHei": "微软雅黑",
  "Microsoft JhengHei": "微软正黑体",
  SimSun: "宋体",
  NSimSun: "新宋体",
  SimHei: "黑体",
  FangSong: "仿宋",
  LiSu: "隶书",
  YouYuan: "幼圆",
  DengXian: "等线",
  STKaiti: "华文楷体",
  STFangsong: "华文仿宋",
  STSong: "华文宋体",
  STZhongsong: "华文中宋",
  STXihei: "华文细黑",
  STXinwei: "华文新魏",
  STHupo: "华文琥珀",
  STCaiyun: "华文彩云",
  FZShuTi: "方正舒体",
};
// i18n-allow-block-end

/** 展示名：映射表优先，其次 fullName 里有中文就用它，否则原样 */
function fontLabel(family: string, fullName?: string): string {
  const override = FONT_NAME_OVERRIDES[family];
  if (override) return override;
  if (fullName && /[\u4e00-\u9fff]/.test(fullName)) return fullName;
  return family;
}

/** 滑杆读数：透明度 / 亮度 / 面板不透明度统一按百分比显示 */
const percent = (value: number) => `${Math.round(value * 100)}%`;

/** 轮播间隔候选（秒）：够用又不至于让下拉太长 */
const CAROUSEL_INTERVALS = [10, 30, 60, 300, 900, 1800];

export function AppearanceSection({
  preference,
  onPreference,
  palette,
  onPalette,
  fontFamily,
  codeFontFamily,
  customFonts,
  onFontChange,
  onCodeFontChange,
  onImportFont,
  onRemoveFont,
  wallpaper,
  onImportWallpaper,
  onRemoveWallpaper,
  onWallpaperChange,
}: {
  preference: ThemePreference;
  onPreference: (value: ThemePreference) => void;
  /** 配色方案：与明暗正交 */
  palette: ThemePalette;
  onPalette: (value: ThemePalette) => void;
  /** 界面字体：空串 = 默认 MiSans */
  fontFamily: string;
  /** 代码字体：空串 = 默认等宽栈 */
  codeFontFamily: string;
  /** 已导入的自定义字体展示名 */
  customFonts: string[];
  onFontChange: (value: string) => void;
  onCodeFontChange: (value: string) => void;
  /** 导入字体文件；返回导入后的展示名（取消/失败返回 null） */
  onImportFont: () => Promise<string | null>;
  /** 删除已导入的字体；删除成功返回 true */
  onRemoveFont: (family: string) => Promise<boolean>;
  /** 自定义背景库；null = 还没导入过 */
  wallpaper: WallpaperSettings | null;
  /** 弹文件选择框（可多选）导入图片 / 视频 */
  onImportWallpaper: (kind: WallpaperKind) => void;
  /** 从背景库删掉一项 */
  onRemoveWallpaper: (fileName: string) => void;
  /** 调选中项 / 开关 / 轮播 / 透明度等（立即生效，落盘节流） */
  onWallpaperChange: (patch: Partial<WallpaperSettings>) => void;
}) {
  const { t, i18n } = useTranslation("settings");
  const items = wallpaper?.items ?? [];
  /** 当前背景的类型：决定声音开关是否出现、轮播队列有多大 */
  const activeKind =
    items.find((item) => item.fileName === wallpaper?.active)?.kind ?? items[0]?.kind ?? null;
  /** 背景库按类型分页：图片 / 视频（初始停在当前背景所属的那一页） */
  const [tab, setTab] = useState<WallpaperKind>(activeKind ?? "image");
  const visibleItems = useMemo(() => items.filter((item) => item.kind === tab), [items, tab]);
  const carousel = wallpaper?.carousel ?? { enabled: false, intervalSec: 60 };
  /** 轮播只在同类型内循环，所以「至少两张」要看当前项所属的那一类 */
  const carouselPoolSize = activeKind ? items.filter((item) => item.kind === activeKind).length : 0;

  /**
   * 切 Tab 就把当前背景换成该类型的第一张（这一类没东西时保持原样）。
   * 只改选中项，不碰 enabled：用户关掉「自定义背景」后再切 Tab 不该被悄悄打开。
   */
  const switchTab = (next: WallpaperKind) => {
    setTab(next);
    const first = items.find((item) => item.kind === next);
    if (first && wallpaper?.active !== first.fileName) {
      onWallpaperChange({ active: first.fileName });
    }
  };
  const themeOptions = useMemo(
    () => THEME_VALUES.map((value) => ({ value, label: t(`appearance.theme.${value}`) })),
    [t],
  );
  /** 系统字体族列表（value = CSS 族名，label = 本地化展示名）；null = 还没拿到 */
  const [systemFonts, setSystemFonts] = useState<Array<{ value: string; label: string }> | null>(null);

  // Local Font Access 需要用户手势：进页先试一次，被拒/没激活就等点击字体行时再试
  const loadSystemFonts = useCallback(async () => {
    const query = (
      window as Window & {
        queryLocalFonts?: () => Promise<Array<{ family: string; fullName?: string }>>;
      }
    ).queryLocalFonts;
    if (typeof query !== "function") {
      setSystemFonts([]);
      return;
    }
    try {
      const fonts = await query();
      const seen = new Set<string>();
      const list: Array<{ value: string; label: string }> = [];
      for (const font of fonts) {
        if (seen.has(font.family)) continue;
        seen.add(font.family);
        list.push({ value: font.family, label: fontLabel(font.family, font.fullName) });
      }
      list.sort((a, b) => a.label.localeCompare(b.label, i18n.language));
      setSystemFonts(list);
    } catch {
      // 保持 null：下拉里保留「点击重试」入口
    }
  }, [i18n]);

  useEffect(() => {
    void loadSystemFonts();
  }, [loadSystemFonts]);

  /** 下拉列表里删除已导入字体；界面或代码字体正用它就把那一路回退默认 */
  const removeFont = useCallback(
    async (family: string) => {
      const ok = await onRemoveFont(family);
      if (!ok) return;
      if (fontFamily === family) onFontChange("");
      if (codeFontFamily === family) onCodeFontChange("");
    },
    [onRemoveFont, fontFamily, codeFontFamily, onFontChange, onCodeFontChange],
  );

  const fontOptions = useMemo<Array<CustomSelectOption<string>>>(() => {
    const options: Array<CustomSelectOption<string>> = [
      { value: "", label: t("appearance.defaultFont") },
    ];
    const known = new Set<string>((systemFonts ?? []).map((font) => font.value));
    // 选中的字体不在已知列表（如重启后系统字体还没读到）：单独补一项，别让显示错位
    const patched = new Set<string>();
    for (const selected of [fontFamily, codeFontFamily]) {
      if (selected && !known.has(selected) && !customFonts.includes(selected) && !patched.has(selected)) {
        patched.add(selected);
        options.push({ value: selected, label: FONT_NAME_OVERRIDES[selected] ?? selected });
      }
    }
    if (systemFonts === null) {
      options.push({
        value: "__loading__",
        label: t("appearance.fontsLoading"),
        disabled: true,
      });
    } else {
      for (const font of systemFonts) options.push({ value: font.value, label: font.label });
    }
    for (const name of customFonts) {
      options.push({
        value: name,
        label: t("appearance.imported", { name }),
        onDelete: () => void removeFont(name),
      });
    }
    return options;
  }, [fontFamily, codeFontFamily, systemFonts, customFonts, removeFont, t]);

  const importFont = async () => {
    // 只入库不自动套用：导入后两路下拉里都会出现（已导入），用哪路由用户选
    await onImportFont();
  };

  return (
    <div className="mc-settings__inner">
      <Section
        title={t("appearance.themeSection")}
        description={t("appearance.themeDesc")}
      >
        <FieldRow label={t("appearance.themeField")}>
          <SegmentedControl
            value={preference}
            options={themeOptions}
            onChange={onPreference}
            ariaLabel={t("appearance.themeField")}
          />
        </FieldRow>
      </Section>

      <Section
        title={t("appearance.paletteSection")}
        description={t("appearance.paletteDesc")}
      >
        <div className="mc-palette">
          <PaletteSwatches value={palette} onChange={onPalette} />
        </div>
      </Section>

      <Section
        title={t("appearance.fontSection")}
        description={t("appearance.fontDesc")}
      >
        <FieldRow label={t("appearance.importField")}>
          <Button icon={<LuFolderUp size={13} />} onClick={() => void importFont()}>
            {t("appearance.importButton")}
          </Button>
        </FieldRow>
        <FieldRow label={t("appearance.uiFont")}>
          <div
            className="mc-appearance__fontrow"
            onClickCapture={systemFonts === null ? () => void loadSystemFonts() : undefined}
          >
            <CustomSelect
              value={fontFamily}
              options={fontOptions}
              onChange={onFontChange}
              ariaLabel={t("appearance.uiFont")}
            />
          </div>
        </FieldRow>
        <FieldRow label={t("appearance.codeFont")}>
          <div
            className="mc-appearance__fontrow"
            onClickCapture={systemFonts === null ? () => void loadSystemFonts() : undefined}
          >
            <CustomSelect
              value={codeFontFamily}
              options={fontOptions}
              onChange={onCodeFontChange}
              ariaLabel={t("appearance.codeFont")}
            />
          </div>
        </FieldRow>
      </Section>

      <Section title={t("appearance.backgroundSection")} description={t("appearance.backgroundDesc")}>
        <FieldRow label={t("appearance.backgroundEnable")}>
          <Toggle
            checked={wallpaper?.enabled ?? false}
            onChange={(next) => onWallpaperChange({ enabled: next })}
            disabled={!wallpaper}
            label={t("appearance.backgroundEnable")}
          />
        </FieldRow>

        <div className="mc-wallpaper">
          <div className="mc-wallpaper__bar">
            <SegmentedControl<WallpaperKind>
              value={tab}
              options={[
                { value: "image", label: t("appearance.backgroundImage") },
                { value: "video", label: t("appearance.backgroundVideo") },
              ]}
              onChange={switchTab}
              ariaLabel={t("appearance.backgroundSection")}
            />
            <span className="mc-wallpaper__count">
              {t("appearance.backgroundCount", { count: visibleItems.length })}
            </span>
          </div>

          <div className="mc-wallpaper__grid">
            {visibleItems.map((item) => {
              const url = wallpaperUrl(item.fileName);
              const isActive = wallpaper?.active === item.fileName;
              return (
                <div
                  key={item.fileName}
                  className="mc-wallpaper__tile"
                  data-active={isActive}
                  role="button"
                  tabIndex={0}
                  title={item.fileName}
                  onClick={() => onWallpaperChange({ active: item.fileName })}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onWallpaperChange({ active: item.fileName });
                  }}
                >
                  {item.kind === "video" ? (
                    <video className="mc-wallpaper__thumb" src={`${url}#t=0.1`} muted preload="metadata" />
                  ) : (
                    <img className="mc-wallpaper__thumb" src={url} alt="" loading="lazy" />
                  )}
                  <span className="mc-wallpaper__kind">
                    {item.kind === "video"
                      ? t("appearance.backgroundVideo")
                      : t("appearance.backgroundImage")}
                  </span>
                  <button
                    type="button"
                    className="mc-wallpaper__remove"
                    aria-label={t("appearance.backgroundRemove")}
                    title={t("appearance.backgroundRemove")}
                    onClick={(event) => {
                      event.stopPropagation();
                      onRemoveWallpaper(item.fileName);
                    }}
                  >
                    <LuX size={12} />
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              className="mc-wallpaper__tile mc-wallpaper__tile--add"
              onClick={() => onImportWallpaper(tab)}
            >
              <LuPlus size={18} />
              <span>{t("appearance.backgroundAdd")}</span>
            </button>
          </div>

          {visibleItems.length === 0 ? (
            <p className="mc-wallpaper__empty">{t("appearance.backgroundEmpty")}</p>
          ) : null}
        </div>

        {activeKind === "video" ? (
          <FieldRow label={t("appearance.backgroundSound")}>
            <Toggle
              checked={wallpaper?.videoSound ?? false}
              onChange={(next) => onWallpaperChange({ videoSound: next })}
              disabled={!wallpaper}
              label={t("appearance.backgroundSound")}
            />
          </FieldRow>
        ) : null}

        <FieldRow label={t("appearance.backgroundCarousel")}>
          <Toggle
            checked={wallpaper?.carousel.enabled ?? false}
            onChange={(next) => onWallpaperChange({ carousel: { ...carousel, enabled: next } })}
            disabled={!wallpaper || carouselPoolSize < 2}
            label={t("appearance.backgroundCarousel")}
          />
        </FieldRow>
        {wallpaper?.carousel.enabled ? (
          <FieldRow label={t("appearance.backgroundInterval")}>
            <CustomSelect<string>
              value={String(carousel.intervalSec)}
              options={CAROUSEL_INTERVALS.map((seconds) => ({
                value: String(seconds),
                label:
                  seconds < 60
                    ? t("appearance.backgroundSeconds", { count: seconds })
                    : t("appearance.backgroundMinutes", { count: Math.round(seconds / 60) }),
              }))}
              onChange={(value) =>
                onWallpaperChange({ carousel: { ...carousel, intervalSec: Number(value) } })
              }
              ariaLabel={t("appearance.backgroundInterval")}
            />
          </FieldRow>
        ) : null}

        <FieldRow label={t("appearance.backgroundOpacity")}>
          <Slider
            value={wallpaper?.opacity ?? 1}
            min={0.05}
            max={1}
            step={0.05}
            onChange={(value) => onWallpaperChange({ opacity: value })}
            ariaLabel={t("appearance.backgroundOpacity")}
            format={percent}
            disabled={!wallpaper}
          />
        </FieldRow>
        <FieldRow label={t("appearance.backgroundBrightness")}>
          <Slider
            value={wallpaper?.brightness ?? 1}
            min={0.2}
            max={2}
            step={0.05}
            onChange={(value) => onWallpaperChange({ brightness: value })}
            ariaLabel={t("appearance.backgroundBrightness")}
            format={percent}
            disabled={!wallpaper}
          />
        </FieldRow>
        <FieldRow label={t("appearance.backgroundBlur")}>
          <Slider
            value={wallpaper?.blur ?? 0}
            min={0}
            max={40}
            step={1}
            onChange={(value) => onWallpaperChange({ blur: value })}
            ariaLabel={t("appearance.backgroundBlur")}
            format={(value) => `${Math.round(value)}px`}
            disabled={!wallpaper}
          />
        </FieldRow>
        <FieldRow label={t("appearance.backgroundPanel")}>
          <Slider
            value={wallpaper?.uiOpacity ?? 0.72}
            min={0.2}
            max={1}
            step={0.05}
            onChange={(value) => onWallpaperChange({ uiOpacity: value })}
            ariaLabel={t("appearance.backgroundPanel")}
            format={percent}
            disabled={!wallpaper}
          />
        </FieldRow>
      </Section>
    </div>
  );
}
