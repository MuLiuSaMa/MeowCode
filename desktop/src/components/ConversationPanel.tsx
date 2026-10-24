import { useEffect, useMemo, useRef, useState } from "react";
import {
  LuArchive,
  LuChevronDown,
  LuEllipsis,
  LuFolder,
  LuFolderOpen,
  LuGitBranch,
  LuPin,
  LuPinOff,
  LuSquare,
  LuSquarePen,
  LuTrash2,
  LuX,
} from "react-icons/lu";
import type { SessionSummary } from "../api";
import { baseName } from "../util";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import "./ConversationPanel.css";

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
  const [value, setValue] = useState(initial);

  useEffect(() => {
    if (cwd) setValue(initial);
  }, [cwd, initial]);

  return (
    <Dialog open={Boolean(cwd)} onClose={onCancel} labelledBy="mc-rename-title">
      <span className="mc-dialog__title" id="mc-rename-title">
        编辑工作区名称
      </span>
      <p className="mc-dialog__desc">
        只改侧栏显示名称，不会改动磁盘上的文件夹（留空恢复为文件夹名）。
      </p>
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
          取消
        </Button>
        <Button variant="primary" onClick={() => onSave(value)}>
          保存
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
  const [value, setValue] = useState(target?.title ?? "");

  useEffect(() => {
    setValue(target?.title ?? "");
  }, [target]);

  return (
    <Dialog open={Boolean(target)} onClose={onCancel} labelledBy="mc-rename-session-title">
      <span className="mc-dialog__title" id="mc-rename-session-title">
        重命名对话
      </span>
      <p className="mc-dialog__desc">只修改会话标题，消息内容不会变化。</p>
      <input
        className="mc-dialog__input"
        value={value}
        placeholder="输入对话标题"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && value.trim()) onSave(value.trim());
        }}
      />
      <div className="mc-dialog__footer">
        <Button variant="ghost" onClick={onCancel}>
          取消
        </Button>
        <Button variant="primary" disabled={!value.trim()} onClick={() => onSave(value.trim())}>
          保存
        </Button>
      </div>
    </Dialog>
  );
}

