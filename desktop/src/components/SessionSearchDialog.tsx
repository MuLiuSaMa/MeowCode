import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LuSearch } from "react-icons/lu";
import {
  searchSessions,
  type SessionSearchHit,
  type SessionSearchResult,
  type SessionSearchSnippet,
} from "../api";
import { splitHighlight } from "../search-highlight";
import { flattenHitRows } from "../session-search-rows";
import { baseName } from "../util";
import { formatSessionStamp } from "../i18n/format";
import { Dialog } from "./ui/Dialog";
import "./SessionSearchDialog.css";

const DEBOUNCE_MS = 160;
const MAX_RESULTS = 20;

/**
 * 会话全文检索（Ctrl+K / 聊天头搜索按钮）：跨全部历史会话搜 user/assistant 正文。
 * 纯本地索引匹配，零模型 token；Enter 跳到命中会话并定位到那句话。
 */
export function SessionSearchDialog({
  open,
  onClose,
  onOpen,
}: {
  open: boolean;
  onClose: () => void;
  onOpen: (hit: SessionSearchHit, snippet: SessionSearchSnippet | null) => void;
}) {
  const { t } = useTranslation("chat");
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SessionSearchResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  // 代际丢弃：慢请求返回时只采纳最新一代（api() 走 IPC，AbortSignal 不可克隆，不能用 AbortController）
  const seqRef = useRef(0);
  // IME 组字期间不触发搜索/跳转（中文输入法 Enter 上屏会误当确认）
  const composingRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setResult(null);
    setFailed(false);
    setIndex(0);
    seqRef.current += 1;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    seqRef.current += 1;
    const seq = seqRef.current;
    if (!trimmed) {
      setResult(null);
      setFailed(false);
      return;
    }
    const timer = setTimeout(() => {
      void searchSessions(trimmed, { limit: MAX_RESULTS })
        .then((payload) => {
          if (seqRef.current === seq) {
            setResult(payload);
            setFailed(false);
          }
        })
        .catch(() => {
          if (seqRef.current === seq) {
            setFailed(true);
            setResult(null);
          }
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, open]);

  const rows = useMemo(() => flattenHitRows(result?.hits ?? []), [result]);

  useEffect(() => {
    setIndex(0);
  }, [rows]);

  // 选中项滚动到可视区
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.children[index] as HTMLElement | undefined;
    active?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const pick = (row: (typeof rows)[number]) => {
    onClose();
    onOpen(row.hit, row.snippet);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((current) => Math.min(current + 1, Math.max(rows.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = rows[index];
      if (target) pick(target);
    }
  };

  const loading = open && query.trim() && result === null && !failed;

  return (
    <Dialog open={open} onClose={onClose} labelledBy="mc-sesssearch-title" className="mc-sesssearch">
      <span className="mc-dialog__title" id="mc-sesssearch-title">
        {t("conversation.searchTitle")}
      </span>

      <div className="mc-sesssearch__search">
        <LuSearch size={14} />
        <input
          autoFocus
          value={query}
          placeholder={t("conversation.searchPlaceholder")}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
        />
        {result && result.hits.length > 0 ? (
          <span className="mc-sesssearch__count">{t("conversation.searchHitCount", { count: result.hits.length })}</span>
        ) : null}
      </div>

      {failed ? (
        <p className="mc-sesssearch__empty">{t("conversation.searchFailed")}</p>
      ) : loading ? (
        <p className="mc-sesssearch__empty">{t("conversation.searchLoading")}</p>
      ) : rows.length === 0 ? (
        <p className="mc-sesssearch__empty">
          {query.trim() ? t("conversation.searchNoMatch") : t("conversation.searchEmpty")}
        </p>
      ) : (
        <ul className="mc-sesssearch__list" ref={listRef}>
          {rows.map((row, rowIndex) =>
            row.snippet === null ? (
              <li key={row.key}>
                <button
                  type="button"
                  className="mc-sesssearch__item mc-sesssearch__item--header"
                  data-active={rowIndex === index}
                  onMouseEnter={() => setIndex(rowIndex)}
                  onClick={() => pick(row)}
                >
                  <span className="mc-sesssearch__title mc-truncate">
                    {row.hit.title || t("conversation.untitled")}
                  </span>
                  <span className="mc-sesssearch__meta">
                    <span className="mc-sesssearch__project mc-truncate">{baseName(row.hit.cwd)}</span>
                    <span className="mc-sesssearch__time">{formatSessionStamp(new Date(row.hit.createdAt))}</span>
                  </span>
                </button>
              </li>
            ) : (
              <li key={row.key}>
                <button
                  type="button"
                  className="mc-sesssearch__item mc-sesssearch__item--snippet"
                  data-active={rowIndex === index}
                  onMouseEnter={() => setIndex(rowIndex)}
                  onClick={() => pick(row)}
                >
                  <span className={`mc-sesssearch__role mc-sesssearch__role--${row.snippet.role}`}>
                    {t(row.snippet.role === "user" ? "conversation.searchRoleUser" : "conversation.searchRoleAssistant")}
                  </span>
                  <span className="mc-sesssearch__snippet mc-truncate">
                    {row.snippet.prefix ? <span className="mc-sesssearch__ellipsis">…</span> : null}
                    {splitHighlight(row.snippet.text, row.snippet.ranges).map((segment, segmentIndex) =>
                      segment.hit ? (
                        <mark key={segmentIndex} className="mc-sesssearch__mark">
                          {segment.text}
                        </mark>
                      ) : (
                        <span key={segmentIndex}>{segment.text}</span>
                      ),
                    )}
                    {row.snippet.suffix ? <span className="mc-sesssearch__ellipsis">…</span> : null}
                  </span>
                </button>
              </li>
            ),
          )}
        </ul>
      )}

      <div className="mc-sesssearch__hint">
        {result?.truncated ? <span className="mc-sesssearch__truncated">{t("conversation.searchTruncated")}</span> : null}
        <span>{t("conversation.searchHint")}</span>
      </div>
    </Dialog>
  );
}
