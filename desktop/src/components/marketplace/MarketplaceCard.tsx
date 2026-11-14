import { LuMessageSquare } from "react-icons/lu";
import { useTranslation } from "react-i18next";
import { Badge } from "../ui/Badge";
import type { MarketplaceEntryLike } from "../../api";
import { categoryLabelKey } from "./marketplace-categories";
import "./marketplace.css";

/** 市场图标：有 dataUrl 用真图标，否则首字母色块兜底 */
export function MarketIcon({
  entry,
  iconUrl,
  size = 36,
}: {
  entry: { id: string; name: string; source: string };
  iconUrl?: string;
  size?: number;
}) {
  const SOURCE_COLORS: Record<string, string> = {
    trae: "#3b82f6",
    zcode: "#8b5cf6",
    dsh: "#10b981",
    codex: "#f59e0b",
    metis: "#ec4899",
    builtin: "#64748b",
    community: "#f97316",
    clawhub: "#0ea5e9",
    skillhub: "#22c55e",
  };
  if (iconUrl) {
    return (
      <img
        src={iconUrl}
        alt=""
        className="mc-mkt__iconimg"
        style={{ width: size, height: size }}
        loading="lazy"
      />
    );
  }
  return (
    <span
      className="mc-mkt__icon"
      style={{ background: SOURCE_COLORS[entry.source] ?? "#64748b", width: size, height: size }}
      aria-hidden="true"
    >
      {(Array.from(entry.name || entry.id)[0] ?? "?").toUpperCase()}
    </span>
  );
}

/** 社区/第三方条目徽标（卡片/行通用）；作者名与源名是标识符，不翻译 */
export function CommunityBadge({ entry }: { entry: MarketplaceEntryLike }) {
  const { t } = useTranslation("marketplace");
  if (entry.channel === "thirdparty") {
    return <Badge tone="running">{entry.upstream === "skillhub" ? "SkillHub" : "ClawHub"}</Badge>;
  }
  if (entry.channel !== "community") return null;
  return (
    <>
      <Badge tone="running">{t("channel.community")}</Badge>
      {entry.author ? (
        <span className="mc-mkt__author" title={t("card.authorTitle", { author: entry.author })}>
          @{entry.author}
        </span>
      ) : null}
    </>
  );
}

/** 市场卡片（技能/插件）：图标 + 名称 + 两行截断描述 + 安装按钮；点击打开详情 */
export function MarketplaceCard({
  entry,
  iconUrl,
  busy,
  onInstall,
  onOpen,
  onUse,
  onDelete,
  canDelete,
}: {
  entry: MarketplaceEntryLike;
  iconUrl?: string;
  busy: boolean;
  onInstall: (entry: MarketplaceEntryLike) => void;
  onOpen: (entry: MarketplaceEntryLike) => void;
  onUse: (entry: MarketplaceEntryLike) => void;
  /** 社区条目删除入口（自己的条目才可见） */
  onDelete?: (entry: MarketplaceEntryLike) => void;
  canDelete?: boolean;
}) {
  const { t } = useTranslation("marketplace");
  const updatable = Boolean(entry.updateAvailable);
  const categoryKey = categoryLabelKey(entry.category);
  return (
    <article
      className="mc-mkt__card mc-mkt__card--clickable"
      onClick={() => onOpen(entry)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen(entry);
      }}
    >
      <div className="mc-mkt__cardtop">
        <MarketIcon entry={entry} iconUrl={iconUrl} />
        <div className="mc-mkt__cardinfo">
          <div className="mc-mkt__name">
            <span className="mc-mkt__name-text" title={entry.name}>
              {entry.name}
            </span>
            <CommunityBadge entry={entry} />
          </div>
          <p className="mc-mkt__desc">{entry.description}</p>
        </div>
      </div>
      <div className="mc-mkt__cardbottom">
        <span className="mc-mkt__source">{categoryKey ? t(categoryKey) : entry.category}</span>
        <span className="mc-mkt__cardactions">
          {canDelete && onDelete ? (
            <button
              type="button"
              className="mc-mkt__ghost"
              title={t("card.deletePrTitle")}
              onClick={(event) => {
                event.stopPropagation();
                onDelete(entry);
              }}
            >
              {t("actions.delete")}
            </button>
          ) : null}
          {entry.type === "skill" && !updatable ? (
            <button
              type="button"
              className="mc-mkt__install"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                onUse(entry);
              }}
            >
              {busy ? (
                t("actions.preparing")
              ) : (
                <>
                  <LuMessageSquare size={13} /> {t("actions.use")}
                </>
              )}
            </button>
          ) : entry.installed && !updatable ? (
            <button
              type="button"
              className="mc-mkt__install"
              disabled
              title={t("card.installedTitle")}
            >
              {t("actions.installed")}
            </button>
          ) : (
            <button
              type="button"
              className="mc-mkt__install"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                onInstall(entry);
              }}
            >
              {busy
                ? t(updatable ? "actions.updating" : "actions.installing")
                : t(updatable ? "actions.update" : "actions.install")}
            </button>
          )}
        </span>
      </div>
    </article>
  );
}
