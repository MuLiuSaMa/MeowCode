import { useCallback, useEffect, useState } from "react";
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

const TOKEN_LABELS: Record<string, string> = {
  MEOWCODE_GITEE_TOKEN: "Gitee 私人令牌",
  MEOWCODE_GITCODE_TOKEN: "GitCode 访问令牌",
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

  const label = platform === "gitee" ? "Gitee" : platform === "gitcode" ? "GitCode" : "MCP";
  const redirectUri = platform ? status?.redirectUri ?? PLATFORM_CALLBACKS[platform] ?? "" : "";
  const builtinClientId = status?.clientId ?? "";
  const envNames = entry?.requiresEnv ?? [];

  /** 发起授权：主进程起本地回跳服务 → 返回授权页地址 → 交给系统浏览器打开 */
  const startConnect = useCallback(async () => {
    if (!platform) return;
    if (typeof window.meow.oauthConnectStart !== "function") {
      setError("OAuth 模块尚未加载，请完全重启 MeowCode 后重试。");
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
  }, [platform]);

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
        setError(result.message || "授权失败，请重试。");
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
  }, [open, phase, platform, onSaved]);

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
      setError("请填写 Client Secret。");
      return;
    }
    if (!clientId.trim()) {
      setError("请填写 Client ID（与 Client Secret 属于同一个应用）。");
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
        setError(result.message ?? "保存失败。");
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
      setError("请至少填写一个 Token。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const result = await window.meow.setMcpCredentials({ env });
      if (!result.ok) {
        setError(result.message ?? "保存失败。");
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
      aria-label={kind === "redirect" ? "复制回调地址" : "复制 Client ID"}
    >
      {copied === kind ? <LuCheck size={13} /> : <LuCopy size={13} />}
      {copied === kind ? "已复制" : "复制"}
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
        连接 {label}
      </span>
      <p className="mc-dialog__desc">
        使用 {label} OAuth 直接授权：点击后会用系统浏览器打开授权页，授权完自动回到 MeowCode。
        凭据只保存在本机，用于连接 {label} MCP。
      </p>

      {phase === "setup" ? (
        <>
          <div className="mc-oauth__redirect">
            <span className="mc-oauth__redirectlabel">
              回调地址（需与 {label} OAuth 应用登记的一致）
            </span>
            <div className="mc-oauth__redirectrow">
              <code className="mc-oauth__redirecturi">{redirectUri}</code>
              {copyButton("redirect", redirectUri)}
            </div>
          </div>
          <label className="mc-oauth__field">
            <span className="mc-oauth__fieldlabel">
              Client ID（与下面的 Client Secret 必须属于同一个应用）
            </span>
            <input
              className="mc-dialog__input mc-oauth__input"
              type="text"
              value={clientId}
              placeholder="OAuth 应用的 Client ID"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setClientId(event.target.value)}
            />
            {builtinClientId ? (
              <span className="mc-oauth__fieldhint">
                默认填的是 MeowCode 内置应用 ID。若你用自己的应用，请把这里和下面的 Secret
                一起改成应用页面上的值——两者不配套会换 token 失败（401）。
                <button
                  type="button"
                  className="mc-oauth__altlink"
                  onClick={() => setClientId(builtinClientId)}
                >
                  恢复内置 Client ID
                </button>
                {copyButton("client", builtinClientId)}
              </span>
            ) : null}
          </label>
          <label className="mc-oauth__field">
            <span className="mc-oauth__fieldlabel">
              Client Secret（{label} 换 token 强制校验，只需填一次）
            </span>
            <input
              className="mc-dialog__input mc-oauth__input"
              type="password"
              value={clientSecret}
              placeholder="OAuth 应用的 Client Secret"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setClientSecret(event.target.value)}
            />
          </label>
          <div className="mc-oauth__hint">
            这个表单只出现一次：{label} 换 token 时必须带 Client Secret（平台不支持免密 PKCE），
            首次填一次后加密存在本机。点「保存并连接」会立刻弹出浏览器；之后每次点「连接 {label}」
            都直接开浏览器，不再出现这个表单。
            <code>也可以把 Secret 放进 %APPDATA%\MeowCode\oauth-apps.json（不进仓库）</code>
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
              取消
            </Button>
            <Button
              variant="ghost"
              disabled={saving || verifying || !clientId.trim() || !clientSecret.trim()}
              onClick={() => void verifyApp()}
            >
              {verifying ? "校验中…" : "校验凭据"}
            </Button>
            <Button variant="primary" disabled={saving} onClick={() => void saveApp()}>
              {saving ? "保存中…" : "保存并连接"}
            </Button>
          </div>
        </>
      ) : null}

      {phase === "connect" || phase === "starting" ? (
        <>
          <div className="mc-oauth__hint">
            点击「直接连接」会用系统浏览器打开 {label} 授权页，授权后自动回跳本机，无需粘贴 Token。
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
              重新配置应用凭据（Client ID / Secret）
            </button>
          </p>
          <div className="mc-dialog__footer">
            <Button variant="ghost" disabled={phase === "starting"} onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" disabled={phase === "starting"} onClick={() => void startConnect()}>
              {phase === "starting" ? "正在打开…" : "直接连接"}
            </Button>
          </div>
        </>
      ) : null}

      {phase === "pending" ? (
        <>
          <p className="mc-oauth__wait">
            <LuLoaderCircle size={14} className="mc-oauth__spin" />
            等待你在浏览器中完成授权…
          </p>
          <div className="mc-dialog__footer">
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button
              variant="primary"
              icon={<LuExternalLink size={14} />}
              onClick={() => void window.meow.openExternal(authorizeUrl)}
            >
              重新打开授权页
            </Button>
          </div>
        </>
      ) : null}

      {phase === "success" ? (
        <>
          <div className="mc-oauth__success">
            <LuCheck size={16} />
            <span>{label} 已连接，正在加载 MCP 工具。</span>
          </div>
          <div className="mc-dialog__footer">
            <Button variant="primary" onClick={onClose}>
              完成
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
              重新配置应用凭据（Client ID / Secret）
            </button>
          </p>
          <div className="mc-dialog__footer">
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" onClick={() => void startConnect()}>
              重试
            </Button>
          </div>
        </>
      ) : null}

      {phase === "pat" ? (
        <>
          {envNames.map((name) => (
            <label className="mc-oauth__field" key={name}>
              <span className="mc-oauth__fieldlabel">{TOKEN_LABELS[name] ?? name}</span>
              <input
                className="mc-dialog__input mc-oauth__input"
                type="password"
                value={patValues[name] ?? ""}
                placeholder="粘贴 Token"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) =>
                  setPatValues((current) => ({ ...current, [name]: event.target.value }))
                }
              />
            </label>
          ))}
          {error ? (
            <div className="mc-oauth__error">
              <LuTriangleAlert size={15} />
              <span>{error}</span>
            </div>
          ) : null}
          <div className="mc-dialog__footer">
            <Button variant="ghost" disabled={saving} onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" disabled={saving} onClick={() => void savePat()}>
              {saving ? "校验中…" : "保存"}
            </Button>
          </div>
        </>
      ) : null}

      {phase === "setup" || phase === "connect" || phase === "error" || phase === "success" ? (
        <p className="mc-oauth__alt">
          <button type="button" className="mc-oauth__altlink" onClick={() => setPhase("pat")}>
            改用私人令牌
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
            使用 OAuth 直接连接
          </button>
        </p>
      ) : null}
    </Dialog>
  );
}
