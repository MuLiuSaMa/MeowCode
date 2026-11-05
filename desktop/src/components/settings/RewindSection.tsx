import { useTranslation } from "react-i18next";
import { CustomSelect } from "../ui/CustomSelect";
import { FieldRow, Section } from "../ui/Section";
import { Toggle } from "../ui/Toggle";

const KEEP_OPTIONS = [30, 60, 120, 200, 400] as const;
const TOTAL_MB_OPTIONS = [128, 512, 1024, 2048] as const;

/** 会话回滚（文件快照）：开关 + 保留滑窗 + 容量上限；改后重启应用生效。 */
export function RewindSection({
  enabled,
  onEnabledChange,
  keepCheckpoints,
  onKeepCheckpointsChange,
  maxTotalMb,
  onMaxTotalMbChange,
}: {
  enabled: boolean;
  onEnabledChange: (value: boolean) => void;
  keepCheckpoints: number;
  onKeepCheckpointsChange: (value: number) => void;
  maxTotalMb: number;
  onMaxTotalMbChange: (value: number) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="mc-settings__inner">
      <Section title={t("rewind.section")}>
        <FieldRow label={t("rewind.enabled.label")} hint={t("rewind.enabled.hint")}>
          <Toggle
            checked={enabled}
            onChange={onEnabledChange}
            label={t("rewind.enabled.label")}
          />
        </FieldRow>
        <FieldRow label={t("rewind.keep.label")} hint={t("rewind.keep.hint")}>
          <CustomSelect
            value={String(keepCheckpoints)}
            options={KEEP_OPTIONS.map((value) => ({
              value: String(value),
              label: String(value),
            }))}
            onChange={(value) => onKeepCheckpointsChange(Number(value))}
            ariaLabel={t("rewind.keep.label")}
            disabled={!enabled}
          />
        </FieldRow>
        <FieldRow label={t("rewind.maxTotal.label")} hint={t("rewind.maxTotal.hint")}>
          <CustomSelect
            value={String(maxTotalMb)}
            options={TOTAL_MB_OPTIONS.map((value) => ({
              value: String(value),
              label: `${value} MB`,
            }))}
            onChange={(value) => onMaxTotalMbChange(Number(value))}
            ariaLabel={t("rewind.maxTotal.label")}
            disabled={!enabled}
          />
        </FieldRow>
      </Section>
    </div>
  );
}
