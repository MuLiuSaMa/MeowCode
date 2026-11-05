import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuChevronRight, LuEllipsis, LuRotateCw } from "react-icons/lu";
import { api } from "../../api";
import "./ReviewTab.css";

type ReviewChange = {
  path: string;
  operation: "write_file" | "edit_file";
  changeCount: number;
  added: number;
  removed: number;
  timestamp: string;
  diff: string;
};

/** diff 行分类：着色用 */
function diffLineKind(line: string): "add" | "del" | "meta" | "ctx" {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") || line.startsWith("\\")) {
    return "meta";
  }
  if (line.startsWith("+ ")) return "add";
  if (line.startsWith("- ")) return "del";
  return "ctx";
}

function baseNameOf(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

function dirNameOf(filePath: string): string {
  const index = filePath.lastIndexOf("/");
  return index > 0 ? filePath.slice(0, index) : "";
}

/**
 * 审阅页签：本会话 Agent 改过的文件列表 + 内联 diff。
 * 数据源 GET /session/changes（持久化于会话 JSONL，重启仍可审阅）。
 */
export function ReviewTab({ sessionId }: { sessionId?: string }) {
  const { t } = useTranslation("panel");
  const [changes, setChanges] = useState<ReviewChange[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  /** 展开查看 diff 的文件 */
  const [expanded, setExpanded] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const result = await api<{ changes: ReviewChange[] }>("/session/changes");
      setChanges(result.changes);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    setExpanded(null);
    void reload();
    const unsubscribe = window.meow.onEvent((event) => {
      const relevant =
        event.type === "file_changed" || event.type === "turn_complete";
      if (!relevant) return;
      if (event.sessionId && sessionId && event.sessionId !== sessionId) return;
      void reload();
    });
    return unsubscribe;
  }, [reload, sessionId]);

  return (
    <div className="mc-review">
      <div className="mc-review__head">
        <span className="mc-review__count">
          {loading ? t("review.loading") : t("review.changedFiles", { count: changes.length })}
        </span>
        <button type="button" className="mc-review__refresh" aria-label={t("review.refresh")} title={t("review.refresh")} onClick={() => void reload()}>
          <LuRotateCw size={13} />
        </button>
      </div>

      {failed ? (
        <p className="mc-review__empty">{t("review.failed")}</p>
      ) : !loading && changes.length === 0 ? (
        <p className="mc-review__empty">{t("review.empty")}</p>
      ) : (
        <div className="mc-review__list">
          {changes.map((change) => {
            const open = expanded === change.path;
            return (
              <div className="mc-review__item" key={change.path} data-open={open}>
                <button
                  type="button"
                  className="mc-review__row"
                  onClick={() => setExpanded(open ? null : change.path)}
                >
                  <LuChevronRight size={13} className="mc-review__chevron" />
                  <span className="mc-review__name mc-truncate" title={change.path}>
                    {baseNameOf(change.path)}
                  </span>
                  {dirNameOf(change.path) ? (
                    <span className="mc-review__dir mc-truncate">{dirNameOf(change.path)}</span>
                  ) : null}
                  <span className="mc-review__stats">
                    {change.added > 0 ? <span className="mc-review__add">+{change.added}</span> : null}
                    {change.removed > 0 ? <span className="mc-review__del">-{change.removed}</span> : null}
                  </span>
                  {change.changeCount > 1 ? (
                    <span className="mc-review__badge" title={t("review.changeCount", { count: change.changeCount })}>
                      {change.changeCount}
                    </span>
                  ) : null}
                  <LuEllipsis size={13} className="mc-review__hint" />
                </button>

                {open ? (
                  <div className="mc-review__diff" role="region" aria-label={t("review.diffAria", { path: change.path })}>
                    {change.diff.split("\n").map((line, index) => (
                      <div className="mc-review__line" data-kind={diffLineKind(line)} key={index}>
                        {line || " "}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
