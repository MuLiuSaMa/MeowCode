import type { SessionSummary } from "./api";

export type ConversationGroup = { cwd: string; items: SessionSummary[] };

/**
 * 会话列表按工作区分组并排序。
 *
 * 排序规则只有两条：
 *  1. 置顶项目在前，按用户置顶的顺序；
 *  2. 其余按各自最新一条会话的创建时间倒序。
 *
 * 刻意**不**把当前工作区提到最前 —— 点开另一个项目的会话时，分组位置若跟着跳，
 * 整个列表会在手底下重排，很容易点错下一条。当前分组由 data-active 高亮表示。
 */
export function groupSessionsByProject(options: {
  sessions: SessionSummary[];
  /** 当前工作区：即使没有任何会话也要占一个空分组 */
  workspace: string | null | undefined;
  archivedSessions: string[];
  removedProjects: string[];
  pinnedProjects: string[];
}): ConversationGroup[] {
  const { sessions, workspace, archivedSessions, removedProjects, pinnedProjects } = options;
  const map = new Map<string, SessionSummary[]>();
  if (workspace) map.set(workspace, []);
  for (const session of sessions) {
    if (archivedSessions.includes(session.filePath)) continue;
    // 空会话（没发过消息）不进列表：它只是"打开过"，不构成一条记录
    if (session.messageCount <= 0) continue;
    // worktree 会话归回它派生自的项目，否则同一个仓库会被拆成好几组
    const project = session.worktree?.sourceCwd ?? session.cwd;
    const list = map.get(project);
    if (list) list.push(session);
    else map.set(project, [session]);
  }
  const entries = [...map.entries()]
    .filter(([cwd]) => !removedProjects.includes(cwd))
    .map(([cwd, items]) => ({ cwd, items }));
  return entries.sort((a, b) => {
    const pinA = pinnedProjects.indexOf(a.cwd);
    const pinB = pinnedProjects.indexOf(b.cwd);
    if (pinA !== -1 || pinB !== -1) {
      if (pinA === -1) return 1;
      if (pinB === -1) return -1;
      return pinA - pinB;
    }
    return (b.items[0]?.createdAt ?? "").localeCompare(a.items[0]?.createdAt ?? "");
  });
}
