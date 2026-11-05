/**
 * 更新包下载（主进程专用，纯 CJS 以便 main.cjs 直接 require）。
 *
 * 与 NexBox 的更新流程对齐：
 *  - 按平台挑安装包（Windows 认 .exe/.msi，macOS 认 .dmg，Linux 认 .AppImage…）；
 *  - GitCode 的资产 URL 可能落在不可达的 test.gitcode.net，换主站由 302 转到 file-cdn；
 *  - 下载过程中按字节推进度，交给主进程广播给渲染层。
 *
 * 单独成文件：这段有分支（平台差异、URL 修正、流式计数），拆出来才能单测。
 */
const fs = require("node:fs");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

/** 各平台优先的安装包后缀（按顺序匹配） */
const PLATFORM_EXTENSIONS = {
  win32: [".exe", ".msi"],
  darwin: [".dmg", ".zip", ".pkg"],
  linux: [".appimage", ".deb", ".rpm", ".tar.gz"],
};

/** 按平台挑一个安装包；挑不到返回 null */
function pickInstallerAsset(assets, platform = process.platform) {
  if (!Array.isArray(assets) || !assets.length) return null;
  const preferred = PLATFORM_EXTENSIONS[platform] || PLATFORM_EXTENSIONS.win32;
  for (const extension of preferred) {
    const hit = assets.find(
      (asset) =>
        asset &&
        typeof asset.name === "string" &&
        asset.name.toLowerCase().endsWith(extension.toLowerCase()),
    );
    if (hit) return hit;
  }
  return null;
}

/**
 * GitCode API 返回的资产地址可能指向 test.gitcode.net（那个域名不可达），
 * 换成主站后由 302 跳到 file-cdn.gitcode.com 才能正常下载。
 */
function normalizeAssetUrl(url) {
  return String(url || "").replace("https://test.gitcode.net/", "https://gitcode.com/");
}

/** 把资产名清洗成安全的文件名（去掉路径分隔符与 Windows 非法字符） */
function safeAssetFileName(name) {
  const base = String(name || "")
    .split(/[\\/]/)
    .pop()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .trim();
  return base || "MeowCode-Setup.exe";
}

/** 把 release.assets 规整成 {name,url,size} 列表 */
function normalizeAssets(assets) {
  if (!Array.isArray(assets)) return [];
  return assets
    .filter((asset) => asset && typeof asset.name === "string")
    .map((asset) => ({
      name: asset.name,
      url: normalizeAssetUrl(asset.browser_download_url || asset.url || ""),
      size: Number(asset.size) || 0,
    }));
}

/**
 * 流式下载到 target。
 * onProgress({ received, total, percent })：percent 在拿不到 content-length 时为 0。
 */
async function downloadToFile({ url, target, onProgress, fetchImpl = fetch, signal }) {
  const response = await fetchImpl(normalizeAssetUrl(url), { redirect: "follow", signal });
  if (!response.ok) {
    throw new Error(`下载失败：HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("下载失败：响应没有内容");
  }
  const total = Number(response.headers?.get?.("content-length") || 0);
  let received = 0;
  let lastSent = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      const now = Date.now();
      // 进度事件按 200ms 节流：一次几百 MB 的下载不能把 IPC 淹了
      if (now - lastSent >= 200 || received === total) {
        lastSent = now;
        onProgress?.({
          received,
          total,
          percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
        });
      }
      callback(null, chunk);
    },
  });
  const source = Readable.fromWeb(response.body);
  await pipeline(source, counter, fs.createWriteStream(target));
  return { path: target, received, total };
}

module.exports = {
  PLATFORM_EXTENSIONS,
  pickInstallerAsset,
  normalizeAssetUrl,
  safeAssetFileName,
  normalizeAssets,
  downloadToFile,
};
