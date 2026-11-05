/**
 * 更新检查（主进程专用，纯 CJS 以便 main.cjs 直接 require）。
 *
 * 走 GitCode Releases（发布也发在 GitCode，国内直连 GitHub 不稳），
 * 逻辑参考 NexBox 的 src/lib/update-checker.ts：
 *  - release 接口带只读令牌，避开匿名限流；
 *  - 响应没有顶层 html_url，按仓库 + tag 拼发布页地址；
 *  - 版本按数字段比较，缺位补 0。
 *
 * 单独成文件而不是塞在 main.cjs 里：这段逻辑有分支（各种错误码），
 * 拆出来才能被单测覆盖（main.cjs 依赖 electron，跑不起来）。
 */
const { pickInstallerAsset, normalizeAssets } = require("./update-download.cjs");

const GITCODE_OWNER = "MuLiuSaMa";
const GITCODE_REPO = "MeowCode";
const GITCODE_WEB = "https://gitcode.com";
// 只读令牌：仅用于 release 接口走认证、规避匿名限流（无写权限，公开仓库下无额外风险）
const GITCODE_READ_TOKEN = "WmAt3-nHJiYGKrCby8bGajtw";
const UPDATE_TIMEOUT_MS = 8_000;

/** 拆版本号：去 v 前缀，按 . + - 切分，非数字段当 0 */
function parseVersionParts(value) {
  return String(value || "")
    .trim()
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
}

/** latest 是否比 current 新 */
function isNewerVersion(current, latest) {
  const a = parseVersionParts(current);
  const b = parseVersionParts(latest);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (right > left) return true;
    if (right < left) return false;
  }
  return false;
}

/** 把异常翻译成给人看的一句话 */
function describeUpdateError(error, status) {
  const body = error && typeof error.body === "string" ? error.body : "";
  // GitCode 没发过 Release 时不是 404，而是 400 + "未找到 release"
  if (status === 404 || /未找到\s*release|not\s*found\s*release/i.test(body)) {
    return "GitCode 上还没有发布版本（发一个 Release 后再检查）";
  }
  if (status === 401 || status === 403) return `GitCode 拒绝了请求（${status}）`;
  if (status) return `GitCode 返回 ${status}`;
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/timeout|abort/i.test(message)) return "请求超时，请检查网络后重试";
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|network/i.test(message)) {
    return "网络不可用，无法连接 GitCode";
  }
  return `检查失败：${message || "未知错误"}`;
}

/** 拉最新 release；失败抛带 status/body 的错误 */
async function fetchLatestGitCodeRelease() {
  const url = `https://api.gitcode.com/api/v5/repos/${GITCODE_OWNER}/${GITCODE_REPO}/releases/latest`;
  const response = await fetch(url, {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${GITCODE_READ_TOKEN}`,
    },
    signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const error = new Error(body || `HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  const data = await response.json();
  if (!data || typeof data.tag_name !== "string" || !data.tag_name) {
    throw new Error("release 响应缺少 tag_name");
  }
  const assets = normalizeAssets(data.assets);
  return {
    version: data.tag_name,
    name: typeof data.name === "string" ? data.name : "",
    // GitCode 的 release 响应没有顶层 html_url，按仓库与 tag 拼
    url: `${GITCODE_WEB}/${GITCODE_OWNER}/${GITCODE_REPO}/releases/tag/${encodeURIComponent(
      data.tag_name,
    )}`,
    publishedAt: typeof data.published_at === "string" ? data.published_at : "",
    notes: typeof data.body === "string" ? data.body.slice(0, 2_000) : "",
    assets,
    // 当前平台能用的安装包（没有则说明这次发布没带安装包）
    asset: pickInstallerAsset(assets),
  };
}

/**
 * 检查更新入口。
 * 返回 { ok:true, current, latest, hasUpdate } 或 { ok:false, current, error }。
 */
async function checkForUpdate(currentVersion) {
  const current = currentVersion || "0.0.0";
  try {
    const latest = await fetchLatestGitCodeRelease();
    return { ok: true, current, latest, hasUpdate: isNewerVersion(current, latest.version) };
  } catch (error) {
    return { ok: false, current, error: describeUpdateError(error, error && error.status) };
  }
}

module.exports = {
  GITCODE_OWNER,
  GITCODE_REPO,
  GITCODE_WEB,
  parseVersionParts,
  isNewerVersion,
  describeUpdateError,
  fetchLatestGitCodeRelease,
  checkForUpdate,
};
