/**
 * 托盘菜单「最近对话」的数据处理（纯函数，方便单测）。
 * main.cjs 只负责拿数据、建菜单和分发点击，这里决定哪些会话能进菜单、
 * 怎么排序、标题怎么截断，以及「3 条 + 更多」怎么切分。
 */

/** 菜单直接列出的最近会话条数。 */
const TRAY_RECENT_COUNT = 3;
/** 收进「更多」子菜单的上限（再多托盘菜单就滚不完了）。 */
const TRAY_MORE_LIMIT = 20;
/** 标题截断长度：Windows 菜单不会自动省略，太长的名字会把菜单撑到屏幕外。 */
const TRAY_LABEL_MAX = 42;

/**
 * 会话列表 → 托盘的会话项。
 * 还没发过消息的空会话（messageCount = 0）不进菜单：点开只会得到一张欢迎页。
 * 按创建时间倒序（与侧栏一致），总量截到 3 + 更多 能装下的数量。
 */
function normalizeTraySessions(list) {
  const items = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item.filePath !== "string" || !item.filePath) continue;
    const messageCount = Number(item.messageCount);
    if (!Number.isFinite(messageCount) || messageCount <= 0) continue;
    items.push({
      filePath: item.filePath,
      title: typeof item.title === "string" ? item.title : null,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : "",
    });
  }
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return items.slice(0, TRAY_RECENT_COUNT + TRAY_MORE_LIMIT);
}

/** 菜单项标题：没标题用「未命名会话」兜底；& 要转义成 &&，否则被 Windows 当成助记符。 */
function traySessionLabel(session, untitled) {
  const raw = String(session?.title ?? "").trim() || untitled || "";
  const clipped = raw.length > TRAY_LABEL_MAX ? `${raw.slice(0, TRAY_LABEL_MAX)}…` : raw;
  return clipped.replace(/&/g, "&&");
}

/** 切成「菜单里直接列出的 3 条」和「更多子菜单」，前者为空说明还没有任何对话。 */
function splitTraySessions(list) {
  const items = Array.isArray(list) ? list : [];
  return {
    recent: items.slice(0, TRAY_RECENT_COUNT),
    more: items.slice(TRAY_RECENT_COUNT, TRAY_RECENT_COUNT + TRAY_MORE_LIMIT),
  };
}

module.exports = {
  TRAY_RECENT_COUNT,
  TRAY_MORE_LIMIT,
  TRAY_LABEL_MAX,
  normalizeTraySessions,
  traySessionLabel,
  splitTraySessions,
};
