import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuCheck, LuCopy, LuExternalLink, LuLoaderCircle, LuTriangleAlert } from "react-icons/lu";
import type { MarketplaceEntry, OauthPlatform, OauthPlatformStatus } from "../../api";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import "./PlatformOauthDialog.css";

/** 主进程会回传真实回调地址；这里只是状态还没拿到时的兜底。 */
const PLATFORM_CALLBACKS: Record<string, string> = {
  gitee: "http://127.0.0.1:53682/oauth/gitee/callback",
  gitcode: "http://127.0.0.1:53682/oauth/gitcode/callback",
};

/** 环境变量名是发给后端的标识符，表里只存对应的词条 key */
const TOKEN_LABEL_KEYS: Record<string, string> = {
  MEOWCODE_GITEE_TOKEN: "oauth.tokenLabelGitee",
  MEOWCODE_GITCODE_TOKEN: "oauth.tokenLabelGitcode",
};

type Phase = "setup" | "connect" | "starting" | "pending" | "success" | "error" | "pat";

/**
 * Gitee / GitCode「直接连接」：Client ID 内置（MeowCode 官方应用），
 * 点一下就用系统浏览器打开授权页，本地 127.0.0.1 回跳换 token。
 * 两个平台换 token 强制校验 client_secret（不支持 PKCE），所以首次需填一次 Secret（加密存本机）。
 * 仍保留手动粘贴 PAT 的兜底入口。
 */
