import { useEffect, useMemo, useRef, useState } from "react";
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
import type { SessionSummary } from "../api";
import { groupSessionsByProject } from "../conversation-groups";
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
  workspace,
  archivedSessions,
  projectNames,
  pinnedProjects,
  removedProjects,
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
  onRemoveProject,
  onOpenProject,
}: {
  sessions: SessionSummary[];
  currentSessionId?: string;
  /** 正在生成回复的主会话 id（可多个，切走的会话仍在后台跑） */
  runningSessionIds?: string[];
  /** 正在等待工具审批的会话 id（可多个）；圆点改用警示色 */
  approvalSessionIds?: string[];
  workspace?: string;
  /** 归档的会话文件路径（settings.json），主列表里隐藏 */
  archivedSessions: string[];
  /** 项目（工作区）自定义显示名：cwd → name */
  projectNames: Record<string, string>;
  /** 置顶的项目 cwd（顺序即置顶顺序） */
  pinnedProjects: string[];
  /** 已移除（侧栏隐藏）的项目 cwd */
  removedProjects: string[];
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
  onRemoveProject: (cwd: string) => void;
  onOpenProject: (cwd: string) => void;
}) {
  const { t } = useTranslation("chat");
  /** 折叠的项目 cwd 集合：点了文件夹行收起该组聊天，再点展开 */
  const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<string>>(() => new Set());
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

  /** 折叠 / 展开某个项目分组 */
  const toggleCollapsed = (cwd: string) =>
    setCollapsedProjects((current) => {
      const next = new Set(current);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });

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
      }),
    [sessions, archivedSessions, workspace, removedProjects, pinnedProjects],
  );

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
      (approvalSessionIds ?? []).includes(session.id),
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
      </div>

      <div className="mc-convpanel__scroll">
        {groups.length === 0 ? (
          <p className="mc-convpanel__empty">{t("conversation.empty")}</p>
        ) : (
          <>
            <p className="mc-convpanel__section">{t("conversation.projects")}</p>
            {groups.map((group) => {
              const collapsedNow = collapsedProjects.has(group.cwd);
              const items = group.items;
              const pinned = pinnedProjects.includes(group.cwd);
              return (
                <div className="mc-convpanel__group" key={group.cwd}>
                  <div
                    className="mc-convpanel__grouprow"
                    data-active={group.cwd === workspace}
                    data-menu={menuFor === group.cwd}
                    onClick={(event) => {
                      // 只有点空白处才折叠；按钮（操作菜单 / 新建）和菜单本体不触发
                      if (menuFor === group.cwd) return;
                      if ((event.target as HTMLElement).closest("button")) return;
                      toggleCollapsed(group.cwd);
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
                      onClick={() => toggleCollapsed(group.cwd)}
                    >
                      <LuChevronDown size={13} className="mc-convpanel__chevron" />
                      <LuFolder size={14} className="mc-convpanel__folder" />
                      <span className="mc-truncate">{displayName(group.cwd)}</span>
                      {collapsedNow && group.items.length > 0 ? (
                        <span className="mc-convpanel__groupcount">{group.items.length}</span>
                      ) : null}
                    </button>
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

                    {menuFor === group.cwd ? (
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
                    <ul className="mc-convpanel__items">
                      {items.map((session) => {
                        const waitingApproval = (approvalSessionIds ?? []).includes(session.id);
                        const running = (runningSessionIds ?? []).includes(session.id) || waitingApproval;
                        return (
                          <li
                            key={session.filePath}
                            className="mc-convpanel__itemrow"
                            data-menu-open={sessionMenuFor === session.filePath ? "true" : undefined}
                            data-selecting={selected ? "true" : undefined}
                          >
                            <button
                              type="button"
                              className="mc-convpanel__item"
                              data-active={session.id === currentSessionId}
                              data-running={running}
                              data-selecting={selected ? "true" : undefined}
                              data-selected={selected?.has(session.filePath) ? "true" : undefined}
                              aria-pressed={selected ? selected.has(session.filePath) : undefined}
                              title={`${group.cwd}${
                                session.worktree ? ` · ${session.worktree.branch}` : ""
                              } · ${formatDateTime(new Date(session.createdAt))}`}
                              onClick={() => {
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
                              {running ? (
                                <span
                                  className="mc-convpanel__runningdot"
                                  data-approval={waitingApproval}
                                  role="status"
                                  aria-label={
                                    waitingApproval
                                      ? t("conversation.waitingApproval")
                                      : t("conversation.generating")
                                  }
                                  title={
                                    waitingApproval
                                      ? t("conversation.waitingApproval")
                                      : t("conversation.generating")
                                  }
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
                                {formatSessionStamp(new Date(session.createdAt))}
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
              );
            })}
          </>
        )}
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
