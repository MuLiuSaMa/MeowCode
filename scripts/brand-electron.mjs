#!/usr/bin/env node
/**
 * Dev Electron 打标（任务管理器名称 / 图标 / 版本信息）：
 *  - 默认（--soft）：已打标且图标指纹未变则跳过；图标变了或未打标则尝试打标，
 *    失败只警告、不阻塞 dev 启动（应用运行中 exe 被占用属于预期情况）。
 *  - --force：强制重打（要求应用完全退出，含托盘）。
 *
 * 打标内容：electron.exe → MeowCode.exe（同步 electron/path.txt），替换图标组
 * （resources/icon.ico），版本信息字符串全部改为 MeowCode。幂等可重复执行；
 * 写盘失败时保持原状（原始 exe 不动、path.txt 不改）。
 *
 * 注意：exe 改名后 Electron 不再视其为 default app，app.isPackaged 在 dev 下也会是 true。
 * main.cjs 已改用 devRepoRoot() 做布局探测，新增资源路径代码不要用 app.isPackaged。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as ResEdit from "resedit";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronDir = path.join(repoRoot, "desktop", "node_modules", "electron");
const distDir = path.join(electronDir, "dist");
const pathFile = path.join(electronDir, "path.txt");
const iconPath = path.join(repoRoot, "resources", "icon.ico");
const iconHashFile = path.join(distDir, ".meowcode-icon.sha256");
const sourceExe = path.join(distDir, "electron.exe");
const targetExe = path.join(distDir, "MeowCode.exe");

const force = process.argv.includes("--force");
const soft = !force;

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const version = String(pkg.version ?? "0.1.0");
const [vMajor = 0, vMinor = 0, vPatch = 0, vBuild = 0] = version
  .split(".")
  .map((part) => Number.parseInt(part, 10) || 0);
const copyright = String(pkg.license ?? "GPL-3.0-or-later");

function warn(message) {
  console.warn(`[brand-electron] ${message}`);
}

function iconFingerprint() {
  if (!fs.existsSync(iconPath)) return null;
  return createHash("sha256").update(fs.readFileSync(iconPath)).digest("hex");
}

/** path.txt 指向 MeowCode.exe、文件存在、且嵌入的图标指纹与 resources/icon.ico 一致。 */
function isBranded() {
  try {
    const target = fs.readFileSync(pathFile, "utf8").trim();
    if (target !== "MeowCode.exe" || !fs.existsSync(targetExe)) return false;
    const current = iconFingerprint();
    if (!current) return true;
    return fs.readFileSync(iconHashFile, "utf8").trim() === current;
  } catch {
    return false;
  }
}

function applyBranding(buffer) {
  const exe = ResEdit.NtExecutable.from(buffer, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  if (fs.existsSync(iconPath)) {
    const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath));
    const icons = iconFile.icons.map((item) => item.data);
    const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
    if (groups.length) {
      for (const group of groups) {
        ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
          res.entries,
          group.id,
          group.lang,
          icons,
        );
      }
    } else {
      ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, icons);
    }
  } else {
    warn(`缺少 ${path.relative(repoRoot, iconPath)}，跳过图标替换`);
  }

  const versionInfos = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (versionInfos.length) {
    for (const info of versionInfos) {
      info.setFileVersion(vMajor, vMinor, vPatch, vBuild, 1033);
      info.setProductVersion(vMajor, vMinor, vPatch, vBuild, 1033);
      info.setStringValues(
        { lang: 1033, codepage: 1200 },
        {
          FileDescription: "MeowCode",
          ProductName: "MeowCode",
          CompanyName: "MeowCode",
          InternalName: "MeowCode",
          OriginalFilename: "MeowCode.exe",
          LegalCopyright: copyright,
        },
      );
      info.outputToResourceEntries(res.entries);
    }
  } else {
    warn("未找到版本信息资源，跳过版本信息替换");
  }

  res.outputResource(exe);
  return Buffer.from(exe.generate());
}

/** 先写临时文件再替换：运行中的 exe 无法覆盖，失败时清理临时文件、原文件不动 */
function writeAtomic(file, buffer) {
  const temp = `${file}.brand-${process.pid}.tmp`;
  fs.writeFileSync(temp, buffer);
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // 临时文件清理失败可忽略
    }
    throw error;
  }
}

function brand() {
  // 优先用未打标的 electron.exe 作源（electron 重装/升级后）；否则用现有 MeowCode.exe 重打
  let source = null;
  if (fs.existsSync(sourceExe)) source = sourceExe;
  else if (fs.existsSync(targetExe)) source = targetExe;
  if (!source) throw new Error(`找不到 Electron 可执行文件：${distDir}`);

  const branded = applyBranding(fs.readFileSync(source));
  writeAtomic(targetExe, branded);
  // 先落盘 exe 再改 path.txt：任何一步失败都不会让启动指向不存在的文件
  fs.writeFileSync(pathFile, "MeowCode.exe", "utf8");
  const fingerprint = iconFingerprint();
  if (fingerprint) fs.writeFileSync(iconHashFile, fingerprint, "utf8");
  if (source === sourceExe) {
    try {
      fs.unlinkSync(sourceExe);
    } catch (error) {
      warn(`未能移除旧 electron.exe（${error.message}）`);
    }
  }
}

if (!force && isBranded()) {
  // 已打标：dev 启动链上静默跳过。换 Logo 后需手动 --force 才会应用新图标。
  process.exit(0);
}

try {
  brand();
  console.log(
    `[brand-electron] 已打标：${path.relative(repoRoot, targetExe)}（版本 ${version}${
      fs.existsSync(iconPath) ? "，图标 resources/icon.ico" : ""
    }）`,
  );
} catch (error) {
  if (soft) {
    warn(`打标失败（应用可能正在运行、exe 被占用）：${error.message}；继续启动，沿用当前可执行文件`);
    process.exit(0);
  }
  console.error(`[brand-electron] 打标失败：${error.message}`);
  console.error("[brand-electron] 请完全退出 MeowCode（含托盘）后重试。");
  process.exit(1);
}
