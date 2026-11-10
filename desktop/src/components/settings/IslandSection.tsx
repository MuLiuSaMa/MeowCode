import { useTranslation } from "react-i18next";
import { FieldRow, Section } from "../ui/Section";
import { Toggle } from "../ui/Toggle";

/** AI 悬浮岛：屏幕顶部胶囊聚合显示所有运行中会话，可展开查看/继续对话（默认关）。 */
export function IslandSection({
  floatingIsland,
  onFloatingIslandChange,
}: {
  floatingIsland: boolean;
  onFloatingIslandChange: (value: boolean) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="mc-settings__inner">
      <Section title={t("island.section")} description={t("island.desc")}>
        <FieldRow label={t("island.field")}>
          <Toggle checked={floatingIsland} onChange={onFloatingIslandChange} label={t("island.field")} />
        </FieldRow>
      </Section>
    </div>
  );
}
