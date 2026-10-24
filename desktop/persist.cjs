const fs = require("node:fs");
const path = require("node:path");

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // Busy-wait fallback (extremely rare: Atomics unavailable).
    }
  }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Read JSON, moving a corrupt file aside and falling back to `.bak`.
 * Never overwrites the corrupt file, so the user can inspect it.
 */
function readJsonWithBackup(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const missing = error && error.code === "ENOENT";
    if (!missing) {
      const corruptPath = `${filePath}.corrupt-${stamp()}.json`;
      try {
        // 移走而不是复制：避免同一会话里每次 readSettings 都生成一份损坏副本
        fs.renameSync(filePath, corruptPath);
      } catch {
        try {
          fs.copyFileSync(filePath, corruptPath);
        } catch {
          // best effort
        }
      }
    }
    try {
      return JSON.parse(fs.readFileSync(`${filePath}.bak`, "utf8"));
    } catch {
      return typeof fallback === "function" ? fallback() : fallback;
    }
  }
}

/**
 * Same-directory tmp + fsync + rename. Keeps the previous valid file as `.bak`.
 * Windows antivirus/indexer can briefly lock the target; retry rename a few times.
 */
function writeJsonAtomic(filePath, value, options = {}) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  try {
    const current = fs.readFileSync(filePath, "utf8");
    JSON.parse(current);
    fs.copyFileSync(filePath, `${filePath}.bak`);
  } catch {
    // Missing or already corrupt: don't replace a good backup with a corrupt one.
  }
  const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  const text = options.pretty === false ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  let fd;
  try {
    fd = fs.openSync(tmpPath, "w");
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (error) {
      const retryable =
        process.platform === "win32" &&
        ["EPERM", "EACCES", "EBUSY"].includes(error && error.code);
      if (retryable && attempt < 5) {
        sleepSync(20 * (attempt + 1));
        continue;
      }
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // best effort
      }
      throw error;
    }
  }
}

module.exports = { readJsonWithBackup, writeJsonAtomic };
