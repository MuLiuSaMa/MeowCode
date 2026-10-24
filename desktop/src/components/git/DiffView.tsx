import { useMemo } from "react";
import { LuCircleAlert } from "react-icons/lu";
import type { GitDiffResult } from "../../api";
import { parsePatch } from "../../git/patch";
import "./git.css";

/** patch 渲染：双行号 + 着色 + 截断提示。数据由 useGitView 传入。 */
export function DiffView({
  diff,
  loading,
  emptyHint = "选择一个文件查看改动",
}: {
  diff: GitDiffResult | null;
  loading?: boolean;
  emptyHint?: string;
}) {
  const parsed = useMemo(() => (diff?.patch ? parsePatch(diff.patch) : { rows: [], omitted: 0 }), [diff?.patch]);

  if (loading) return <div className="mc-git__placeholder">正在读取 diff…</div>;
  if (!diff) return <div className="mc-git__placeholder">{emptyHint}</div>;
  if (diff.binary) return <div className="mc-git__placeholder">二进制文件，不展示内容</div>;
  if (!diff.patch.trim()) return <div className="mc-git__placeholder">没有可显示的改动</div>;

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
            <LuCircleAlert size={12} /> 补丁过大，已截断
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
