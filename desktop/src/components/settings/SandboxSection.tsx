import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuShield, LuShieldCheck } from "react-icons/lu";
import {
  getSandbox,
  setSandbox,
  type SandboxSettings,
  type SandboxStatus,
} from "../../api";
import { Button } from "../ui/Button";
import { CustomSelect, type CustomSelectOption } from "../ui/CustomSelect";
import { Dialog } from "../ui/Dialog";
import { FieldRow, Section } from "../ui/Section";
import { Spinner } from "../ui/Spinner";
import { Toggle } from "../ui/Toggle";
import "./SandboxSection.css";

type SandboxMode = "full-access" | "workspace-write";

/**
 * 沙箱分区：只保留「沙箱模式」与「文件删除确认」两行。
 *
 * 模式映射：完全访问 = 后端 enabled:false；工作区写入 = enabled:true + 受限令牌。
 * 文件删除确认只在工作区写入模式下生效；完全访问模式显示为关闭且不可操作。
 * 额外可写根 / 私有 temp / 授权超时仍存在 settings.json 与 server 策略里，
 * 由工作区写入模式自动使用（本轮不暴露 UI）。
 */
export function SandboxSection({ onToast }: { onToast: (text: string) => void }) {
  const { t } = useTranslation("settings");
  const [status, setStatus] = useState<SandboxStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmEnable, setConfirmEnable] = useState(false);
  const [pendingMode, setPendingMode] = useState<SandboxMode | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await getSandbox());
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("sandbox.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [onToast, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const persist = async (next: SandboxStatus) => {
    await window.meow.saveProviderPrefs({
      sandbox: {
        enabled: next.enabled,
        mode: next.mode,
        writableRoots: next.writableRoots,
        allowTemp: next.allowTemp,
        grantTimeoutMs: next.grantTimeoutMs,
        confirmDelete: next.confirmDelete,
      },
    });
  };

  const apply = async (patch: Partial<SandboxSettings>) => {
    if (!status) return;
    const previous = status;
    const merged = { ...status, ...patch };
    setStatus(merged);
    setBusy(true);
    try {
      const next = await setSandbox({
        enabled: merged.enabled,
        mode: merged.mode,
        writableRoots: merged.writableRoots,
        allowTemp: merged.allowTemp,
        grantTimeoutMs: merged.grantTimeoutMs,
        confirmDelete: merged.confirmDelete,
      });
      setStatus(next);
      await persist(next);
      if (next.probeDurationMs !== undefined) {
        onToast(t("sandbox.enabled", { ms: next.probeDurationMs }));
      }
    } catch (error) {
      setStatus(previous);
      onToast(error instanceof Error ? error.message : t("sandbox.saveFailed"));
    } finally {
      setBusy(false);
    }
  };

  if (loading || !status) {
    return (
      <div className="mc-settings__inner">
        <div className="mc-sandbox__loading">
          <Spinner size={16} />
        </div>
      </div>
    );
  }

  const mode: SandboxMode = status.enabled ? "workspace-write" : "full-access";
  const modeOptions: Array<CustomSelectOption<SandboxMode>> = [
    {
      value: "full-access",
      label: t("sandbox.modeFull"),
      description: t("sandbox.modeFullDesc"),
    },
    {
      value: "workspace-write",
      label: t("sandbox.modeWorkspace"),
      description: t("sandbox.modeWorkspaceDesc"),
    },
  ];

  const changeMode = (next: SandboxMode) => {
    if (next === mode) return;
    if (next === "workspace-write") {
      setPendingMode(next);
      setConfirmEnable(true);
      return;
    }
    void apply({ enabled: false });
  };

  const confirmSwitch = () => {
    setConfirmEnable(false);
    if (pendingMode === "workspace-write") {
      void apply({ enabled: true });
    }
    setPendingMode(null);
  };

  const cancelSwitch = () => {
    setConfirmEnable(false);
    setPendingMode(null);
  };

  return (
    <div className="mc-settings__inner">
      <Section title={t("sandbox.title")}>
        <FieldRow label={t("sandbox.modeField")} hint={t("sandbox.modeDesc")}>
          <CustomSelect
            value={mode}
            options={modeOptions}
            onChange={changeMode}
            ariaLabel={t("sandbox.modeField")}
            icon={mode === "workspace-write" ? <LuShieldCheck size={14} /> : <LuShield size={14} />}
            className="mc-sandbox__mode"
            disabled={busy || !status.supported}
          />
        </FieldRow>

        <FieldRow label={t("sandbox.deleteField")} hint={t("sandbox.deleteDesc")}>
          <Toggle
            checked={status.enabled ? status.confirmDelete : false}
            onChange={(value) => void apply({ confirmDelete: value })}
            disabled={busy || !status.enabled}
            label={t("sandbox.deleteField")}
          />
        </FieldRow>

        {!status.supported ? <p className="mc-sandbox__warn">{t("sandbox.unsupported")}</p> : null}
      </Section>

      <Dialog
        open={confirmEnable}
        onClose={cancelSwitch}
        labelledBy="mc-sandbox-risk-title"
      >
        <span className="mc-dialog__title" id="mc-sandbox-risk-title">
          {t("sandbox.riskTitle")}
        </span>
        <p className="mc-dialog__desc">{t("sandbox.riskDoes")}</p>
        <div className="mc-sandbox__note">
          <p>{t("sandbox.riskDoesNot")}</p>
          <p>{t("sandbox.riskUndo")}</p>
        </div>
        <div className="mc-dialog__footer">
          <Button variant="ghost" onClick={cancelSwitch}>
            {t("sandbox.cancel")}
          </Button>
          <Button variant="primary" onClick={confirmSwitch}>
            {t("sandbox.confirmEnable")}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
