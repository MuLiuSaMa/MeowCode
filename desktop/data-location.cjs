const fs = require("node:fs");
const path = require("node:path");
const { writeJsonAtomic } = require("./persist.cjs");

/**
 * 数据目录迁移只搬应用自己写的必要数据；Chromium 的 Cache/GPUCache 等
 * 在运行中被占用且可重建，不复制，避免 Windows 上 EBUSY 导致迁移失败。
 */
const DATA_ENTRIES = [
  "agent",
  "fonts",
  "oauth-apps.json",
  "model-profiles.json",
  "open-with-cache.json",
  "statistics-sent.json",
];

function defaultDataDir(appData) {
  return path.join(appData, "MeowCode");
}

/** 自定义位置指针放在 userData 外面，移动数据时不会被一起搬走 */
function locationPointerPath(appData) {
  return path.join(appData, "MeowCode-location.json");
}

function readDataLocation(appData) {
  const fallback = defaultDataDir(appData);
  try {
    const entry = JSON.parse(fs.readFileSync(locationPointerPath(appData), "utf8"));
    if (typeof entry.path !== "string" || !path.isAbsolute(entry.path)) return fallback;
    const target = path.resolve(entry.path);
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return fallback;
    return target;
  } catch {
    return fallback;
  }
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** 返回错误码；null 表示可以迁移 */
function validateDataTarget({ current, target, defaultDir }) {
  if (typeof target !== "string" || !target.trim()) return "invalid_target";
  const currentDir = path.resolve(current);
  const targetDir = path.resolve(target);
  const defaultPath = path.resolve(defaultDir);
  if (targetDir === currentDir) return "same_path";
  // 允许切回默认位置：默认目录里可能已有旧数据，直接使用不再复制
  if (targetDir === defaultPath) return null;
  if (isInside(currentDir, targetDir) || isInside(targetDir, currentDir)) return "invalid_target";
  if (fs.existsSync(targetDir)) {
    if (!fs.statSync(targetDir).isDirectory()) return "invalid_target";
    if (fs.readdirSync(targetDir).length > 0) return "not_empty";
  }
  return null;
}

function migrateData({ current, target, defaultDir, pointerPath }) {
  const code = validateDataTarget({ current, target, defaultDir });
  if (code) return { ok: false, code };

  const currentDir = path.resolve(current);
  const targetDir = path.resolve(target);
  try {
    if (targetDir === path.resolve(defaultDir)) {
      try {
        fs.unlinkSync(pointerPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      return { ok: true, resetToDefault: true };
    }

    fs.mkdirSync(targetDir, { recursive: true });
    for (const entry of DATA_ENTRIES) {
      const source = path.join(currentDir, entry);
      if (!fs.existsSync(source)) continue;
      fs.cpSync(source, path.join(targetDir, entry), { recursive: true, force: true });
    }
    writeJsonAtomic(pointerPath, { version: 1, path: targetDir }, { pretty: false });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      code: "copy_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

module.exports = {
  DATA_ENTRIES,
  defaultDataDir,
  locationPointerPath,
  readDataLocation,
  validateDataTarget,
  migrateData,
};
