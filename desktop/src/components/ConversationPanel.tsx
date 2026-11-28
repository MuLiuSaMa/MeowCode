import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  LuArchive,
  LuChevronDown,
  LuEllipsis,
  LuFileDown,
  LuFolder,
  LuFolderOpen,
  LuGitBranch,
  LuListChecks,
  LuPin,
  LuPinOff,
  LuSquare,
  LuSquarePen,
  LuTrash2,
  LuX,
} from "react-icons/lu";
import type { SessionSummary, TurnStatus } from "../api";
import { PluginSlot } from "../plugins/PluginSlot";
import {
  PINNED_GROUP_ID,
  groupSessionsByProject,
  reorderConversationPaths,
} from "../conversation-groups";
import { formatDateTime, formatSessionStamp } from "../i18n/format";
import { baseName } from "../util";
import { Button } from "./ui/Button";
import { CheckboxBox } from "./ui/Checkbox";
import { Dialog } from "./ui/Dialog";
import "./ConversationPanel.css";

/** 右键/「…」菜单的近似尺寸（含停止运行与多选约 248）：用于把菜单夹在窗口内，实际高度由内容决定 */
const SESSION_MENU_WIDTH = 158;
const SESSION_MENU_ESTIMATED_HEIGHT = 248;

/** 项目「…」菜单的近似尺寸（5 项 + 3 分隔线） */
const PROJECT_MENU_WIDTH = 196;
const PROJECT_MENU_ESTIMATED_HEIGHT = 220;

type CardPointerDrag = {
  pointerId: number;
  filePath: string;
  cwd: string;
  list: HTMLElement;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
};

function clampSessionMenuPoint(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - SESSION_MENU_WIDTH - 8)),
    y: Math.max(8, Math.min(y, window.innerHeight - SESSION_MENU_ESTIMATED_HEIGHT - 8)),
  };
}

/** 编辑项目显示名（只改侧栏标签，不动磁盘目录） */
function RenameProjectDialog({
  cwd,
  initial,
  onCancel,
  onSave,
}: {
  /** null = 关闭 */
  cwd: string | null;
  initial: string;
  onCancel: () => void;
  onSave: (name: string) => void;
}) {
  const { t } = useTranslation("chat");
  const [value, setValue] = useState(initial);

  useEffect(() => {
    if (cwd) setValue(initial);
  }, [cwd, initial]);

  return (
    <Dialog open={Boolean(cwd)} onClose={onCancel} labelledBy="mc-rename-title">
      <span className="mc-dialog__title" id="mc-rename-title">
        {t("conversation.renameProject.title")}
      </span>
      <p className="mc-dialog__desc">{t("conversation.renameProject.description")}</p>
      <input
        className="mc-dialog__input"
        value={value}
        placeholder={cwd ? baseName(cwd) : ""}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onSave(value);
        }}
      />
      <div className="mc-dialog__footer">
        <Button variant="ghost" onClick={onCancel}>
          {t("dialog.cancel")}
        </Button>
        <Button variant="primary" onClick={() => onSave(value)}>
          {t("dialog.save")}
        </Button>
      </div>
    </Dialog>
  );
}

function RenameSessionDialog({
  target,
  onCancel,
  onSave,
}: {
  /** null = 关闭 */
  target: SessionSummary | null;
  onCancel: () => void;
  onSave: (title: string) => void;
}) {
  const { t } = useTranslation("chat");
  const [value, setValue] = useState(target?.title ?? "");

  useEffect(() => {
    setValue(target?.title ?? "");
  }, [target]);

  return (
    <Dialog open={Boolean(target)} onClose={onCancel} labelledBy="mc-rename-session-title">
      <span className="mc-dialog__title" id="mc-rename-session-title">
        {t("conversation.renameSession.title")}
      </span>
      <p className="mc-dialog__desc">{t("conversation.renameSession.description")}</p>
      <input
        className="mc-dialog__input"
        value={value}
        placeholder={t("conversation.renameSession.placeholder")}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && value.trim()) onSave(value.trim());
        }}
      />
      <div className="mc-dialog__footer">
        <Button variant="ghost" onClick={onCancel}>
          {t("dialog.cancel")}
        </Button>
        <Button variant="primary" disabled={!value.trim()} onClick={() => onSave(value.trim())}>
          {t("dialog.save")}
        </Button>
      </div>
    </Dialog>
  );
}

/** 会话「…」菜单改为 fixed 定位：优先向下，放不下再向上，并夹在视口内。 */
function sessionMenuAnchorFor(
  button: HTMLElement,
  running: boolean,
): { x: number; y: number; dir: "up" | "down" } {
  const rect = button.getBoundingClientRect();
  const height = SESSION_MENU_ESTIMATED_HEIGHT + (running ? 36 : 0);
  const below = rect.bottom + 4;
  const openDown = below + height <= window.innerHeight - 8;
  const point = clampSessionMenuPoint(
    rect.right - SESSION_MENU_WIDTH - 4,
    openDown ? below : rect.top - height - 4,
  );
  return { ...point, dir: openDown ? "down" : "up" };
}

