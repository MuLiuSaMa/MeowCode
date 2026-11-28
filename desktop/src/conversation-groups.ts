import type { ConversationOrder, SessionSummary } from "./api";

export type ConversationGroup = { cwd: string; items: SessionSummary[] };

/** 置顶对话伪分组的 cwd：不对应真实工作区，渲染层据此出「置顶」栏变体 */
export const PINNED_GROUP_ID = "__pinned__";

/**
 * 会话列表按工作区分组并排序。
 *
 * 排序规则只有三条：
 *  1. 被置顶的对话进最前面的伪分组（PINNED_GROUP_ID），按置顶顺序排列，
 *     并从各自的项目分组里移出（不重复显示）；
 *  2. 置顶项目在前，按用户置顶的顺序；
 *  3. 其余按各自最新一条会话的最后活动时间倒序。
 *
 * 「最后活动时间」而不是创建时间：继续一个旧对话后，它所在的分组和卡片
 * 都会回到最前。没有 updatedAt（旧服务端）时退回创建时间。
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
  /** 置顶对话的 filePath 列表（顺序即置顶顺序） */
  pinnedConversations?: string[];
  conversationOrder?: ConversationOrder;
}): ConversationGroup[] {
  const {
    sessions,
    workspace,
    archivedSessions,
    removedProjects,
    pinnedProjects,
    pinnedConversations,
    conversationOrder,
  } = options;
  const lastActive = (session: SessionSummary) => session.updatedAt ?? session.createdAt;
  const pinnedPaths = new Set(pinnedConversations ?? []);
  const sessionByPath = new Map(sessions.map((session) => [session.filePath, session]));
  const map = new Map<string, SessionSummary[]>();
  if (workspace) map.set(workspace, []);
  for (const session of sessions) {
    if (archivedSessions.includes(session.filePath)) continue;
    // 已置顶的对话只进「置顶」伪分组，不再出现在项目分组里
    if (pinnedPaths.has(session.filePath)) continue;
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
    .map(([cwd, items]) => {
      const rank = new Map((conversationOrder?.[cwd] ?? []).map((filePath, index) => [filePath, index]));
      return {
        cwd,
        items: [...items].sort((a, b) => {
          const rankA = rank.get(a.filePath);
          const rankB = rank.get(b.filePath);
          if (rankA !== undefined || rankB !== undefined) {
            if (rankA === undefined) return 1;
            if (rankB === undefined) return -1;
            return rankA - rankB;
          }
          return lastActive(b).localeCompare(lastActive(a));
        }),
      };
    });
  const latest = (items: SessionSummary[]) =>
    items.reduce((value, item) => (lastActive(item) > value ? lastActive(item) : value), "");
  const groups = entries.sort((a, b) => {
    const pinA = pinnedProjects.indexOf(a.cwd);
    const pinB = pinnedProjects.indexOf(b.cwd);
    if (pinA !== -1 || pinB !== -1) {
      if (pinA === -1) return 1;
      if (pinB === -1) return -1;
      return pinA - pinB;
    }
    return latest(b.items).localeCompare(latest(a.items));
  });
  // 「置顶」伪分组排在所有项目分组之前；条目按置顶顺序收拢，归档/空会话不进栏
  if (pinnedConversations?.length) {
    const pinned: SessionSummary[] = [];
    const seen = new Set<string>();
    for (const filePath of pinnedConversations) {
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      const session = sessionByPath.get(filePath);
      if (!session) continue;
      if (archivedSessions.includes(filePath)) continue;
      if (session.messageCount <= 0) continue;
      pinned.push(session);
    }
    if (pinned.length > 0) groups.unshift({ cwd: PINNED_GROUP_ID, items: pinned });
  }
  return groups;
}

export function reorderConversationPaths(
  filePaths: string[],
  activePath: string,
  overPath: string,
  position: "before" | "after",
): string[] {
  const from = filePaths.indexOf(activePath);
  const over = filePaths.indexOf(overPath);
  if (from < 0 || over < 0 || from === over) return filePaths;
  const rest = filePaths.filter((filePath) => filePath !== activePath);
  const target = rest.indexOf(overPath);
  rest.splice(target + (position === "after" ? 1 : 0), 0, activePath);
  return rest;
}
