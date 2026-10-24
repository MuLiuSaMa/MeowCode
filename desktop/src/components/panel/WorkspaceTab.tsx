import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  LuChevronRight,
  LuFile,
  LuFileCode,
  LuFilm,
  LuFolder,
  LuImage,
  LuMusic,
  LuSearch,
} from "react-icons/lu";
import { api } from "../../api";
import { FilePreview } from "./FilePreview";
import "./WorkspaceTab.css";

type DirEntry = { name: string; path: string; dir: boolean };

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "m4a", "flac"]);
const CODE_EXTS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "css",
  "html",
  "py",
  "rs",
  "go",
  "java",
  "c",
  "cpp",
  "h",
  "sh",
  "yml",
  "yaml",
  "toml",
  "md",
]);

/** 单层目录最多渲染的条目数（node_modules 这类超大目录给出提示） */
const MAX_ENTRIES_PER_DIR = 1_000;
/** 筛选模式的命中上限 */
const MAX_FILTER_RESULTS = 300;

/** 文件列表（右侧子栏）宽度约束与记忆 */
const FILE_TREE_MIN = 140;
const FILE_TREE_MAX = 480;

function clampTreeWidth(value: number): number {
  return Math.min(FILE_TREE_MAX, Math.max(FILE_TREE_MIN, value));
}

