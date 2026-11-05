import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { LuCircleAlert, LuShrink, LuX } from "react-icons/lu";
import type { ContextUsage } from "../api";
import { formatNumber } from "../i18n/format";
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
  const { t } = useTranslation("shell");
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
        <Trans
          t={t}
          i18nKey="contextWarning.usage"
          values={{
            percent: formatNumber(percent),
            used: formatTokenCount(usage.usedTokens),
            window: formatTokenCount(contextWindow),
          }}
          components={{ b: <b /> }}
        />
        {streaming ? t("contextWarning.hintStreaming") : t("contextWarning.hint")}
      </span>
      <button
        type="button"
        className="mc-ctxwarn__compact"
        disabled={busy}
        onClick={() => void handleCompact()}
      >
        <LuShrink size={13} />
        {pending
          ? t("contextWarning.compacting")
          : streaming
            ? t("contextWarning.compactAfterTurn")
            : t("contextWarning.compactNow")}
      </button>
      <button
        type="button"
        className="mc-ctxwarn__dismiss"
        aria-label={t("contextWarning.dismissAria")}
        title={t("contextWarning.dismissTitle")}
        onClick={onDismiss}
      >
        <LuX size={13} />
      </button>
    </div>
  );
}
