import { LuMessageSquare } from "react-icons/lu";
import type { MarketplaceEntry } from "../../api";
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
      {(entry.name || entry.id).charAt(0).toUpperCase()}
    </span>
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
}: {
  entry: MarketplaceEntry;
  iconUrl?: string;
  busy: boolean;
  onInstall: (entry: MarketplaceEntry) => void;
  onOpen: (entry: MarketplaceEntry) => void;
  onUse: (entry: MarketplaceEntry) => void;
}) {
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
          </div>
          <p className="mc-mkt__desc">{entry.description}</p>
        </div>
      </div>
      <div className="mc-mkt__cardbottom">
        <span className="mc-mkt__source">{entry.category}</span>
        {entry.type === "skill" ? (
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
              "准备中…"
            ) : (
              <>
                <LuMessageSquare size={13} /> 使用
              </>
            )}
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
            {busy ? "安装中…" : "＋ 安装"}
          </button>
        )}
      </div>
    </article>
  );
}
