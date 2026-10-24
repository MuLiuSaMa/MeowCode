import { useEffect, useMemo, useRef, useState } from "react";
import { LuFileText, LuSearch } from "react-icons/lu";
import { api } from "../../api";
import { Dialog } from "../ui/Dialog";
import "./QuickOpenDialog.css";

/** 命中上限：结果列表只展示前 N 个 */
const MAX_RESULTS = 200;

function baseNameOf(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

function dirNameOf(filePath: string): string {
  const index = filePath.lastIndexOf("/");
  return index > 0 ? filePath.slice(0, index) : "";
}

/**
 * 快速打开（Ctrl+P）：列出工作区文件，子串过滤，文件名命中优先。
 * 选中后由调用方打开「文件查看」页签。
 */
export function QuickOpenDialog({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (path: string) => void;
}) {
  const [files, setFiles] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    setFailed(false);
    setFiles(null);
    let disposed = false;
    void api<{ files: string[] }>("/workspace/files")
      .then((result) => {
        if (!disposed) setFiles(result.files);
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
    };
  }, [open]);

  const results = useMemo(() => {
    if (!files) return [];
    const needle = query.trim().toLowerCase();
    const scored = files
      .map((file) => {
        if (!needle) return { file, score: 0 };
        const path = file.toLowerCase();
        const base = path.split("/").pop() ?? path;
        if (base.includes(needle)) return { file, score: 2 };
        if (path.includes(needle)) return { file, score: 1 };
        return { file, score: -1 };
      })
      .filter((item) => item.score >= 0);
    scored.sort(
      (a, b) => b.score - a.score || a.file.localeCompare(b.file, undefined, { sensitivity: "base" }),
    );
    return scored.slice(0, MAX_RESULTS).map((item) => item.file);
  }, [files, query]);

  useEffect(() => {
    setIndex(0);
  }, [query, files]);

  // 选中项滚动到可视区
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.children[index] as HTMLElement | undefined;
    active?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const pick = (path: string) => {
    onClose();
    onPick(path);
  };

  return (
    <Dialog open={open} onClose={onClose} labelledBy="mc-quickopen-title" className="mc-quickopen">
      <span className="mc-dialog__title" id="mc-quickopen-title">
        快速打开
      </span>

      <div className="mc-quickopen__search">
        <LuSearch size={14} />
        <input
          autoFocus
          value={query}
          placeholder="输入文件名或路径"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((current) => Math.min(current + 1, Math.max(results.length - 1, 0)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((current) => Math.max(current - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              const target = results[index];
              if (target) pick(target);
            }
          }}
        />
      </div>

      {failed ? (
        <p className="mc-quickopen__empty">文件列表读取失败，请重试</p>
      ) : files === null ? (
        <p className="mc-quickopen__empty">加载中…</p>
      ) : results.length === 0 ? (
        <p className="mc-quickopen__empty">{query.trim() ? "没有匹配的文件" : "工作区里没有文件"}</p>
      ) : (
        <ul className="mc-quickopen__list" ref={listRef}>
          {results.map((file, itemIndex) => (
            <li key={file}>
              <button
                type="button"
                className="mc-quickopen__item"
                data-active={itemIndex === index}
                onMouseEnter={() => setIndex(itemIndex)}
                onClick={() => pick(file)}
              >
                <LuFileText size={14} className="mc-quickopen__icon" />
                {dirNameOf(file) ? (
                  <span className="mc-quickopen__dir mc-truncate">{dirNameOf(file)}/</span>
                ) : null}
                <span className="mc-quickopen__name mc-truncate">{baseNameOf(file)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
