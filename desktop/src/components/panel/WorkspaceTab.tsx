import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  LuChevronRight,
  LuClipboardPaste,
  LuCopy,
  LuExternalLink,
  LuFile,
  LuFileCode,
  LuFilm,
  LuFolder,
  LuFolderOpen,
  LuImage,
  LuLink,
  LuMusic,
  LuSearch,
  LuTrash2,
} from "react-icons/lu";
import { api } from "../../api";
import { PluginSlot } from "../../plugins/PluginSlot";
import { usePluginSlot } from "../../plugins/runtime";
import { FilePreview } from "./FilePreview";
import { formatNumber } from "../../i18n/format";
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
const FILE_TREE_MIN = 150;
const FILE_TREE_MAX = 480;
/** 预览区最少要留出的宽度：面板不够时列表先让位，但列表自身不低于 FILE_TREE_MIN */
const PREVIEW_MIN_WIDTH = 200;

/** 按面板可用宽度收窄列表宽度（列表下限固定，宁可压预览也不把文字变图标） */
function clampTreeWidth(value: number, available?: number): number {
  const upper =
    available && available > 0
      ? Math.max(FILE_TREE_MIN, Math.min(FILE_TREE_MAX, available - PREVIEW_MIN_WIDTH))
      : FILE_TREE_MAX;
  return Math.min(Math.max(FILE_TREE_MIN, value), upper);
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

/** 工作区根 + 相对路径 → 系统绝对路径（分隔符跟随工作区根） */
function joinWorkspacePath(workspace: string, relative: string): string {
  const base = workspace.replace(/[\\/]+$/, "");
  const separator = base.includes("\\") ? "\\" : "/";
  return `${base}${separator}${relative.replace(/[\\/]+/g, separator)}`;
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
  const { t } = useTranslation("panel");
  const pluginMenuItems = usePluginSlot("fileTree.contextMenu");
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
  /** 容器实测宽度：窄面板时要保证预览区最小值，列表宽度随之让位 */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [available, setAvailable] = useState(0);
  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setAvailable(Math.round(width));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const sideWidth = clampTreeWidth(treeWidth, available);
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
    setTreeWidth(clampTreeWidth(drag.startWidth - (event.clientX - drag.startX), available));
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

  /** 右键菜单（portal 到 body + fixed 定位，避免被面板 overflow 裁剪）；entry=null 表示列表空白区域 */
  const [menu, setMenu] = useState<{ x: number; y: number; entry: DirEntry | null } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  /** 应用内文件剪贴板：「复制」后可在任意目录「粘贴」出一份副本 */
  const [clipboard, setClipboard] = useState<{ path: string; name: string } | null>(null);

  // 换工作区就清掉剪贴板，避免跨项目粘贴
  useEffect(() => {
    setClipboard(null);
  }, [workspace]);

  // 打开时按视口回夹，菜单不越出屏幕
  useLayoutEffect(() => {
    if (!menu) return;
    const node = menuRef.current;
    if (!node) return;
    const margin = 8;
    const maxLeft = window.innerWidth - node.offsetWidth - margin;
    const maxTop = window.innerHeight - node.offsetHeight - margin;
    node.style.left = `${Math.max(margin, Math.min(menu.x, maxLeft))}px`;
    node.style.top = `${Math.max(margin, Math.min(menu.y, maxTop))}px`;
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    const close = () => setMenu(null);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  const openMenu = (event: ReactMouseEvent, entry: DirEntry) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, entry });
  };

  /** 列表空白区域：只提供粘贴（目标 = 工作区根目录） */
  const openRootMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, entry: null });
  };

  const absolutePath = (relative: string): string | null =>
    workspace ? joinWorkspacePath(workspace, relative) : null;

  const runMenuAction = (action: () => void) => {
    setMenu(null);
    action();
  };

  const refreshDir = (dirPath: string) => {
    void loadDir(dirPath);
    setAllFiles(null);
  };

  const openEntry = (entry: DirEntry) => {
    const target = absolutePath(entry.path);
    if (target) void window.meow.openPath(target);
  };

  const revealEntry = (entry: DirEntry) => {
    const target = absolutePath(entry.path);
    if (target) void window.meow.showInFolder(target);
  };

  const copyEntryPath = (entry: DirEntry) => {
    const target = absolutePath(entry.path);
    if (target) void navigator.clipboard?.writeText(target).catch(() => undefined);
  };

  const pasteIntoDir = (dirPath: string) => {
    if (!clipboard) return;
    void window.meow
      .workspacePaste(clipboard.path, dirPath, t("workspace.menu.copySuffix"))
      .then((result) => {
        if (result.ok) refreshDir(dirPath);
      })
      .catch(() => undefined);
  };

  const pasteInto = (entry: DirEntry) => {
    pasteIntoDir(entry.path);
  };

  // const 局部变量：闭包里也能保住非空收窄
  const menuEntry = menu?.entry ?? null;

  const trashEntry = (entry: DirEntry) => {
    void window.meow
      .workspaceTrash(entry.path)
      .then((error) => {
        if (error) return;
        refreshDir(dirNameOf(entry.path));
        if (entry.path === file) onSelect("");
      })
      .catch(() => undefined);
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

  // 外部编辑器/终端改动：把已展开的目录重新拉一遍（300ms 合并事件风暴）
  useEffect(() => {
    let timer: number | null = null;
    const off = window.meow.onEvent((event) => {
      if ((event as { type?: string }).type !== "workspace_changed") return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        const dirs = Object.keys(childrenByDir);
        for (const dir of dirs.length ? dirs : [""]) void loadDir(dir);
        setAllFiles(null);
      }, 300);
    });
    return () => {
      off();
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [childrenByDir, workspace]);

  const toggleDir = (dirPath: string) => {    setExpanded((current) => {
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
        <p className="mc-wstree__hint" style={{ "--wstree-indent": `${8 + depth * 12}px` } as CSSProperties}>
          {t("workspace.loading")}
        </p>
      );
    }
    if (failedDirs.has(dirPath)) {
      return (
        <p className="mc-wstree__hint" style={{ "--wstree-indent": `${8 + depth * 12}px` } as CSSProperties}>
          {t("workspace.readFailed")}
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
                style={{ "--wstree-indent": `${8 + depth * 12}px` } as CSSProperties}
                onClick={() => toggleDir(entry.path)}
                onContextMenu={(event) => openMenu(event, entry)}
              >
                <LuChevronRight
                  size={12}
                  className="mc-wstree__chevron"
                  data-open={expanded.has(entry.path)}
                />
                <LuFolder size={13} className="mc-wstree__icon" data-cat="dir" />
                <span className="mc-wstree__name mc-truncate">{entry.name}</span>
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
              style={{ "--wstree-indent": `${8 + depth * 12}px` } as CSSProperties}
              onClick={() => onSelect(entry.path)}
              onContextMenu={(event) => openMenu(event, entry)}
            >
              <span className="mc-wstree__chevron" />
              {fileIcon(entry.name)}
              <span className="mc-wstree__name mc-truncate">{entry.name}</span>
            </button>
          ),
        )}
        {entries.length > MAX_ENTRIES_PER_DIR ? (
          <p className="mc-wstree__hint" style={{ "--wstree-indent": `${8 + depth * 12}px` } as CSSProperties}>
            {t("workspace.truncated", {
              total: formatNumber(entries.length),
              shown: formatNumber(MAX_ENTRIES_PER_DIR),
            })}
          </p>
        ) : null}
      </>
    );
  };

  return (
    <div className="mc-wstree" ref={rootRef}>
      <div className="mc-wstree__main">
        {file ? (
          <FilePreview path={file} workspace={workspace} />
        ) : (
          <p className="mc-wstree__empty">{t("workspace.selectFile")}</p>
        )}
      </div>

      {/* 预览与文件列表之间的拖拽把手 */}
      <div
        className="mc-wstree__resize"
        role="separator"
        aria-label={t("workspace.resizeAria")}
        onPointerDown={startTreeResize}
        onPointerMove={moveTreeResize}
        onPointerUp={endTreeResize}
      />

      <aside className="mc-wstree__side" style={{ width: sideWidth }}>
        <label className="mc-wstree__filter">
          <LuSearch size={13} />
          <input
            value={query}
            placeholder={t("workspace.filterPlaceholder")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="mc-wstree__list" onContextMenu={openRootMenu}>
          {needle ? (
            allFiles === null ? (
              <p className="mc-wstree__hint">{t("workspace.searching")}</p>
            ) : filtered.length === 0 ? (
              <p className="mc-wstree__hint">{t("workspace.noMatch")}</p>
            ) : (
              filtered.map((item) => (
                <button
                  type="button"
                  key={item}
                  className="mc-wstree__row"
                  data-active={item === file}
                  title={item}
                  onClick={() => onSelect(item)}
                  onContextMenu={(event) =>
                    openMenu(event, { name: baseNameOf(item), path: item, dir: false })
                  }
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

      {menu
        ? createPortal(
            <div
              className="mc-wstree__menu"
              role="menu"
              ref={menuRef}
              style={{ left: menu.x, top: menu.y }}
              onContextMenu={(event) => event.preventDefault()}
            >
              {menuEntry ? (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="mc-wstree__menuitem"
                    onClick={() => runMenuAction(() => openEntry(menuEntry))}
                  >
                    <LuExternalLink size={13} />
                    {t("workspace.menu.open")}
                  </button>
                  {menuEntry.dir ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="mc-wstree__menuitem"
                      disabled={!clipboard}
                      onClick={() => runMenuAction(() => pasteInto(menuEntry))}
                    >
                      <LuClipboardPaste size={13} />
                      {t("workspace.menu.paste")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      role="menuitem"
                      className="mc-wstree__menuitem"
                      onClick={() =>
                        runMenuAction(() =>
                          setClipboard({ path: menuEntry.path, name: menuEntry.name }),
                        )
                      }
                    >
                      <LuCopy size={13} />
                      {t("workspace.menu.copy")}
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    className="mc-wstree__menuitem"
                    onClick={() => runMenuAction(() => copyEntryPath(menuEntry))}
                  >
                    <LuLink size={13} />
                    {t("workspace.menu.copyPath")}
                  </button>
                  <div className="mc-wstree__menusep" />
                  <button
                    type="button"
                    role="menuitem"
                    className="mc-wstree__menuitem"
                    onClick={() => runMenuAction(() => revealEntry(menuEntry))}
                  >
                    <LuFolderOpen size={13} />
                    {t("workspace.menu.reveal")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="mc-wstree__menuitem"
                    data-danger="true"
                    onClick={() => runMenuAction(() => trashEntry(menuEntry))}
                  >
                    <LuTrash2 size={13} />
                    {t("workspace.menu.delete")}
                  </button>
                  {pluginMenuItems.length > 0 ? <div className="mc-wstree__menusep" /> : null}
                  <PluginSlot
                    name="fileTree.contextMenu"
                    props={{
                      target: {
                        kind: menuEntry.dir ? "folder" : "file",
                        path: menuEntry.path,
                        name: menuEntry.name,
                      },
                      closeMenu: () => setMenu(null),
                    }}
                  />
                </>
              ) : (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="mc-wstree__menuitem"
                    disabled={!clipboard}
                    onClick={() => runMenuAction(() => pasteIntoDir(""))}
                  >
                    <LuClipboardPaste size={13} />
                    {t("workspace.menu.paste")}
                  </button>
                  {pluginMenuItems.length > 0 ? <div className="mc-wstree__menusep" /> : null}
                  <PluginSlot
                    name="fileTree.contextMenu"
                    props={{
                      target: { kind: "root" },
                      closeMenu: () => setMenu(null),
                    }}
                  />
                </>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
