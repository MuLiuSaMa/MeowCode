/**
 * 微软商店 MSIX 打包配置。
 *
 * 复用 package.json 的 build 段，只把 Windows 目标换成 appx、输出扩展名改成 .msix
 * （MakeAppx 按输出文件名决定容器扩展名，APPX 与 MSIX 内容结构一致）。
 *
 * 商店身份来自 Partner Center →「产品标识」，缺省值已按当前产品写死，
 * 仍可用环境变量覆盖（换产品/换账号时不用改代码）：
 *   MEOWCODE_MSIX_IDENTITY_NAME            Package/Identity/Name
 *   MEOWCODE_MSIX_PUBLISHER                Package/Identity/Publisher（CN=…）
 *   MEOWCODE_MSIX_PUBLISHER_DISPLAY_NAME   Package/Properties/PublisherDisplayName
 * 三个值任一与商店不一致都会被拒收。
 *
 * 资源图来自 resources/appx（node scripts/make-msix-assets.mjs 生成）。
 */
const base = require("./package.json").build;

module.exports = {
  ...base,
  directories: {
    ...base.directories,
    // appx 目标用 getResource(undefined, "appx") 找资源图，默认找 desktop/build
    buildResources: "../resources",
  },
  win: {
    ...base.win,
    target: [{ target: "appx", arch: ["x64"] }],
  },
  appx: {
    applicationId: "MeowCode",
    identityName: process.env.MEOWCODE_MSIX_IDENTITY_NAME || "MuLiuSaMa.MeowCode",
    publisher:
      process.env.MEOWCODE_MSIX_PUBLISHER || "CN=30F199CB-855A-42F4-96A9-F43088B508BF",
    publisherDisplayName: process.env.MEOWCODE_MSIX_PUBLISHER_DISPLAY_NAME || "MuLiu_SaMa",
    displayName: "MeowCode",
    // 商店包最低 Win10 1809（MSIX 容器），上限按当前 SDK 标注
    minVersion: "10.0.17763.0",
    maxVersionTested: "10.0.26100.0",
    languages: ["zh-CN", "en-US"],
    backgroundColor: "transparent",
    artifactName: "${productName}-${version}-${arch}.msix",
  },
};
