"use strict";

const fs = require("node:fs");
const path = require("node:path");
const ResEdit = require("resedit");

/** 2052 = 中文（简体），与 scripts/brand-electron.mjs 的开发态产物保持一致 */
const VERSION_LANG = 2052;

function applyVersionInfo(file, info) {
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(file), { ignoreCert: true });
  const resource = ResEdit.NtExecutableResource.from(exe);
  const versionInfos = ResEdit.Resource.VersionInfo.fromEntries(resource.entries);
  const [major = 0, minor = 0, patch = 0, build = 0] = String(info.version)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);

  for (const versionInfo of versionInfos) {
    versionInfo.lang = VERSION_LANG;
    // 去掉 Electron 自带的英文版本字符串，只保留作者与中文资源
    for (const existing of versionInfo.getAllLanguagesForStringValues()) {
      versionInfo.removeAllStringValues(existing, false);
    }
    versionInfo.replaceAvailableLanguages([{ lang: VERSION_LANG, codepage: 1200 }]);
    versionInfo.setFileVersion(major, minor, patch, build, VERSION_LANG);
    versionInfo.setProductVersion(major, minor, patch, build, VERSION_LANG);
    versionInfo.setStringValues(
      { lang: VERSION_LANG, codepage: 1200 },
      {
        FileDescription: "MeowCode",
        ProductName: "MeowCode",
        CompanyName: info.author,
        Author: info.author,
        InternalName: "MeowCode",
        OriginalFilename: "MeowCode.exe",
        LegalCopyright: info.copyright,
      },
    );
    versionInfo.outputToResourceEntries(resource.entries);
  }

  resource.outputResource(exe);
  fs.writeFileSync(file, Buffer.from(exe.generate()));
}

/** electron-builder afterPack：把打包后的 MeowCode.exe 属性改成作者与中文。 */
module.exports = async function afterPack(context) {
  if (process.platform !== "win32") return;
  const appInfo = context.packager?.appInfo;
  const productName = appInfo?.productName || "MeowCode";
  const exePath = path.join(context.appOutDir, `${productName}.exe`);
  if (!fs.existsSync(exePath)) return;
  const author = appInfo?.companyName || "MuLiuSaMa";
  const copyright = appInfo?.copyright || `Copyright © ${new Date().getFullYear()} ${author}`;
  applyVersionInfo(exePath, {
    author,
    copyright,
    version: appInfo?.version || "1.0.0",
  });
};
