import { useEffect, useState } from "react";
import { LuChevronLeft } from "react-icons/lu";
import { Badge } from "../ui/Badge";
import { Toggle } from "../ui/Toggle";
import {
  fetchMarketplaceDetail,
  renderMarkdown,
  type MarketplaceDetail,
  type MarketplaceEntry,
  type PluginDescriptor,
} from "../../api";
import { MarketIcon } from "./MarketplaceCard";
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
  entry: MarketplaceEntry;
  iconUrl?: string;
  /** 已加载的插件 descriptor（已安装时才有，用于启停 Toggle） */
  descriptor: PluginDescriptor | undefined;
  busy: boolean;
  onBack: () => void;
  onInstall: (entry: MarketplaceEntry) => void;
  onToggle: (descriptor: PluginDescriptor, next: boolean) => void;
  onUninstall: (entry: MarketplaceEntry) => void;
}) {
  const [detail, setDetail] = useState<MarketplaceDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setLoadError(null);
    fetchMarketplaceDetail(entry.id, entry.type)
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

  return (
    <div className="mc-mkt__detailpage">
      <button type="button" className="mc-mkt__back" onClick={onBack}>
        <LuChevronLeft size={14} /> 返回市场
      </button>

      <header className="mc-mkt__dhead">
        <MarketIcon entry={entry} iconUrl={iconUrl} size={48} />
        <div className="mc-mkt__dheadinfo">
          <h2 className="mc-mkt__dtitle">{entry.name}</h2>
          <p className="mc-mkt__dmeta">
            {entry.category} · v{entry.version}
          </p>
        </div>
        <div className="mc-mkt__dactions">
          {installed && descriptor ? (
            <>
              {descriptor.error ? <Badge tone="danger">加载失败</Badge> : null}
              <Toggle
                checked={descriptor.enabled && !descriptor.error}
                disabled={busy}
                label={`启用插件 ${entry.id}`}
                onChange={(next) => onToggle(descriptor, next)}
              />
              <button
                type="button"
                className="mc-mkt__ghost"
                disabled={busy}
                onClick={() => onUninstall(entry)}
              >
                卸载
              </button>
            </>
          ) : (
            <button
              type="button"
              className="mc-mkt__install"
              disabled={busy}
              onClick={() => onInstall(entry)}
            >
              {busy ? "安装中…" : "＋ 安装"}
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
