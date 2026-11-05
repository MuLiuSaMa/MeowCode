import { useTranslation } from "react-i18next";
import { FieldRow, Section } from "../ui/Section";
import "./ShortcutsSection.css";

/** 表里只存 key：标签在组件里查表，切语言才会刷新。新增快捷键在这里加一行即可。 */
const SHORTCUTS: Array<{ keys: string[]; labelKey: string }> = [
  { keys: ["Ctrl", "K"], labelKey: "shortcuts.items.search" },
  { keys: ["Ctrl", "P"], labelKey: "shortcuts.items.quickOpen" },
  { keys: ["Ctrl", "Alt", "S"], labelKey: "shortcuts.items.sideChat" },
  { keys: ["Ctrl", "`"], labelKey: "shortcuts.items.terminal" },
  { keys: ["Enter"], labelKey: "shortcuts.items.send" },
  { keys: ["Ctrl", "Enter"], labelKey: "shortcuts.items.commit" },
];

/** 快捷键一览（纯展示，无持久化）。macOS 上 Ctrl 同样生效（App 里 mod = ctrl || meta）。 */
export function ShortcutsSection() {
  const { t } = useTranslation("settings");
  return (
    <div className="mc-settings__inner">
      <Section title={t("shortcuts.title")} description={t("shortcuts.description")}>
        {SHORTCUTS.map((item) => (
          <FieldRow key={item.labelKey} label={t(item.labelKey)} hint={t("shortcuts.ctrlHint")}>
            <span className="mc-shortcuts__keys">
              {item.keys.map((key, index) => (
                <span key={key} className="mc-shortcuts__keywrap">
                  {index > 0 ? <span className="mc-shortcuts__plus">+</span> : null}
                  <kbd className="mc-shortcuts__kbd">{key}</kbd>
                </span>
              ))}
            </span>
          </FieldRow>
        ))}
      </Section>
    </div>
  );
}