/** 会话菜单默认向上；上方空间不足时向下，避免被文件夹行和滚动容器裁切 */
function sessionMenuDirection(anchor: HTMLElement): "up" | "down" {
  const rect = anchor.getBoundingClientRect();
  const scroll = anchor.closest<HTMLElement>(".mc-convpanel__scroll")?.getBoundingClientRect();
  const top = scroll?.top ?? 0;
  const bottom = scroll?.bottom ?? window.innerHeight;
  return rect.top - top >= bottom - rect.bottom ? "up" : "down";
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
  onArchiveProject: (filePaths: string[]) => void;
  onRenameProject: (cwd: string, name: string) => void;
  onTogglePinProject: (cwd: string) => void;
  onRemoveProject: (cwd: string) => void;
  onOpenProject: (cwd: string) => void;
}) {
  /** 折叠的项目 cwd 集合：点了文件夹行收起该组聊天，再点展开 */
  const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<string>>(() => new Set());
  /** 菜单展开的项目 cwd */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** 正在重命名的项目 cwd；null = 对话框关闭 */
  const [editing, setEditing] = useState<string | null>(null);
  /** 展开会话操作菜单的 filePath */
  const [sessionMenuFor, setSessionMenuFor] = useState<string | null>(null);
  /** 会话菜单展开方向：靠近顶部时向下，避免被文件夹行裁切 */
  const [sessionMenuDir, setSessionMenuDir] = useState<"up" | "down">("up");
  const [renamingSession, setRenamingSession] = useState<SessionSummary | null>(null);
  const [deletingSession, setDeletingSession] = useState<SessionSummary | null>(null);
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
  // 空会话（没发过消息）不进列表，发过消息才显示。
  const groups = useMemo(() => {
    const map = new Map<string, SessionSummary[]>();
    if (workspace) map.set(workspace, []);
    for (const session of sessions) {
      if (archivedSessions.includes(session.filePath)) continue;
      if (session.messageCount <= 0) continue;
      const list = map.get(session.cwd);
      if (list) list.push(session);
      else map.set(session.cwd, [session]);
    }
    const entries = [...map.entries()]
      .filter(([cwd]) => !removedProjects.includes(cwd))
      .map(([cwd, items]) => ({ cwd, items }));
    // 排序：置顶在前（按置顶顺序）→ 当前工作区 → 其余按最近会话时间倒序
    return entries.sort((a, b) => {
      const pinA = pinnedProjects.indexOf(a.cwd);
      const pinB = pinnedProjects.indexOf(b.cwd);
      if (pinA !== -1 || pinB !== -1) {
        if (pinA === -1) return 1;
        if (pinB === -1) return -1;
        return pinA - pinB;
      }
      if (a.cwd === workspace) return -1;
      if (b.cwd === workspace) return 1;
      return (b.items[0]?.createdAt ?? "").localeCompare(a.items[0]?.createdAt ?? "");
    });
  }, [sessions, archivedSessions, workspace, removedProjects, pinnedProjects]);

  return (
    <section className="mc-panel mc-panel--conversations mc-convpanel">
      <div className="mc-convpanel__top">
        <button type="button" className="mc-convpanel__new" onClick={onNewChat}>
          <LuSquarePen size={14} />
          <span>新聊天</span>
        </button>
      </div>

      <div className="mc-convpanel__scroll">
        {groups.length === 0 ? (
          <p className="mc-convpanel__empty">暂无对话</p>
        ) : (
          <>
            <p className="mc-convpanel__section">项目</p>
            {groups.map((group) => {
              const collapsedNow = collapsedProjects.has(group.cwd);
              const items = group.items;
              const pinned = pinnedProjects.includes(group.cwd);
              const sessionMenuOpen = items.some((session) => session.filePath === sessionMenuFor);
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
                      title={collapsedNow ? "展开项目" : "折叠项目"}
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
                        aria-label="项目操作"
                        title="更多操作"
                        onClick={() => setMenuFor(menuFor === group.cwd ? null : group.cwd)}
                      >
                        <LuEllipsis size={15} />
                      </button>
                      <button
                        type="button"
                        className="mc-convpanel__groupbtn"
                        aria-label="在此项目中新建对话"
                        title="在此项目中新建对话"
                        onClick={() => onNewChatInProject(group.cwd)}
                      >
                        <LuSquarePen size={13} />
                      </button>
                    </span>

                    {menuFor === group.cwd ? (
                      <div className="mc-convpanel__menu" ref={menuRef} role="menu" aria-label="项目操作">
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
                          {pinned ? "取消置顶" : "置顶"}
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
                          编辑
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
                          在资源管理器中打开
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
                          归档聊天
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
                          移除项目
                        </button>
                      </div>
                    ) : null}
                  </div>

                  {items.length === 0 ? (
                    <p className="mc-convpanel__nochats">暂无聊天</p>
                  ) : (
                    <div className="mc-convpanel__collapse" data-open={!collapsedNow} aria-hidden={collapsedNow} inert={collapsedNow ? true : undefined}>
                    <div className="mc-convpanel__collapse-inner" data-menu-open={sessionMenuOpen ? "true" : undefined}>
                    <ul className="mc-convpanel__items">
                      {items.map((session) => {
                        const waitingApproval = (approvalSessionIds ?? []).includes(session.id);
                        const running = (runningSessionIds ?? []).includes(session.id) || waitingApproval;
                        return (
                          <li key={session.filePath} className="mc-convpanel__itemrow">
                            <button
                              type="button"
                              className="mc-convpanel__item"
                              data-active={session.id === currentSessionId}
                              data-running={running}
                              title={`${group.cwd} · ${new Date(session.createdAt).toLocaleString()}`}
                              onClick={() => onSwitchSession(session.filePath)}
                            >
                              {running ? (
                                <span
                                  className="mc-convpanel__runningdot"
                                  data-approval={waitingApproval}
                                  role="status"
                                  aria-label={waitingApproval ? "等待工具审批" : "正在生成回复"}
                                  title={waitingApproval ? "等待工具审批" : "正在生成回复"}
                                />
                              ) : null}
                              <span className="mc-convpanel__itemtitle">
                                {/* AI 标题优先；还没生成就显示「新对话」，日期放在悬停提示里 */}
                                {session.title || "新对话"}
                              </span>
                            </button>
                            <button
                              type="button"
                              className="mc-convpanel__rowbtn"
                              aria-label="会话操作"
                              aria-haspopup="menu"
                              aria-expanded={sessionMenuFor === session.filePath}
                              title="会话操作"
                              onClick={(event) => {
                                if (sessionMenuFor === session.filePath) {
                                  setSessionMenuFor(null);
                                  return;
                                }
                                setSessionMenuDir(sessionMenuDirection(event.currentTarget));
                                setSessionMenuFor(session.filePath);
                              }}
                            >
                              <LuEllipsis size={15} />
                            </button>
                            {sessionMenuFor === session.filePath ? (
                              <div
                                className="mc-convpanel__menu mc-convpanel__sessionmenu"
                                data-dir={sessionMenuDir}
                                ref={sessionMenuRef}
                                role="menu"
                                aria-label="会话操作"
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
                                      停止运行
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
                                  重命名
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
                                  创建分支
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
                                  归档
                                </button>
                                <div className="mc-convpanel__menusep" />
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="mc-convpanel__menuitem mc-convpanel__menuitem--danger"
                                  disabled={running}
                                  title={running ? "运行中不能删除" : undefined}
                                  onClick={() => {
                                    setDeletingSession(session);
                                    setSessionMenuFor(null);
                                  }}
                                >
                                  <LuTrash2 size={14} />
                                  删除
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
          删除对话
        </span>
        <p className="mc-dialog__desc">
          「{deletingSession?.title || "新对话"}」及其全部消息会从磁盘删除，无法恢复。
        </p>
        <div className="mc-dialog__footer">
          <Button variant="ghost" onClick={() => setDeletingSession(null)}>
            取消
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (deletingSession) onDeleteSession(deletingSession.filePath);
              setDeletingSession(null);
            }}
          >
            删除
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
