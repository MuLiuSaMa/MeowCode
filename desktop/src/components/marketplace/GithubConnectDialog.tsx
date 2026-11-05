import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { LuCheck, LuCopy, LuExternalLink, LuLoaderCircle, LuTriangleAlert } from "react-icons/lu";
import type { GithubDeviceFlow } from "../../api";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import "./GithubConnectDialog.css";

type Phase = "idle" | "starting" | "pending" | "success" | "error";

/**
 * GitHub MCP 的 OAuth 设备流：显示一次性代码 → 浏览器授权 → 主进程保存 token 并热更新 MCP。
 * token 不经过渲染层，这里只处理设备码和状态。
 */
export function GithubConnectDialog({
  open,
  onClose,
  onConnected,
}: {
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
}) {
  const { t } = useTranslation("marketplace");
  const [phase, setPhase] = useState<Phase>("idle");
  const [flow, setFlow] = useState<GithubDeviceFlow | null>(null);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [intervalSec, setIntervalSec] = useState(5);
  const [copied, setCopied] = useState(false);
  /** 设备码是自动复制的：给用户一个明确提示，避免以为还要手动点一次 */
  const [autoCopied, setAutoCopied] = useState(false);

  useEffect(() => {
    if (open) return;
    setPhase("idle");
    setFlow(null);
    setError("");
    setWarning("");
    setIntervalSec(5);
    setCopied(false);
    setAutoCopied(false);
  }, [open]);

  useEffect(() => {
    if (!open || phase !== "pending" || !flow) return;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      if (cancelled) return;
      try {
        const result = await window.meow.githubDevicePoll(flow.flowId);
        if (cancelled) return;
        if (result.status === "pending") {
          timer = window.setTimeout(tick, intervalSec * 1000);
          return;
        }
        if (result.status === "slow_down") {
          const next = result.interval || intervalSec + 5;
          setIntervalSec(next);
          timer = window.setTimeout(tick, next * 1000);
          return;
        }
        if (result.status === "success") {
          setWarning(result.warning ?? "");
          setPhase("success");
          onConnected();
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
    timer = window.setTimeout(tick, intervalSec * 1000);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [open, phase, flow, intervalSec, onConnected, t]);

  const copyCode = async (code: string, auto = false) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (auto) setAutoCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const start = async () => {
    if (typeof window.meow.githubDeviceStart !== "function") {
      setError(t("github.moduleMissing"));
      setPhase("error");
      return;
    }
    setPhase("starting");
    setError("");
    setWarning("");
    try {
      const result = await window.meow.githubDeviceStart();
      if (!result.ok) {
        setError(result.message);
        setPhase("error");
        return;
      }
      setFlow(result.flow);
      setIntervalSec(result.flow.interval);
      setPhase("pending");
      // 拿到设备码立刻写进剪贴板：浏览器打开后直接 Cmd/Ctrl+V 即可
      void copyCode(result.flow.userCode, true);
      void window.meow.openExternal(result.flow.verificationUri);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  };

  return (
    <Dialog open={open} onClose={onClose} labelledBy="mc-ghauth-title">
      <span className="mc-dialog__title" id="mc-ghauth-title">
        {t("github.title")}
      </span>
      <p className="mc-dialog__desc">{t("github.desc")}</p>

      {phase === "idle" || phase === "starting" ? (
        <>
          <div className="mc-ghauth__hint">
            <p>{t("github.prereq")}</p>
            <ul>
              <li>
                <Trans
                  i18nKey="github.deviceFlowStep"
                  ns="marketplace"
                  components={[
                    <button
                      type="button"
                      className="mc-ghauth__link"
                      onClick={() => void window.meow.openExternal("https://github.com/settings/apps")}
                    />,
                  ]}
                />
              </li>
              <li>{t("github.permissions")}</li>
            </ul>
          </div>
          <div className="mc-dialog__footer">
            <Button variant="ghost" onClick={onClose}>
              {t("actions.cancel")}
            </Button>
            <Button variant="primary" disabled={phase === "starting"} onClick={() => void start()}>
              {phase === "starting" ? t("github.starting") : t("github.start")}
            </Button>
          </div>
        </>
      ) : null}

      {phase === "pending" && flow ? (
        <>
          <div className="mc-ghauth__codebox">
            <span className="mc-ghauth__codelabel">
              {t("github.codeLabel")}
              {autoCopied ? t("github.codeAutoCopied") : ""}
            </span>
            <div className="mc-ghauth__coderow">
              <code className="mc-ghauth__code">{flow.userCode}</code>
              <button
                type="button"
                className="mc-ghauth__copy"
                onClick={() => void copyCode(flow.userCode)}
                aria-label={t("github.copyCodeAria")}
              >
                {copied ? <LuCheck size={13} /> : <LuCopy size={13} />}
                {copied ? t("actions.copied") : t("actions.copy")}
              </button>
            </div>
          </div>
          <p className="mc-ghauth__wait">
            <LuLoaderCircle size={14} className="mc-ghauth__spin" />
            {t("github.waiting", { count: Math.ceil(flow.expiresIn / 60) })}
          </p>
          <div className="mc-dialog__footer">
            <Button variant="ghost" onClick={onClose}>
              {t("actions.cancel")}
            </Button>
            <Button
              variant="primary"
              icon={<LuExternalLink size={14} />}
              onClick={() => void window.meow.openExternal(flow.verificationUri)}
            >
              {t("github.openInBrowser")}
            </Button>
          </div>
        </>
      ) : null}

      {phase === "success" ? (
        <>
          <div className="mc-ghauth__success">
            <LuCheck size={16} />
            <span>{t("github.connected")}</span>
          </div>
          {warning ? <div className="mc-ghauth__warning">{warning}</div> : null}
          <div className="mc-dialog__footer">
            <Button variant="primary" onClick={onClose}>
              {t("actions.done")}
            </Button>
          </div>
        </>
      ) : null}

      {phase === "error" ? (
        <>
          <div className="mc-ghauth__error">
            <LuTriangleAlert size={15} />
            <span>{error}</span>
          </div>
          <div className="mc-dialog__footer">
            <Button variant="ghost" onClick={onClose}>
              {t("actions.cancel")}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setPhase("idle");
                setFlow(null);
              }}
            >
              {t("actions.retry")}
            </Button>
          </div>
        </>
      ) : null}
    </Dialog>
  );
}
