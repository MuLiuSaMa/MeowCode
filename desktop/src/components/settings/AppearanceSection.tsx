import { FieldRow, Section } from "../ui/Section";
import { SegmentedControl } from "../ui/SegmentedControl";
import type { ThemePreference } from "../../api";

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

export function AppearanceSection({
  preference,
  onPreference,
}: {
  preference: ThemePreference;
  onPreference: (value: ThemePreference) => void;
}) {
  return (
    <div className="mc-settings__inner">
      <Section
        title="主题"
        description="「跟随系统」会实时跟随 Windows 的浅色 / 深色设置。切换后会立即生效，不需要重启。"
      >
        <FieldRow label="外观主题">
          <SegmentedControl value={preference} options={THEME_OPTIONS} onChange={onPreference} ariaLabel="外观主题" />
        </FieldRow>
      </Section>
    </div>
  );
}
