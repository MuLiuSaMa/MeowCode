import { useMemo, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { LuCircleAlert } from "react-icons/lu";
import type { GitDiffResult } from "../../api";
import { parsePatch } from "../../git/patch";
import "./git.css";

/** 猫爪印：4 趾 + 肉垫，颜色跟随 currentColor。 */
function PawSvg() {
  return (
    <svg viewBox="0 0 64 64" fill="currentColor" aria-hidden="true">
      <ellipse cx="12.5" cy="23" rx="7.2" ry="9.6" transform="rotate(-16 12.5 23)" />
      <ellipse cx="25" cy="12.5" rx="7.2" ry="10" transform="rotate(-5 25 12.5)" />
      <ellipse cx="39" cy="12.5" rx="7.2" ry="10" transform="rotate(5 39 12.5)" />
      <ellipse cx="51.5" cy="23" rx="7.2" ry="9.6" transform="rotate(16 51.5 23)" />
      <path d="M32 32.5 C40.5 32.5 47.5 38 47.5 45 C47.5 51 43.5 55.5 38 55.5 C34.8 55.5 34.4 53.2 32 53.2 C29.6 53.2 29.2 55.5 26 55.5 C20.5 55.5 16.5 51 16.5 45 C16.5 38 23.5 32.5 32 32.5 Z" />
    </svg>
  );
}

/** diff 空状态：一串猫爪印从左到右依次浮现，走完淡出循环（节奏在 git.css）。 */
function PawWalk() {
  return (
    <div className="mc-git__pawwalk" aria-hidden="true">
      {Array.from({ length: 5 }, (_, index) => (
        <span key={index} className="mc-git__paw" style={{ "--i": index } as CSSProperties}>
          <PawSvg />
        </span>
      ))}
    </div>
  );
}

/** patch 渲染：双行号 + 着色 + 截断提示。数据由 useGitView 传入。 */
export function DiffView({
  diff,
  loading,
  emptyHint,
}: {
  diff: GitDiffResult | null;
  loading?: boolean;
  emptyHint?: string;
}) {
  const { t } = useTranslation("git");
  const parsed = useMemo(() => (diff?.patch ? parsePatch(diff.patch) : { rows: [], omitted: 0 }), [diff?.patch]);

  if (loading) return <div className="mc-git__placeholder">{t("diff.loading")}</div>;
  if (!diff)
    return (
      <div className="mc-git__placeholder mc-git__emptywalk">
        <PawWalk />
        <span>{emptyHint ?? t("diff.select")}</span>
      </div>
    );
  if (diff.binary) return <div className="mc-git__placeholder">{t("diff.binary")}</div>;
  if (!diff.patch.trim()) return <div className="mc-git__placeholder">{t("diff.empty")}</div>;

  return (
    <div className="mc-git__diff">
      <div className="mc-git__diffbar">
        {/* 提交详情里没有 numstat，两个数都是 0：这时不显示，免得看起来像"没有增删" */}
        {diff.added || diff.removed ? (
          <>
            <span className="mc-git__count" data-kind="add">
              +{diff.added}
            </span>
            <span className="mc-git__count" data-kind="del">
              −{diff.removed}
            </span>
          </>
        ) : null}
        {diff.truncated ? (
          <span className="mc-git__warn">
            <LuCircleAlert size={12} /> {t("diff.truncated")}
          </span>
        ) : null}
      </div>
      <pre className="mc-git__patch">
        {parsed.rows.map((row, index) => (
          <div key={index} className="mc-git__line" data-kind={row.kind}>
            <span className="mc-git__ln">{row.oldNo ?? ""}</span>
            <span className="mc-git__ln">{row.newNo ?? ""}</span>
            <span className="mc-git__code">{row.text || " "}</span>
          </div>
        ))}
        {parsed.omitted > 0 ? (
          <div className="mc-git__line" data-kind="meta">
            <span className="mc-git__ln" />
            <span className="mc-git__ln" />
            <span className="mc-git__code">... [{parsed.omitted} more lines not rendered]</span>
          </div>
        ) : null}
      </pre>
    </div>
  );
}