export function ConversationPanel({
  sessions,
  currentSessionId,
  runningSessionIds,
  approvalSessionIds,
  askSessionIds,
  compactingSessionIds,
  turnStatuses,
  workspace,
  archivedSessions,
  projectNames,
  pinnedProjects,
  pinnedConversations,
  conversationOrder,
  removedProjects,
  collapsedProjects,
  onToggleCollapsedProject,
  onNewChat,
  onNewChatInProject,
  onSwitchSession,
  onRenameSession,
  onDeleteSession,
  onBranchSession,
  onStopSession,
  onArchiveSession,
  onExportSession,
  onArchiveSessions,
  onDeleteSessions,
  onArchiveProject,
  onRenameProject,
  onTogglePinProject,
  onTogglePinConversation,
  onReorderConversations,
  onRemoveProject,
  onOpenProject,
}: {
  sessions: SessionSummary[];
  currentSessionId?: string;
  /** 正在生成回复的主会话 id（可多个，切走的会话仍在后台跑） */
  runningSessionIds?: string[];
  /** 正在等待工具审批的会话 id（可多个）；圆点改用警示色 */
  approvalSessionIds?: string[];
  /** 正在等待用户回答的会话 id（可多个） */
  askSessionIds?: string[];
  /** 正在压缩历史的会话 id（可多个） */
  compactingSessionIds?: string[];
  /** 各会话最近一次回合结果 */
  turnStatuses?: Record<string, TurnStatus>;
  workspace?: string;
  /** 归档的会话文件路径（settings.json），主列表里隐藏 */
  archivedSessions: string[];
  /** 项目（工作区）自定义显示名：cwd → name */
  projectNames: Record<string, string>;
  /** 置顶的项目 cwd（顺序即置顶顺序） */
  pinnedProjects: string[];
  /** 置顶对话的 filePath 列表（顺序即置顶顺序，新置顶的排最前） */
  pinnedConversations: string[];
  /** 项目内手动拖拽后的会话顺序 */
  conversationOrder: Record<string, string[]>;
  /** 已移除（侧栏隐藏）的项目 cwd */
  removedProjects: string[];
  /** 已折叠的项目 cwd */
  collapsedProjects: ReadonlySet<string>;
  onToggleCollapsedProject: (cwd: string) => void;
  onNewChat: () => void;
  /** 在指定项目里新开对话（当前项目直接新建，其他项目先切工作区） */
  onNewChatInProject: (cwd: string) => void;
  onSwitchSession: (filePath: string) => void;
  onRenameSession: (filePath: string, title: string) => void;
  onDeleteSession: (filePath: string) => void;
  onBranchSession: (filePath: string) => void;
  /** 停止运行中的会话（含后台并行会话与等待审批的会话） */
  onStopSession: (sessionId: string) => void;
  onArchiveSession: (filePath: string) => void;
  /** 导出会话为 Markdown / HTML / JSON 文件 */
  onExportSession: (filePath: string, title: string | null) => void;
  /** 多选后批量归档：一次写入 preferences，避免逐条覆盖 */
  onArchiveSessions: (filePaths: string[]) => void;
  /** 多选后批量删除会话文件（运行中的会被服务端拒绝，单个失败不影响其余） */
  onDeleteSessions: (filePaths: string[]) => void;
  onArchiveProject: (filePaths: string[]) => void;
  onRenameProject: (cwd: string, name: string) => void;
  onTogglePinProject: (cwd: string) => void;
  onTogglePinConversation: (filePath: string) => void;
  onReorderConversations: (cwd: string, filePaths: string[]) => void;
  onRemoveProject: (cwd: string) => void;
  onOpenProject: (cwd: string) => void;
}) {
  const { t } = useTranslation("chat");
  /** 菜单展开的项目 cwd */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** 项目菜单锚点：fixed 定位到「…」按钮下方并夹在窗口内，避免被面板滚动区裁切 */
  const [projectMenuAnchor, setProjectMenuAnchor] = useState<{ x: number; y: number } | null>(
    null,
  );
  /** 正在重命名的项目 cwd；null = 对话框关闭 */
  const [editing, setEditing] = useState<string | null>(null);
  /** 展开会话操作菜单的 filePath */
  const [sessionMenuFor, setSessionMenuFor] = useState<string | null>(null);
  /** 右键菜单坐标：非空时菜单改为 fixed 跟随鼠标；普通「…」菜单为 null */
  const [sessionMenuAnchor, setSessionMenuAnchor] = useState<{ x: number; y: number } | null>(
    null,
  );
  /** 会话菜单展开方向：靠近顶部时向下，避免被文件夹行裁切 */
  const [sessionMenuDir, setSessionMenuDir] = useState<"up" | "down">("up");
  const [renamingSession, setRenamingSession] = useState<SessionSummary | null>(null);
  const [deletingSession, setDeletingSession] = useState<SessionSummary | null>(null);
  /** 多选模式：null = 未进入；Set = 已勾选的 filePath（只在本次侧栏会话内有效，不落盘） */
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(null);
  /** 批量删除确认弹窗 */
  const [deletingSelected, setDeletingSelected] = useState(false);
  const [dragging, setDragging] = useState<{ filePath: string; cwd: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    filePath: string;
    position: "before" | "after";
  } | null>(null);
  const dropTargetRef = useRef<{ filePath: string; position: "before" | "after" } | null>(
    null,
  );
  const pointerDragRef = useRef<CardPointerDrag | null>(null);
  /** Chromium 拖拽后不会刷新 :hover，改由指针位置显式驱动行高亮 */
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);
  const dropPointRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (dragging) return;
    const point = dropPointRef.current;
    if (!point) return;
    dropPointRef.current = null;
    const row = document
      .elementFromPoint(point.x, point.y)
      ?.closest<HTMLElement>(".mc-convpanel__itemrow");
    setHoveredPath(row?.dataset.filePath ?? null);
  }, [dragging]);
  /** 拖拽重排的 FLIP 快照：松手前记录旧位置，提交后把卡片从旧位置滑到新位置 */
  const flipPendingRef = useRef<{
    list: HTMLElement;
    tops: Map<string, number>;
    draggedPath: string;
  } | null>(null);
  const flipAnimationsRef = useRef<Animation[]>([]);
  useLayoutEffect(() => {
    const pending = flipPendingRef.current;
    if (!pending) return;
    flipPendingRef.current = null;
    for (const animation of flipAnimationsRef.current) animation.cancel();
    flipAnimationsRef.current = [];
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const styles = getComputedStyle(pending.list);
    const duration = Number.parseFloat(styles.getPropertyValue("--dur")) || 160;
    const easing =
      styles.getPropertyValue("--ease").trim() || "cubic-bezier(0.2, 0, 0.2, 1)";
    const animations: Animation[] = [];
    pending.list.querySelectorAll<HTMLElement>(".mc-convpanel__itemrow").forEach((row) => {
      const path = row.dataset.filePath;
      if (!path || path === pending.draggedPath) return;
      const first = pending.tops.get(path);
      if (first === undefined) return;
      const delta = first - row.offsetTop;
      if (Math.abs(delta) < 1) return;
      animations.push(
        row.animate(
          [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }],
          { duration, easing },
        ),
      );
    });
    flipAnimationsRef.current = animations;
  });
  useEffect(() => {
    if (!dragging) return;
    document.body.classList.add("mc-convpanel-dragging");
    return () => document.body.classList.remove("mc-convpanel-dragging");
  }, [dragging]);

  const suppressItemClickRef = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const sessionMenuRef = useRef<HTMLDivElement>(null);

  // 点菜单外部 / Esc 关闭（与权限菜单同款处理）
  useEffect(() => {
    if (!menuFor) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      setMenuFor(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuFor(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuFor]);

  const setCardDropTarget = (
    next: { filePath: string; position: "before" | "after" } | null,
  ) => {
    const current = dropTargetRef.current;
    if (current?.filePath === next?.filePath && current?.position === next?.position) return;
    dropTargetRef.current = next;
    setDropTarget(next);
  };

  const updateCardDropTarget = (drag: CardPointerDrag) => {
    const listRect = drag.list.getBoundingClientRect();
    if (
      drag.x < listRect.left ||
      drag.x > listRect.right ||
      drag.y < listRect.top ||
      drag.y > listRect.bottom
    ) {
      setCardDropTarget(null);
      return;
    }
    const rows = Array.from(
      drag.list.querySelectorAll<HTMLElement>(".mc-convpanel__itemrow"),
    ).filter((row) => row.dataset.filePath && row.dataset.filePath !== drag.filePath);
    let next: { filePath: string; position: "before" | "after" } | null = null;
    for (const row of rows) {
      const filePath = row.dataset.filePath;
      if (!filePath) continue;
      const rect = row.getBoundingClientRect();
      if (drag.y < rect.top + rect.height / 2) {
        next = { filePath, position: "before" };
        break;
      }
      next = { filePath, position: "after" };
    }
    setCardDropTarget(next);
  };

  const startCardPointerDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    filePath: string,
    cwd: string,
  ) => {
    if (selected || event.button !== 0 || pointerDragRef.current) return;
    const list = event.currentTarget.closest<HTMLElement>(".mc-convpanel__items");
    if (!list) return;
    pointerDragRef.current = {
      pointerId: event.pointerId,
      filePath,
      cwd,
      list,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      active: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveCardPointerDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
      drag.active = true;
      for (const animation of flipAnimationsRef.current) animation.cancel();
      flipAnimationsRef.current = [];
      setHoveredPath(null);
      setDragging({ filePath: drag.filePath, cwd: drag.cwd });
    }
    event.preventDefault();
    updateCardDropTarget(drag);
  };

  const finishCardPointerDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    pointerDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag.active) {
      setCardDropTarget(null);
      return;
    }
    event.preventDefault();
    const target = dropTargetRef.current;
    setCardDropTarget(null);
    setDragging(null);
    setHoveredPath(null);
    dropPointRef.current = { x: event.clientX, y: event.clientY };
    suppressItemClickRef.current = true;
    window.setTimeout(() => {
      suppressItemClickRef.current = false;
    }, 0);
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest(".mc-convpanel__item")) {
      active.blur();
    }
    if (!target) return;
    const rows = Array.from(
      drag.list.querySelectorAll<HTMLElement>(".mc-convpanel__itemrow"),
    );
    const tops = new Map<string, number>();
    const current: string[] = [];
    for (const row of rows) {
      const filePath = row.dataset.filePath;
      if (!filePath) continue;
      tops.set(filePath, row.offsetTop);
      current.push(filePath);
    }
    flipPendingRef.current = { list: drag.list, tops, draggedPath: drag.filePath };
    const next = reorderConversationPaths(
      current,
      drag.filePath,
      target.filePath,
      target.position,
    );
    if (next.some((filePath, index) => filePath !== current[index])) {
      onReorderConversations(drag.cwd, next);
    }
  };

  const cancelCardPointerDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    pointerDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.active) {
      suppressItemClickRef.current = true;
      window.setTimeout(() => {
        suppressItemClickRef.current = false;
      }, 0);
    }
    setCardDropTarget(null);
    setDragging(null);
    setHoveredPath(null);
  };

  // 会话行菜单：点外部 / Esc 关闭；点菜单按钮本身交给 onClick 切换，避免先关后开
  useEffect(() => {
    if (!sessionMenuFor) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (sessionMenuRef.current?.contains(target)) return;
      if (target.closest?.(".mc-convpanel__rowbtn")) return;
      setSessionMenuFor(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSessionMenuFor(null);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [sessionMenuFor]);

  // 会话菜单用 fixed 定位：列表滚动或窗口缩放后不再跟随行，直接关闭
  useEffect(() => {
    if (!sessionMenuFor || !sessionMenuAnchor) return;
    const onScroll = (event: Event) => {
      if (sessionMenuRef.current?.contains(event.target as Node)) return;
      setSessionMenuFor(null);
    };
    const onResize = () => setSessionMenuFor(null);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [sessionMenuFor, sessionMenuAnchor]);

  // 菜单关闭后清掉右键坐标，下次「…」菜单回到行内定位
  useEffect(() => {
    if (!sessionMenuFor) setSessionMenuAnchor(null);
  }, [sessionMenuFor]);

  // 多选模式：Esc 退出（弹窗开着时把 Esc 让给弹窗自己处理）
  useEffect(() => {
    if (!selected || renamingSession || deletingSession || deletingSelected) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selected, renamingSession, deletingSession, deletingSelected]);

  // 项目菜单改 fixed 定位后：面板滚动或窗口缩放时直接关闭，避免悬空错位
  useEffect(() => {
    if (!menuFor || !projectMenuAnchor) return;
    const onScroll = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenuFor(null);
    };
    const onResize = () => setMenuFor(null);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [menuFor, projectMenuAnchor]);

  useEffect(() => {
    if (!menuFor) setProjectMenuAnchor(null);
  }, [menuFor]);

  const displayName = (cwd: string) => projectNames[cwd]?.trim() || baseName(cwd);

  // 按工作区（cwd）分组，对应参考图里的「项目」；当前工作区永远在列（可能是「暂无聊天」）。
  // 空会话（没发过消息）不进列表，发过消息才显示。排序规则见 conversation-groups.ts。
  const groups = useMemo(
    () =>
      groupSessionsByProject({
        sessions,
        workspace,
        archivedSessions,
        removedProjects,
        pinnedProjects,
        pinnedConversations,
        conversationOrder,
      }),
    [
      sessions,
      archivedSessions,
      workspace,
      removedProjects,
      pinnedProjects,
      pinnedConversations,
      conversationOrder,
    ],
  );

  // 「置顶」伪分组永远排在第一位（conversation-groups.ts 保证）；「项目」标题插在它之后
  const pinnedGroup = groups.find((group) => group.cwd === PINNED_GROUP_ID) ?? null;

  // 多选：以列表里**当前可见**的会话为准 —— 归档/删除后勾选自动收敛，不会误操作已消失的条目
  const selectableItems = groups.flatMap((group) => group.items);
  const selectedItems = selected
    ? selectableItems.filter((session) => selected.has(session.filePath))
    : [];
  const selectedAll =
    selectableItems.length > 0 && selectedItems.length === selectableItems.length;
  /** 选中项里有正在生成 / 等待审批的会话：删除不安全（服务端会拒绝），按钮直接禁用 */
  const selectedRunning = selectedItems.some(
    (session) =>
      (runningSessionIds ?? []).includes(session.id) ||
      (approvalSessionIds ?? []).includes(session.id) ||
      (askSessionIds ?? []).includes(session.id) ||
      (compactingSessionIds ?? []).includes(session.id),
  );

  const toggleSelected = (filePath: string) =>
    setSelected((current) => {
      if (!current) return current;
      const next = new Set(current);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });

  const toggleSelectAll = () =>
    setSelected((current) => {
      if (!current) return current;
      if (selectedAll) return new Set<string>();
      return new Set(selectableItems.map((session) => session.filePath));
    });

  return (
    <section className="mc-panel mc-panel--conversations mc-convpanel">
      <div className="mc-convpanel__top">
        {selected ? (
          // 多选操作条：顶掉「新聊天」，选完即退出，不留在侧栏
          <div className="mc-convpanel__selectbar">
            <span className="mc-convpanel__selectcount">
              {t("conversation.selectedCount", { count: selectedItems.length })}
            </span>
            <button type="button" className="mc-convpanel__selectall" onClick={toggleSelectAll}>
              {selectedAll ? t("conversation.selectNone") : t("conversation.selectAll")}
            </button>
            <button
              type="button"
              className="mc-convpanel__groupbtn"
              disabled={selectedItems.length === 0}
              aria-label={t("conversation.archive")}
              title={t("conversation.archive")}
              onClick={() => {
                if (!selectedItems.length) return;
                onArchiveSessions(selectedItems.map((session) => session.filePath));
                setSelected(null);
              }}
            >
              <LuArchive size={15} />
            </button>
            <button
              type="button"
              className="mc-convpanel__groupbtn mc-convpanel__groupbtn--danger"
              disabled={selectedItems.length === 0 || selectedRunning}
              aria-label={t("dialog.delete")}
              title={selectedRunning ? t("conversation.deleteBlocked") : t("dialog.delete")}
              onClick={() => setDeletingSelected(true)}
            >
              <LuTrash2 size={15} />
            </button>
            <button
              type="button"
              className="mc-convpanel__groupbtn"
              aria-label={t("conversation.exitSelection")}
              title={t("conversation.exitSelection")}
              onClick={() => setSelected(null)}
            >
              <LuX size={15} />
            </button>
          </div>
        ) : (
          <button type="button" className="mc-convpanel__new" onClick={onNewChat}>
            <LuSquarePen size={14} />
            <span>{t("conversation.newChat")}</span>
          </button>
        )}
        <div className="mc-convpanel__pluginactions">
          <PluginSlot name="conversations.header.actions" props={{}} />
        </div>
      </div>

      <div className="mc-convpanel__scroll">
        {groups.length === 0 ? (
          <p className="mc-convpanel__empty">{t("conversation.empty")}</p>
        ) : (
          <>
            {groups.map((group, groupIndex) => {
              const isPinnedZone = group.cwd === PINNED_GROUP_ID;
              const collapsedNow = collapsedProjects.has(group.cwd);
              const items = group.items;
              const pinned = pinnedProjects.includes(group.cwd);
              return (
                <Fragment key={group.cwd}>
                  {/* 「项目」标题插在第一个项目分组之前，让「置顶」栏浮在所有项目之上 */}
                  {groupIndex === (pinnedGroup ? 1 : 0) ? (
                    <p className="mc-convpanel__section">{t("conversation.projects")}</p>
                  ) : null}
                <div className="mc-convpanel__group">
                  <div
                    className="mc-convpanel__grouprow"
                    data-active={group.cwd === workspace}
                    data-menu={menuFor === group.cwd}
                    data-pinned={isPinnedZone ? "true" : undefined}
                    onClick={(event) => {
                      // 只有点空白处才折叠；按钮（操作菜单 / 新建）和菜单本体不触发
                      if (menuFor === group.cwd) return;
                      if ((event.target as HTMLElement).closest("button")) return;
                      onToggleCollapsedProject(group.cwd);
                    }}
                  >
                    <button
                      type="button"
                      className="mc-convpanel__groupname"
                      data-collapsed={collapsedNow}
                      aria-expanded={!collapsedNow}
                      title={
                        collapsedNow ? t("conversation.expandProject") : t("conversation.collapseProject")
                      }
                      onClick={() => onToggleCollapsedProject(group.cwd)}
                    >
                      <LuChevronDown size={13} className="mc-convpanel__chevron" />
                      {isPinnedZone ? (
                        <LuPin size={14} className="mc-convpanel__folder" />
                      ) : (
                        <LuFolder size={14} className="mc-convpanel__folder" />
                      )}
                      <span className="mc-truncate">
                        {isPinnedZone ? t("conversation.pinned") : displayName(group.cwd)}
                      </span>
                      {collapsedNow && group.items.length > 0 ? (
                        <span className="mc-convpanel__groupcount">{group.items.length}</span>
                      ) : null}
                    </button>
                    {isPinnedZone ? null : (
                    <span className="mc-convpanel__groupactions">
                      <button
                        type="button"
                        className="mc-convpanel__groupbtn"
                        aria-label={t("conversation.projectActions")}
                        title={t("conversation.moreActions")}
                        onClick={(event) => {
                          if (menuFor === group.cwd) {
                            setMenuFor(null);
                            return;
                          }
                          const rect = event.currentTarget.getBoundingClientRect();
                          setProjectMenuAnchor({
                            x: Math.max(8, rect.right - PROJECT_MENU_WIDTH - 4),
                            y: Math.min(
                              rect.bottom + 6,
                              window.innerHeight - PROJECT_MENU_ESTIMATED_HEIGHT - 8,
                            ),
                          });
                          setMenuFor(group.cwd);
                        }}
                      >
                        <LuEllipsis size={15} />
                      </button>
                      <button
                        type="button"
                        className="mc-convpanel__groupbtn"
                        aria-label={t("conversation.newChatInProject")}
                        title={t("conversation.newChatInProject")}
                        onClick={() => onNewChatInProject(group.cwd)}
                      >
                        <LuSquarePen size={13} />
                      </button>
                    </span>
                    )}

                    {!isPinnedZone && menuFor === group.cwd ? (
                      <div
                        className="mc-convpanel__menu"
                        data-context={projectMenuAnchor ? "true" : undefined}
                        ref={menuRef}
                        role="menu"
                        aria-label={t("conversation.projectActions")}
                        style={
                          projectMenuAnchor
                            ? {
                                left: projectMenuAnchor.x,
                                top: projectMenuAnchor.y,
                                right: "auto",
                                bottom: "auto",
                              }
                            : undefined
                        }
                      >
                        <button
                          type="button"
                          role="menuitem"
                          className="mc-convpanel__menuitem"
                          onClick={() => {
                            onTogglePinProject(group.cwd);
                            setMenuFor(null);
                          }}
                        >
                          {pinned ? <LuPinOff size={14} /> : <LuPin size={14} />}
                          {pinned ? t("conversation.unpin") : t("conversation.pin")}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="mc-convpanel__menuitem"
                          onClick={() => {
                            setEditing(group.cwd);
                            setMenuFor(null);
                          }}
                        >
                          <LuSquarePen size={14} />
                          {t("conversation.edit")}
                        </button>
                        <div className="mc-convpanel__menusep" />
                        <button
                          type="button"
                          role="menuitem"
                          className="mc-convpanel__menuitem"
                          onClick={() => {
                            onOpenProject(group.cwd);
                            setMenuFor(null);
                          }}
                        >
                          <LuFolderOpen size={14} />
                          {t("conversation.revealInExplorer")}
                        </button>
                        <div className="mc-convpanel__menusep" />
                        <button
                          type="button"
                          role="menuitem"
                          className="mc-convpanel__menuitem"
                          disabled={group.items.length === 0}
                          onClick={() => {
                            onArchiveProject(group.items.map((session) => session.filePath));
                            setMenuFor(null);
                          }}
                        >
                          <LuArchive size={14} />
                          {t("conversation.archiveChats")}
                        </button>
                        <div className="mc-convpanel__menusep" />
                        <button
                          type="button"
                          role="menuitem"
                          className="mc-convpanel__menuitem"
                          onClick={() => {
                            onRemoveProject(group.cwd);
                            setMenuFor(null);
                          }}
                        >
                          <LuX size={14} />
                          {t("conversation.removeProject")}
                        </button>
                      </div>
                    ) : null}
                  </div>

                  {items.length === 0 ? (
                    <p className="mc-convpanel__nochats">{t("conversation.noChats")}</p>
                  ) : (
                    <div className="mc-convpanel__collapse" data-open={!collapsedNow} aria-hidden={collapsedNow} inert={collapsedNow ? true : undefined}>
                    <div className="mc-convpanel__collapse-inner">
                    <ul
                      className="mc-convpanel__items"
                      onPointerMove={(event) => {
                        if (dragging || pointerDragRef.current?.active) return;
                        const row =
                          event.target instanceof Element
                            ? event.target.closest<HTMLElement>(".mc-convpanel__itemrow")
                            : null;
                        const path = row?.dataset.filePath ?? null;
                        setHoveredPath((current) => (current === path ? current : path));
                      }}
                      onPointerLeave={() => setHoveredPath(null)}
                    >
                      {items.map((session) => {
                        const waitingApproval = (approvalSessionIds ?? []).includes(session.id);
                        const waitingAnswer = (askSessionIds ?? []).includes(session.id);
                        const compactingNow = (compactingSessionIds ?? []).includes(session.id);
                        const running =
                          (runningSessionIds ?? []).includes(session.id) ||
                          waitingApproval ||
                          waitingAnswer ||
                          compactingNow;
                        const terminalStatus = turnStatuses?.[session.id];
                        const status = waitingApproval
                          ? "approval"
                          : waitingAnswer
                            ? "ask"
                            : compactingNow
                              ? "compacting"
                              : (runningSessionIds ?? []).includes(session.id)
                                ? "running"
                                : terminalStatus;
                        const terminalLabel = terminalStatus
                          ? terminalStatus === "completed"
                            ? t("panel:runStatus.completed")
                            : terminalStatus === "aborted"
                              ? t("panel:runStatus.aborted")
                              : terminalStatus === "interrupted"
                                ? t("panel:runStatus.interrupted")
                                : t("panel:runStatus.failed")
                          : null;
                        const statusLabel = waitingApproval
                          ? t("conversation.waitingApproval")
                          : waitingAnswer
                            ? t("status.waitingAnswer")
                            : compactingNow
                              ? t("status.compacting")
                              : (runningSessionIds ?? []).includes(session.id)
                                ? t("conversation.generating")
                                : terminalLabel;
                        const activeAt = session.updatedAt ?? session.createdAt;
                        // 置顶伪分组没有真实 cwd：tooltip 退回会话自身的工作区
                        const rowCwd = isPinnedZone
                          ? (session.worktree?.sourceCwd ?? session.cwd)
                          : group.cwd;
                        const isPinnedConversation = pinnedConversations.includes(session.filePath);
                        return (
                          <li
                            key={session.filePath}
                            className="mc-convpanel__itemrow"
                            data-file-path={session.filePath}
                            data-hover={hoveredPath === session.filePath ? "true" : undefined}
                            data-menu-open={sessionMenuFor === session.filePath ? "true" : undefined}
                            data-selecting={selected ? "true" : undefined}
                            data-dragging={dragging?.filePath === session.filePath ? "true" : undefined}
                            data-drop={
                              dropTarget?.filePath === session.filePath ? dropTarget.position : undefined
                            }
                          >
                            <button
                              type="button"
                              className="mc-convpanel__item"
                              onPointerDown={(event) => {
                                // 置顶栏不支持拖拽重排：顺序由置顶先后决定
                                if (isPinnedZone) return;
                                startCardPointerDrag(event, session.filePath, group.cwd);
                              }}
                              onPointerMove={moveCardPointerDrag}
                              onPointerUp={finishCardPointerDrag}
                              onPointerCancel={cancelCardPointerDrag}
                              onLostPointerCapture={cancelCardPointerDrag}
                              data-active={session.id === currentSessionId}
                              data-running={running}
                              data-selecting={selected ? "true" : undefined}
                              data-selected={selected?.has(session.filePath) ? "true" : undefined}
                              aria-pressed={selected ? selected.has(session.filePath) : undefined}
                              title={
                                hoveredPath === session.filePath
                                  ? `${rowCwd}${
                                      session.worktree ? ` · ${session.worktree.branch}` : ""
                                    } · ${formatDateTime(new Date(activeAt))}`
                                  : undefined
                              }
                              onClick={() => {
                                if (suppressItemClickRef.current) {
                                  suppressItemClickRef.current = false;
                                  return;
                                }
                                // 多选模式下点行 = 勾选 / 取消，不切会话
                                if (selected) {
                                  toggleSelected(session.filePath);
                                  return;
                                }
                                onSwitchSession(session.filePath);
                              }}
                              onContextMenu={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                if (selected) return;
                                setMenuFor(null);
                                setSessionMenuAnchor(
                                  clampSessionMenuPoint(event.clientX, event.clientY),
                                );
                                setSessionMenuFor(session.filePath);
                              }}
                            >
                              {selected ? (
                                <CheckboxBox
                                  className="mc-convpanel__check"
                                  checked={selected.has(session.filePath)}
                                />
                              ) : null}
                              {status ? (
                                <span
                                  className="mc-convpanel__statusdot"
                                  data-state={status}
                                  role="status"
                                  aria-label={statusLabel ?? undefined}
                                  title={statusLabel ?? undefined}
                                />
                              ) : null}
                              <span className="mc-convpanel__itemtitle">
                                {/* AI 标题优先；还没生成就显示「新对话」，日期放在悬停提示里 */}
                                {session.title || t("conversation.untitled")}
                              </span>
                              {session.worktree ? (
                                <span
                                  className="mc-convpanel__branch"
                                  title={session.worktree.branch}
                                >
                                  <LuGitBranch size={11} />
                                  <span>{session.worktree.branch.replace(/^meowcode\//, "")}</span>
                                </span>
                              ) : null}
                              <span className="mc-convpanel__itemtime">
                                {formatSessionStamp(new Date(activeAt))}
                              </span>
                            </button>
                            <button
                              type="button"
                              className="mc-convpanel__rowbtn"
                              aria-label={t("conversation.sessionActions")}
                              aria-haspopup="menu"
                              aria-expanded={sessionMenuFor === session.filePath}
                              title={t("conversation.sessionActions")}
                              style={
                                sessionMenuFor === session.filePath
                                  ? { opacity: 1, transition: "none" }
                                  : undefined
                              }
                              onClick={(event) => {
                                if (sessionMenuFor === session.filePath) {
                                  setSessionMenuFor(null);
                                  return;
                                }
                                const anchor = sessionMenuAnchorFor(
                                  event.currentTarget,
                                  running,
                                );
                                setSessionMenuAnchor({ x: anchor.x, y: anchor.y });
                                setSessionMenuDir(anchor.dir);
                                setSessionMenuFor(session.filePath);
                              }}
                            >
                              <LuEllipsis size={15} />
                            </button>
                            {sessionMenuFor === session.filePath ? (
                              <div
                                className="mc-convpanel__menu mc-convpanel__sessionmenu"
                                data-dir={sessionMenuDir}
                                data-context={sessionMenuAnchor ? "true" : undefined}
                                ref={sessionMenuRef}
                                role="menu"
                                aria-label={t("conversation.sessionActions")}
                                style={
                                  sessionMenuAnchor
                                    ? {
                                        left: sessionMenuAnchor.x,
                                        top: sessionMenuAnchor.y,
                                        right: "auto",
                                        bottom: "auto",
                                      }
                                    : undefined
                                }
                              >
                                {running ? (
                                  <>
                                    <button
                                      type="button"
                                      role="menuitem"
                                      className="mc-convpanel__menuitem"
                                      onClick={() => {
                                        onStopSession(session.id);
                                        setSessionMenuFor(null);
                                      }}
                                    >
                                      <LuSquare size={14} />
                                      {t("conversation.stopRunning")}
                                    </button>
                                    <div className="mc-convpanel__menusep" />
                                  </>
                                ) : null}
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="mc-convpanel__menuitem"
                                  onClick={() => {
                                    onTogglePinConversation(session.filePath);
                                    setSessionMenuFor(null);
                                  }}
                                >
                                  {isPinnedConversation ? (
                                    <LuPinOff size={14} />
                                  ) : (
                                    <LuPin size={14} />
                                  )}
                                  {isPinnedConversation
                                    ? t("conversation.unpin")
                                    : t("conversation.pin")}
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="mc-convpanel__menuitem"
                                  onClick={() => {
                                    setRenamingSession(session);
                                    setSessionMenuFor(null);
                                  }}
                                >
                                  <LuSquarePen size={14} />
                                  {t("conversation.rename")}
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="mc-convpanel__menuitem"
                                  onClick={() => {
                                    onBranchSession(session.filePath);
                                    setSessionMenuFor(null);
                                  }}
                                >
                                  <LuGitBranch size={14} />
                                  {t("conversation.createBranch")}
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="mc-convpanel__menuitem"
                                  onClick={() => {
                                    onArchiveSession(session.filePath);
                                    setSessionMenuFor(null);
                                  }}
                                >
                                  <LuArchive size={14} />
                                  {t("conversation.archive")}
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="mc-convpanel__menuitem"
                                  onClick={() => {
                                    onExportSession(session.filePath, session.title);
                                    setSessionMenuFor(null);
                                  }}
                                >
                                  <LuFileDown size={14} />
                                  {t("conversation.export")}
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="mc-convpanel__menuitem"
                                  onClick={() => {
                                    setMenuFor(null);
                                    setSessionMenuFor(null);
                                    setSelected(new Set([session.filePath]));
                                  }}
                                >
                                  <LuListChecks size={14} />
                                  {t("conversation.multiSelect")}
                                </button>
                                <div className="mc-convpanel__menusep" />
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="mc-convpanel__menuitem mc-convpanel__menuitem--danger"
                                  disabled={running}
                                  title={running ? t("conversation.deleteBlocked") : undefined}
                                  onClick={() => {
                                    setDeletingSession(session);
                                    setSessionMenuFor(null);
                                  }}
                                >
                                  <LuTrash2 size={14} />
                                  {t("dialog.delete")}
                                </button>
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                    </div>
                    </div>
                  )}
                </div>
                </Fragment>
              );
            })}
          </>
        )}
      </div>

      <div className="mc-convpanel__pluginfoot">
        <PluginSlot name="conversations.footer" props={{}} />
      </div>

      <RenameProjectDialog
        cwd={editing}
        initial={editing ? projectNames[editing] ?? "" : ""}
        onCancel={() => setEditing(null)}
        onSave={(name) => {
          if (editing) onRenameProject(editing, name);
          setEditing(null);
        }}
      />

      <RenameSessionDialog
        target={renamingSession}
        onCancel={() => setRenamingSession(null)}
        onSave={(title) => {
          if (renamingSession) onRenameSession(renamingSession.filePath, title);
          setRenamingSession(null);
        }}
      />

      <Dialog
        open={Boolean(deletingSession)}
        onClose={() => setDeletingSession(null)}
        labelledBy="mc-delete-session-title"
      >
        <span className="mc-dialog__title" id="mc-delete-session-title">
          {t("conversation.deleteSession.title")}
        </span>
        <p className="mc-dialog__desc">
          {t("conversation.deleteSession.description", {
            name: deletingSession?.title || t("conversation.untitled"),
          })}
        </p>
        <div className="mc-dialog__footer">
          <Button variant="ghost" onClick={() => setDeletingSession(null)}>
            {t("dialog.cancel")}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (deletingSession) onDeleteSession(deletingSession.filePath);
              setDeletingSession(null);
            }}
          >
            {t("dialog.delete")}
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={deletingSelected}
        onClose={() => setDeletingSelected(false)}
        labelledBy="mc-delete-selected-title"
      >
        <span className="mc-dialog__title" id="mc-delete-selected-title">
          {t("conversation.deleteSelected.title")}
        </span>
        <p className="mc-dialog__desc">
          {t("conversation.deleteSelected.description", { count: selectedItems.length })}
        </p>
        <div className="mc-dialog__footer">
          <Button variant="ghost" onClick={() => setDeletingSelected(false)}>
            {t("dialog.cancel")}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              onDeleteSessions(selectedItems.map((session) => session.filePath));
              setDeletingSelected(false);
              setSelected(null);
            }}
          >
            {t("dialog.delete")}
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
