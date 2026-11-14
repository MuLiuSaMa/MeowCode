import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuChevronLeft } from "react-icons/lu";
import { Badge } from "../ui/Badge";
import { Toggle } from "../ui/Toggle";
import {
  fetchMarketplaceDetail,
  renderMarkdown,
  type MarketplaceDetail,
  type MarketplaceEntryLike,
  type PluginDescriptor,
} from "../../api";
import { MarketIcon } from "./MarketplaceCard";
import { categoryLabelKey } from "./marketplace-categories";
import "./marketplace.css";

/**
 * 插件详情页（Trae 风格，占整个市场主体）：« 返回市场 + 大图标 + 名称 + meta +
 * 描述框 + 使用说明 markdown + 右上角启停/安装操作。
 */
export function PluginDetailPage({
  entry,
  iconUrl,
  descriptor,
  busy,
  onBack,
  onInstall,
  onToggle,
  onUninstall,
}: {
  entry: MarketplaceEntryLike;
  iconUrl?: string;
  /** 已加载的插件 descriptor（已安装时才有，用于启停 Toggle） */
  descriptor: PluginDescriptor | undefined;
  busy: boolean;
  onBack: () => void;
  onInstall: (entry: MarketplaceEntryLike) => void;
  onToggle: (descriptor: PluginDescriptor, next: boolean) => void;
  onUninstall: (entry: MarketplaceEntryLike) => void;
}) {
  const [detail, setDetail] = useState<MarketplaceDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { t } = useTranslation("marketplace");

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setLoadError(null);
    // 自建/内置插件是渲染层合成的条目，市场索引里没有详情可查
    if (entry.local) return;
    fetchMarketplaceDetail(entry.id, entry.type, entry.channel)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [entry]);

  const installed = entry.installed;
  const loadFailed = Boolean(descriptor?.error);
  // 分类是索引里的规范值：已知分类查词条，社区自定义分类原样显示
  const categoryKey = categoryLabelKey(entry.category);

  return (
    <div className="mc-mkt__detailpage">
      <button type="button" className="mc-mkt__back" onClick={onBack}>
        <LuChevronLeft size={14} /> {t("pluginPage.back")}
      </button>

      <header className="mc-mkt__dhead">
        <MarketIcon
          entry={entry}
          iconUrl={iconUrl ?? descriptor?.iconUrl}
          size={48}
        />
        <div className="mc-mkt__dheadinfo">
          <h2 className="mc-mkt__dtitle">{entry.name}</h2>
          <p className="mc-mkt__dmeta">
            {categoryKey ? t(categoryKey) : entry.category} · v{entry.version}
            {descriptor?.source === "builtin" ? ` · ${t("pluginPage.bundled")}` : ""}
          </p>
        </div>
        <div className="mc-mkt__dactions">
          {installed && descriptor ? (
            <>
              {descriptor.error ? <Badge tone="danger">{t("plugin.loadFailed")}</Badge> : null}
              <Toggle
                checked={descriptor.enabled && !descriptor.error}
                disabled={busy}
                label={t("plugin.enableAria", { id: entry.id })}
                onChange={(next) => onToggle(descriptor, next)}
              />
              {descriptor.source === "builtin" ? null : (
                <button
                  type="button"
                  className="mc-mkt__ghost"
                  disabled={busy}
                  onClick={() => onUninstall(entry)}
                >
                  {t("actions.uninstall")}
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              className="mc-mkt__install"
              disabled={busy}
              onClick={() => onInstall(entry)}
            >
              {busy ? t("actions.installing") : t("actions.install")}
            </button>
          )}
        </div>
      </header>

      <div className="mc-mkt__ddesc">{entry.description}</div>

      {loadError ? <p className="mc-mkt__error">{loadError}</p> : null}

      {detail?.detail ? (
        <div
          className="mc-mkt__dbody"
          // usage 来自本地 bundles 内置说明，经 DOMPurify 清洗
          dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.detail) }}
        />
      ) : null}
      {installed && loadFailed && descriptor?.error ? (
        <p className="mc-mkt__error">{descriptor.error}</p>
      ) : null}
    </div>
  );
}
