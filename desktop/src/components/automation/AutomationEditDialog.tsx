import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { saveAutomation, type Automation, type AutomationAutonomy, type AutomationInput } from "../../api";
import { Button } from "../ui/Button";
import { CustomSelect } from "../ui/CustomSelect";
import { Dialog } from "../ui/Dialog";
import { SegmentedControl } from "../ui/SegmentedControl";
import { TextField } from "../ui/TextField";
import { DatePicker } from "./DatePicker";
import { TimeSelect } from "./TimeSelect";
import { toLocalInputValue } from "./schedule";

type FreqKind = "interval" | "daily" | "weekly" | "monthly" | "once" | "cron";

const FREQ_KINDS: FreqKind[] = ["interval", "daily", "weekly", "monthly", "once", "cron"];
/** 每月几号：1-31 下拉（缺月由主进程收敛到当月最后一天） */
const DAY_OPTIONS = Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }));

/**
 * 新建/编辑自动化任务。高级设置默认折叠（低频字段不外露），
 * cron 校验在主进程保存时兜底，错误原样回显。
 */
export function AutomationEditDialog({
  open,
  initial,
  workspace,
  projects,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** 编辑目标；null = 新建 */
  initial: Automation | null;
  /** 当前工作区（新建时的默认目标） */
  workspace: string | null;
  /** 已知项目列表 */
  projects: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation("automation");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState("");
  const [kind, setKind] = useState<FreqKind>("daily");
  const [intervalMinutes, setIntervalMinutes] = useState("60");
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState("1");
  const [dayOfMonth, setDayOfMonth] = useState("1");
  const [onceAt, setOnceAt] = useState("");
  const [cron, setCron] = useState("");
  const [maxRuns, setMaxRuns] = useState("");
  const [autonomy, setAutonomy] = useState<AutomationAutonomy>("auto");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaving(false);
    if (initial) {
      setTitle(initial.title);
      setPrompt(initial.prompt);
      setCwd(initial.cwd);
      setKind(initial.kind);
      setIntervalMinutes(String(initial.intervalMinutes ?? 60));
      setTime(initial.time ?? "09:00");
      setWeekday(String(initial.weekday ?? 1));
      setDayOfMonth(String(initial.dayOfMonth ?? 1));
      setOnceAt(initial.onceAt ? toLocalInputValue(new Date(initial.onceAt)) : "");
      setCron(initial.cron ?? "");
      setMaxRuns(initial.maxRuns != null ? String(initial.maxRuns) : "");
      setAutonomy(initial.autonomy ?? "auto");
      setAdvancedOpen(initial.kind === "cron");
    } else {
      setTitle("");
      setPrompt("");
      setCwd(workspace ?? projects[0] ?? "");
      setKind("daily");
      setIntervalMinutes("60");
      setTime("09:00");
      setWeekday("1");
      setDayOfMonth("1");
      // 一次性默认 15 分钟后：多数「稍后跑一下」的场景直接保存即可
      setOnceAt(toLocalInputValue(new Date(Date.now() + 15 * 60_000)));
      setCron("");
      setMaxRuns("");
      setAutonomy("auto");
      setAdvancedOpen(false);
    }
  }, [open, initial, workspace, projects]);

  const workspaceOptions = [
    ...new Set([cwd, workspace ?? "", ...projects].filter((item) => item.length > 0)),
  ].map((value) => ({ value, label: value || t("form.fieldWorkspace") }));

  const pickWorkspace = async () => {
    const picked = await window.meow.pickWorkspace();
    if (picked) setCwd(picked);
  };

  const save = async () => {
    if (!title.trim() || !prompt.trim() || !cwd.trim()) {
      setError(t("form.errorRequired"));
      return;
    }
    if (kind === "once" && !onceAt) {
      setError(t("form.errorRequired"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const input: AutomationInput = {
        id: initial?.id,
        title: title.trim(),
        prompt: prompt.trim(),
        cwd: cwd.trim(),
        kind,
        recurring: kind !== "once",
        enabled: initial?.enabled ?? true,
        autonomy,
      };
      if (kind === "interval") {
        input.intervalMinutes = Math.max(1, Math.floor(Number(intervalMinutes) || 0));
        if (!Number.isFinite(input.intervalMinutes)) throw new Error(t("form.errorRequired"));
      } else if (kind === "daily" || kind === "weekly" || kind === "monthly") {
        input.time = time;
        if (kind === "weekly") input.weekday = Number(weekday);
        if (kind === "monthly") input.dayOfMonth = Math.min(31, Math.max(1, Number(dayOfMonth) || 1));
      } else if (kind === "once") {
        const at = new Date(onceAt);
        if (Number.isNaN(at.getTime())) throw new Error(t("form.errorRequired"));
        input.onceAt = at.toISOString();
      } else if (kind === "cron") {
        input.cron = cron.trim();
      }
      const parsedMaxRuns = Math.floor(Number(maxRuns));
      if (maxRuns.trim() && Number.isFinite(parsedMaxRuns) && parsedMaxRuns >= 1) {
        input.maxRuns = parsedMaxRuns;
      }
      await saveAutomation(input);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? () => undefined : onClose} labelledBy="mc-auto-edit-title">
      <span className="mc-dialog__title" id="mc-auto-edit-title">
        {initial ? t("form.editTitle") : t("form.createTitle")}
      </span>

      <div className="mc-auto__form">
        <TextField
          label={t("form.fieldTitle")}
          value={title}
          placeholder={t("form.titlePlaceholder")}
          maxLength={80}
          onChange={(event) => setTitle(event.target.value)}
        />

        <label className="mc-field">
          <span className="mc-field__label">{t("form.fieldPrompt")}</span>
          <textarea
            className="mc-auto__textarea"
            value={prompt}
            placeholder={t("form.promptPlaceholder")}
            rows={4}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>

        <label className="mc-field">
          <span className="mc-field__label">{t("form.fieldWorkspace")}</span>
          <div className="mc-auto__workspace">
            <CustomSelect
              value={cwd}
              options={workspaceOptions}
              onChange={setCwd}
              ariaLabel={t("form.fieldWorkspace")}
            />
            <button type="button" className="mc-auto__ghost" onClick={() => void pickWorkspace()}>
              {t("form.fieldWorkspace")}…
            </button>
          </div>
        </label>

        <div className="mc-field">
          <span className="mc-field__label">{t("form.fieldSchedule")}</span>
          <SegmentedControl
            value={kind}
            ariaLabel={t("form.fieldSchedule")}
            options={FREQ_KINDS.map((value) => ({ value, label: t(`form.freq.${value}`) }))}
            onChange={setKind}
          />
        </div>

        {kind === "interval" ? (
          <TextField
            label={t("form.intervalMinutes")}
            type="number"
            min={1}
            max={525600}
            value={intervalMinutes}
            onChange={(event) => setIntervalMinutes(event.target.value)}
          />
        ) : null}
        {kind === "daily" || kind === "weekly" || kind === "monthly" ? (
          <div className="mc-field">
            <span className="mc-field__label">{t("form.time")}</span>
            <TimeSelect value={time} onChange={setTime} ariaLabel={t("form.time")} />
          </div>
        ) : null}
        {kind === "weekly" ? (
          <label className="mc-field">
            <span className="mc-field__label">{t("form.weekday")}</span>
            <CustomSelect
              value={weekday}
              options={[0, 1, 2, 3, 4, 5, 6].map((value) => ({
                value: String(value),
                label: t(`weekday.${value}`),
              }))}
              onChange={setWeekday}
              ariaLabel={t("form.weekday")}
            />
          </label>
        ) : null}
        {kind === "monthly" ? (
          <div className="mc-field">
            <span className="mc-field__label">{t("form.dayOfMonth")}</span>
            <CustomSelect
              value={dayOfMonth}
              options={DAY_OPTIONS}
              onChange={setDayOfMonth}
              ariaLabel={t("form.dayOfMonth")}
            />
          </div>
        ) : null}
        {kind === "once" ? (
          <div className="mc-field">
            <span className="mc-field__label">{t("form.onceAt")}</span>
            <div className="mc-auto__daterow">
              <DatePicker
                value={onceAt.slice(0, 10)}
                onChange={(date) => setOnceAt(`${date}T${onceAt.slice(11, 16) || "09:00"}`)}
                ariaLabel={t("form.onceAt")}
              />
              <TimeSelect
                value={onceAt.slice(11, 16) || "09:00"}
                onChange={(nextTime) => setOnceAt(`${onceAt.slice(0, 10)}T${nextTime}`)}
                ariaLabel={t("form.onceAt")}
              />
            </div>
          </div>
        ) : null}

        <button
          type="button"
          className="mc-auto__advanced"
          data-open={advancedOpen}
          onClick={() => setAdvancedOpen((prev) => !prev)}
        >
          {t("form.advanced")}
        </button>
        {advancedOpen ? (
          <div className="mc-auto__advancedbody">
            {kind === "cron" ? (
              <TextField
                label={t("form.fieldCron")}
                value={cron}
                placeholder={t("form.cronPlaceholder")}
                onChange={(event) => setCron(event.target.value)}
              />
            ) : null}
            <div className="mc-field">
              <span className="mc-field__label">{t("autonomy.label")}</span>
              <SegmentedControl<AutomationAutonomy>
                value={autonomy}
                ariaLabel={t("autonomy.label")}
                options={(["auto", "observe", "off"] as const).map((value) => ({
                  value,
                  label: t(`autonomy.${value}`),
                }))}
                onChange={setAutonomy}
              />
            </div>
            <TextField
              label={t("form.fieldMaxRuns")}
              type="number"
              min={1}
              value={maxRuns}
              placeholder={t("form.maxRunsPlaceholder")}
              onChange={(event) => setMaxRuns(event.target.value)}
            />
          </div>
        ) : null}

        {error ? <p className="mc-auto__error">{error}</p> : null}
      </div>

      <div className="mc-dialog__footer">
        <Button variant="ghost" disabled={saving} onClick={onClose}>
          {t("actions.cancel")}
        </Button>
        <Button variant="primary" disabled={saving} onClick={() => void save()}>
          {saving ? t("actions.saving") : t("actions.save")}
        </Button>
      </div>
    </Dialog>
  );
}
