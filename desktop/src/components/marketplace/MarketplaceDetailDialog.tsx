import { useEffect, useState } from "react";
import { LuMessageSquare } from "react-icons/lu";
import { Dialog } from "../ui/Dialog";
import { fetchMarketplaceDetail, renderMarkdown, type MarketplaceDetail, type MarketplaceEntry } from "../../api";
import { MarketIcon } from "./MarketplaceCard";
import "./marketplace.css";

/**
 * 技能详情弹窗（Trae 风格）：大图标 + 名称 + 分类 + 描述框 + 正文 markdown
 * + 底部操作（使用=自动安装并跳转对话）。
 */
export function MarketplaceDetailDialog({
  entry,
  iconUrl,
  busy,
  onClose,
  onUse,
}: {
  entry: MarketplaceEntry | null;
  iconUrl?: string;
  busy: boolean;
  onClose: () => void;
  onUse: (entry: MarketplaceEntry) => void;
}) {
  const [detail, setDetail] = useState<MarketplaceDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!entry) {
      setDetail(null);
      setLoadError(null);
      return;
    }
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

  return (
    <Dialog open={entry !== null} onClose={onClose} className="mc-mkt__dialog">
      {entry ? (
        <div className="mc-mkt__dwrap">
          <button type="button" className="mc-mkt__dclose" aria-label="关闭" onClick={onClose}>
            ×
          </button>
          <header className="mc-mkt__dhead">
            <MarketIcon entry={entry} iconUrl={iconUrl} size={44} />
            <div>
              <h2 className="mc-mkt__dtitle" id="mc-mkt-detail-title">
                {entry.name}
              </h2>
              <p className="mc-mkt__dmeta">
                {entry.category}
                {entry.version !== "0.0.0" ? ` · v${entry.version}` : ""}
              </p>
            </div>
          </header>

          <div className="mc-mkt__ddesc">{entry.description}</div>

          {loadError ? <p className="mc-mkt__error">{loadError}</p> : null}

          {detail?.detail ? (
            <div
              className="mc-mkt__dbody"
              // 详情正文来自本地 bundles 内的 SKILL.md / 插件说明，经 DOMPurify 清洗
              dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.detail) }}
            />
          ) : !loadError && detail === null ? (
            <p className="mc-mkt__empty">加载详情中…</p>
          ) : null}

          <footer className="mc-mkt__dfoot">
            <button
              type="button"
              className="mc-mkt__install"
              disabled={busy}
              onClick={() => onUse(entry)}
            >
              {busy ? "准备中…" : <><LuMessageSquare size={13} /> 使用</>}
            </button>
          </footer>
        </div>
      ) : null}
    </Dialog>
  );
}
