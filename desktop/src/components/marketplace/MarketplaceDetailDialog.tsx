import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuMessageSquare } from "react-icons/lu";
import { Dialog } from "../ui/Dialog";
import { fetchMarketplaceDetail, renderMarkdown, type MarketplaceDetail, type MarketplaceEntryLike } from "../../api";
import { MarketIcon, CommunityBadge } from "./MarketplaceCard";
import { categoryLabelKey } from "./marketplace-categories";
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
  entry: MarketplaceEntryLike | null;
  iconUrl?: string;
  busy: boolean;
  onClose: () => void;
  onUse: (entry: MarketplaceEntryLike) => void;
}) {
  const [detail, setDetail] = useState<MarketplaceDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { t } = useTranslation("marketplace");

  useEffect(() => {
    if (!entry) {
      setDetail(null);
      setLoadError(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setLoadError(null);
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

  return (
    <Dialog open={entry !== null} onClose={onClose} className="mc-mkt__dialog">
      {entry ? (
        <div className="mc-mkt__dwrap">
          <button
            type="button"
            className="mc-mkt__dclose"
            aria-label={t("actions.close")}
            onClick={onClose}
          >
            ×
          </button>
          <header className="mc-mkt__dhead">
            <MarketIcon entry={entry} iconUrl={iconUrl} size={44} />
            <div>
              <h2 className="mc-mkt__dtitle" id="mc-mkt-detail-title">
                {entry.name}
                <CommunityBadge entry={entry} />
              </h2>
              <p className="mc-mkt__dmeta">
                {(() => {
                  // 分类是索引里的规范值：已知分类查词条，社区自定义分类原样显示
                  const key = categoryLabelKey(entry.category);
                  return key ? t(key) : entry.category;
                })()}
                {entry.version !== "0.0.0" ? ` · v${entry.version}` : ""}
                {entry.channel === "community" && entry.author ? ` · @${entry.author}` : ""}
                {entry.channel === "community" && entry.homepage
                  ? ` · ${t("detail.communityListed")}`
                  : ""}
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
            <p className="mc-mkt__empty">{t("detail.loading")}</p>
          ) : null}

          <footer className="mc-mkt__dfoot">
            <button
              type="button"
              className="mc-mkt__install"
              disabled={busy}
              onClick={() => onUse(entry)}
            >
              {busy ? t("actions.preparing") : <><LuMessageSquare size={13} /> {t("actions.use")}</>}
            </button>
          </footer>
        </div>
      ) : null}
    </Dialog>
  );
}