export function PlatformOauthDialog({
  platform,
  entry,
  status,
  open,
  onClose,
  onSaved,
}: {
  platform: OauthPlatform | null;
  entry: MarketplaceEntry | null;
  status?: OauthPlatformStatus;
  open: boolean;
  onClose: () => void;
  onSaved: (warning?: string) => void;
}) {
  const { t } = useTranslation("marketplace");
  const [phase, setPhase] = useState<Phase>("connect");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [patValues, setPatValues] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyMessage, setVerifyMessage] = useState("");
  const [copied, setCopied] = useState<"" | "redirect" | "client">("");
  const [authorizeUrl, setAuthorizeUrl] = useState("");

  const label = platform ? t(`platforms.${platform}`) : "MCP";
  const redirectUri = platform ? status?.redirectUri ?? PLATFORM_CALLBACKS[platform] ?? "" : "";
  const builtinClientId = status?.clientId ?? "";
  const envNames = entry?.requiresEnv ?? [];

  /** 发起授权：主进程起本地回跳服务 → 返回授权页地址 → 交给系统浏览器打开 */
  const startConnect = useCallback(async () => {
    if (!platform) return;
    if (typeof window.meow.oauthConnectStart !== "function") {
      setError(t("oauth.moduleMissing"));
      setPhase("error");
      return;
    }
    setPhase("starting");
    setError("");
    try {
      const result = await window.meow.oauthConnectStart({ platform });
      if (!result.ok) {
        setError(result.message);
        setPhase(result.needsClientSecret ? "setup" : "error");
        return;
      }
      setAuthorizeUrl(result.authorizeUrl);
      setPhase("pending");
      void window.meow.openExternal(result.authorizeUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [platform, t]);

  useEffect(() => {
    if (!open || !platform) return;
    setClientSecret("");
    // Client ID 预填当前生效值（默认内置应用）；用户可改成自己应用的 ID
    setClientId(status?.clientId ?? "");
    setPatValues(Object.fromEntries(envNames.map((name) => [name, ""])));
    setError("");
    setSaving(false);
    setVerifying(false);
    setVerifyMessage("");
    setCopied("");
    setAuthorizeUrl("");
    // 状态未知时留给「直接连接」按钮，避免误判成需要重新填 Secret
    if (status === undefined) {
      setPhase("connect");
      return;
    }
    if (status.configured) {
      // 已配置好：直接调起浏览器，点一下就走完
      void startConnect();
      return;
    }
    setPhase("setup");
    // 只在打开/切换平台时重置；status 引用变化不重置输入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, platform]);

  useEffect(() => {
    if (!open || phase !== "pending" || !platform) return;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      if (cancelled) return;
      try {
        const result = await window.meow.oauthConnectPoll({ platform });
        if (cancelled) return;
        if (result.status === "pending") {
          timer = window.setTimeout(tick, 1000);
          return;
        }
        if (result.status === "success") {
          setPhase("success");
          onSaved(result.warning);
          return;
        }
        setError(result.message || t("oauth.authFailed"));
        setPhase("error");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      }
    };
    timer = window.setTimeout(tick, 1000);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [open, phase, platform, onSaved, t]);

  // 离开 pending（关闭/取消）时通知主进程清理本地回跳服务
  useEffect(() => {
    if (!open || phase !== "pending" || !platform) return;
    return () => {
      void window.meow.oauthConnectCancel?.({ platform });
    };
  }, [open, phase, platform]);

  /**
   * 凭据自检：拿当前填的 Client ID + Secret 打一次 token 端点（探针授权码）。
   * 平台先校验 ID/Secret 再校验 code，所以「invalid_grant」= 配对正确，
   * 「invalid_client」= 这对凭据不属于同一个应用——401 不再是黑箱。
   */
  const verifyApp = async () => {
    if (!platform) return;
    setVerifying(true);
    setVerifyMessage("");
    setError("");
    try {
      const result = await window.meow.oauthVerifyApp({
        platform,
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      });
      setVerifyMessage(result.message);
      if (!result.ok) setError(result.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifying(false);
    }
  };

  const saveApp = async () => {
    if (!platform) return;
    if (!clientSecret.trim()) {
      setError(t("oauth.requireSecret"));
      return;
    }
    if (!clientId.trim()) {
      setError(t("oauth.requireClientId"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const result = await window.meow.oauthSaveApp({
        platform,
        // Client ID 与 Secret 成对保存：两者必须来自同一个应用，
        // 否则平台会按 client_id/secret 不匹配拒绝换 token（401 invalid_client）。
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      });
      if (!result.ok) {
        setError(result.message ?? t("actions.saveFailed"));
        return;
      }
      setClientSecret("");
      // 存好 Secret 立刻拉起浏览器，不再多一步点击
      void startConnect();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const savePat = async () => {
    const env = Object.fromEntries(
      Object.entries(patValues)
        .map(([name, value]) => [name, value.trim()])
        .filter(([, value]) => value),
    );
    if (!Object.keys(env).length) {
      setError(t("oauth.requireToken"));
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
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const copyText = async (kind: "redirect" | "client", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      window.setTimeout(() => setCopied(""), 1500);
    } catch {
      setCopied("");
    }
  };

  const copyButton = (kind: "redirect" | "client", text: string) => (
    <button
      type="button"
      className="mc-oauth__copy"
      onClick={() => void copyText(kind, text)}
      aria-label={
        kind === "redirect" ? t("oauth.copyRedirectAria") : t("oauth.copyClientIdAria")
      }
    >
      {copied === kind ? <LuCheck size={13} /> : <LuCopy size={13} />}
      {copied === kind ? t("actions.copied") : t("actions.copy")}
    </button>
  );

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!saving) onClose();
      }}
      labelledBy="mc-oauth-title"
    >
      <span className="mc-dialog__title" id="mc-oauth-title">
        {t("oauth.connectPlatform", { platform: label })}
      </span>
      <p className="mc-dialog__desc">{t("oauth.desc", { platform: label })}</p>

      {phase === "setup" ? (
        <>
          <div className="mc-oauth__redirect">
            <span className="mc-oauth__redirectlabel">
              {t("oauth.redirectLabel", { platform: label })}
            </span>
            <div className="mc-oauth__redirectrow">
              <code className="mc-oauth__redirecturi">{redirectUri}</code>
              {copyButton("redirect", redirectUri)}
            </div>
          </div>
          <label className="mc-oauth__field">
            <span className="mc-oauth__fieldlabel">{t("oauth.clientIdLabel")}</span>
            <input
              className="mc-dialog__input mc-oauth__input"
              type="text"
              value={clientId}
              placeholder={t("oauth.clientIdPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setClientId(event.target.value)}
            />
            {builtinClientId ? (
              <span className="mc-oauth__fieldhint">
                {t("oauth.clientIdHint")}
                <button
                  type="button"
                  className="mc-oauth__altlink"
                  onClick={() => setClientId(builtinClientId)}
                >
                  {t("oauth.restoreClientId")}
                </button>
                {copyButton("client", builtinClientId)}
              </span>
            ) : null}
          </label>
          <label className="mc-oauth__field">
            <span className="mc-oauth__fieldlabel">
              {t("oauth.secretLabel", { platform: label })}
            </span>
            <input
              className="mc-dialog__input mc-oauth__input"
              type="password"
              value={clientSecret}
              placeholder={t("oauth.secretPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setClientSecret(event.target.value)}
            />
          </label>
          <div className="mc-oauth__hint">
            {t("oauth.setupHint", { platform: label })}
            <code>{t("oauth.secretFilePath")}</code>
          </div>
          {verifyMessage && !error ? (
            <div className="mc-oauth__success">
              <LuCheck size={16} />
              <span>{verifyMessage}</span>
            </div>
          ) : null}
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
            <Button
              variant="ghost"
              disabled={saving || verifying || !clientId.trim() || !clientSecret.trim()}
              onClick={() => void verifyApp()}
            >
              {verifying ? t("actions.verifying") : t("oauth.verifyCredentials")}
            </Button>
            <Button variant="primary" disabled={saving} onClick={() => void saveApp()}>
              {saving ? t("actions.saving") : t("oauth.saveAndConnect")}
            </Button>
          </div>
        </>
      ) : null}

      {phase === "connect" || phase === "starting" ? (
        <>
          <div className="mc-oauth__hint">
            {t("oauth.connectHint", { platform: label })}
            <code>{redirectUri}</code>
          </div>
          {error ? (
            <div className="mc-oauth__error">
              <LuTriangleAlert size={15} />
              <span>{error}</span>
            </div>
          ) : null}
          <p className="mc-oauth__alt">
            <button type="button" className="mc-oauth__altlink" onClick={() => setPhase("setup")}>
              {t("oauth.reconfigure")}
            </button>
          </p>
          <div className="mc-dialog__footer">
            <Button variant="ghost" disabled={phase === "starting"} onClick={onClose}>
              {t("actions.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={phase === "starting"}
              onClick={() => void startConnect()}
            >
              {phase === "starting" ? t("oauth.opening") : t("oauth.connectNow")}
            </Button>
          </div>
        </>
      ) : null}

      {phase === "pending" ? (
        <>
          <p className="mc-oauth__wait">
            <LuLoaderCircle size={14} className="mc-oauth__spin" />
            {t("oauth.awaitingUser")}
          </p>
          <div className="mc-dialog__footer">
            <Button variant="ghost" onClick={onClose}>
              {t("actions.cancel")}
            </Button>
            <Button
              variant="primary"
              icon={<LuExternalLink size={14} />}
              onClick={() => void window.meow.openExternal(authorizeUrl)}
            >
              {t("oauth.reopenAuthPage")}
            </Button>
          </div>
        </>
      ) : null}

      {phase === "success" ? (
        <>
          <div className="mc-oauth__success">
            <LuCheck size={16} />
            <span>{t("oauth.connected", { platform: label })}</span>
          </div>
          <div className="mc-dialog__footer">
            <Button variant="primary" onClick={onClose}>
              {t("actions.done")}
            </Button>
          </div>
        </>
      ) : null}

      {phase === "error" ? (
        <>
          <div className="mc-oauth__error">
            <LuTriangleAlert size={15} />
            <span>{error}</span>
          </div>
          <p className="mc-oauth__alt">
            <button type="button" className="mc-oauth__altlink" onClick={() => setPhase("setup")}>
              {t("oauth.reconfigure")}
            </button>
          </p>
          <div className="mc-dialog__footer">
            <Button variant="ghost" onClick={onClose}>
              {t("actions.cancel")}
            </Button>
            <Button variant="primary" onClick={() => void startConnect()}>
              {t("actions.retry")}
            </Button>
          </div>
        </>
      ) : null}

      {phase === "pat" ? (
        <>
          {envNames.map((name) => {
            const labelKey = TOKEN_LABEL_KEYS[name];
            return (
              <label className="mc-oauth__field" key={name}>
                <span className="mc-oauth__fieldlabel">{labelKey ? t(labelKey) : name}</span>
                <input
                  className="mc-dialog__input mc-oauth__input"
                  type="password"
                  value={patValues[name] ?? ""}
                  placeholder={t("oauth.pasteToken")}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) =>
                    setPatValues((current) => ({ ...current, [name]: event.target.value }))
                  }
                />
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
            <Button variant="primary" disabled={saving} onClick={() => void savePat()}>
              {saving ? t("actions.verifying") : t("actions.save")}
            </Button>
          </div>
        </>
      ) : null}

      {phase === "setup" || phase === "connect" || phase === "error" || phase === "success" ? (
        <p className="mc-oauth__alt">
          <button type="button" className="mc-oauth__altlink" onClick={() => setPhase("pat")}>
            {t("oauth.usePat")}
          </button>
        </p>
      ) : null}
      {phase === "pat" ? (
        <p className="mc-oauth__alt">
          <button
            type="button"
            className="mc-oauth__altlink"
            onClick={() => setPhase(status?.configured ? "connect" : "setup")}
          >
            {t("oauth.useOauth")}
          </button>
        </p>
      ) : null}
    </Dialog>
  );
}
