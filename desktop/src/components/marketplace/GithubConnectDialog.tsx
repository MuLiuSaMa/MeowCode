import { useEffect, useState } from "react";
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
        setError(result.message || "授权失败，请重试。");
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
  }, [open, phase, flow, intervalSec, onConnected]);

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
      setError("GitHub 登录模块尚未加载，请完全重启 MeowCode 后重试。");
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
        连接 GitHub
      </span>
      <p className="mc-dialog__desc">
        使用 GitHub OAuth 设备流授权 MeowCode。Token 会加密保存在本机，仅用于 GitHub MCP。
      </p>

      {phase === "idle" || phase === "starting" ? (
        <>
          <div className="mc-ghauth__hint">
            <p>授权前请确认 GitHub App 已完成：</p>
            <ul>
              <li>
                在{" "}
                <button
                  type="button"
                  className="mc-ghauth__link"
                  onClick={() => void window.meow.openExternal("https://github.com/settings/apps")}
                >
                  GitHub App 设置
                </button>{" "}
                中勾选 <code>Enable device flow</code>
              </li>
              <li>按需授予 Contents、Issues、Pull requests、Actions 等仓库权限</li>
            </ul>
          </div>
          <div className="mc-dialog__footer">
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" disabled={phase === "starting"} onClick={() => void start()}>
              {phase === "starting" ? "正在连接…" : "开始授权"}
            </Button>
          </div>
        </>
      ) : null}

      {phase === "pending" && flow ? (
        <>
          <div className="mc-ghauth__codebox">
            <span className="mc-ghauth__codelabel">
              在 GitHub 输入此代码{autoCopied ? "（已自动复制，直接粘贴即可）" : ""}
            </span>
            <div className="mc-ghauth__coderow">
              <code className="mc-ghauth__code">{flow.userCode}</code>
              <button
                type="button"
                className="mc-ghauth__copy"
                onClick={() => void copyCode(flow.userCode)}
                aria-label="复制设备码"
              >
                {copied ? <LuCheck size={13} /> : <LuCopy size={13} />}
                {copied ? "已复制" : "复制"}
              </button>
            </div>
          </div>
          <p className="mc-ghauth__wait">
            <LuLoaderCircle size={14} className="mc-ghauth__spin" />
            等待你在 GitHub 上授权…设备码 {Math.ceil(flow.expiresIn / 60)} 分钟内有效
          </p>
          <div className="mc-dialog__footer">
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button
              variant="primary"
              icon={<LuExternalLink size={14} />}
              onClick={() => void window.meow.openExternal(flow.verificationUri)}
            >
              在浏览器中打开
            </Button>
          </div>
        </>
      ) : null}

      {phase === "success" ? (
        <>
          <div className="mc-ghauth__success">
            <LuCheck size={16} />
            <span>GitHub 已连接，正在加载 GitHub MCP 工具。</span>
          </div>
          {warning ? <div className="mc-ghauth__warning">{warning}</div> : null}
          <div className="mc-dialog__footer">
            <Button variant="primary" onClick={onClose}>
              完成
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
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setPhase("idle");
                setFlow(null);
              }}
            >
              重试
            </Button>
          </div>
        </>
      ) : null}
    </Dialog>
  );
}
