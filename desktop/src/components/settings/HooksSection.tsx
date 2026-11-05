import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuExternalLink, LuRefreshCw } from "react-icons/lu";
import {
  getHooksConfig,
  openHooksFile,
  saveHooksSettings,
  type HooksConfig,
  type HooksLayer,
  type HooksRunMode,
  type HooksSettingsInput,
} from "../../api";
import { Button } from "../ui/Button";
import { CustomSelect, type CustomSelectOption } from "../ui/CustomSelect";
import { Dialog } from "../ui/Dialog";
import { FieldRow, Section } from "../ui/Section";
import { Toggle } from "../ui/Toggle";
import "./HooksSection.css";

const LAYERS: HooksLayer[] = ["user", "project", "local"];
const RUN_MODES: HooksRunMode[] = ["auto", "ask"];

export function HooksSection({
  turnRunning,
  onToast,
}: {
  turnRunning: boolean;
  onToast: (text: string) => void;
}) {
  const { t } = useTranslation("settings");
  const [config, setConfig] = useState<HooksConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingSave, setPendingSave] = useState<HooksSettingsInput | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setConfig(await getHooksConfig());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const commit = useCallback(
    async (next: HooksSettingsInput) => {
      setSaving(true);
      setError(null);
      try {
        await saveHooksSettings(next);
        // 保存会重启 agent server：用探测代替固定等待，拿到新配置即结束。
        let lastError: unknown = null;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          try {
            setConfig(await getHooksConfig());
            return;
          } catch (err) {
            lastError = err;
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
        }
        throw lastError ?? new Error("hooks config reload failed");
      } catch (err) {
        onToast(err instanceof Error ? err.message : String(err));
        await load();
      } finally {
        setSaving(false);
      }
    },
    [load, onToast],
  );

  const apply = useCallback(
    (patch: Partial<HooksSettingsInput>) => {
      if (!config) return;
      const next: HooksSettingsInput = {
        enabled: config.enabled,
        runMode: config.runMode,
        includeWorkspace: config.scope.workspace,
        ...patch,
      };
      if (turnRunning) {
        setPendingSave(next);
        return;
      }
      void commit(next);
    },
    [commit, config, turnRunning],
  );

  const runModeOptions = useMemo<Array<CustomSelectOption<HooksRunMode>>>(
    () =>
      RUN_MODES.map((value) => ({
        value,
        label: t(`hooks.runMode.options.${value}`),
        description: t(`hooks.runMode.options.${value}Desc`),
      })),
    [t],
  );

  const events = useMemo(
    () => (config?.events ?? []).filter((entry) => entry.commands.length > 0),
    [config],
  );

  const openFile = async (layer: HooksLayer, fallbackPath: string) => {
    try {
      const result = await openHooksFile(layer);
      if (result.ok) return;
      if (result.missing) {
        onToast(t("hooks.configured.missingToast", { path: result.path ?? fallbackPath }));
        return;
      }
      onToast(t("hooks.configured.openError", { error: result.error ?? "unknown" }));
    } catch (err) {
      onToast(err instanceof Error ? err.message : String(err));
    }
  };

  if (loading) {
    return (
      <div className="mc-settings__inner">
        <div className="mc-hooks__state" role="status">
          {t("hooks.loading")}
        </div>
      </div>
    );
  }

  if (error || !config) {
    return (
      <div className="mc-settings__inner">
        <div className="mc-hooks__state mc-hooks__state--error" role="alert">
          <span>{t("hooks.error", { error: error ?? "" })}</span>
          <Button
            size="sm"
            variant="outline"
            icon={<LuRefreshCw size={14} />}
            onClick={() => void load()}
          >
            {t("hooks.retry")}
          </Button>
        </div>
      </div>
    );
  }

  const disabled = saving;
  return (
    <div className="mc-settings__inner">
      <Section
        title={t("hooks.import.section")}
        description={t("hooks.import.description")}
      >
        <FieldRow
          label={t("hooks.import.master")}
          hint={t(`hooks.import.masterHint.${config.enabled ? "on" : "off"}`)}
        >
          <Toggle
            checked={config.enabled}
            disabled={disabled}
            onChange={(value) => apply({ enabled: value })}
            label={t("hooks.import.master")}
          />
        </FieldRow>
        <FieldRow
          label={t("hooks.import.workspace")}
          hint={t(`hooks.import.workspaceHint.${config.scope.workspace ? "on" : "off"}`)}
        >
          <Toggle
            checked={config.scope.workspace}
            disabled={disabled}
            onChange={(value) => apply({ includeWorkspace: value })}
            label={t("hooks.import.workspace")}
          />
        </FieldRow>
        {config.scope.workspace ? (
          <p className="mc-hooks__warning" role="alert">
            {t("hooks.import.workspaceWarning")}
          </p>
        ) : null}
        {!config.enabled ? (
          <p className="mc-hooks__muted">{t("hooks.import.disabledNote")}</p>
        ) : null}
        {config.error ? (
          <p className="mc-hooks__muted mc-hooks__fileerror" role="alert">
            {config.error}
          </p>
        ) : null}
        {saving ? (
          <p className="mc-hooks__muted" role="status">
            {t("hooks.saving")}
          </p>
        ) : null}
      </Section>

      <Section
        title={t("hooks.configured.section")}
        description={t("hooks.configured.description")}
      >
        {events.length === 0 ? (
          <div className="mc-hooks__empty">{t("hooks.configured.empty")}</div>
        ) : (
          <div className="mc-hooks__events">
            {events.map((entry) => (
              <div className="mc-hooks__event" key={entry.event}>
                <div className="mc-hooks__eventhead">
                  <span className="mc-hooks__eventname">{entry.event}</span>
                  <span className="mc-hooks__count">
                    {t("hooks.configured.eventCount", { count: entry.commands.length })}
                  </span>
                </div>
                <div className="mc-hooks__commands">
                  {entry.commands.map((command, index) => (
                    <div
                      className="mc-hooks__commandrow"
                      key={`${entry.event}:${index}:${command.command}`}
                    >
                      <code className="mc-hooks__command">{command.command}</code>
                      <div className="mc-hooks__meta">
                        <span className="mc-hooks__badge">
                          {t(`hooks.configured.layer.${command.layer}`)}
                        </span>
                        {command.matcher ? (
                          <span className="mc-hooks__badge">
                            {t("hooks.configured.matcher", { matcher: command.matcher })}
                          </span>
                        ) : null}
                        <span className="mc-hooks__badge">
                          {t("hooks.configured.timeout", { seconds: command.timeout })}
                        </span>
                        {command.excluded ? (
                          <span className="mc-hooks__badge mc-hooks__badge--excluded">
                            {t("hooks.configured.excluded")}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="mc-hooks__files">
          {LAYERS.map((layer) => {
            const file = config.files.find((item) => item.layer === layer);
            const label = t(`hooks.configured.layer.${layer}`);
            return (
              <div className="mc-hooks__filerow" key={layer}>
                <div className="mc-hooks__filetext">
                  <span className="mc-hooks__filename">{label}</span>
                  <span className="mc-hooks__filepath" title={file?.path ?? ""}>
                    {file?.path ?? t("hooks.configured.layerUnknown")}
                  </span>
                  <span className="mc-hooks__filemeta">
                    {file?.exists
                      ? t("hooks.configured.fileCount", { count: file.commands })
                      : t("hooks.configured.missing")}
                    {file?.excluded ? ` · ${t("hooks.configured.excluded")}` : ""}
                  </span>
                  {file?.error ? (
                    <span className="mc-hooks__fileerror">{file.error}</span>
                  ) : null}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  icon={<LuExternalLink size={13} />}
                  onClick={() => void openFile(layer, file?.path ?? "")}
                >
                  {t("hooks.configured.open")}
                </Button>
              </div>
            );
          })}
        </div>

        {config.unsupportedEvents.length ? (
          <p className="mc-hooks__muted">
            {t("hooks.configured.unsupported", {
              events: config.unsupportedEvents
                .map((item) => `${item.event}(${item.count})`)
                .join(", "),
            })}
          </p>
        ) : null}
      </Section>

      <Section
        title={t("hooks.runMode.section")}
        description={t(`hooks.runMode.description.${config.runMode}`)}
      >
        <FieldRow label={t("hooks.runMode.field")}>
          <CustomSelect
            value={config.runMode}
            options={runModeOptions}
            onChange={(value) => apply({ runMode: value })}
            ariaLabel={t("hooks.runMode.section")}
            disabled={disabled}
          />
        </FieldRow>
      </Section>

      <Dialog open={pendingSave !== null} onClose={() => setPendingSave(null)}>
        <h2 className="mc-dialog__title">{t("hooks.confirm.title")}</h2>
        <p className="mc-dialog__desc">{t("hooks.confirm.message")}</p>
        <div className="mc-dialog__footer">
          <Button onClick={() => setPendingSave(null)}>{t("actions.cancel")}</Button>
          <Button
            variant="danger"
            onClick={() => {
              if (!pendingSave) return;
              const next = pendingSave;
              setPendingSave(null);
              void commit(next);
            }}
          >
            {t("hooks.confirm.confirm")}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
