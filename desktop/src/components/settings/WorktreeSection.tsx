import { useTranslation } from "react-i18next";
import { CustomSelect } from "../ui/CustomSelect";
import { FieldRow, Section } from "../ui/Section";
import { Toggle } from "../ui/Toggle";

const WORKTREE_KEEP_OPTIONS = [5, 10, 15, 20, 30] as const;

export function WorktreeSection({
  fetchUpstream,
  onFetchUpstreamChange,
  autoCleanup,
  onAutoCleanupChange,
  maxKeep,
  onMaxKeepChange,
}: {
  fetchUpstream: boolean;
  onFetchUpstreamChange: (value: boolean) => void;
  autoCleanup: boolean;
  onAutoCleanupChange: (value: boolean) => void;
  maxKeep: number;
  onMaxKeepChange: (value: number) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="mc-settings__inner">
      <Section title={t("worktree.section")}>
        <FieldRow label={t("worktree.fetch.label")} hint={t("worktree.fetch.hint")}>
          <Toggle
            checked={fetchUpstream}
            onChange={onFetchUpstreamChange}
            label={t("worktree.fetch.label")}
          />
        </FieldRow>
        <FieldRow label={t("worktree.cleanup.label")} hint={t("worktree.cleanup.hint")}>
          <Toggle
            checked={autoCleanup}
            onChange={onAutoCleanupChange}
            label={t("worktree.cleanup.label")}
          />
        </FieldRow>
        <FieldRow label={t("worktree.maxKeep.label")} hint={t("worktree.maxKeep.hint")}>
          <CustomSelect
            value={String(maxKeep)}
            options={WORKTREE_KEEP_OPTIONS.map((value) => ({
              value: String(value),
              label: String(value),
            }))}
            onChange={(value) => onMaxKeepChange(Number(value))}
            ariaLabel={t("worktree.maxKeep.label")}
            disabled={!autoCleanup}
          />
        </FieldRow>
      </Section>
    </div>
  );
}
