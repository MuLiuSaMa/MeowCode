import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuCheck, LuClock, LuCopy, LuFileText, LuGitBranch } from "react-icons/lu";
import { renderMarkdown, type TurnUsageTotals } from "../api";
import { formatDateTime, formatDuration, formatNumber } from "../i18n/format";
import "./TurnInfoBar.css";

/** Markdown → 纯文本：交给渲染管线出 HTML，再取文本节点，避免自己写正则。 */
function markdownToText(markdown: string): string {
  const template = document.createElement("template");
  template.innerHTML = renderMarkdown(markdown);
  return (template.content.textContent ?? "").trim();
}

/**
 * 每一轮回复末尾的操作行：复制为 Markdown / 复制为纯文本 / 创建新分支，
 * 右侧是对话结束时间；悬停时间显示「耗时 / 使用 Token」小卡片。
 */
export function TurnInfoBar({
  durationMs,
  endedAt,
  usage,
  markdown,
  onBranch,
}: {
  durationMs: number;
  endedAt?: string;
  usage?: TurnUsageTotals;
  /** 本轮 assistant 正文（Markdown 原文），复制用 */
  markdown: string;
  onBranch?: () => void;
}) {
  const { t } = useTranslation("chat");
  const [copied, setCopied] = useState<"markdown" | "text" | null>(null);
  const copiedTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const copy = async (kind: "markdown" | "text") => {
    const text = kind === "markdown" ? markdown : markdownToText(markdown);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(null), 1_500);
    } catch {
      // 剪贴板不可用（权限/安全上下文）：保持原样，不打断阅读
    }
  };

  const time = endedAt ? formatDateTime(new Date(endedAt)) : "";
  // 纯工具/被中止的回合没有 assistant 正文：复制按钮置灰，避免看起来可点却静默无响应
  const hasCopyText = markdown.trim().length > 0;
  const copyTitle = (key: "turnFooter.copyMarkdown" | "turnFooter.copyPlain") =>
    hasCopyText ? t(key) : t("turnFooter.copyEmpty");

  return (
    <div className="mc-turninfo">
      <div className="mc-turninfo__actions">
        <button
          type="button"
          className="mc-turninfo__action"
          disabled={!hasCopyText}
          title={copyTitle("turnFooter.copyMarkdown")}
          aria-label={copyTitle("turnFooter.copyMarkdown")}
          onClick={() => void copy("markdown")}
        >
          {copied === "markdown" ? <LuCheck size={14} /> : <LuCopy size={14} />}
        </button>
        <button
          type="button"
          className="mc-turninfo__action"
          disabled={!hasCopyText}
          title={copyTitle("turnFooter.copyPlain")}
          aria-label={copyTitle("turnFooter.copyPlain")}
          onClick={() => void copy("text")}
        >
          {copied === "text" ? <LuCheck size={14} /> : <LuFileText size={14} />}
        </button>
        {onBranch ? (
          <button
            type="button"
            className="mc-turninfo__action"
            title={t("turnFooter.branch")}
            aria-label={t("turnFooter.branch")}
            onClick={onBranch}
          >
            <LuGitBranch size={14} />
          </button>
        ) : null}
      </div>
      {time ? (
        <span className="mc-turninfo__timewrap" tabIndex={0} aria-label={t("turnFooter.time")}>
          <LuClock size={12} className="mc-turninfo__icon" aria-hidden="true" />
          <span className="mc-turninfo__time">{time}</span>
          <span className="mc-turninfo__card" role="tooltip">
            <span className="mc-turninfo__row">
              <span>{t("turnFooter.duration")}</span>
              <span>{formatDuration(durationMs)}</span>
            </span>
            <span className="mc-turninfo__row">
              <span>{t("turnFooter.tokens")}</span>
              <span>{usage ? formatNumber(usage.totalTokens) : "—"}</span>
            </span>
          </span>
        </span>
      ) : null}
    </div>
  );
}