function extOf(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function baseNameOf(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}

function dirNameOf(filePath: string): string {
  const index = filePath.lastIndexOf("/");
  return index > 0 ? filePath.slice(0, index) : "";
}

/** 文件类型图标（图片给主题色，音视频紫色，其余中性色） */
function fileIcon(name: string) {
  const ext = extOf(name);
  if (IMAGE_EXTS.has(ext)) return <LuImage size={13} className="mc-wstree__icon" data-cat="image" />;
  if (VIDEO_EXTS.has(ext)) return <LuFilm size={13} className="mc-wstree__icon" data-cat="media" />;
  if (AUDIO_EXTS.has(ext)) return <LuMusic size={13} className="mc-wstree__icon" data-cat="media" />;
  if (CODE_EXTS.has(ext)) return <LuFileCode size={13} className="mc-wstree__icon" />;
  return <LuFile size={13} className="mc-wstree__icon" />;
}

/**
 * 文件页签：左侧预览 + 右侧目录树。
 * 目录**逐层懒加载**：初始只列工作区根一层，点文件夹才拉取该层并展开，不递归、不预展开、不自动展开。
 * 「筛选文件…」输入时走全量文件列表过滤（按需拉取一次），清空后回到逐层浏览。
 */
export function WorkspaceTab({
  file,
  workspace,
  onSelect,
}: {
  /** 当前预览的文件（工作区相对路径） */
  file?: string;
  workspace?: string;
  onSelect: (path: string) => void;
}) {
  /** 目录路径 → 直接子项（"" = 工作区根），逐层缓存 */
  const [childrenByDir, setChildrenByDir] = useState<Record<string, DirEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [failedDirs, setFailedDirs] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  /** 筛选模式用：全量文件列表（首次输入时才拉） */
  const [allFiles, setAllFiles] = useState<string[] | null>(null);
  /** 文件列表子栏宽度：可拖拽调节，localStorage 记忆 */
  const [treeWidth, setTreeWidth] = useState(() => {
    try {
      const saved = Number(window.localStorage.getItem("meowcode:fileTreeWidth"));
      if (Number.isFinite(saved) && saved > 0) return clampTreeWidth(saved);
    } catch {
      // 存储不可用
    }
    return 200;
  });
  const treeDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const startTreeResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    treeDragRef.current = { startX: event.clientX, startWidth: treeWidth };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 指针捕获失败不影响拖拽
    }
  };
  const moveTreeResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = treeDragRef.current;
    if (!drag) return;
    setTreeWidth(clampTreeWidth(drag.startWidth - (event.clientX - drag.startX)));
  };
  const endTreeResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!treeDragRef.current) return;
    treeDragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 已释放
    }
    setTreeWidth((current) => {
      try {
        window.localStorage.setItem("meowcode:fileTreeWidth", String(Math.round(current)));
      } catch {
        // 存储失败忽略
      }
      return current;
    });
  };

  const loadDir = async (dirPath: string) => {
    setLoading((current) => new Set(current).add(dirPath));
    try {
      const result = await api<{ entries: DirEntry[] }>(`/workspace/dir?path=${encodeURIComponent(dirPath)}`);
      setChildrenByDir((current) => ({ ...current, [dirPath]: result.entries }));
    } catch {
      setFailedDirs((current) => new Set(current).add(dirPath));
    } finally {
      setLoading((current) => {
        const next = new Set(current);
        next.delete(dirPath);
        return next;
      });
    }
  };

  // 工作区变化：重置并只加载根目录一层
  useEffect(() => {
    setChildrenByDir({});
    setExpanded(new Set());
    setFailedDirs(new Set());
    setLoading(new Set());
    setAllFiles(null);
    void loadDir("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  const toggleDir = (dirPath: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
        if (!(dirPath in childrenByDir)) void loadDir(dirPath);
      }
      return next;
    });
  };

  const needle = query.trim().toLowerCase();
  // 筛选模式：按需拉一次全量文件列表
  useEffect(() => {
    if (!needle || allFiles !== null) return;
    let disposed = false;
    void api<{ files: string[] }>("/workspace/files")
      .then((result) => {
        if (!disposed) setAllFiles(result.files);
      })
      .catch(() => {
        if (!disposed) setAllFiles([]);
      });
    return () => {
      disposed = true;
    };
  }, [needle, allFiles]);

  const filtered = useMemo(() => {
    if (!needle || !allFiles) return [];
    return allFiles.filter((item) => item.toLowerCase().includes(needle)).slice(0, MAX_FILTER_RESULTS);
  }, [needle, allFiles]);

  const renderDir = (dirPath: string, depth: number): ReactNode => {
    if (loading.has(dirPath) && !(dirPath in childrenByDir)) {
      return (
        <p className="mc-wstree__hint" style={{ paddingLeft: 8 + depth * 12 }}>
          加载中…
        </p>
      );
    }
    if (failedDirs.has(dirPath)) {
      return (
        <p className="mc-wstree__hint" style={{ paddingLeft: 8 + depth * 12 }}>
          读取失败
        </p>
      );
    }
    const entries = childrenByDir[dirPath];
    if (!entries) return null;
    const visible = entries.slice(0, MAX_ENTRIES_PER_DIR);
    return (
      <>
        {visible.map((entry) =>
          entry.dir ? (
            <div key={entry.path}>
              <button
                type="button"
                className="mc-wstree__row"
                data-dir="true"
                title={entry.path}
                style={{ paddingLeft: 8 + depth * 12 }}
                onClick={() => toggleDir(entry.path)}
              >
                <LuChevronRight
                  size={12}
                  className="mc-wstree__chevron"
                  data-open={expanded.has(entry.path)}
                />
                <LuFolder size={13} className="mc-wstree__icon" data-cat="dir" />
                <span className="mc-truncate">{entry.name}</span>
              </button>
              {expanded.has(entry.path) ? renderDir(entry.path, depth + 1) : null}
            </div>
          ) : (
            <button
              type="button"
              key={entry.path}
              className="mc-wstree__row"
              data-active={entry.path === file}
              title={entry.path}
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => onSelect(entry.path)}
            >
              <span className="mc-wstree__chevron" />
              {fileIcon(entry.name)}
              <span className="mc-truncate">{entry.name}</span>
            </button>
          ),
        )}
        {entries.length > MAX_ENTRIES_PER_DIR ? (
          <p className="mc-wstree__hint" style={{ paddingLeft: 8 + depth * 12 }}>
            …共 {entries.length} 项，仅显示前 {MAX_ENTRIES_PER_DIR}
          </p>
        ) : null}
      </>
    );
  };

  return (
    <div className="mc-wstree">
      <div className="mc-wstree__main">
        {file ? (
          <FilePreview path={file} workspace={workspace} />
        ) : (
          <p className="mc-wstree__empty">在右侧选择文件预览（文本 / 图片 / 视频 / 音频 / PDF）</p>
        )}
      </div>

      {/* 预览与文件列表之间的拖拽把手 */}
      <div
        className="mc-wstree__resize"
        role="separator"
        aria-label="调整文件列表宽度"
        onPointerDown={startTreeResize}
        onPointerMove={moveTreeResize}
        onPointerUp={endTreeResize}
      />

      <aside className="mc-wstree__side" style={{ width: treeWidth }}>
        <label className="mc-wstree__filter">
          <LuSearch size={13} />
          <input
            value={query}
            placeholder="筛选文件…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="mc-wstree__list">
          {needle ? (
            allFiles === null ? (
              <p className="mc-wstree__hint">搜索中…</p>
            ) : filtered.length === 0 ? (
              <p className="mc-wstree__hint">没有匹配的文件</p>
            ) : (
              filtered.map((item) => (
                <button
                  type="button"
                  key={item}
                  className="mc-wstree__row"
                  data-active={item === file}
                  title={item}
                  onClick={() => onSelect(item)}
                >
                  {fileIcon(baseNameOf(item))}
                  <span className="mc-wstree__name mc-truncate">{baseNameOf(item)}</span>
                  {dirNameOf(item) ? (
                    <span className="mc-wstree__dir mc-truncate">{dirNameOf(item)}</span>
                  ) : null}
                </button>
              ))
            )
          ) : (
            renderDir("", 0)
          )}
        </div>
      </aside>
    </div>
  );
}
