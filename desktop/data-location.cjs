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

/**
 * Electron safeStorage 的密钥在 Windows 上落在 userData/Local State（DPAPI 包裹）。
 * 不一起搬走，settings.json 里的 apiKeyEncrypted 等密文在新位置就解不开（401）。
 * 旧位置保留这份文件：切回默认目录时旧数据仍能解密。
 */
const PROFILE_KEY_ENTRIES = ["Local State"];
const COPY_ENTRIES = [...DATA_ENTRIES, ...PROFILE_KEY_ENTRIES];

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

function copyEntries(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of COPY_ENTRIES) {
    const source = path.join(from, entry);
    if (!fs.existsSync(source)) continue;
    fs.cpSync(source, path.join(to, entry), { recursive: true, force: true });
  }
}

/** 删除旧位置里已迁移的应用数据；残留（被占用等）不影响新位置运行。 */
function removeEntries(dir) {
  for (const entry of DATA_ENTRIES) {
    try {
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    } catch {
      // 旧位置残留只是占盘，不阻塞迁移
    }
  }
}

function hasDataEntries(dir) {
  return DATA_ENTRIES.some((entry) => fs.existsSync(path.join(dir, entry)));
}

function migrateData({ current, target, defaultDir, pointerPath, removeSource = false }) {
  const code = validateDataTarget({ current, target, defaultDir });
  if (code) return { ok: false, code };

  const currentDir = path.resolve(current);
  const targetDir = path.resolve(target);
  try {
    if (targetDir === path.resolve(defaultDir)) {
      // 默认目录可能已被上次「转移」清空：没有数据时先从当前位置复制回来
      if (removeSource || !hasDataEntries(targetDir)) copyEntries(currentDir, targetDir);
      try {
        fs.unlinkSync(pointerPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (removeSource) removeEntries(currentDir);
      return { ok: true, resetToDefault: true };
    }

    copyEntries(currentDir, targetDir);
    writeJsonAtomic(pointerPath, { version: 1, path: targetDir }, { pretty: false });
    // 先写指针再删旧数据：删除失败时新位置仍然可用
    if (removeSource) removeEntries(currentDir);
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
