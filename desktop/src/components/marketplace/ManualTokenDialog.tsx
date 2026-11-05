import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuTriangleAlert } from "react-icons/lu";
import type { MarketplaceEntry } from "../../api";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import "./PlatformOauthDialog.css";

/** 环境变量名是发给后端的标识符，表里只存对应的词条 key */
const TOKEN_LABEL_KEYS: Record<string, string> = {
  MEOWCODE_FIGMA_TOKEN: "manualToken.labelFigma",
  LUCKIN_MCP_TOKEN: "manualToken.labelLuckin",
};

const TOKEN_HINT_KEYS: Record<string, string> = {
  MEOWCODE_FIGMA_TOKEN: "manualToken.hintFigma",
  LUCKIN_MCP_TOKEN: "manualToken.hintLuckin",
};

/**
 * 手动令牌弹窗：给没有 OAuth 通道的 MCP（如 Figma Context）粘贴访问令牌。
 * 保存流程 = 主进程在线校验 → 加密存本机 settings → 热更新 server 进程 env 并重连 MCP。
 */
export function ManualTokenDialog({
  entry,
  open,
  onClose,
  onSaved,
}: {
  entry: MarketplaceEntry | null;
  open: boolean;
  onClose: () => void;
  onSaved: (warning?: string) => void;
}) {
  const { t } = useTranslation("marketplace");
  const envNames = entry?.requiresEnv ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues(Object.fromEntries(envNames.map((name) => [name, ""])));
    setError("");
    setSaving(false);
    // 只在打开/切换条目时重置输入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entry]);

  const save = async () => {
    const env = Object.fromEntries(
      Object.entries(values)
        .map(([name, value]) => [name, value.trim()])
        .filter(([, value]) => value),
    );
    if (!Object.keys(env).length) {
      setError(t("manualToken.empty"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const result = await window.meow.setMcpCredentials({ env });
      if (!result.ok) {
        setError(result.message ?? t("actions.saveFailed"));
        return;
      }
      onSaved(result.warning);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const entryName = entry?.name ?? "MCP";

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!saving) onClose();
      }}
      labelledBy="mc-manual-token-title"
    >
      <span className="mc-dialog__title" id="mc-manual-token-title">
        {t("manualToken.title", { name: entryName })}
      </span>
      <p className="mc-dialog__desc">{t("manualToken.desc", { name: entryName })}</p>
      {envNames.map((name) => {
        const labelKey = TOKEN_LABEL_KEYS[name];
        const hintKey = TOKEN_HINT_KEYS[name];
        return (
          <label className="mc-oauth__field" key={name}>
            <span className="mc-oauth__fieldlabel">{labelKey ? t(labelKey) : name}</span>
            <input
              className="mc-dialog__input mc-oauth__input"
              type="password"
              value={values[name] ?? ""}
              placeholder={t("manualToken.placeholder")}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) =>
                setValues((current) => ({ ...current, [name]: event.target.value }))
              }
            />
            {hintKey ? <span className="mc-oauth__fieldhint">{t(hintKey)}</span> : null}
          </label>
        );
      })}
      {error ? (
        <div className="mc-oauth__error">
          <LuTriangleAlert size={15} />
          <span>{error}</span>
        </div>
      ) : null}
      <div className="mc-dialog__footer">
        <Button variant="ghost" disabled={saving} onClick={onClose}>
          {t("actions.cancel")}
        </Button>
        <Button variant="primary" disabled={saving} onClick={() => void save()}>
          {saving ? t("actions.verifying") : t("actions.save")}
        </Button>
      </div>
    </Dialog>
  );
}
