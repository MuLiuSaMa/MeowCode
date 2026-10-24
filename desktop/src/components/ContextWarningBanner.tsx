import { useState } from "react";
import { LuCircleAlert, LuShrink, LuX } from "react-icons/lu";
import type { ContextUsage } from "../api";
import { formatTokenCount } from "./ContextMeter";
import "./ContextWarningBanner.css";

/**
 * 上下文接近窗口上限时的提示条：
 * 只提示用户手动压缩；真正溢出仍由服务端自动压缩。
 */
export function ContextWarningBanner({
  usage,
  streaming,
  compacting,
  dismissed,
  onCompact,
  onDismiss,
}: {
  usage: ContextUsage | null;
  streaming: boolean;
  compacting: boolean;
  dismissed: boolean;
  onCompact: () => Promise<void>;
  onDismiss: () => void;
}) {
  const [pending, setPending] = useState(false);
  if (dismissed || compacting || !usage?.recommendedCompaction || !usage.contextWindow) {
    return null;
  }

  const contextWindow = usage.contextWindow;
  const percent = Math.round((usage.usedTokens / contextWindow) * 100);
  const busy = streaming || pending;

  const handleCompact = async () => {
    setPending(true);
    try {
      await onCompact();
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mc-ctxwarn" role="status">
      <span className="mc-ctxwarn__icon">
        <LuCircleAlert size={14} />
      </span>
      <span className="mc-ctxwarn__text">
        上下文已用 <b>{percent}%</b>（{formatTokenCount(usage.usedTokens)} /{" "}
        {formatTokenCount(contextWindow)}）。
        {streaming
          ? "本轮结束后可手动压缩，避免下一次请求溢出后自动压缩。"
          : "建议手动压缩，避免下一次请求溢出后自动压缩。"}
      </span>
      <button
        type="button"
        className="mc-ctxwarn__compact"
        disabled={busy}
        onClick={() => void handleCompact()}
      >
        <LuShrink size={13} />
        {pending ? "正在压缩…" : streaming ? "本轮结束后可压缩" : "立即压缩"}
      </button>
      <button
        type="button"
        className="mc-ctxwarn__dismiss"
        aria-label="忽略压缩提示"
        title="本次不再提示"
        onClick={onDismiss}
      >
        <LuX size={13} />
      </button>
    </div>
  );
}
