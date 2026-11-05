import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuFolderUp } from "react-icons/lu";
import { Button } from "../ui/Button";
import { CustomSelect, type CustomSelectOption } from "../ui/CustomSelect";
import { FieldRow, Section } from "../ui/Section";
import { SegmentedControl } from "../ui/SegmentedControl";
import type { ThemePreference } from "../../api";
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

export function AppearanceSection({
  preference,
  onPreference,
  fontFamily,
  codeFontFamily,
  customFonts,
  onFontChange,
  onCodeFontChange,
  onImportFont,
  onRemoveFont,
}: {
  preference: ThemePreference;
  onPreference: (value: ThemePreference) => void;
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
}) {
  const { t, i18n } = useTranslation("settings");
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
    </div>
  );
}
